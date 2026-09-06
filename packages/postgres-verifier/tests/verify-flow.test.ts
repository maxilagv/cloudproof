import { execFileSync } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ExecutorError,
  type CommandRunner,
  type DockerExecutor,
  type EphemeralPostgresSpec,
  type RunningContainer,
} from "@cloudproof/docker-executor";
import { afterEach, describe, expect, it } from "vitest";
import {
  parseFixtureEnvironment,
  verifyRelease,
  type VerifyApproval,
} from "../dist/index.js";

interface Harness {
  executor: DockerExecutor;
  workload: CommandRunner;
  events: string[];
}

const openServers = new Set<Server>();

afterEach(async () => {
  await Promise.all(
    [...openServers].map(
      (server) =>
        new Promise<void>((resolve) => server.close(() => resolve())),
    ),
  );
  openServers.clear();
});

function harness(
  options: {
    unsafeReplay?: boolean;
    failPopulatedMigration?: boolean;
    failFingerprint?: boolean;
  } = {},
): Harness {
  const events: string[] = [];
  const effects = new Map<string, number>();
  const schemaByDatabase = new Map<string, string>();
  const schemaLabelByDatabase = new Map<string, "S0" | "S1">();
  const servers = new Map<string, Server>();
  let postgresCount = 0;
  let appCount = 0;
  let unsafeConsumed = false;
  let baseImage: string | undefined;

  const executor: DockerExecutor = {
    async buildImage(spec) {
      events.push(`build:${spec.sha}`);
      const image = `image:${spec.sha}`;
      baseImage ??= image;
      return image;
    },
    async imageDigest(imageTag) {
      return `sha256:${imageTag}`;
    },
    async startEphemeralPostgres(spec: EphemeralPostgresSpec): Promise<RunningContainer> {
      postgresCount += 1;
      const id = `pg-${postgresCount}-${spec.label.toLowerCase()}`;
      events.push(`postgres:${id}:clone=${spec.cloneFromContainerId ?? "none"}`);
      if (options.failPopulatedMigration === true && spec.label === "S1" && postgresCount === 5) {
        throw new Error("migration rejected populated rows");
      }
      effects.set(
        id,
        spec.cloneFromContainerId === undefined
          ? 0
          : (effects.get(spec.cloneFromContainerId) ?? 0),
      );
      schemaByDatabase.set(id, spec.migrationsUpToSha);
      schemaLabelByDatabase.set(id, spec.label);
      return { id, serviceName: id, connectionUrl: `db://${id}` };
    },
    async startApp(imageTag, env): Promise<RunningContainer> {
      appCount += 1;
      const databaseId = new URL(env["DATABASE_URL"] ?? "db://missing").hostname;
      const id = `app-${appCount}-${databaseId}`;
      events.push(`app:${databaseId}`);
      const injectUnsafe =
        options.unsafeReplay === true &&
        !unsafeConsumed &&
        imageTag === baseImage &&
        schemaLabelByDatabase.get(databaseId) === "S1";
      if (injectUnsafe) unsafeConsumed = true;
      const server = createServer((request, response) => {
        response.setHeader("content-type", "application/json");
        if (request.method === "POST" && request.url === "/register") {
          effects.set(databaseId, (effects.get(databaseId) ?? 0) + 1);
          response.statusCode = 201;
          response.end(JSON.stringify({ user: "cloudproof" }));
          return;
        }
        if (request.method === "POST" && request.url === "/orders") {
          if (injectUnsafe) {
            response.statusCode = 500;
            response.end(JSON.stringify({ code: "23502", message: "currency cannot be null" }));
            return;
          }
          effects.set(databaseId, (effects.get(databaseId) ?? 0) + 1);
          response.statusCode = 201;
          response.end(JSON.stringify({ saved: true }));
          return;
        }
        if (request.method === "GET" && request.url === "/orders") {
          response.statusCode = 200;
          response.end(JSON.stringify({ saved: true }));
          return;
        }
        response.statusCode = 404;
        response.end(JSON.stringify({ error: "not found" }));
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      openServers.add(server);
      servers.set(id, server);
      const address = server.address();
      if (address === null || typeof address === "string") throw new Error("missing test port");
      return {
        id,
        serviceName: id,
        connectionUrl: `http://127.0.0.1:${address.port}`,
        containerPort: 3000,
      };
    },
    async captureSqlEffects(containerId) {
      events.push(`effects:${containerId}:${effects.get(containerId) ?? 0}`);
      return {
        tables: [
          {
            table: "public.orders",
            inserted: effects.get(containerId) ?? 0,
            updated: 0,
            deleted: 0,
          },
        ],
      };
    },
    async captureSchemaFingerprint(containerId) {
      if (options.failFingerprint === true) {
        throw new ExecutorError("Falló fingerprint de schema PostgreSQL.", [
          'ERROR: operator is not unique: text || "char"',
        ]);
      }
      const schema = schemaByDatabase.get(containerId) ?? "unknown";
      const hex = schema === "head" ? "b".repeat(64) : "a".repeat(64);
      return { digest: `sha256:${hex}` as `sha256:${string}` };
    },
    async exportPostgres() {},
    async teardown(containerId) {
      const server = servers.get(containerId);
      if (server !== undefined) {
        await new Promise<void>((resolve) => server.close(() => resolve()));
        openServers.delete(server);
      }
      events.push(`teardown:${containerId}`);
    },
  };

  const workload: CommandRunner = {
    async run(command, _args, runOptions) {
      const baseUrl = runOptions?.env?.["CLOUDPROOF_BASE_URL"];
      if (baseUrl === undefined) throw new Error("missing CLOUDPROOF_BASE_URL");
      if (command === "test-fixtures") {
        events.push("fixtures");
        const register = await fetch(`${baseUrl}/register`, { method: "POST" });
        const envPath = runOptions?.env?.["CLOUDPROOF_FIXTURE_ENV"];
        if (envPath === undefined) throw new Error("missing CLOUDPROOF_FIXTURE_ENV");
        writeFileSync(
          envPath,
          "# token emitido por el fixture\nAUTH_TOKEN=tok123\nCLOUDPROOF_BASE_URL=http://evil\nBAD NAME=x\n",
          "utf-8",
        );
        return { exitCode: register.status === 201 ? 0 : 1, stdout: "", stderr: "" };
      }
      if (command === "test-fixtures-broken") {
        events.push("fixtures");
        return { exitCode: 1, stdout: "", stderr: "no pude crear el usuario semilla" };
      }
      const token = runOptions?.env?.["AUTH_TOKEN"];
      events.push(token === undefined ? "workload" : `workload:token=${token}`);
      const write = await fetch(`${baseUrl}/orders`, { method: "POST" });
      const read = await fetch(`${baseUrl}/orders`);
      return {
        exitCode: write.status === 201 && read.status === 200 ? 0 : 1,
        stdout: "",
        stderr: "",
      };
    },
  };
  return { executor, workload, events };
}

async function run(
  scenario: Harness,
  approvals: VerifyApproval[] = [],
  requiredRoutes: string[] | null = ["POST /orders"],
) {
  const subjectSha = git(process.cwd(), ["rev-parse", "HEAD"]);
  return verifyRelease(
    {
      baseSha: subjectSha,
      headSha: subjectSha,
      serviceName: "api",
      servicePath: ".",
      runner: "unit",
      workload: { command: "test-workload" },
      ...(requiredRoutes === null ? {} : { requiredRoutes }),
      approvals,
    },
    scenario.executor,
    scenario.workload,
  );
}

describe("verifyRelease state machine", () => {
  it("prioriza el error exacto del fingerprint sobre síntomas de coverage", async () => {
    const bundle = await run(harness({ failFingerprint: true }));

    expect(bundle.conclusion).toBe("INCONCLUSIVE");
    const fingerprint = bundle.assertions.find(
      (item) => item.id === "postgres.baseline.schema-stable",
    );
    expect(fingerprint).toMatchObject({ result: "skipped", mandatory: true });
    expect(fingerprint?.evidence.join("\n")).toContain(
      'operator is not unique: text || "char"',
    );
    expect(bundle.nextActions[0]).toMatchObject({
      kind: "rerun-stage",
      assertionId: "postgres.baseline.schema-stable",
    });
    expect(bundle.nextActions[0]?.instruction).toContain(
      'operator is not unique: text || "char"',
    );
  });

  it("emite VERIFIED solo con cobertura declarada y efectos SQL equivalentes", async () => {
    const scenario = harness();
    const bundle = await run(scenario);

    expect(bundle.conclusion).toBe("VERIFIED");
    expect(bundle.coverage).toMatchObject({ source: "declared", complete: true });
    expect(bundle.assertions.find((item) => item.id === "postgres.sql-effects.matrix")?.result).toBe(
      "pass",
    );
    expect(bundle.assertions.find((item) => item.id === "cloudproof.execution-complete")?.result).toBe(
      "pass",
    );
  });

  it("convierte divergencia HTTP y de escrituras en findings reproducibles UNSAFE", async () => {
    const bundle = await run(harness({ unsafeReplay: true }));

    expect(bundle.conclusion).toBe("UNSAFE");
    const route = bundle.assertions.find(
      (item) => item.id.startsWith("postgres.old-app-new-schema.post-orders-"),
    );
    expect(route).toMatchObject({ result: "fail", state: "A0_S1" });
    expect(route?.evidence.join("\n")).toContain("SQLSTATE 23502");
    expect(route?.reproductionContext).toMatchObject({ kind: "live-state" });
    expect(bundle.assertions.find((item) => item.id === "postgres.sql-effects.matrix")?.result).toBe(
      "fail",
    );
  });

  it("prueba la migración sobre el S0 poblado y conserva el error como bundle", async () => {
    const bundle = await run(harness({ failPopulatedMigration: true }));

    expect(bundle.conclusion).toBe("UNSAFE");
    expect(bundle.assertions.find((item) => item.id === "postgres.migration-candidate")).toMatchObject(
      {
        result: "fail",
        state: "MIGRATE_S0_TO_S1",
        reproductionContext: { kind: "rerun-cloudproof" },
      },
    );
  });

  it("una etapa aprobada pero no completada sigue siendo INCONCLUSIVE", async () => {
    const bundle = await run(harness({ failPopulatedMigration: true }), [
      {
        assertionId: "postgres.migration-candidate",
        reason: "Se acepta temporalmente",
      },
    ]);

    expect(bundle.conclusion).toBe("INCONCLUSIVE");
    expect(
      bundle.assertions.find((item) => item.id === "postgres.migration-candidate")?.approval,
    ).toBeDefined();
    expect(bundle.assertions.some((item) => item.id === "cloudproof.execution-complete")).toBe(false);
  });

  it("serviceEnv llega al contenedor pero no puede pisar DATABASE_URL", async () => {
    const scenario = harness();
    const captured: Array<Record<string, string>> = [];
    const originalStartApp = scenario.executor.startApp.bind(scenario.executor);
    scenario.executor.startApp = async (imageTag, env) => {
      captured.push(env);
      return originalStartApp(imageTag, env);
    };

    await verifyRelease(
      {
        baseSha: git(process.cwd(), ["rev-parse", "HEAD"]),
        headSha: git(process.cwd(), ["rev-parse", "HEAD"]),
        serviceName: "api",
        servicePath: ".",
        runner: "unit",
        workload: { command: "test-workload" },
        requiredRoutes: ["POST /orders"],
        serviceEnv: { BETTER_AUTH_SECRET: "cloudproof-secret", DATABASE_URL: "postgres://mal" },
        approvals: [],
      },
      scenario.executor,
      scenario.workload,
    );

    expect(captured.length).toBeGreaterThan(0);
    for (const env of captured) {
      expect(env["BETTER_AUTH_SECRET"]).toBe("cloudproof-secret");
      expect(env["DATABASE_URL"]).toMatch(/^db:\/\//); // el de la corrida, no el declarado
    }
  });

  it("sin universo de rutas degrada un replay exitoso a INCONCLUSIVE", async () => {
    const bundle = await run(harness(), [], null);

    expect(bundle.conclusion).toBe("INCONCLUSIVE");
    expect(bundle.coverage).toMatchObject({ source: "unknown", complete: false });
    expect(bundle.assertions.find((item) => item.id === "coverage.routes-declared")?.result).toBe(
      "skipped",
    );
  });

  it("solo una aprobación exacta y explícita permite aceptar cada divergencia", async () => {
    const first = await run(harness({ unsafeReplay: true }));
    const approvals: VerifyApproval[] = first.assertions
      .filter((item) => item.result === "fail")
      .map((item) => ({ assertionId: item.id, reason: "Cambio coordinado con consumidores" }));
    const bundle = await run(harness({ unsafeReplay: true }), approvals);

    expect(bundle.conclusion).toBe("VERIFIED");
    expect(bundle.assertions.filter((item) => item.result === "fail").every((item) => item.approval)).toBe(
      true,
    );
  });
});

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8" }).trim();
}

/**
 * Repo git real con dos commits: "base" crea una tabla, "head" agrega una
 * migración nueva con un DROP TABLE. `planRelease` solo puede clasificar
 * DDL destructivo leyendo diffs git de verdad — a diferencia del resto de
 * este archivo, que usa los SHAs sintéticos "base"/"head" porque nunca
 * necesitó que el triage estático resolviera nada.
 */
function createDestructiveMigrationRepo(): { repoRoot: string; baseSha: string; headSha: string } {
  const repoRoot = mkdtempSync(join(tmpdir(), "cloudproof-triage-"));
  git(repoRoot, ["init", "-q"]);
  git(repoRoot, ["config", "user.email", "cloudproof-tests@example.com"]);
  git(repoRoot, ["config", "user.name", "CloudProof Tests"]);

  mkdirSync(join(repoRoot, "migrations", "0001_init"), { recursive: true });
  writeFileSync(
    join(repoRoot, "migrations", "0001_init", "migration.sql"),
    "CREATE TABLE orders (id serial primary key);\n",
    "utf-8",
  );
  git(repoRoot, ["add", "."]);
  git(repoRoot, ["commit", "-q", "-m", "base"]);
  const baseSha = git(repoRoot, ["rev-parse", "HEAD"]);

  mkdirSync(join(repoRoot, "migrations", "0002_drop"), { recursive: true });
  writeFileSync(
    join(repoRoot, "migrations", "0002_drop", "migration.sql"),
    'DROP TABLE "orders";\n',
    "utf-8",
  );
  git(repoRoot, ["add", "."]);
  git(repoRoot, ["commit", "-q", "-m", "head"]);
  const headSha = git(repoRoot, ["rev-parse", "HEAD"]);

  return { repoRoot, baseSha, headSha };
}

describe("V-2: gate estático de riesgo crítico antes de Docker (auditoría 2026-07-20)", () => {
  it("un DROP detectado por triage estático corta a UNSAFE sin construir imágenes", async () => {
    const { repoRoot, baseSha, headSha } = createDestructiveMigrationRepo();
    try {
      const scenario = harness();
      const bundle = await verifyRelease(
        {
          baseSha,
          headSha,
          serviceName: "api",
          servicePath: ".",
          runner: "unit",
          cwd: repoRoot,
          workload: { command: "test-workload" },
          requiredRoutes: ["POST /orders"],
          approvals: [],
        },
        scenario.executor,
        scenario.workload,
      );

      expect(bundle.conclusion).toBe("UNSAFE");
      const staticAssertion = bundle.assertions.find((item) =>
        item.id.startsWith("postgres.static.destructive-ddl-"),
      );
      expect(staticAssertion).toMatchObject({ result: "fail", mandatory: true });
      expect(staticAssertion?.evidence.join("\n")).toContain("DDL destructivo detectado");
      // Fail-fast: el hallazgo estático corta antes de tocar Docker.
      expect(scenario.events.some((event) => event.startsWith("build:"))).toBe(false);
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("una approval explícita sobre el hallazgo estático permite continuar la matriz", async () => {
    const { repoRoot, baseSha, headSha } = createDestructiveMigrationRepo();
    try {
      const probe = harness();
      const firstPass = await verifyRelease(
        {
          baseSha,
          headSha,
          serviceName: "api",
          servicePath: ".",
          runner: "unit",
          cwd: repoRoot,
          workload: { command: "test-workload" },
          requiredRoutes: ["POST /orders"],
          approvals: [],
        },
        probe.executor,
        probe.workload,
      );
      const staticAssertionId = firstPass.assertions.find((item) =>
        item.id.startsWith("postgres.static.destructive-ddl-"),
      )?.id;
      expect(staticAssertionId).toBeDefined();

      const scenario = harness();
      const bundle = await verifyRelease(
        {
          baseSha,
          headSha,
          serviceName: "api",
          servicePath: ".",
          runner: "unit",
          cwd: repoRoot,
          workload: { command: "test-workload" },
          requiredRoutes: ["POST /orders"],
          approvals: [
            {
              assertionId: staticAssertionId as string,
              reason: "DROP intencional, tabla ya vacía y retirada",
            },
          ],
        },
        scenario.executor,
        scenario.workload,
      );

      const approved = bundle.assertions.find((item) => item.id === staticAssertionId);
      expect(approved?.approval).toBeDefined();
      // Con la approval puesta, la matriz sí llega a construir imágenes.
      expect(scenario.events.some((event) => event.startsWith("build:"))).toBe(true);
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });
});

function createAppRouteRepo(route: string): { repoRoot: string; baseSha: string; headSha: string } {
  const repoRoot = mkdtempSync(join(tmpdir(), "cloudproof-route-"));
  git(repoRoot, ["init", "-q"]);
  git(repoRoot, ["config", "user.email", "cloudproof-tests@example.com"]);
  git(repoRoot, ["config", "user.name", "CloudProof Tests"]);
  const routeDirectory = join(repoRoot, "src", "app", ...route.split("/"));
  mkdirSync(routeDirectory, { recursive: true });
  writeFileSync(
    join(routeDirectory, "route.ts"),
    "export async function POST() { return Response.json({ version: 0 }); }\n" +
      "export async function GET() { return Response.json({ version: 0 }); }\n",
    "utf-8",
  );
  git(repoRoot, ["add", "."]);
  git(repoRoot, ["commit", "-q", "-m", "base"]);
  const baseSha = git(repoRoot, ["rev-parse", "HEAD"]);
  writeFileSync(
    join(routeDirectory, "route.ts"),
    "export async function POST() { return Response.json({ version: 1 }); }\n" +
      "export async function GET() { return Response.json({ version: 1 }); }\n",
    "utf-8",
  );
  git(repoRoot, ["add", "."]);
  git(repoRoot, ["commit", "-q", "-m", "candidate"]);
  return { repoRoot, baseSha, headSha: git(repoRoot, ["rev-parse", "HEAD"]) };
}

describe("change-aware coverage and adaptive matrix", () => {
  it("blocks VERIFIED when the changed endpoint received no traffic", async () => {
    const repo = createAppRouteRepo("api/catalogo/inline");
    try {
      const scenario = harness();
      const bundle = await verifyRelease(
        {
          baseSha: repo.baseSha,
          headSha: repo.headSha,
          serviceName: "api",
          servicePath: ".",
          runner: "unit",
          cwd: repo.repoRoot,
          workload: { command: "test-workload" },
          requiredRoutes: ["POST /orders"],
          approvals: [],
        },
        scenario.executor,
        scenario.workload,
      );

      expect(bundle.conclusion).toBe("INCONCLUSIVE");
      expect(bundle.coverage).toMatchObject({
        complete: false,
        changedRoutesDetected: 2,
        changedRoutesObserved: 0,
        changedRoutesMissing: [
          "GET /api/catalogo/inline",
          "POST /api/catalogo/inline",
        ],
        changeSource: "diff-inferred",
      });
      expect(
        bundle.assertions.find((item) => item.id.startsWith("coverage.changed-route."))?.evidence,
      ).toContain("Derivada por next-app-router desde src/app/api/catalogo/inline/route.ts.");
      expect(bundle.nextActions).toContainEqual(
        expect.objectContaining({
          kind: "exercise-route",
          subject: "POST /api/catalogo/inline",
        }),
      );
    } finally {
      rmSync(repo.repoRoot, { recursive: true, force: true });
    }
  });

  it("runs only the targeted matrix when schema and SQL did not change", async () => {
    const repo = createAppRouteRepo("orders");
    try {
      const scenario = harness();
      const bundle = await verifyRelease(
        {
          baseSha: repo.baseSha,
          headSha: repo.headSha,
          serviceName: "api",
          servicePath: ".",
          runner: "unit",
          cwd: repo.repoRoot,
          workload: { command: "test-workload" },
          requiredRoutes: ["POST /orders", "GET /orders"],
          approvals: [],
        },
        scenario.executor,
        scenario.workload,
      );

      expect(bundle.conclusion).toBe("VERIFIED");
      expect(bundle.provenance.artifacts).toContain("matrix=TARGETED_RELEASE_MATRIX");
      expect(bundle.coverage).toMatchObject({
        complete: true,
        changedRoutesDetected: 2,
        changedRoutesObserved: 2,
        changedRoutesMissing: [],
      });
      expect(scenario.events.some((event) => event.includes("-s1"))).toBe(false);
      expect(bundle.assertions.some((item) => item.state === "COEXIST_A0_A1_S1")).toBe(false);
      expect(bundle.assertions.find((item) => item.id === "cloudproof.execution-complete")?.result).toBe(
        "pass",
      );
    } finally {
      rmSync(repo.repoRoot, { recursive: true, force: true });
    }
  });
});

describe("fixtures.beforeAll (informe 2026-07-18, gate 2)", () => {
  it("graba el prefijo replayable, entrega el token al workload y conserva VERIFIED", async () => {
    const scenario = harness();
    const bundle = await verifyRelease(
      {
        baseSha: git(process.cwd(), ["rev-parse", "HEAD"]),
        headSha: git(process.cwd(), ["rev-parse", "HEAD"]),
        serviceName: "api",
        servicePath: ".",
        runner: "unit",
        workload: { command: "test-workload" },
        fixtures: { beforeAll: { command: "test-fixtures" } },
        requiredRoutes: ["POST /orders"],
        approvals: [],
      },
      scenario.executor,
      scenario.workload,
    );

    expect(bundle.conclusion).toBe("VERIFIED");
    const fixtures = bundle.assertions.find((item) => item.id === "workload.fixtures");
    expect(fixtures).toMatchObject({ result: "pass", mandatory: true, state: "A0_S0" });
    const evidence = fixtures?.evidence.join("\n") ?? "";
    expect(evidence).toContain("1 exchange(s) como prefijo replayable");
    expect(evidence).toContain("AUTH_TOKEN");
    // El VALOR del token jamás entra a la evidencia, solo el nombre.
    expect(evidence).not.toContain("tok123");
    // El workload recibió el token por el handoff, después de los fixtures.
    expect(scenario.events).toContain("workload:token=tok123");
    expect(scenario.events.indexOf("fixtures")).toBeLessThan(
      scenario.events.indexOf("workload:token=tok123"),
    );
  });

  it("un fixture roto produce INCONCLUSIVE accionable sin ejecutar el workload", async () => {
    const scenario = harness();
    const bundle = await verifyRelease(
      {
        baseSha: git(process.cwd(), ["rev-parse", "HEAD"]),
        headSha: git(process.cwd(), ["rev-parse", "HEAD"]),
        serviceName: "api",
        servicePath: ".",
        runner: "unit",
        workload: { command: "test-workload" },
        fixtures: { beforeAll: { command: "test-fixtures-broken" } },
        requiredRoutes: ["POST /orders"],
        approvals: [],
      },
      scenario.executor,
      scenario.workload,
    );

    expect(bundle.conclusion).toBe("INCONCLUSIVE");
    const fixtures = bundle.assertions.find((item) => item.id === "workload.fixtures");
    expect(fixtures).toMatchObject({ result: "skipped", mandatory: true });
    expect(fixtures?.evidence.join("\n")).toContain("no pude crear el usuario semilla");
    // El workload nunca corrió: no hay evento workload* posterior.
    expect(scenario.events.some((event) => event.startsWith("workload"))).toBe(false);
    expect(
      bundle.nextActions.some(
        (action) => action.kind === "rerun-stage" && action.assertionId === "workload.fixtures",
      ),
    ).toBe(true);
  });
});

describe("parseFixtureEnvironment", () => {
  it("acepta KEY=VALUE, ignora comentarios y descarta nombres inválidos o reservados", () => {
    expect(
      parseFixtureEnvironment(
        [
          "# comentario",
          "AUTH_TOKEN=tok123",
          "SESSION=a b c",
          "BAD NAME=x",
          "CLOUDPROOF_BASE_URL=http://evil",
          "cloudproof_fixture_env=/tmp/x",
          "NODE_OPTIONS=--require evil.js",
          "PATH=/evil",
          "=sin-nombre",
          "SIN_VALOR",
        ].join("\n"),
      ),
    ).toEqual({ AUTH_TOKEN: "tok123", SESSION: "a b c" });
  });
});
