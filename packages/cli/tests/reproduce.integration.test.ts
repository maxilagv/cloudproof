import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  ComposeExecutor,
  SpawnRunner,
} from "@proof/docker-executor";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runReleaseVerify } from "../src/commands/release-verify.js";
import {
  reproductionManifestPath,
  runReproduce,
  type LiveReproductionResult,
  type ReproduceDependencies,
  type ReproductionExecutorOptions,
} from "../src/commands/reproduce.js";

/**
 * Gate Docker real para 1.D: corre release verify con un workload real para
 * obtener y persistir el bundle UNSAFE; después reproduce su assertion,
 * comprueba la app por HTTP y ejecuta la limpieza dirigida por runId.
 */
const enabled = process.env["PROOF_DOCKER_IT"] === "1";
const fullEnabled = process.env["PROOF_DOCKER_IT_FULL"] === "1";
const runner = new SpawnRunner();

if (enabled) {
  const probe = await runner
    .run("docker", ["info"], { timeoutMs: 30_000 })
    .catch(() => ({ exitCode: -1, stdout: "", stderr: "docker no ejecutable" }));
  if (probe.exitCode !== 0) {
    throw new Error(
      `PROOF_DOCKER_IT=1 pero el daemon de Docker no responde:\n${probe.stderr.slice(-500)}`,
    );
  }
}

async function command(commandName: string, args: string[], cwd: string): Promise<string> {
  const result = await runner.run(commandName, args, { cwd, timeoutMs: 120_000 });
  if (result.exitCode !== 0) {
    throw new Error(`${commandName} ${args.join(" ")} falló:\n${result.stderr}`);
  }
  return result.stdout.trim();
}

function writeFiles(root: string, files: Record<string, string>): void {
  for (const [relativePath, contents] of Object.entries(files)) {
    const absolutePath = join(root, relativePath);
    mkdirSync(dirname(absolutePath), { recursive: true });
    writeFileSync(absolutePath, contents, "utf-8");
  }
}

const SERVER_JS = `
import http from "node:http";
import pg from "pg";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const server = http.createServer(async (request, response) => {
  response.setHeader("content-type", "application/json");
  if (request.method === "POST" && request.url === "/orders") {
    try {
      await pool.query("INSERT INTO orders(name) VALUES($1)", ["proof"]);
      response.statusCode = 201;
      response.end(JSON.stringify({ saved: true }));
    } catch (error) {
      response.statusCode = 500;
      response.end(JSON.stringify({ code: error.code, message: error.message }));
    }
    return;
  }
  response.end(JSON.stringify({ ok: true }));
});
for (;;) {
  try {
    await pool.query("SELECT 1");
    break;
  } catch {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}
server.listen(3000, "0.0.0.0");
`;

const WORKLOAD_JS = `
const baseUrl = process.env.PROOF_BASE_URL;
if (!baseUrl) {
  console.error("PROOF_BASE_URL no está definida");
  process.exit(1);
}
for (let index = 0; index < 3; index++) {
  const response = await fetch(baseUrl + "/orders", { method: "POST" });
  if (response.status !== 201) {
    console.error("POST /orders devolvió " + response.status);
    process.exit(1);
  }
}
`;

const DOCKERFILE = `
FROM node:20-alpine
WORKDIR /app
COPY package.json server.js ./
RUN npm install --omit=dev
EXPOSE 3000
CMD ["node", "server.js"]
`;

const BASE_SCHEMA = `
datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

model Order {
  id   Int    @id @default(autoincrement())
  name String
  @@map("orders")
}
`;

const HEAD_SCHEMA = `
datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

model Order {
  id       Int    @id @default(autoincrement())
  name     String
  currency String
  @@map("orders")
}
`;

interface Fixture {
  root: string;
  repo: string;
  baseSha: string;
  headSha: string;
}

async function createFixture(): Promise<Fixture> {
  const root = mkdtempSync(join(tmpdir(), "proof-reproduce-docker-"));
  const repo = join(root, "repo");
  mkdirSync(repo);
  writeFiles(repo, {
    Dockerfile: DOCKERFILE,
    "server.js": SERVER_JS,
    "scripts/workload.mjs": WORKLOAD_JS,
    "package.json": JSON.stringify({
      name: "proof-reproduce-fixture",
      private: true,
      type: "module",
      dependencies: { pg: "8.16.3" },
      devDependencies: { prisma: "6.19.0" },
    }),
    "proof.config.ts": `export default {
  services: { api: { kind: "node", path: "." } },
  data: { main: { kind: "postgres", version: 16 } },
  flows: [],
  release: { strategy: "migration-first", rollback: "application" },
  policies: [],
  workload: { command: "node", args: ["scripts/workload.mjs"] },
  coverage: { requiredRoutes: ["POST /orders"] },
  approvals: [],
};\n`,
    "prisma/schema.prisma": BASE_SCHEMA,
    "prisma/migrations/migration_lock.toml": 'provider = "postgresql"\n',
    "prisma/migrations/0001_init/migration.sql":
      "CREATE TABLE orders (id SERIAL PRIMARY KEY, name TEXT NOT NULL);\n",
  });

  await command("git", ["init", "-b", "main"], repo);
  await command("git", ["config", "user.email", "reproduce-it@proof.local"], repo);
  await command("git", ["config", "user.name", "proof-reproduce-it"], repo);
  await command("git", ["add", "-A"], repo);
  await command("git", ["commit", "-m", "base app and schema"], repo);
  const baseSha = await command("git", ["rev-parse", "HEAD"], repo);

  writeFiles(repo, {
    "prisma/schema.prisma": HEAD_SCHEMA,
    "prisma/migrations/0002_currency/migration.sql":
      "ALTER TABLE orders ADD COLUMN currency TEXT;\n" +
      "UPDATE orders SET currency = 'USD';\n" +
      "ALTER TABLE orders ALTER COLUMN currency SET NOT NULL;\n",
  });
  await command("git", ["add", "-A"], repo);
  await command("git", ["commit", "-m", "require order currency"], repo);
  const headSha = await command("git", ["rev-parse", "HEAD"], repo);
  return { root, repo, baseSha, headSha };
}

describe.skipIf(!enabled || !fullEnabled)("proof reproduce con Docker real", () => {
  let fixture: Fixture;
  let reproduction: LiveReproductionResult | undefined;
  let reproductionFactory:
    | ((options: ReproductionExecutorOptions) => ComposeExecutor)
    | undefined;

  beforeAll(async () => {
    fixture = await createFixture();
  }, 120_000);

  afterAll(async () => {
    if (reproduction !== undefined && reproductionFactory !== undefined) {
      await reproductionFactory({ repoRoot: fixture.repo, runId: reproduction.runId }).disposeRun();
    }
    try {
      rmSync(fixture.root, { recursive: true, force: true });
    } catch {
      // Los worktrees viven en tmp; un lock efímero de Windows no deja Docker residual.
    }
  }, 180_000);

  it("reconstruye el finding real, deja la app accesible y cleanup deja cero contenedores", async () => {
    const verifiedBundle = await runReleaseVerify({
      cwd: fixture.repo,
      baseSha: fixture.baseSha,
      headSha: fixture.headSha,
    });
    expect(verifiedBundle.conclusion).toBe("UNSAFE");
    const failedAssertion = verifiedBundle.assertions.find(
      (assertion) => assertion.result === "fail" && assertion.id !== "workload.baseline",
    );
    expect(failedAssertion?.evidence.join("\n")).toContain("SQLSTATE 23502");
    const assertionId = failedAssertion?.id;
    if (assertionId === undefined) {
      throw new Error("release verify no produjo la assertion fallida esperada");
    }

    reproductionFactory = (options) =>
      new ComposeExecutor({
        repoRoot: options.repoRoot,
        ...(options.runId === undefined ? {} : { runId: options.runId }),
        worktreesDir: join(fixture.root, "reproduce-worktrees"),
      });
    const overrides: Partial<ReproduceDependencies> = {
      createExecutor: reproductionFactory,
      writeOutput() {},
    };
    const result = await runReproduce(assertionId, { cwd: fixture.repo }, overrides);
    expect(result.kind).toBe("started");
    reproduction = result as LiveReproductionResult;

    const reproducedResponse = await fetch(reproduction.appUrl + "/orders", { method: "POST" });
    const reproducedBody = (await reproducedResponse.json()) as { code?: string };
    expect(reproducedResponse.status).toBe(500);
    expect(reproducedBody.code).toBe("23502");

    // El artefacto no es decorativo: Compose debe poder restaurar el snapshot
    // y exponer app/Postgres mediante su proxy sin quitar el internal network.
    let artifactStarted = false;
    try {
      await command(
        "docker",
        ["compose", "-f", reproduction.composePath, "config", "--quiet"],
        fixture.repo,
      );
      artifactStarted = true;
      await command(
        "docker",
        ["compose", "-f", reproduction.composePath, "up", "-d", "--wait"],
        fixture.repo,
      );
      const published = await command(
        "docker",
        ["compose", "-f", reproduction.composePath, "port", "proxy", "3000"],
        fixture.repo,
      );
      const artifactUrl = `http://127.0.0.1:${published.slice(published.lastIndexOf(":") + 1)}`;
      let artifactResponse: Response | undefined;
      const deadline = Date.now() + 30_000;
      while (Date.now() < deadline) {
        try {
          artifactResponse = await fetch(artifactUrl + "/orders", { method: "POST" });
          break;
        } catch {
          await new Promise((resolve) => setTimeout(resolve, 500));
        }
      }
      expect(artifactResponse?.status).toBe(500);
      expect((await artifactResponse?.json()) as { code?: string }).toMatchObject({ code: "23502" });
    } finally {
      if (artifactStarted) {
        await command(
          "docker",
          ["compose", "-f", reproduction.composePath, "down", "-v", "--remove-orphans"],
          fixture.repo,
        );
      }
    }

    const running = await runner.run("docker", [
      "ps",
      "-aq",
      "--filter",
      `label=dev.proof.run=${reproduction.runId}`,
    ]);
    expect(running.stdout.trim()).not.toBe("");

    await runReproduce(assertionId, { cwd: fixture.repo, cleanup: true }, overrides);
    expect(existsSync(reproductionManifestPath(assertionId, fixture.repo))).toBe(false);

    const leftovers = await runner.run("docker", [
      "ps",
      "-aq",
      "--filter",
      `label=dev.proof.run=${reproduction.runId}`,
    ]);
    expect(leftovers.stdout.trim()).toBe("");
    const leftoverNetworks = await runner.run("docker", [
      "network",
      "ls",
      "-q",
      "--filter",
      `label=dev.proof.run=${reproduction.runId}`,
    ]);
    expect(leftoverNetworks.stdout.trim()).toBe("");
    reproduction = undefined;
  }, 900_000);
});
