import { execFileSync } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import {
  ExecutorError,
  type CommandRunner,
  type DockerExecutor,
  type EphemeralPostgresSpec,
  type RunningContainer,
} from "@cloudproof/docker-executor";
import { afterEach, describe, expect, it } from "vitest";
import { classifyMigrationApplyFailure, verifyRelease } from "../dist/index.js";

/**
 * Endurecimiento del informe Lubrisur 2026-07 (2ª ronda): la historia de
 * migraciones del commit BASE no se reconstruía desde cero
 * (`20260531162000_fase2_operaciones` re-creaba `quotes.active`) y la corrida
 * quedaba INCONCLUSIVE con un "Address the cause" genérico. Contramedidas:
 *  1. clasificación determinista del fallo + atribución estructural
 *     (assertion postgres.migration-history, nextAction repair-migration-history);
 *  2. data.schemaBaseline: génesis de S0 desde un dump de la base desplegada,
 *     con migrate deploy aplicando solo lo pendiente — como producción.
 */

const PRISMA_P3018_OUTPUT = [
  "Falló prisma migrate deploy (hasta base) sobre pg-1-s0 (exit 1).",
  [
    "Applying migration `20260531162000_fase2_operaciones`",
    "Error: P3018",
    "",
    "A migration failed to apply. New migrations cannot be applied before the error is recovered from.",
    "",
    "Migration name: 20260531162000_fase2_operaciones",
    "",
    "Database error code: 42701",
    "",
    "Database error:",
    'ERROR: column "active" of relation "quotes" already exists',
  ].join("\n"),
];

const openServers = new Set<Server>();
const repositories: string[] = [];

afterEach(async () => {
  await Promise.all(
    [...openServers].map(
      (server) => new Promise<void>((resolve) => server.close(() => resolve())),
    ),
  );
  openServers.clear();
  for (const dir of repositories.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8", windowsHide: true }).trim();
}

/** Repo git real y efímero: planRelease (dentro de verify) exige git. */
function repository(files: Record<string, string> = {}): { cwd: string; sha: string } {
  const cwd = mkdtempSync(join(tmpdir(), "cloudproof-lubrisur2-"));
  repositories.push(cwd);
  git(cwd, ["init", "-q"]);
  git(cwd, ["config", "user.name", "CloudProof Tests"]);
  git(cwd, ["config", "user.email", "cloudproof-tests@example.com"]);
  writeFileSync(join(cwd, "README.md"), "lubrisur2\n", "utf-8");
  for (const [name, contents] of Object.entries(files)) {
    writeFileSync(join(cwd, name), contents, "utf-8");
  }
  git(cwd, ["add", "."]);
  git(cwd, ["commit", "-q", "-m", "base"]);
  return { cwd, sha: git(cwd, ["rev-parse", "HEAD"]) };
}

interface Harness {
  executor: DockerExecutor;
  workload: CommandRunner;
  postgresSpecs: EphemeralPostgresSpec[];
}

function harness(options: { failSeedWithPrismaHistory?: boolean } = {}): Harness {
  const postgresSpecs: EphemeralPostgresSpec[] = [];
  const effects = new Map<string, number>();
  const schemaByDatabase = new Map<string, string>();
  const servers = new Map<string, Server>();
  let postgresCount = 0;
  let appCount = 0;

  const executor: DockerExecutor = {
    async buildImage(spec) {
      return `image:${spec.sha}`;
    },
    async imageDigest(imageTag) {
      return `sha256:${imageTag}`;
    },
    async startEphemeralPostgres(spec: EphemeralPostgresSpec): Promise<RunningContainer> {
      postgresSpecs.push(spec);
      postgresCount += 1;
      if (
        options.failSeedWithPrismaHistory === true &&
        spec.label === "S0" &&
        spec.cloneFromContainerId === undefined
      ) {
        throw new ExecutorError(PRISMA_P3018_OUTPUT[0] ?? "", [PRISMA_P3018_OUTPUT[1] ?? ""]);
      }
      const id = `pg-${postgresCount}-${spec.label.toLowerCase()}`;
      effects.set(
        id,
        spec.cloneFromContainerId === undefined
          ? 0
          : (effects.get(spec.cloneFromContainerId) ?? 0),
      );
      schemaByDatabase.set(id, spec.migrationsUpToSha);
      return { id, serviceName: id, connectionUrl: `db://${id}` };
    },
    async startApp(_imageTag, env): Promise<RunningContainer> {
      appCount += 1;
      const databaseId = new URL(env["DATABASE_URL"] ?? "db://missing").hostname;
      const id = `app-${appCount}-${databaseId}`;
      const server = createServer((request, response) => {
        response.setHeader("content-type", "application/json");
        if (request.method === "POST" && request.url === "/orders") {
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
      const hex = schemaByDatabase.get(containerId) === "head" ? "b".repeat(64) : "a".repeat(64);
      return { digest: `sha256:${hex}` as `sha256:${string}` };
    },
    async exportPostgres() {},
    async teardown(containerId) {
      const server = servers.get(containerId);
      if (server !== undefined) {
        await new Promise<void>((resolve) => server.close(() => resolve()));
        openServers.delete(server);
      }
    },
  };

  const workload: CommandRunner = {
    async run(_command, _args, runOptions) {
      const baseUrl = runOptions?.env?.["CLOUDPROOF_BASE_URL"];
      if (baseUrl === undefined) throw new Error("missing CLOUDPROOF_BASE_URL");
      const write = await fetch(`${baseUrl}/orders`, { method: "POST" });
      const read = await fetch(`${baseUrl}/orders`);
      return {
        exitCode: write.status === 201 && read.status === 200 ? 0 : 1,
        stdout: "",
        stderr: "",
      };
    },
  };
  return { executor, workload, postgresSpecs };
}

describe("classifyMigrationApplyFailure (determinista, sin heurísticas)", () => {
  it("extrae migración, SQLSTATE y ERROR del output real de P3018", () => {
    const failure = classifyMigrationApplyFailure(PRISMA_P3018_OUTPUT);
    expect(failure).toMatchObject({
      migrationName: "20260531162000_fase2_operaciones",
      databaseErrorCode: "42701",
      prismaCode: "P3018",
    });
    expect(failure?.databaseError).toContain('column "active" of relation "quotes" already exists');
  });

  it("clasifica P3009 (migraciones fallidas registradas) aunque no haya línea ERROR", () => {
    const failure = classifyMigrationApplyFailure([
      "Error: P3009",
      "migrate found failed migrations in the target database.",
      "The `20260101000000_init` migration started at ... failed",
    ]);
    expect(failure?.prismaCode).toBe("P3009");
    expect(failure?.migrationName).toBe("20260101000000_init");
  });

  it("NO clasifica fallos que no vienen de prisma migrate (timeout, red, Docker)", () => {
    expect(
      classifyMigrationApplyFailure(["Timeout tras 300000 ms: docker run postgres"]),
    ).toBeUndefined();
    expect(
      classifyMigrationApplyFailure(["Falló docker run de Postgres efímero (S0) (exit 125)."]),
    ).toBeUndefined();
  });
});

describe("historia de migraciones irreplayable (seed S0 del commit base)", () => {
  it("emite postgres.migration-history con atribución estructural y una única nextAction accionable", async () => {
    const { cwd, sha } = repository();
    const scenario = harness({ failSeedWithPrismaHistory: true });

    const bundle = await verifyRelease(
      {
        baseSha: sha,
        headSha: sha,
        serviceName: "api",
        servicePath: ".",
        runner: "unit",
        cwd,
        workload: { command: "test-workload" },
        requiredRoutes: ["POST /orders"],
        approvals: [],
      },
      scenario.executor,
      scenario.workload,
    );

    expect(bundle.conclusion).toBe("INCONCLUSIVE");
    const history = bundle.assertions.find((item) => item.id === "postgres.migration-history");
    expect(history).toMatchObject({ result: "skipped", mandatory: true, state: "A0_S0" });
    const evidence = history?.evidence.join("\n") ?? "";
    expect(evidence).toContain("20260531162000_fase2_operaciones");
    expect(evidence).toContain("condición preexistente");
    expect(evidence).toContain("el candidato no participa");

    expect(bundle.nextActions).toHaveLength(1);
    expect(bundle.nextActions[0]).toMatchObject({
      kind: "repair-migration-history",
      assertionId: "postgres.migration-history",
    });
    const instruction = bundle.nextActions[0]?.instruction ?? "";
    expect(instruction).toContain("NOT the cause");
    expect(instruction).toContain("schemaBaseline");
    expect(instruction).toContain("Do NOT edit already-applied migrations");
  });

  it("un fallo del seed SIN marcadores de prisma migrate conserva el flujo genérico", async () => {
    const { cwd, sha } = repository();
    const scenario = harness();
    const failing: DockerExecutor = {
      ...scenario.executor,
      async startEphemeralPostgres() {
        throw new ExecutorError("Falló docker run de Postgres efímero (S0) (exit 125).", [
          "docker: no space left on device",
        ]);
      },
    };

    const bundle = await verifyRelease(
      {
        baseSha: sha,
        headSha: sha,
        serviceName: "api",
        servicePath: ".",
        runner: "unit",
        cwd,
        workload: { command: "test-workload" },
        requiredRoutes: ["POST /orders"],
        approvals: [],
      },
      failing,
      scenario.workload,
    );

    expect(bundle.conclusion).toBe("INCONCLUSIVE");
    expect(bundle.assertions.some((item) => item.id === "postgres.migration-history")).toBe(false);
    const generic = bundle.assertions.find((item) => item.id === "postgres.baseline-schema");
    expect(generic?.result).toBe("skipped");
  });
});

describe("data.schemaBaseline (génesis de S0 desde la base desplegada)", () => {
  const validBaseline = [
    "CREATE TABLE quotes (id serial PRIMARY KEY, active boolean NOT NULL DEFAULT true);",
    "CREATE TABLE _prisma_migrations (id varchar(36) PRIMARY KEY, migration_name varchar(250) NOT NULL);",
    "INSERT INTO _prisma_migrations (id, migration_name) VALUES ('a', '20260531162000_fase2_operaciones');",
    "",
  ].join("\n");

  it("aplica el baseline SOLO al seed S0, lo digesta y deja la procedencia en el Bundle", async () => {
    const { cwd, sha } = repository({ "cloudproof.baseline.sql": validBaseline });
    const scenario = harness();

    const bundle = await verifyRelease(
      {
        baseSha: sha,
        headSha: sha,
        serviceName: "api",
        servicePath: ".",
        runner: "unit",
        cwd,
        schemaBaseline: "cloudproof.baseline.sql",
        workload: { command: "test-workload" },
        requiredRoutes: ["POST /orders"],
        approvals: [],
      },
      scenario.executor,
      scenario.workload,
    );

    expect(bundle.conclusion).toBe("VERIFIED");
    const digest = createHash("sha256").update(validBaseline).digest("hex");
    const assertion = bundle.assertions.find((item) => item.id === "postgres.schema-baseline");
    expect(assertion).toMatchObject({ result: "pass", mandatory: true, state: "A0_S0" });
    expect(assertion?.evidence.join("\n")).toContain(`sha256:${digest}`);
    expect(assertion?.evidence.join("\n")).toContain("NO se");
    expect(bundle.provenance.artifacts).toContain(`schema-baseline=sha256:${digest}`);

    const withBaseline = scenario.postgresSpecs.filter(
      (spec) => spec.schemaBaselineSql !== undefined,
    );
    expect(withBaseline).toHaveLength(1);
    expect(withBaseline[0]?.cloneFromContainerId).toBeUndefined();
    expect(withBaseline[0]?.schemaBaselineSql).toContain("cloudproof.baseline.sql");
  });

  it("rechaza un baseline sin _prisma_migrations ANTES de gastar Docker, con la receta pg_dump", async () => {
    const { cwd, sha } = repository({
      "cloudproof.baseline.sql": "CREATE TABLE quotes (id serial PRIMARY KEY);\n",
    });
    const scenario = harness();

    const bundle = await verifyRelease(
      {
        baseSha: sha,
        headSha: sha,
        serviceName: "api",
        servicePath: ".",
        runner: "unit",
        cwd,
        schemaBaseline: "cloudproof.baseline.sql",
        workload: { command: "test-workload" },
        requiredRoutes: ["POST /orders"],
        approvals: [],
      },
      scenario.executor,
      scenario.workload,
    );

    expect(bundle.conclusion).toBe("INCONCLUSIVE");
    const assertion = bundle.assertions.find((item) => item.id === "postgres.schema-baseline");
    expect(assertion?.result).not.toBe("pass");
    const evidence = assertion?.evidence.join("\n") ?? "";
    expect(evidence).toContain("_prisma_migrations");
    expect(evidence).toContain("pg_dump");
    expect(scenario.postgresSpecs).toHaveLength(0);
  });

  it("un baseline declarado pero inexistente corta ANTES de gastar Docker", async () => {
    const { cwd, sha } = repository();
    const scenario = harness();

    const bundle = await verifyRelease(
      {
        baseSha: sha,
        headSha: sha,
        serviceName: "api",
        servicePath: ".",
        runner: "unit",
        cwd,
        schemaBaseline: "cloudproof.baseline.sql",
        workload: { command: "test-workload" },
        requiredRoutes: ["POST /orders"],
        approvals: [],
      },
      scenario.executor,
      scenario.workload,
    );

    expect(bundle.conclusion).toBe("INCONCLUSIVE");
    const assertion = bundle.assertions.find((item) => item.id === "postgres.schema-baseline");
    expect(assertion?.evidence.join("\n")).toContain("no existe o no puede leerse");
    expect(scenario.postgresSpecs).toHaveLength(0);
  });
});
