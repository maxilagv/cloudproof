import { createServer, type Server } from "node:http";
import { writeFileSync } from "node:fs";
import {
  ExecutorError,
  type CommandRunner,
  type DockerExecutor,
  type EphemeralPostgresSpec,
  type RunningContainer,
} from "@proof/docker-executor";
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
  const servers = new Map<string, Server>();
  let postgresCount = 0;
  let appCount = 0;
  let unsafeConsumed = false;

  const executor: DockerExecutor = {
    async buildImage(spec) {
      events.push(`build:${spec.sha}`);
      return `image:${spec.sha}`;
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
        imageTag === "image:base" &&
        schemaByDatabase.get(databaseId) === "head";
      if (injectUnsafe) unsafeConsumed = true;
      const server = createServer((request, response) => {
        response.setHeader("content-type", "application/json");
        if (request.method === "POST" && request.url === "/register") {
          effects.set(databaseId, (effects.get(databaseId) ?? 0) + 1);
          response.statusCode = 201;
          response.end(JSON.stringify({ user: "proof" }));
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
      const baseUrl = runOptions?.env?.["PROOF_BASE_URL"];
      if (baseUrl === undefined) throw new Error("missing PROOF_BASE_URL");
      if (command === "test-fixtures") {
        events.push("fixtures");
        const register = await fetch(`${baseUrl}/register`, { method: "POST" });
        const envPath = runOptions?.env?.["PROOF_FIXTURE_ENV"];
        if (envPath === undefined) throw new Error("missing PROOF_FIXTURE_ENV");
        writeFileSync(
          envPath,
          "# token emitido por el fixture\nAUTH_TOKEN=tok123\nPROOF_BASE_URL=http://evil\nBAD NAME=x\n",
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
  return verifyRelease(
    {
      baseSha: "base",
      headSha: "head",
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
    expect(bundle.assertions.find((item) => item.id === "proof.execution-complete")?.result).toBe(
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
        reproductionContext: { kind: "rerun-proof" },
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
    expect(bundle.assertions.some((item) => item.id === "proof.execution-complete")).toBe(false);
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
        baseSha: "base",
        headSha: "head",
        serviceName: "api",
        servicePath: ".",
        runner: "unit",
        workload: { command: "test-workload" },
        requiredRoutes: ["POST /orders"],
        serviceEnv: { BETTER_AUTH_SECRET: "proof-secret", DATABASE_URL: "postgres://mal" },
        approvals: [],
      },
      scenario.executor,
      scenario.workload,
    );

    expect(captured.length).toBeGreaterThan(0);
    for (const env of captured) {
      expect(env["BETTER_AUTH_SECRET"]).toBe("proof-secret");
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

describe("fixtures.beforeAll (informe 2026-07-18, gate 2)", () => {
  it("graba el prefijo replayable, entrega el token al workload y conserva VERIFIED", async () => {
    const scenario = harness();
    const bundle = await verifyRelease(
      {
        baseSha: "base",
        headSha: "head",
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
        baseSha: "base",
        headSha: "head",
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
          "PROOF_BASE_URL=http://evil",
          "proof_fixture_env=/tmp/x",
          "NODE_OPTIONS=--require evil.js",
          "PATH=/evil",
          "=sin-nombre",
          "SIN_VALOR",
        ].join("\n"),
      ),
    ).toEqual({ AUTH_TOKEN: "tok123", SESSION: "a b c" });
  });
});
