import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { loadConfig } from "@cloudproof/config";
import { afterEach, describe, expect, it, vi } from "vitest";
import { doctorExitCode, runDoctor, trackedSecretCandidates } from "../src/commands/doctor.js";
import { runInit } from "../src/commands/init.js";

const roots: string[] = [];

function repo(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "cloudproof-init-doctor-"));
  roots.push(root);
  for (const [relativePath, contents] of Object.entries(files)) {
    const absolutePath = join(root, relativePath);
    mkdirSync(dirname(absolutePath), { recursive: true });
    writeFileSync(absolutePath, contents, "utf-8");
  }
  return root;
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("cloudproof init", () => {
  it("detecta Prisma/Postgres en monorepo y genera un config cargable sin @cloudproof/config", async () => {
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const root = repo({
      "package.json": JSON.stringify({
        private: true,
        scripts: { "test:e2e": "node scripts/e2e.mjs", test: "vitest" },
      }),
      "pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
      "apps/api/Dockerfile": "FROM node:20-alpine\n",
      "apps/api/prisma/schema.prisma":
        'datasource db {\n  provider = "postgresql"\n  url = env("DATABASE_URL")\n}\n',
      "apps/api/prisma/migrations/migration_lock.toml": 'provider = "postgresql"\n',
    });

    const result = await runInit({ cwd: root });
    const config = await loadConfig(root);

    expect(result.configWritten).toBe(true);
    expect(result.detected.map((item) => item.kind)).toEqual(
      expect.arrayContaining(["node", "postgres", "prisma"]),
    );
    expect(config.services).toEqual({ api: { kind: "node", path: "apps/api" } });
    expect(result.services).toEqual([{ name: "api", path: "apps/api", kind: "node" }]);
    expect(config.data).toEqual({ postgres: { kind: "postgres", version: 16 } });
    expect(config.workload).toEqual({
      command: "pnpm",
      args: ["run", "test:e2e"],
    });
    expect(readFileSync(join(root, "cloudproof.config.ts"), "utf-8")).not.toMatch(
      /from\s+["']@cloudproof\/config["']/,
    );
  });

  it("monorepo Turborepo: elige la app construible y asigna prismaSchema del paquete compartido (caso rallly)", async () => {
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const root = repo({
      "package.json": JSON.stringify({ private: true, workspaces: ["apps/*", "packages/*"] }),
      "pnpm-workspace.yaml": "packages:\n  - apps/*\n  - packages/*\n",
      "turbo.json": "{}",
      "apps/web/package.json": JSON.stringify({ name: "web" }),
      "apps/web/Dockerfile": "FROM node:20\nCOPY turbo.json turbo.json\n",
      "packages/database/package.json": JSON.stringify({ name: "database" }),
      "packages/database/prisma/schema.prisma":
        'datasource db {\n  provider = "postgresql"\n  url = env("DATABASE_URL")\n}\n',
      "docker-compose.yml": [
        "services:",
        "  db:",
        "    image: postgres:16",
        "  selfhosted:",
        "    build:",
        "      args:",
        "        - SELF_HOSTED=true",
        "      context: .",
        "      dockerfile: ./apps/web/Dockerfile",
        "",
      ].join("\n"),
    });

    const result = await runInit({ cwd: root });
    const config = await loadConfig(root);

    expect(result.services).toEqual([
      {
        name: "web",
        path: "apps/web",
        kind: "node",
        prismaSchema: "packages/database/prisma/schema.prisma",
        buildArgs: { SELF_HOSTED: "true" },
      },
    ]);
    expect(config.services["web"]).toMatchObject({
      path: "apps/web",
      prismaSchema: "packages/database/prisma/schema.prisma",
      buildArgs: { SELF_HOSTED: "true" },
    });
  });

  it("monorepo con prisma anidado bajo src/: el servicio es apps/api y el schema explícito (caso peppermint)", async () => {
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const root = repo({
      "package.json": JSON.stringify({ private: true, workspaces: ["apps/*"] }),
      "apps/api/package.json": JSON.stringify({ name: "api" }),
      "apps/api/Dockerfile": "FROM node:20\n",
      "apps/api/src/prisma/schema.prisma":
        'datasource db {\n  provider = "postgresql"\n  url = env("DATABASE_URL")\n}\n',
      "apps/client/package.json": JSON.stringify({ name: "client" }),
    });

    const result = await runInit({ cwd: root });

    expect(result.services).toEqual([
      {
        name: "api",
        path: "apps/api",
        kind: "node",
        prismaSchema: "apps/api/src/prisma/schema.prisma",
      },
    ]);
  });

  it("Dockerfile custom: prefiere la variante de producción sobre el match por nombre (caso inbox-zero)", async () => {
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const root = repo({
      "package.json": JSON.stringify({ private: true, workspaces: ["apps/*"] }),
      "apps/web/package.json": JSON.stringify({ name: "web" }),
      "apps/web/prisma/schema.prisma":
        'datasource db {\n  provider = "postgresql"\n  url = env("DATABASE_URL")\n}\n',
      "docker/Dockerfile.web": "FROM node:20\n",
      "docker/Dockerfile.prod": "FROM node:20\n",
      "apps/worker/package.json": JSON.stringify({ name: "worker" }),
    });

    const result = await runInit({ cwd: root });

    expect(result.services).toEqual([
      {
        name: "web",
        path: "apps/web",
        kind: "node",
        dockerfile: "docker/Dockerfile.prod",
      },
    ]);
  });

  it("Dockerfile custom: sin variante prod cae al match por nombre de servicio", async () => {
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const root = repo({
      "package.json": JSON.stringify({ private: true, workspaces: ["apps/*"] }),
      "apps/web/package.json": JSON.stringify({ name: "web" }),
      "apps/web/prisma/schema.prisma":
        'datasource db {\n  provider = "postgresql"\n  url = env("DATABASE_URL")\n}\n',
      "docker/Dockerfile.web": "FROM node:20\n",
    });

    const result = await runInit({ cwd: root });

    expect(result.services).toEqual([
      {
        name: "web",
        path: "apps/web",
        kind: "node",
        dockerfile: "docker/Dockerfile.web",
      },
    ]);
  });

  it("detecta el layout multi-archivo de Prisma (prisma/schema/) sin declarar prismaSchema", async () => {
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const root = repo({
      "package.json": JSON.stringify({ scripts: { "test:e2e": "jest" } }),
      Dockerfile: "FROM node:20\n",
      "prisma/schema/main.prisma":
        'datasource db {\n  provider = "postgresql"\n  url = env("DATABASE_URL")\n}\n',
      "prisma/schema/auth.prisma": "model User { id String @id }\n",
    });

    const result = await runInit({ cwd: root });

    expect(result.detected.map((item) => item.kind)).toEqual(
      expect.arrayContaining(["postgres", "prisma"]),
    );
    expect(result.services).toEqual([{ name: "api", path: ".", kind: "node" }]);
  });

  it("ignora outputs generados excluidos por Git al detectar servicios", async () => {
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const root = repo({
      ".gitignore": "src/generated/\n",
      "package.json": "{}",
      "prisma/schema.prisma":
        'datasource db {\n  provider = "postgresql"\n  url = env("DATABASE_URL")\n}\n',
      "src/generated/package.json": JSON.stringify({ name: "generated-prisma-client" }),
      "src/generated/Dockerfile": "FROM scratch\n",
    });
    execFileSync("git", ["init", "--quiet"], { cwd: root, windowsHide: true });

    const result = await runInit({ cwd: root });

    expect(result.services).toEqual([{ name: "api", path: ".", kind: "node" }]);
  });

  it("emite kind nextjs cuando el servicio usa Next.js", async () => {
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const root = repo({
      "package.json": JSON.stringify({ private: true, workspaces: ["apps/*"] }),
      "apps/web/package.json": JSON.stringify({
        name: "web",
        dependencies: { next: "15.0.0" },
        scripts: { build: "next build" },
      }),
      "apps/web/Dockerfile": "FROM node:20\n",
      "apps/web/prisma/schema.prisma":
        'datasource db {\n  provider = "postgresql"\n  url = env("DATABASE_URL")\n}\n',
    });

    const result = await runInit({ cwd: root });
    const config = await loadConfig(root);

    expect(result.services).toEqual([{ name: "web", path: "apps/web", kind: "nextjs" }]);
    expect(config.services["web"]?.kind).toBe("nextjs");
  });

  it("es idempotente y nunca sobrescribe configuración del usuario", async () => {
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const original = "export default { custom: true };\n";
    const root = repo({
      "package.json": "{}",
      "cloudproof.config.ts": original,
    });

    const result = await runInit({ cwd: root });

    expect(result.configWritten).toBe(false);
    expect(readFileSync(join(root, "cloudproof.config.ts"), "utf-8")).toBe(original);
  });

  it("genera AGENTS.md con la regla de verificación para agentes (tesis 8.2, I-012)", async () => {
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const root = repo({ "package.json": "{}" });

    const result = await runInit({ cwd: root });
    const agents = readFileSync(join(root, "AGENTS.md"), "utf-8");

    expect(result.agentsResult).toBe("created");
    expect(agents).toContain("<!-- cloudproof:agents:begin -->");
    expect(agents).toContain("<!-- cloudproof:agents:end -->");
    expect(agents).toContain("cloudproof release plan --base-sha");
    expect(agents).toContain("cloudproof release verify");
    expect(agents).toContain("cloudproof_release_verify");
    expect(agents).toContain("`VERIFIED`");
    expect(agents).toContain("`UNSAFE`");
    expect(agents).toContain("`INCONCLUSIVE`");
    expect(agents).toContain("remediation");
    expect(agents).toContain("nextAction");
    expect(agents).toContain("Agents must never create their own approval");
  });

  it("AGENTS.md es idempotente y re-init no duplica el bloque", async () => {
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const root = repo({ "package.json": "{}" });

    await runInit({ cwd: root });
    const first = readFileSync(join(root, "AGENTS.md"), "utf-8");
    const second = await runInit({ cwd: root });

    expect(second.agentsResult).toBe("unchanged");
    expect(readFileSync(join(root, "AGENTS.md"), "utf-8")).toBe(first);
  });

  it("preserva el contenido del usuario: agrega el bloque a un AGENTS.md existente y solo reemplaza lo gestionado", async () => {
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const userContent = "# Mis reglas\n\nUsar siempre pnpm.\n";
    const root = repo({
      "package.json": "{}",
      "AGENTS.md": userContent,
    });

    const appended = await runInit({ cwd: root });
    const afterAppend = readFileSync(join(root, "AGENTS.md"), "utf-8");

    expect(appended.agentsResult).toBe("updated");
    expect(afterAppend).toContain("Usar siempre pnpm.");
    expect(afterAppend.indexOf("<!-- cloudproof:agents:begin -->")).toBeGreaterThan(
      afterAppend.indexOf("Usar siempre pnpm."),
    );

    // Simular una edición del bloque gestionado: re-init lo restaura sin tocar el resto.
    writeFileSync(
      join(root, "AGENTS.md"),
      afterAppend.replace("cloudproof release plan --base-sha", "COMANDO EDITADO"),
      "utf-8",
    );
    const restored = await runInit({ cwd: root });
    const afterRestore = readFileSync(join(root, "AGENTS.md"), "utf-8");

    expect(restored.agentsResult).toBe("updated");
    expect(afterRestore).toContain("Usar siempre pnpm.");
    expect(afterRestore).toContain("cloudproof release plan --base-sha");
    expect(afterRestore).not.toContain("COMANDO EDITADO");
    expect(afterRestore.match(/cloudproof:agents:begin/g)).toHaveLength(1);
  });
});

describe("cloudproof doctor", () => {
  it("usa exit 1 para findings HIGH/CRITICAL y 0 para diagnósticos menores", () => {
    expect(doctorExitCode([{ severity: "HIGH", message: "falta Dockerfile" }])).toBe(1);
    expect(doctorExitCode([{ severity: "CRITICAL", message: "Docker no responde" }])).toBe(1);
    expect(doctorExitCode([{ severity: "MEDIUM", message: "coverage incompleta" }])).toBe(0);
    expect(doctorExitCode([])).toBe(0);
  });

  it("acepta un proyecto completo sin findings", async () => {
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const root = repo({
      "package.json": JSON.stringify({ engines: { node: ">=18" } }),
      Dockerfile: "FROM node:20-alpine\nRUN apk add --no-cache openssl\n",
      "prisma/schema.prisma":
        'datasource db {\n  provider = "postgresql"\n  url = env("DATABASE_URL")\n}\n',
      "cloudproof.config.ts": `export default {
  services: { api: { kind: "node", path: ".", port: 3000 } },
  data: { postgres: { kind: "postgres", version: 16 } },
  flows: [],
  release: { strategy: "migration-first", rollback: "application" },
  policies: [],
  workload: { command: "node", args: ["scripts/e2e.mjs"] },
  coverage: { requiredRoutes: ["POST /orders"] },
  approvals: [],
};\n`,
    });

    await expect(runDoctor({ cwd: root, systemChecks: false })).resolves.toEqual([]);
  });

  it("señala configuración insegura o incompleta antes de ejecutar Docker", async () => {
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const root = repo({
      "package.json": "{}",
      "cloudproof.config.ts": `export default {
  services: { api: { kind: "node", path: "missing" } },
  data: { postgres: { kind: "postgres", version: 16 } },
  flows: [],
  release: { strategy: "migration-first", rollback: "application" },
  policies: [],
  approvals: [{
    assertionId: "postgres.sql-effects",
    reason: "temporal",
    expiresAt: "2020-01-01T00:00:00.000Z"
  }],
};\n`,
    });

    const findings = await runDoctor({ cwd: root, systemChecks: false });
    const messages = findings.map((finding) => finding.message).join("\n");

    expect(messages).toContain("falta Dockerfile");
    expect(messages).toContain("No se declaró workload");
    expect(messages).toContain("No se declaró coverage.requiredRoutes");
    expect(messages).toContain("Approval expirada");
    expect(existsSync(join(root, "cloudproof.config.ts"))).toBe(true);
  });

  it("acepta services.<n>.dockerfile custom y el layout multi-archivo de Prisma", async () => {
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const root = repo({
      "package.json": "{}",
      "docker/Dockerfile.web": "FROM node:20\n",
      "prisma/schema/main.prisma":
        'datasource db {\n  provider = "postgresql"\n  url = env("DATABASE_URL")\n}\n',
      "cloudproof.config.ts": `export default {
  services: { web: { kind: "node", path: ".", dockerfile: "docker/Dockerfile.web" } },
  data: { postgres: { kind: "postgres", version: 16 } },
  flows: [],
  release: { strategy: "migration-first", rollback: "application" },
  policies: [],
  workload: { command: "node", args: ["scripts/e2e.mjs"] },
  coverage: { requiredRoutes: ["POST /orders"] },
  approvals: [],
};\n`,
    });

    await expect(runDoctor({ cwd: root, systemChecks: false })).resolves.toEqual([]);
  });

  it("cuando falta el Dockerfile sugiere candidatos con nombre custom", async () => {
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const root = repo({
      "package.json": "{}",
      "docker/Dockerfile.api": "FROM node:20\n",
      "prisma/schema.prisma":
        'datasource db {\n  provider = "postgresql"\n  url = env("DATABASE_URL")\n}\n',
      "cloudproof.config.ts": `export default {
  services: { api: { kind: "node", path: "." } },
  data: { postgres: { kind: "postgres", version: 16 } },
  flows: [],
  release: { strategy: "migration-first", rollback: "application" },
  policies: [],
  workload: { command: "node", args: ["scripts/e2e.mjs"] },
  coverage: { requiredRoutes: ["POST /orders"] },
  approvals: [],
};\n`,
    });

    const findings = await runDoctor({ cwd: root, systemChecks: false });
    const messages = findings.map((finding) => finding.message).join("\n");

    expect(messages).toContain("falta Dockerfile");
    expect(messages).toContain("docker/Dockerfile.api");
    expect(messages).toContain("services.api.dockerfile");
  });
});

describe("cloudproof doctor env relevance", () => {
  it("prioriza variables usadas por verify y resume las ajenas sin listarlas", async () => {
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const unrelated = Array.from({ length: 23 }, (_, index) => `UNRELATED_${index}=x`).join("\n");
    const root = repo({
      ".env.example": `RUNTIME_TOKEN=x\n${unrelated}\n`,
      "package.json": JSON.stringify({ engines: { node: ">=18" } }),
      Dockerfile: "FROM node:20-alpine\n",
      "src/index.ts": "export const token = process.env.RUNTIME_TOKEN;\n",
      "prisma/schema.prisma":
        'datasource db {\n  provider = "postgresql"\n  url = env("DATABASE_URL")\n}\n',
      "scripts/e2e.mjs": "fetch(process.env.CLOUDPROOF_BASE_URL + '/orders');\n",
      "cloudproof.config.ts": `export default {
  services: { api: { kind: "node", path: "." } },
  data: { postgres: { kind: "postgres", version: 16 } },
  flows: [],
  release: { strategy: "migration-first", rollback: "application" },
  policies: [],
  workload: { command: "node", args: ["scripts/e2e.mjs"] },
  coverage: { requiredRoutes: ["GET /orders"] },
  approvals: [],
};\n`,
    });

    const findings = await runDoctor({ cwd: root, systemChecks: false });
    const relevant = findings.find((finding) => finding.message.includes("lecturas sin fallback"));
    const noise = findings.find((finding) => finding.message.includes("evitar ruido"));

    expect(relevant).toMatchObject({ severity: "MEDIUM" });
    expect(relevant?.message).toContain("RUNTIME_TOKEN");
    expect(relevant?.message).not.toContain("UNRELATED_0");
    expect(noise).toMatchObject({ severity: "LOW" });
    expect(noise?.message).toContain("23 variable(s)");
    expect(noise?.message).not.toContain("UNRELATED_0");
  });
});

describe("cloudproof doctor — chequeos de infraestructura (informe 2026-07-18)", () => {
  it("trackedSecretCandidates marca .env y llaves privadas, no las plantillas", () => {
    expect(
      trackedSecretCandidates([
        ".env",
        ".env.production",
        ".env.example",
        ".env.sample",
        "config/.env.local",
        "docs/setup.md",
        "certs/server.pem",
        "certs/bundle.p12",
        ".ssh/id_rsa",
        "src/id_rsa.ts",
        "package.json",
      ]),
    ).toEqual([".env", ".env.production", "config/.env.local", "certs/server.pem", "certs/bundle.p12", ".ssh/id_rsa"]);
  });

  it("systemChecks:false no ejecuta chequeos de disco/puertos/git", async () => {
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const root = repo({
      ".env": "DATABASE_URL=postgresql://user:secret@localhost/db\n",
    });

    const findings = await runDoctor({ cwd: root, systemChecks: false });
    const messages = findings.map((finding) => finding.message).join("\n");

    expect(messages).not.toContain("GiB libres");
    expect(messages).not.toContain("credenciales versionadas");
    expect(messages).not.toContain("shallow");
  });
});
