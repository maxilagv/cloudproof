import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { ComposeExecutor, SpawnRunner } from "@cloudproof/docker-executor";
import { verifyRelease } from "@cloudproof/postgres-verifier";

/**
 * E2E de la Subfase 1.C: la demo canónica de la tesis (19.5) de punta a
 * punta contra Docker REAL, sin ningún mock. Gated por CLOUDPROOF_DOCKER_IT=1
 * (mismo patrón que docker-executor): sin el flag se skipea; con el flag
 * y sin daemon, falla ruidosamente.
 *
 * Fixture: una API de pagos (node + pg) con Prisma. Tres commits:
 *   C1 (base):    payments(id, amount)
 *   C2 (rota):    + currency con backfill y NOT NULL (rompe escrituras de A0)
 *                   → la app vieja no puede escribir (SQLSTATE 23502)
 *   C3 (benigna): + ALTER TABLE payments ADD COLUMN note TEXT (nullable)
 *                   → la app vieja sigue funcionando
 *
 * Nota: el Dockerfile del fixture usa npm DENTRO del contenedor (la regla
 * de pnpm del equipo aplica al host, que acá nunca ejecuta npm).
 */
const enabled = process.env["CLOUDPROOF_DOCKER_IT"] === "1";

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
const cliEntry = fileURLToPath(new URL("../dist/index.js", import.meta.url));

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

const SERVER_MJS = `import { createServer } from "node:http";
import pg from "pg";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

const server = createServer(async (req, res) => {
  const send = (code, body) => {
    res.writeHead(code, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  try {
    if (req.method === "POST" && req.url === "/payments") {
      let raw = "";
      for await (const chunk of req) raw += chunk;
      const { amount } = JSON.parse(raw || "{}");
      const result = await pool.query(
        "INSERT INTO payments (amount) VALUES ($1) RETURNING id, amount",
        [amount ?? 1],
      );
      return send(201, { id: result.rows[0].id, amount: result.rows[0].amount, at: new Date().toISOString() });
    }
    if (req.method === "GET" && req.url === "/payments") {
      const result = await pool.query("SELECT id, amount FROM payments ORDER BY id");
      return send(200, { items: result.rows, at: new Date().toISOString() });
    }
    return send(404, { error: "not found" });
  } catch (err) {
    return send(500, { error: { code: err.code ?? "UNKNOWN", message: err.message } });
  }
});

server.listen(3000);
`;

// node:http en vez de fetch: el pool keep-alive de undici + process.exit()
// dispara un assert de libuv en Windows (src\\win\\async.c) que hace crashear
// el child — y un workload que crashea es, correctamente, baseline FAIL.
const E2E_MJS = `import { request } from "node:http";

const base = process.env.CLOUDPROOF_BASE_URL;
if (!base) {
  console.error("CLOUDPROOF_BASE_URL no está definida");
  process.exit(1);
}

function call(method, path, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, base);
    const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    const req = request(
      url,
      {
        method,
        headers: payload
          ? { "content-type": "application/json", "content-length": String(payload.length) }
          : {},
      },
      (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode ?? 0));
      },
    );
    req.on("error", reject);
    req.end(payload);
  });
}

let failures = 0;
for (let i = 0; i < 3; i++) {
  const status = await call("POST", "/payments", { amount: 10 + i });
  if (status !== 201) {
    console.error("POST /payments devolvió " + status);
    failures += 1;
  }
}
const listStatus = await call("GET", "/payments");
if (listStatus !== 200) {
  console.error("GET /payments devolvió " + listStatus);
  failures += 1;
}
process.exitCode = failures === 0 ? 0 : 1;
`;

const BASE_FILES: Record<string, string> = {
  "package.json": JSON.stringify(
    {
      name: "payments-fixture",
      private: true,
      type: "module",
      dependencies: { pg: "^8.13.0" },
      devDependencies: { prisma: "6" },
    },
    null,
    2,
  ),
  Dockerfile: [
    "FROM node:20-alpine",
    "WORKDIR /app",
    "COPY package.json ./",
    "RUN npm install --omit=dev",
    "COPY . .",
    "EXPOSE 3000",
    `CMD ["node","server.mjs"]`,
    "",
  ].join("\n"),
  "server.mjs": SERVER_MJS,
  "scripts/e2e.mjs": E2E_MJS,
  "cloudproof.config.ts": `export default {
  services: { api: { kind: "node", path: "." } },
  data: { postgres: { kind: "postgres" } },
  release: { strategy: "migration-first", rollback: "application" },
  policies: ["no-destructive-migrations"],
  workload: { command: "node", args: ["scripts/e2e.mjs"] },
  coverage: { requiredRoutes: ["POST /payments", "GET /payments"] },
  approvals: [],
};
`,
  "prisma/schema.prisma": [
    "datasource db {",
    `  provider = "postgresql"`,
    `  url      = env("DATABASE_URL")`,
    "}",
    "",
  ].join("\n"),
  "prisma/migrations/migration_lock.toml": `provider = "postgresql"\n`,
  "prisma/migrations/0001_init/migration.sql":
    "CREATE TABLE payments (id SERIAL PRIMARY KEY, amount INTEGER NOT NULL);\n",
};

describe.skipIf(!enabled)("Subfase 1.C — demo canónica end-to-end", () => {
  let tmp: string;
  let repo: string;
  let baseSha: string;
  let unsafeSha: string;
  let benignSha: string;

  beforeAll(async () => {
    tmp = mkdtempSync(join(tmpdir(), "cloudproof-e2e-"));
    repo = join(tmp, "repo");
    mkdirSync(repo);
    writeFiles(repo, BASE_FILES);

    await sh("git", ["init", "-b", "main"], repo);
    await sh("git", ["config", "user.email", "e2e@cloudproof.local"], repo);
    await sh("git", ["config", "user.name", "cloudproof-e2e"], repo);
    await sh("git", ["add", "-A"], repo);
    await sh("git", ["commit", "-m", "base: payments(id, amount)"], repo);
    baseSha = await sh("git", ["rev-parse", "HEAD"], repo);

    // Candidata ROTA: migra datos existentes, pero A0 no envía la nueva columna.
    writeFiles(repo, {
      "prisma/migrations/0002_add_currency/migration.sql":
        "ALTER TABLE payments ADD COLUMN currency TEXT;\n" +
        "UPDATE payments SET currency = 'USD';\n" +
        "ALTER TABLE payments ALTER COLUMN currency SET NOT NULL;\n",
    });
    await sh("git", ["add", "-A"], repo);
    await sh("git", ["commit", "-m", "candidate: add currency NOT NULL"], repo);
    unsafeSha = await sh("git", ["rev-parse", "HEAD"], repo);

    // Candidata BENIGNA (rama desde C1): columna nullable, no rompe nada.
    await sh("git", ["checkout", "-b", "benign", baseSha], repo);
    writeFiles(repo, {
      "prisma/migrations/0002_add_note/migration.sql":
        "ALTER TABLE payments ADD COLUMN note TEXT;\n",
    });
    await sh("git", ["add", "-A"], repo);
    await sh("git", ["commit", "-m", "candidate: add note nullable"], repo);
    benignSha = await sh("git", ["rev-parse", "HEAD"], repo);

    await sh("git", ["checkout", "main"], repo);
  }, 120_000);

  afterAll(async () => {
    await ComposeExecutor.sweepAll();
    try {
      rmSync(tmp, { recursive: true, force: true });
    } catch {
      // Lock efímero de Windows: el directorio está en tmp de todos modos.
    }
  }, 120_000);

  it("demo canónica (19.5): migración NOT NULL → CLI reporta UNSAFE con SQLSTATE 23502 y recomendación", async () => {
    const result = await runner.run(
      "node",
      [cliEntry, "release", "verify", "--base-sha", baseSha, "--head-sha", unsafeSha],
      { cwd: repo, timeoutMs: 480_000 },
    );

    const context = `stdout:\n${result.stdout}\n\nstderr:\n${result.stderr}`;
    expect(result.exitCode, context).toBe(0);
    expect(result.stdout, context).toContain("Tests normales: PASS");
    expect(result.stdout, context).toContain("Migration: APPLIED");
    expect(result.stdout, context).toContain("RELEASE CLOUDPROOF: UNSAFE");
    expect(result.stdout, context).toContain("Old application cannot write to migrated schema.");
    expect(result.stdout, context).toContain("POST /payments failed 3/3.");
    expect(result.stdout, context).toContain("SQLSTATE 23502");
    expect(result.stdout, context).toContain("Recommended:");
    expect(result.stdout, context).toContain("1. Add nullable column");
    expect(result.stdout, context).toContain(
      "Reproduce: cloudproof reproduce postgres.old-app-new-schema.post-payments",
    );
    expect(result.stdout, context).toContain("[policy] no-destructive-migrations");

    // El bundle quedó persistido para cloudproof reproduce (1.D).
    const cloudproofDir = join(repo, ".cloudproof");
    expect(existsSync(cloudproofDir)).toBe(true);
    expect(readdirSync(cloudproofDir).some((f) => f.startsWith("release-verify-"))).toBe(true);

    // Cero residuos: la CLI hizo disposeRun de su corrida.
    const leftovers = await runner.run("docker", [
      "ps",
      "-aq",
      "--filter",
      "label=dev.cloudproof.owner=cloudproof",
    ]);
    expect(leftovers.stdout.trim(), "contenedores cloudproof residuales tras la CLI").toBe("");
  }, 600_000);

  it("cambio benigno (columna nullable) → VERIFIED, sin falsos positivos por timestamps", async () => {
    const executor = new ComposeExecutor({ repoRoot: repo });
    try {
      const bundle = await verifyRelease(
        {
          baseSha,
          headSha: benignSha,
          servicePath: ".",
          runner: "e2e-benign",
          cwd: repo,
          workload: { command: "node", args: ["scripts/e2e.mjs"] },
          requiredRoutes: ["POST /payments", "GET /payments"],
        },
        executor,
      );

      expect(bundle.conclusion, JSON.stringify(bundle, null, 2)).toBe("VERIFIED");
      const routes = bundle.assertions.filter((a) => a.id.startsWith("postgres."));
      expect(routes.length).toBeGreaterThan(0);
      expect(routes.every((a) => a.result === "pass")).toBe(true);
    } finally {
      await executor.disposeRun();
    }
  }, 600_000);

  it("sin workload declarado → INCONCLUSIVE (criterio 19.4), nunca un VERIFIED fabricado", async () => {
    const executor = new ComposeExecutor({ repoRoot: repo });
    try {
      const bundle = await verifyRelease(
        {
          baseSha,
          headSha: benignSha,
          servicePath: ".",
          runner: "e2e-no-workload",
          cwd: repo,
        },
        executor,
      );

      expect(bundle.conclusion).toBe("INCONCLUSIVE");
      expect(bundle.coverage.routesObserved).toBe(0);
    } finally {
      await executor.disposeRun();
    }
  }, 300_000);
});
