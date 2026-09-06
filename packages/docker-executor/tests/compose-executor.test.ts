import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { createHash } from "node:crypto";
import {
  ComposeExecutor,
  ExecutorError,
  copySources,
  contextSourceExists,
  isPrismaSchemaTarget,
} from "../dist/index.js";
import { FakeRunner, compose, gitCachedWorktree, type Responder } from "./fake-runner.js";

const FULL_SHA = "a".repeat(40);
const SHA12 = FULL_SHA.slice(0, 12);

function migratorTag(prisma: string): string {
  const identity = JSON.stringify({ recipe: "v2", base: "node:20-bookworm", prisma });
  return `cloudproof-prisma-migrator:${createHash("sha256").update(identity).digest("hex").slice(0, 16)}`;
}

/** Réplica de la identidad del tag de buildImage (rutas + bytes del Dockerfile). */
function appTag(spec: {
  servicePath: string;
  dockerfileRel: string;
  contextRel: string;
  dockerfileContents: string;
}): string {
  const identity = createHash("sha256")
    .update(
      JSON.stringify({
        servicePath: spec.servicePath,
        dockerfile: spec.dockerfileRel,
        context: spec.contextRel,
        buildArgs: [],
        buildNetwork: "default",
        dockerfileSha256: createHash("sha256")
          .update(Buffer.from(spec.dockerfileContents, "utf-8"))
          .digest("hex"),
      }),
    )
    .digest("hex")
    .slice(0, 8);
  return `cloudproof-app:${SHA12}-${identity}`;
}

let tmp: string;
let worktreesDir: string;

function seedWorktree(files: Record<string, string>): string {
  const dir = join(worktreesDir, SHA12);
  mkdirSync(dir, { recursive: true });
  for (const [relPath, contents] of Object.entries(files)) {
    const absPath = join(dir, relPath);
    mkdirSync(dirname(absPath), { recursive: true });
    writeFileSync(absPath, contents, "utf-8");
  }
  return dir;
}

function makeExecutor(runner: FakeRunner, extra: Record<string, unknown> = {}): ComposeExecutor {
  return new ComposeExecutor({
    runner,
    repoRoot: tmp,
    worktreesDir,
    runId: "test",
    pollIntervalMs: 1,
    readinessTimeoutMs: 500,
    httpProbe: async () => true,
    blockEgress: false,
    ...extra,
  });
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "cloudproof-ut-"));
  worktreesDir = join(tmp, "wt");
  mkdirSync(worktreesDir, { recursive: true });
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function inspectMissResponder(): Responder {
  return (command, args) => {
    if (
      command === "docker" &&
      args[0] === "image" &&
      args[1] === "inspect" &&
      String(args[2] ?? "").startsWith("cloudproof-app:")
    ) {
      return { exitCode: 1, stderr: "No such image" };
    }
    return undefined;
  };
}

describe("buildImage", () => {
  const rootDockerfile = "FROM scratch\n";
  const expectedTag = appTag({
    servicePath: ".",
    dockerfileRel: "Dockerfile",
    contextRel: ".",
    dockerfileContents: rootDockerfile,
  });

  it("construye la imagen desde un worktree cacheado y la etiqueta por SHA+rutas+Dockerfile", async () => {
    seedWorktree({ Dockerfile: rootDockerfile });
    const runner = new FakeRunner(compose(gitCachedWorktree(FULL_SHA), inspectMissResponder()));

    const tag = await makeExecutor(runner).buildImage({ sha: FULL_SHA, servicePath: "." });

    expect(tag).toBe(expectedTag);
    expect(runner.count("docker build", "-t", expectedTag, "--label dev.cloudproof.owner=cloudproof")).toBe(1);
  });

  it("no rebuildea si la imagen ya existe (cache por tag)", async () => {
    seedWorktree({ Dockerfile: rootDockerfile });
    const runner = new FakeRunner(gitCachedWorktree(FULL_SHA)); // inspect responde exit 0

    const tag = await makeExecutor(runner).buildImage({ sha: FULL_SHA, servicePath: "." });

    expect(tag).toBe(expectedTag);
    expect(runner.count("docker build")).toBe(0);
  });

  it("CLOUDPROOF_FORCE_REBUILD=1 saltea el hit de cache y reconstruye", async () => {
    seedWorktree({ Dockerfile: rootDockerfile });
    const runner = new FakeRunner(gitCachedWorktree(FULL_SHA)); // inspect daría hit
    process.env["CLOUDPROOF_FORCE_REBUILD"] = "1";
    try {
      await makeExecutor(runner).buildImage({ sha: FULL_SHA, servicePath: "." });
    } finally {
      delete process.env["CLOUDPROOF_FORCE_REBUILD"];
    }
    expect(runner.count("docker build")).toBe(1);
  });

  it("un Dockerfile distinto para el mismo SHA produce un tag distinto (cache no stale)", async () => {
    const dir = seedWorktree({ Dockerfile: rootDockerfile });
    const runner = new FakeRunner(compose(gitCachedWorktree(FULL_SHA), inspectMissResponder()));
    const executor = makeExecutor(runner);

    const first = await executor.buildImage({ sha: FULL_SHA, servicePath: "." });
    writeFileSync(join(dir, "Dockerfile"), "FROM scratch\nLABEL cambiado=true\n", "utf-8");
    const second = await executor.buildImage({ sha: FULL_SHA, servicePath: "." });

    expect(first).not.toBe(second);
  });

  it("si usa el Dockerfile raíz conserva el worktree completo como build context", async () => {
    const dir = seedWorktree({
      Dockerfile: rootDockerfile,
      "apps/api/package.json": "{}\n",
    });
    const runner = new FakeRunner(compose(gitCachedWorktree(FULL_SHA), inspectMissResponder()));

    await makeExecutor(runner).buildImage({ sha: FULL_SHA, servicePath: "apps/api" });

    const build = runner.calls.find(
      (call) => call.command === "docker" && call.args[0] === "build",
    );
    expect(build?.args.at(-1)).toBe(dir);
    expect(build?.args).toContain(join(dir, "Dockerfile"));
  });

  it("falla explícitamente si no hay Dockerfile y menciona services.<nombre>.dockerfile", async () => {
    seedWorktree({ "README.md": "sin dockerfile" });
    const runner = new FakeRunner(gitCachedWorktree(FULL_SHA));

    await expect(
      makeExecutor(runner).buildImage({ sha: FULL_SHA, servicePath: "." }),
    ).rejects.toThrow(/dockerfile/i);
    expect(runner.count("docker build")).toBe(0);
  });
});

describe("resolución de build context (patrón Turborepo, gate 1.E)", () => {
  it("COPY de un archivo que solo existe en la raíz mueve el contexto a la raíz", async () => {
    const dir = seedWorktree({
      "turbo.json": "{}\n",
      "apps/web/Dockerfile": "FROM scratch\nCOPY turbo.json turbo.json\nCOPY apps/web ./apps/web\n",
      "apps/web/package.json": "{}\n",
    });
    const runner = new FakeRunner(compose(gitCachedWorktree(FULL_SHA), inspectMissResponder()));

    await makeExecutor(runner).buildImage({ sha: FULL_SHA, servicePath: "apps/web" });

    const build = runner.calls.find((call) => call.command === "docker" && call.args[0] === "build");
    expect(build?.args.at(-1)).toBe(dir);
    expect(build?.args).toContain(join(dir, "apps/web", "Dockerfile"));
  });

  it("fuentes resolubles localmente conservan la carpeta del servicio como contexto", async () => {
    const dir = seedWorktree({
      "apps/api/Dockerfile": "FROM scratch\nCOPY package*.json ./\nCOPY src ./src\n",
      "apps/api/package.json": "{}\n",
      "apps/api/src/main.ts": "// app\n",
    });
    const runner = new FakeRunner(compose(gitCachedWorktree(FULL_SHA), inspectMissResponder()));

    await makeExecutor(runner).buildImage({ sha: FULL_SHA, servicePath: "apps/api" });

    const build = runner.calls.find((call) => call.command === "docker" && call.args[0] === "build");
    expect(build?.args.at(-1)).toBe(join(dir, "apps/api"));
  });

  it("las copias entre stages (--from) no influyen en el contexto", async () => {
    const dir = seedWorktree({
      "apps/api/Dockerfile":
        "FROM scratch AS builder\nCOPY package.json ./\nFROM scratch\nCOPY --from=builder /app/out ./out\n",
      "apps/api/package.json": "{}\n",
    });
    const runner = new FakeRunner(compose(gitCachedWorktree(FULL_SHA), inspectMissResponder()));

    await makeExecutor(runner).buildImage({ sha: FULL_SHA, servicePath: "apps/api" });

    const build = runner.calls.find((call) => call.command === "docker" && call.args[0] === "build");
    expect(build?.args.at(-1)).toBe(join(dir, "apps/api"));
  });

  it("spec.dockerfile usa un Dockerfile custom y el contexto se infiere igual", async () => {
    const dir = seedWorktree({
      "docker/Dockerfile.web": "FROM scratch\nCOPY package.json ./\n",
      "package.json": "{}\n",
      "apps/web/package.json": "{}\n",
    });
    const runner = new FakeRunner(compose(gitCachedWorktree(FULL_SHA), inspectMissResponder()));

    await makeExecutor(runner).buildImage({
      sha: FULL_SHA,
      servicePath: "apps/web",
      dockerfile: "docker/Dockerfile.web",
    });

    const build = runner.calls.find((call) => call.command === "docker" && call.args[0] === "build");
    expect(build?.args).toContain(join(dir, "docker/Dockerfile.web"));
    // package.json no existe en docker/ pero sí en la raíz → contexto raíz.
    expect(build?.args.at(-1)).toBe(dir);
  });

  it("spec.buildContext explícito gana sobre la inferencia", async () => {
    const dir = seedWorktree({
      "apps/web/Dockerfile": "FROM scratch\nCOPY turbo.json turbo.json\n",
      "apps/web/package.json": "{}\n",
      "turbo.json": "{}\n",
    });
    const runner = new FakeRunner(compose(gitCachedWorktree(FULL_SHA), inspectMissResponder()));

    await makeExecutor(runner).buildImage({
      sha: FULL_SHA,
      servicePath: "apps/web",
      buildContext: "apps/web",
    });

    const build = runner.calls.find((call) => call.command === "docker" && call.args[0] === "build");
    expect(build?.args.at(-1)).toBe(join(dir, "apps/web"));
  });

  it("spec.buildArgs se pasan como --build-arg y participan de la identidad del tag", async () => {
    seedWorktree({ Dockerfile: "FROM scratch\nARG SELF_HOSTED\n" });
    const runner = new FakeRunner(compose(gitCachedWorktree(FULL_SHA), inspectMissResponder()));
    const executor = makeExecutor(runner);

    const withArgs = await executor.buildImage({
      sha: FULL_SHA,
      servicePath: ".",
      buildArgs: { SELF_HOSTED: "true" },
    });
    const withoutArgs = await executor.buildImage({ sha: FULL_SHA, servicePath: "." });

    expect(runner.count("--build-arg SELF_HOSTED=true")).toBe(1);
    expect(withArgs).not.toBe(withoutArgs);
  });

  it("spec.dockerfile inexistente falla sin fabricar un build", async () => {
    seedWorktree({ Dockerfile: "FROM scratch\n" });
    const runner = new FakeRunner(gitCachedWorktree(FULL_SHA));

    await expect(
      makeExecutor(runner).buildImage({
        sha: FULL_SHA,
        servicePath: ".",
        dockerfile: "docker/Dockerfile.api",
      }),
    ).rejects.toThrow(/docker\/Dockerfile\.api/);
    expect(runner.count("docker build")).toBe(0);
  });
});

describe("copySources / contextSourceExists", () => {
  it("extrae fuentes de COPY/ADD en forma shell y exec, ignorando flags, stages y URLs", () => {
    const sources = copySources(
      [
        "FROM node:20 AS builder",
        "COPY package.json pnpm-lock.yaml ./",
        "COPY --chown=node:node src ./src",
        "COPY --from=builder /app/dist ./dist",
        'COPY ["turbo.json", "turbo.json"]',
        "ADD https://example.com/archivo.tar.gz /tmp/",
        "ADD vendor.tar.gz /opt/",
        "COPY a \\",
        "     b ./",
      ].join("\n"),
    );

    expect(sources).toEqual([
      "package.json",
      "pnpm-lock.yaml",
      "src",
      "turbo.json",
      "vendor.tar.gz",
      "a",
      "b",
    ]);
  });

  it("contextSourceExists resuelve rutas exactas y wildcards del último segmento", () => {
    const dir = seedWorktree({
      "package.json": "{}\n",
      "packages/db/schema.sql": "--\n",
    });

    expect(contextSourceExists(dir, "package.json")).toBe(true);
    expect(contextSourceExists(dir, "package*.json")).toBe(true);
    expect(contextSourceExists(dir, "missing*.json")).toBe(false);
    expect(contextSourceExists(dir, "packages/db")).toBe(true);
    expect(contextSourceExists(dir, "packages/*/schema.sql")).toBe(true); // prefijo estático existe
    expect(contextSourceExists(dir, "no-existe")).toBe(false);
    expect(contextSourceExists(dir, "./")).toBe(true);
  });
});

describe("isPrismaSchemaTarget", () => {
  it("acepta un schema.prisma, una carpeta con .prisma y rechaza el resto", () => {
    const dir = seedWorktree({
      "prisma/schema.prisma": "datasource db {}\n",
      "multi/prisma/schema/main.prisma": "datasource db {}\n",
      "vacia/prisma/schema/readme.md": "sin schemas\n",
    });

    expect(isPrismaSchemaTarget(join(dir, "prisma/schema.prisma"))).toBe(true);
    expect(isPrismaSchemaTarget(join(dir, "multi/prisma/schema"))).toBe(true);
    expect(isPrismaSchemaTarget(join(dir, "vacia/prisma/schema"))).toBe(false);
    expect(isPrismaSchemaTarget(join(dir, "no-existe"))).toBe(false);
  });
});

describe("startEphemeralPostgres", () => {
  function pgResponder(worktreeDir: string): { responder: Responder; state: { probeCalls: number } } {
    const state = { probeCalls: 0 };
    const responder: Responder = (command, args) => {
      if (command !== "docker") return undefined;
      const line = args.join(" ");
      if (args[0] === "run" && line.includes("postgres:16-alpine")) {
        return { stdout: "pgcid\n" };
      }
      if (args[0] === "exec" && line.includes("pg_postmaster_start_time")) {
        state.probeCalls += 1;
        // 1ª sonda: el postmaster temporal de initdb apagándose (la carrera
        // real). 2ª y 3ª: el definitivo respondiendo dos veces seguidas.
        return state.probeCalls === 1
          ? { exitCode: 2, stderr: "psql: error: FATAL:  the database system is shutting down" }
          : { stdout: "1|2026-01-01 00:00:00.000000+00\n" };
      }
      if (args[0] === "inspect" && line.includes("{{.State.Running}}")) {
        return { stdout: "true\n" };
      }
      if (args[0] === "port") {
        return { stdout: "127.0.0.1:49701\n" };
      }
      return undefined;
    };
    return { responder, state };
  }

  it("levanta postgres, espera readiness, aplica migraciones containerizadas y devuelve ambas URLs", async () => {
    const dir = seedWorktree({
      "prisma/schema.prisma": "datasource db {}\n",
      "package.json": JSON.stringify({ devDependencies: { prisma: "6" } }),
    });
    const { responder, state } = pgResponder(dir);
    const runner = new FakeRunner(compose(gitCachedWorktree(FULL_SHA), responder));

    const pg = await makeExecutor(runner).startEphemeralPostgres({
      label: "S1",
      migrationsUpToSha: FULL_SHA,
    });

    expect(pg.id).toBe("pgcid");
    expect(pg.serviceName).toMatch(/^cloudproof-pg-s1-test-/);
    expect(pg.connectionUrl).toBe(`postgresql://cloudproof:cloudproof@${pg.serviceName}:5432/cloudproof`);
    expect(pg.hostConnectionUrl).toBe("postgresql://cloudproof:cloudproof@127.0.0.1:49701/cloudproof");
    // 1 sonda del postmaster temporal + 2 confirmaciones consecutivas del
    // definitivo. pg_isready no participa más del readiness.
    expect(state.probeCalls).toBe(3);
    expect(runner.count("pg_isready")).toBe(0);
    expect(runner.count("-h 127.0.0.1", "SELECT 1, pg_postmaster_start_time();")).toBe(3);
    expect(runner.count("network create", "--label dev.cloudproof.owner=cloudproof")).toBe(1);
    expect(runner.count(migratorTag("6"), "migrate deploy", "--schema /repo/prisma/schema.prisma")).toBe(1);
    // Workdir neutro: el migrador no debe auto-cargar prisma.config.ts del repo.
    expect(runner.count("-w /opt/cloudproof-migrator", "migrate deploy")).toBe(1);
    expect(runner.count(`${dir}:/repo:ro`)).toBe(1);
    expect(runner.count(`DATABASE_URL=postgresql://cloudproof:cloudproof@${pg.serviceName}:5432/cloudproof`)).toBe(1);
    expect(runner.count("--memory 1g", "--cpus 1", "--pids-limit 256", "no-new-privileges:true")).toBeGreaterThanOrEqual(2);
  });

  it("usa la versión de prisma del package.json del worktree si existe", async () => {
    const dir = seedWorktree({
      "prisma/schema.prisma": "datasource db {}\n",
      "package.json": JSON.stringify({ devDependencies: { prisma: "^5.20.0" } }),
    });
    const { responder } = pgResponder(dir);
    const runner = new FakeRunner(compose(gitCachedWorktree(FULL_SHA), responder));

    await makeExecutor(runner).startEphemeralPostgres({ label: "S0", migrationsUpToSha: FULL_SHA });

    expect(runner.count("image inspect", migratorTag("^5.20.0"))).toBe(1);
    expect(runner.count(migratorTag("^5.20.0"), "migrate deploy")).toBe(1);
  });

  it("soporta el layout multi-archivo: prisma/schema/ como carpeta de schemas", async () => {
    const dir = seedWorktree({
      "prisma/schema/main.prisma": "datasource db {}\n",
      "prisma/schema/auth.prisma": "model User {}\n",
      "package.json": JSON.stringify({ devDependencies: { prisma: "6" } }),
    });
    const { responder } = pgResponder(dir);
    const runner = new FakeRunner(compose(gitCachedWorktree(FULL_SHA), responder));

    await makeExecutor(runner).startEphemeralPostgres({ label: "S0", migrationsUpToSha: FULL_SHA });

    expect(runner.count("migrate deploy", "--schema /repo/prisma/schema")).toBe(1);
  });

  it("repo con prisma.config.*: monta un config sintético en vez de --schema (config-era)", async () => {
    const dir = seedWorktree({
      "prisma/schema/main.prisma": "datasource db {}\n",
      "prisma.config.ts": "import { defineConfig } from 'prisma/config';\nexport default defineConfig({});\n",
    });
    const { responder } = pgResponder(dir);
    const runner = new FakeRunner(compose(gitCachedWorktree(FULL_SHA), responder));

    await makeExecutor(runner).startEphemeralPostgres({ label: "S0", migrationsUpToSha: FULL_SHA });

    const migrate = runner
      .lines()
      .find((line) => line.includes("migrate deploy"));
    expect(migrate).toBeDefined();
    expect(migrate).not.toContain("--schema");
    expect(migrate).toContain(":/opt/cloudproof-migrator/prisma.config.ts:ro");
    expect(migrate).toContain("CLOUDPROOF_PRISMA_SCHEMA=/repo/prisma/schema");
    expect(migrate).toContain("CLOUDPROOF_PRISMA_MIGRATIONS=/repo/prisma/migrations");
  });

  it("acepta un prismaSchema explícito que apunta a una carpeta", async () => {
    const dir = seedWorktree({
      "db/prisma/schema/main.prisma": "datasource db {}\n",
      "package.json": JSON.stringify({ devDependencies: { prisma: "6" } }),
    });
    const { responder } = pgResponder(dir);
    const runner = new FakeRunner(compose(gitCachedWorktree(FULL_SHA), responder));

    await makeExecutor(runner).startEphemeralPostgres({
      label: "S0",
      migrationsUpToSha: FULL_SHA,
      prismaSchema: "db/prisma/schema",
    });

    expect(runner.count("migrate deploy", "--schema /repo/db/prisma/schema")).toBe(1);
  });

  it("la versión de prisma se resuelve desde el package.json del servicio, no solo la raíz", async () => {
    const dir = seedWorktree({
      "apps/api/src/prisma/schema.prisma": "datasource db {}\n",
      "apps/api/package.json": JSON.stringify({ devDependencies: { prisma: "5.6.0" } }),
      "package.json": JSON.stringify({ private: true }),
    });
    const { responder } = pgResponder(dir);
    const runner = new FakeRunner(compose(gitCachedWorktree(FULL_SHA), responder));

    await makeExecutor(runner).startEphemeralPostgres({
      label: "S0",
      migrationsUpToSha: FULL_SHA,
      servicePath: "apps/api",
      prismaSchema: "apps/api/src/prisma/schema.prisma",
    });

    expect(runner.count(migratorTag("5.6.0"), "migrate deploy")).toBe(1);
    const migrate = runner.lines().find((line) => line.includes("migrate deploy"));
    expect(migrate).toContain("--schema"); // prisma 5 → modo clásico
  });

  it("Prisma 7 (o config junto al paquete del schema) activa el modo config-era", async () => {
    const dir = seedWorktree({
      "packages/database/prisma/schema.prisma": "datasource db {}\n",
      "packages/database/prisma.config.ts": "export default {};\n",
      "package.json": JSON.stringify({ devDependencies: { prisma: "6" } }),
    });
    const { responder } = pgResponder(dir);
    const runner = new FakeRunner(compose(gitCachedWorktree(FULL_SHA), responder));

    await makeExecutor(runner).startEphemeralPostgres({
      label: "S0",
      migrationsUpToSha: FULL_SHA,
      prismaSchema: "packages/database/prisma/schema.prisma",
    });

    const migrate = runner.lines().find((line) => line.includes("migrate deploy"));
    expect(migrate).not.toContain("--schema");
    expect(migrate).toContain("CLOUDPROOF_PRISMA_SCHEMA=/repo/packages/database/prisma/schema.prisma");
    expect(migrate).toContain("CLOUDPROOF_PRISMA_MIGRATIONS=/repo/packages/database/prisma/migrations");
  });

  it("falla explícitamente si el commit no tiene schema Prisma, sin correr migraciones", async () => {
    const dir = seedWorktree({ "README.md": "sin prisma" });
    const { responder } = pgResponder(dir);
    const runner = new FakeRunner(compose(gitCachedWorktree(FULL_SHA), responder));

    await expect(
      makeExecutor(runner).startEphemeralPostgres({ label: "S1", migrationsUpToSha: FULL_SHA }),
    ).rejects.toThrow(/schema/i);
    expect(runner.count("migrate deploy")).toBe(0);
  });

  it("clona el estado lógico de S0 antes de aplicar las migraciones de S1", async () => {
    seedWorktree({ "prisma/schema.prisma": "datasource db {}\n" });
    const { responder } = pgResponder(join(worktreesDir, SHA12));
    const runner = new FakeRunner(compose(gitCachedWorktree(FULL_SHA), responder));

    await makeExecutor(runner).startEphemeralPostgres({
      label: "S1",
      migrationsUpToSha: FULL_SHA,
      cloneFromContainerId: "source-s0",
    });

    expect(runner.count("exec source-s0 pg_dump", "--no-owner", "--no-privileges")).toBe(1);
    expect(runner.count("cp source-s0:")).toBe(1);
    expect(runner.count("cp", "pgcid:/tmp/cloudproof-s0-")).toBe(1);
    expect(runner.count("exec pgcid psql", "-f /tmp/cloudproof-s0-")).toBe(1);
    const restoreIndex = runner.lines().findIndex((line) => line.includes("-f /tmp/cloudproof-s0-"));
    const migrateIndex = runner.lines().findIndex(
      (line) => line.includes(migratorTag("latest")) && line.includes("migrate deploy"),
    );
    expect(restoreIndex).toBeGreaterThan(-1);
    expect(migrateIndex).toBeGreaterThan(restoreIndex);
  });
});

describe("evidencia SQL y artefactos", () => {
  it("parsea contadores de pg_stat_user_tables de forma determinista", async () => {
    const runner = new FakeRunner((command, args) => {
      if (command === "docker" && args.join(" ").includes("pg_stat_user_tables")) {
        return { stdout: "public.orders\t3\t1\t0\npublic.users\t0\t0\t2\n" };
      }
      return undefined;
    });

    const snapshot = await makeExecutor(runner, { statsSettleMs: 0 }).captureSqlEffects("pgcid");

    expect(snapshot).toEqual({
      tables: [
        { table: "public.orders", inserted: 3, updated: 1, deleted: 0 },
        { table: "public.users", inserted: 0, updated: 0, deleted: 2 },
      ],
    });
    expect(runner.count("pg_stat_force_next_flush")).toBe(1);
  });

  it("castea los tipos internos char al fingerprintar pg_catalog", async () => {
    let fingerprintSql = "";
    const digest = `sha256:${"a".repeat(64)}`;
    const runner = new FakeRunner((command, args) => {
      if (
        command === "docker" &&
        args[0] === "exec" &&
        args.some((argument) => argument.includes("WITH user_namespaces"))
      ) {
        fingerprintSql = args.at(-1) ?? "";
        return { stdout: `${digest}\n` };
      }
      return undefined;
    });

    const fingerprint = await makeExecutor(runner).captureSchemaFingerprint("pgcid");

    expect(fingerprint.digest).toBe(digest);
    for (const expression of [
      "c.relkind::text",
      "c.relpersistence::text",
      "c.relreplident::text",
      "a.attidentity::text",
      "a.attgenerated::text",
      "con.contype::text",
    ]) {
      expect(fingerprintSql).toContain(expression);
    }
  });
});

describe("startApp", () => {
  it("con egress bloqueado publica vía un sidecar fijo y mantiene la app solo en la red interna", async () => {
    const runner = new FakeRunner((command, args) => {
      if (command !== "docker") return undefined;
      const line = args.join(" ");
      if (args[0] === "run" && line.endsWith("cloudproof-app:x")) return { stdout: "appcid\n" };
      if (args[0] === "run" && line.includes("node:20-alpine node -e")) {
        return { stdout: "proxycid\n" };
      }
      if (args[0] === "port" && args[1] === "proxycid") {
        return { stdout: "127.0.0.1:50010\n" };
      }
      return undefined;
    });
    const executor = makeExecutor(runner, { blockEgress: true });

    const app = await executor.startApp("cloudproof-app:x", { PORT: "3000" });
    await executor.teardown(app.id);

    const targetRun = runner.lines().find((line) => line.endsWith("cloudproof-app:x"));
    expect(targetRun).toContain("--network cloudproof-net-test");
    expect(targetRun).not.toContain(" -p ");
    expect(runner.count("network create --internal", "cloudproof-net-test")).toBe(1);
    expect(runner.count("network create", "cloudproof-access-test")).toBe(1);
    expect(runner.count("--network cloudproof-access-test", "-p 127.0.0.1:0:3000")).toBe(1);
    expect(runner.count("network connect cloudproof-net-test proxycid")).toBe(1);
    expect(runner.count("rm -f proxycid")).toBe(1);
    expect(runner.count("rm -f appcid")).toBe(1);
  });

  it("prioriza env.PORT y publica solo en 127.0.0.1", async () => {
    const runner = new FakeRunner((command, args) => {
      if (command !== "docker") return undefined;
      if (args[0] === "run") return { stdout: "appcid\n" };
      if (args[0] === "port") return { stdout: "127.0.0.1:50000\n" };
      return undefined;
    });

    const app = await makeExecutor(runner).startApp("cloudproof-app:x", { PORT: "8080" });

    expect(app.connectionUrl).toBe("http://127.0.0.1:50000");
    expect(runner.count("-p 127.0.0.1:0:8080")).toBe(1);
    expect(runner.count("--env-file")).toBe(1);
    expect(runner.count("-e PORT=8080")).toBe(0);
    expect(runner.count("image inspect")).toBe(0); // no consultó EXPOSE
  });

  it("sin env.PORT usa el único EXPOSE de la imagen", async () => {
    const runner = new FakeRunner((command, args) => {
      if (command !== "docker") return undefined;
      if (args[0] === "image" && args[1] === "inspect") {
        return { stdout: '{"3000/tcp":{}}\n' };
      }
      if (args[0] === "run") return { stdout: "appcid\n" };
      if (args[0] === "port") return { stdout: "127.0.0.1:50001\n" };
      return undefined;
    });

    await makeExecutor(runner).startApp("cloudproof-app:x", {});

    expect(runner.count("-p 127.0.0.1:0:3000")).toBe(1);
  });

  it("falla con instrucción clara si la imagen no declara EXPOSE y no hay env.PORT", async () => {
    const runner = new FakeRunner((command, args) => {
      if (command === "docker" && args[0] === "image" && args[1] === "inspect") {
        return { stdout: "null\n" };
      }
      return undefined;
    });

    await expect(makeExecutor(runner).startApp("cloudproof-app:x", {})).rejects.toThrow(/env\.PORT|EXPOSE/);
  });

  it("si el contenedor muere antes del readiness, el error incluye los logs como evidencia", async () => {
    const runner = new FakeRunner((command, args) => {
      if (command !== "docker") return undefined;
      if (args[0] === "run") return { stdout: "appcid\n" };
      if (args[0] === "port") return { stdout: "127.0.0.1:50002\n" };
      if (args[0] === "inspect" && args.join(" ").includes("{{.State.Running}}")) {
        return { stdout: "false\n" };
      }
      if (args[0] === "logs") return { stderr: "Error: cannot connect to database\n" };
      return undefined;
    });
    const executor = makeExecutor(runner, { httpProbe: async () => false });

    const failure = await executor.startApp("cloudproof-app:x", { PORT: "3000" }).then(
      () => null,
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(ExecutorError);
    expect((failure as ExecutorError).evidence.join("\n")).toContain("cannot connect to database");
  });
});

describe("teardown y limpieza", () => {
  it("teardown es idempotente: 'No such container' no lanza", async () => {
    const runner = new FakeRunner((command, args) => {
      if (command === "docker" && args[0] === "rm") {
        return { exitCode: 1, stderr: "Error response from daemon: No such container: xyz" };
      }
      return undefined;
    });

    await expect(makeExecutor(runner).teardown("xyz")).resolves.toBeUndefined();
  });

  it("teardown propaga errores reales del daemon", async () => {
    const runner = new FakeRunner((command, args) => {
      if (command === "docker" && args[0] === "rm") {
        return { exitCode: 1, stderr: "Error response from daemon: conflict" };
      }
      return undefined;
    });

    await expect(makeExecutor(runner).teardown("xyz")).rejects.toThrow(ExecutorError);
  });

  it("disposeRun elimina todos los contenedores de la corrida y la red", async () => {
    const runner = new FakeRunner((command, args) => {
      if (command === "docker" && args[0] === "ps") {
        return { stdout: "id1\nid2\n" };
      }
      return undefined;
    });

    await makeExecutor(runner).disposeRun();

    expect(runner.count("ps -aq --filter label=dev.cloudproof.run=test")).toBe(1);
    expect(runner.count("rm -f id1")).toBe(1);
    expect(runner.count("rm -f id2")).toBe(1);
    expect(runner.count("network rm cloudproof-net-test")).toBe(1);
  });

  it("sweepAll barre contenedores y redes de CUALQUIER corrida por owner label", async () => {
    const runner = new FakeRunner((command, args) => {
      if (command === "docker" && args[0] === "ps") {
        return { stdout: "old1\tcloudproof-pg-old\told\n" };
      }
      if (command === "docker" && args[0] === "network" && args[1] === "ls") {
        return { stdout: "net1\tcloudproof-net-old\told\n" };
      }
      return undefined;
    });

    await ComposeExecutor.sweepAll(runner);

    expect(runner.count("ps -a --filter label=dev.cloudproof.owner=cloudproof")).toBe(1);
    expect(runner.count("rm -f old1")).toBe(1);
    expect(runner.count("network rm net1")).toBe(1);
  });
});
