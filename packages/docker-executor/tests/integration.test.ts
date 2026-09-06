import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { ComposeExecutor, SpawnRunner, waitPostgresTcpReady } from "../dist/index.js";

/**
 * Tests de integración contra Docker REAL. Gated por CLOUDPROOF_DOCKER_IT=1:
 * no corren en un `pnpm test` normal, y si el flag está activo pero el
 * daemon no responde, FALLAN ruidosamente en vez de skippear en silencio
 * (un skip silencioso con el flag puesto sería un resultado fabricado).
 *
 * El camino completo de Postgres+Prisma (descarga prisma dentro del
 * contenedor) está detrás de CLOUDPROOF_DOCKER_IT_FULL=1 porque tarda minutos
 * la primera vez.
 */
const enabled = process.env["CLOUDPROOF_DOCKER_IT"] === "1";
const fullEnabled = process.env["CLOUDPROOF_DOCKER_IT_FULL"] === "1";

if (enabled) {
  const probe = await new SpawnRunner()
    .run("docker", ["info"], { timeoutMs: 30_000 })
    .catch(() => ({ exitCode: -1, stdout: "", stderr: "docker no ejecutable" }));
  if (probe.exitCode !== 0) {
    throw new Error(
      `CLOUDPROOF_DOCKER_IT=1 pero el daemon de Docker no responde:\n${probe.stderr.slice(-500)}`,
    );
  }
}

const runner = new SpawnRunner();

describe.skipIf(!enabled)("fingerprint de schema contra PostgreSQL 16 real", () => {
  const containerName = `cloudproof-fingerprint-${randomUUID().slice(0, 8)}`;
  let containerId = "";
  let scratch = "";
  let executor: ComposeExecutor;

  beforeAll(async () => {
    scratch = mkdtempSync(join(tmpdir(), "cloudproof-fingerprint-it-"));
    const started = await runner.run(
      "docker",
      [
        "run",
        "--rm",
        "-d",
        "--name",
        containerName,
        "-e",
        "POSTGRES_USER=cloudproof",
        "-e",
        "POSTGRES_PASSWORD=cloudproof",
        "-e",
        "POSTGRES_DB=cloudproof",
        "postgres:16-alpine",
      ],
      { timeoutMs: 120_000 },
    );
    if (started.exitCode !== 0) throw new Error(started.stderr);
    containerId = started.stdout.trim();
    executor = new ComposeExecutor({ runner, repoRoot: scratch });

    // Misma sonda que el executor real: SELECT 1 por TCP, dos éxitos
    // consecutivos. pg_isready daba OK contra el postmaster temporal de
    // initdb y hacía este beforeAll intermitente.
    await waitPostgresTcpReady(runner, containerId, {
      label: "fingerprint-smoke",
      timeoutMs: 60_000,
      pollIntervalMs: 250,
    });
  }, 120_000);

  afterAll(async () => {
    if (containerId !== "") await runner.run("docker", ["rm", "-f", containerId]);
    if (scratch !== "") rmSync(scratch, { recursive: true, force: true });
  }, 30_000);

  const sql = async (statement: string): Promise<void> => {
    const result = await runner.run("docker", [
      "exec",
      containerId,
      "psql",
      "-v",
      "ON_ERROR_STOP=1",
      "-U",
      "cloudproof",
      "-d",
      "cloudproof",
      "-c",
      statement,
    ]);
    if (result.exitCode !== 0) throw new Error(result.stderr);
  };

  it("funciona en vacío, cambia con DDL e ignora INSERT", async () => {
    const empty = await executor.captureSchemaFingerprint(containerId);

    await sql("CREATE TABLE demo (id integer PRIMARY KEY, active boolean NOT NULL DEFAULT true);");
    const table = await executor.captureSchemaFingerprint(containerId);
    expect(table.digest).not.toBe(empty.digest);

    await sql("INSERT INTO demo (id) VALUES (1);");
    const row = await executor.captureSchemaFingerprint(containerId);
    expect(row.digest).toBe(table.digest);

    await sql("ALTER TABLE demo ADD COLUMN note text;");
    const column = await executor.captureSchemaFingerprint(containerId);
    expect(column.digest).not.toBe(row.digest);

    await sql("CREATE INDEX demo_active_idx ON demo (id) WHERE active;");
    const partialIndex = await executor.captureSchemaFingerprint(containerId);
    expect(partialIndex.digest).not.toBe(column.digest);
  }, 60_000);
});

async function sh(command: string, args: string[], cwd: string): Promise<string> {
  const result = await runner.run(command, args, { cwd, timeoutMs: 60_000 });
  if (result.exitCode !== 0) {
    throw new Error(`${command} ${args.join(" ")} falló:\n${result.stderr}`);
  }
  return result.stdout.trim();
}

function writeFiles(root: string, files: Record<string, string>): void {
  for (const [relPath, contents] of Object.entries(files)) {
    const absPath = join(root, relPath);
    mkdirSync(dirname(absPath), { recursive: true });
    writeFileSync(absPath, contents, "utf-8");
  }
}

async function makeThrowawayRepo(files: Record<string, string>): Promise<{ repo: string; sha: string; tmp: string }> {
  const tmp = mkdtempSync(join(tmpdir(), "cloudproof-it-"));
  const repo = join(tmp, "repo");
  mkdirSync(repo);
  writeFiles(repo, files);
  await sh("git", ["init", "-b", "main"], repo);
  await sh("git", ["config", "user.email", "it@cloudproof.local"], repo);
  await sh("git", ["config", "user.name", "cloudproof-it"], repo);
  await sh("git", ["add", "-A"], repo);
  await sh("git", ["commit", "-m", "it fixture"], repo);
  const sha = await sh("git", ["rev-parse", "HEAD"], repo);
  return { repo, sha, tmp };
}

const DOCKERFILE_TINY_APP = [
  "FROM node:20-alpine",
  "EXPOSE 3000",
  `CMD ["node","-e","require('http').createServer((q,s)=>s.end('ok')).listen(3000)"]`,
  "",
].join("\n");

describe.skipIf(!enabled)("integración 1.A con Docker real", () => {
  let tmp: string;
  let repo: string;
  let sha: string;
  let executor: ComposeExecutor;

  beforeAll(async () => {
    ({ repo, sha, tmp } = await makeThrowawayRepo({ Dockerfile: DOCKERFILE_TINY_APP }));
    executor = new ComposeExecutor({ repoRoot: repo, worktreesDir: join(tmp, "wt") });
  }, 120_000);

  afterAll(async () => {
    await executor?.disposeRun();
    await ComposeExecutor.sweepAll();
    try {
      rmSync(tmp, { recursive: true, force: true });
    } catch {
      // En Windows puede quedar un lock efímero; el dir está en tmp igualmente.
    }
  }, 120_000);

  it("build → startApp → responde HTTP → teardown, sin residuos de la corrida", async () => {
    const tag = await executor.buildImage({ sha, servicePath: "." });
    expect(tag).toMatch(/^cloudproof-app:/);

    const app = await executor.startApp(tag, {});
    expect(app.connectionUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);

    const appNetworks = await runner.run("docker", [
      "inspect",
      "-f",
      "{{json .NetworkSettings.Networks}}",
      app.id,
    ]);
    expect(Object.keys(JSON.parse(appNetworks.stdout) as Record<string, unknown>)).toEqual([
      `cloudproof-net-${executor.runId}`,
    ]);
    const internal = await runner.run("docker", [
      "network",
      "inspect",
      "-f",
      "{{.Internal}}",
      `cloudproof-net-${executor.runId}`,
    ]);
    expect(internal.stdout.trim()).toBe("true");

    const response = await fetch(app.connectionUrl ?? "");
    expect(response.ok).toBe(true);
    expect(await response.text()).toBe("ok");

    await executor.teardown(app.id);

    const leftovers = await runner.run("docker", [
      "ps",
      "-aq",
      "--filter",
      `label=dev.cloudproof.run=${executor.runId}`,
    ]);
    expect(leftovers.stdout.trim()).toBe("");
  }, 300_000);

  it("criterio PHASE_1.md: 20 corridas seguidas de start+teardown sin contenedores residuales", async () => {
    const tag = await executor.buildImage({ sha, servicePath: "." });

    for (let i = 0; i < 20; i++) {
      const app = await executor.startApp(tag, {});
      const response = await fetch(app.connectionUrl ?? "");
      expect(response.ok).toBe(true);
      await executor.teardown(app.id);
    }

    const leftovers = await runner.run("docker", [
      "ps",
      "-aq",
      "--filter",
      `label=dev.cloudproof.run=${executor.runId}`,
    ]);
    expect(leftovers.stdout.trim()).toBe("");
  }, 600_000);
});

const PRISMA_FILES: Record<string, string> = {
  Dockerfile: DOCKERFILE_TINY_APP,
  // Como cualquier repo real que usa Prisma: declara su versión. Sin esto,
  // el fallback a `prisma` latest puede cruzar un major (ej. Prisma 7
  // rechaza el formato de schema clásico) — ese fallo ruidoso es correcto
  // para un repo roto, pero el fixture debe representar un repo sano.
  "package.json": JSON.stringify({ name: "it-fixture", private: true, devDependencies: { prisma: "6" } }),
  "prisma/schema.prisma": [
    "datasource db {",
    `  provider = "postgresql"`,
    `  url      = env("DATABASE_URL")`,
    "}",
    "",
  ].join("\n"),
  "prisma/migrations/migration_lock.toml": `provider = "postgresql"\n`,
  "prisma/migrations/0001_init/migration.sql": "CREATE TABLE demo (id SERIAL PRIMARY KEY);\n",
};

describe.skipIf(!enabled || !fullEnabled)("integración 1.A: Postgres efímero + prisma migrate", () => {
  let tmp: string;
  let repo: string;
  let sha: string;
  let executor: ComposeExecutor;

  beforeAll(async () => {
    ({ repo, sha, tmp } = await makeThrowawayRepo(PRISMA_FILES));
    executor = new ComposeExecutor({ repoRoot: repo, worktreesDir: join(tmp, "wt") });
  }, 120_000);

  afterAll(async () => {
    await executor?.disposeRun();
    await ComposeExecutor.sweepAll();
    try {
      rmSync(tmp, { recursive: true, force: true });
    } catch {
      // ver nota en el suite anterior
    }
  }, 120_000);

  it("levanta S0, aplica la migración real y la tabla existe", async () => {
    const pg = await executor.startEphemeralPostgres({ label: "S0", migrationsUpToSha: sha });

    expect(pg.connectionUrl).toContain(`@${pg.serviceName}:5432/`);
    expect(pg.hostConnectionUrl).toMatch(/@127\.0\.0\.1:\d+\//);

    const query = await runner.run("docker", [
      "exec",
      pg.id,
      "psql",
      "-U",
      "cloudproof",
      "-d",
      "cloudproof",
      "-c",
      "SELECT count(*) FROM demo;",
    ]);
    expect(query.exitCode).toBe(0);

    await executor.teardown(pg.id);
  }, 600_000);
});
