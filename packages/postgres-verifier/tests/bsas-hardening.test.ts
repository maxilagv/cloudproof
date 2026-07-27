import { execFileSync } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import type {
  BuildSpec,
  CommandRunner,
  DockerExecutor,
  EphemeralPostgresSpec,
  RunningContainer,
} from "@proof/docker-executor";
import { afterEach, describe, expect, it } from "vitest";
import { verifyRelease } from "../dist/index.js";

/**
 * Endurecimiento del informe Bs As Neumáticos (2026-07): bootstrap SQL de
 * identidad tras las migraciones y Dockerfile del candidato para ambos
 * lados. Harness mínimo del patrón de verify-flow: executor fake + app HTTP
 * real por celda.
 */

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
  const cwd = mkdtempSync(join(tmpdir(), "proof-bsas-"));
  repositories.push(cwd);
  git(cwd, ["init", "-q"]);
  git(cwd, ["config", "user.name", "Proof Tests"]);
  git(cwd, ["config", "user.email", "proof-tests@example.com"]);
  writeFileSync(join(cwd, "README.md"), "bsas\n", "utf-8");
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
  buildSpecs: BuildSpec[];
  postgresSpecs: EphemeralPostgresSpec[];
}

function harness(): Harness {
  const buildSpecs: BuildSpec[] = [];
  const postgresSpecs: EphemeralPostgresSpec[] = [];
  const effects = new Map<string, number>();
  const schemaByDatabase = new Map<string, string>();
  const servers = new Map<string, Server>();
  let postgresCount = 0;
  let appCount = 0;

  const executor: DockerExecutor = {
    async buildImage(spec) {
      buildSpecs.push(spec);
      return `image:${spec.sha}`;
    },
    async imageDigest(imageTag) {
      return `sha256:${imageTag}`;
    },
    async startEphemeralPostgres(spec: EphemeralPostgresSpec): Promise<RunningContainer> {
      postgresSpecs.push(spec);
      postgresCount += 1;
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
      const baseUrl = runOptions?.env?.["PROOF_BASE_URL"];
      if (baseUrl === undefined) throw new Error("missing PROOF_BASE_URL");
      const write = await fetch(`${baseUrl}/orders`, { method: "POST" });
      const read = await fetch(`${baseUrl}/orders`);
      return {
        exitCode: write.status === 201 && read.status === 200 ? 0 : 1,
        stdout: "",
        stderr: "",
      };
    },
  };
  return { executor, workload, buildSpecs, postgresSpecs };
}

describe("fixtures.bootstrapSql (identidad sin signup público)", () => {
  it("aplica el bootstrap SOLO al seed S0, lo digesta en el Bundle y no rompe VERIFIED", async () => {
    const seedSql = "INSERT INTO users (email, password_hash) VALUES ('seed@proof', '$2b$10$hash');\n";
    const { cwd, sha } = repository({ "proof.seed.sql": seedSql });
    const scenario = harness();

    const bundle = await verifyRelease(
      {
        baseSha: sha,
        headSha: sha,
        serviceName: "api",
        servicePath: ".",
        runner: "unit",
        cwd,
        bootstrapSql: "proof.seed.sql",
        workload: { command: "test-workload" },
        requiredRoutes: ["POST /orders"],
        approvals: [],
      },
      scenario.executor,
      scenario.workload,
    );

    expect(bundle.conclusion).toBe("VERIFIED");
    const bootstrap = bundle.assertions.find((item) => item.id === "postgres.bootstrap");
    const digest = createHash("sha256").update(seedSql).digest("hex");
    expect(bootstrap).toMatchObject({ result: "pass", mandatory: true, state: "A0_S0" });
    expect(bootstrap?.evidence.join("\n")).toContain(`sha256:${digest}`);
    expect(bootstrap?.evidence.join("\n")).toContain("heredan por clonación");
    expect(bundle.provenance.artifacts).toContain(`bootstrap-sql=sha256:${digest}`);

    // Exactamente UNA base recibe el bootstrap (el seed, no clonado); todos
    // los clones lo heredan sin re-aplicarlo.
    const withBootstrap = scenario.postgresSpecs.filter((spec) => spec.bootstrapSql !== undefined);
    expect(withBootstrap).toHaveLength(1);
    expect(withBootstrap[0]?.cloneFromContainerId).toBeUndefined();
    expect(withBootstrap[0]?.bootstrapSql).toContain("proof.seed.sql");
  });

  it("un bootstrap declarado pero ilegible corta ANTES de gastar Docker, con evidencia clara", async () => {
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
        bootstrapSql: "proof.seed.sql",
        workload: { command: "test-workload" },
        requiredRoutes: ["POST /orders"],
        approvals: [],
      },
      scenario.executor,
      scenario.workload,
    );

    expect(bundle.conclusion).toBe("INCONCLUSIVE");
    const bootstrap = bundle.assertions.find((item) => item.id === "postgres.bootstrap");
    expect(bootstrap?.result).not.toBe("pass");
    expect(bootstrap?.evidence.join("\n")).toContain("no existe o no puede leerse");
    expect(scenario.buildSpecs).toHaveLength(0);
    expect(scenario.postgresSpecs).toHaveLength(0);
  });
});

describe("services.<n>.dockerfileFrom = head (onboarding a Docker)", () => {
  it("A0 se construye con la receta del candidato y la procedencia queda en la evidencia", async () => {
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
        serviceDockerfileFrom: "head",
        workload: { command: "test-workload" },
        requiredRoutes: ["POST /orders"],
        approvals: [],
      },
      scenario.executor,
      scenario.workload,
    );

    expect(bundle.conclusion).toBe("VERIFIED");
    const baseBuild = scenario.buildSpecs[0];
    const candidateBuild = scenario.buildSpecs[1];
    expect(baseBuild?.dockerfileFromSha).toBe(sha);
    expect(candidateBuild?.dockerfileFromSha).toBeUndefined();

    const buildBase = bundle.assertions.find((item) => item.id === "build.base");
    expect(buildBase?.evidence.join("\n")).toContain("dockerfileFrom=head");
    expect(bundle.provenance.artifacts).toContain(`a0-dockerfile-from=${sha}`);
  });
});
