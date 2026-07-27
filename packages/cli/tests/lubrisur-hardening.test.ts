import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { loadConfig } from "@proof/config";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runDoctor } from "../src/commands/doctor.js";
import { runInit } from "../src/commands/init.js";

/**
 * Endurecimiento derivado del informe de campo de Lubrisur (2026-07): cada
 * test reproduce un fallo real observado y fija el comportamiento nuevo.
 */

const roots: string[] = [];

function repo(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "proof-lubrisur-"));
  roots.push(root);
  for (const [relativePath, contents] of Object.entries(files)) {
    const absolutePath = join(root, relativePath);
    mkdirSync(dirname(absolutePath), { recursive: true });
    writeFileSync(absolutePath, contents, "utf-8");
  }
  return root;
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8", windowsHide: true }).trim();
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const LUBRISUR_SCHEMA = [
  "generator client {",
  '  provider = "prisma-client-js"',
  '  output   = "../src/generated/prisma"',
  "}",
  "datasource db {",
  '  provider = "postgresql"',
  '  url      = env("DATABASE_URL")',
  "}",
].join("\n");

describe("init — cliente Prisma generado (fallo 1 del informe)", () => {
  it("no convierte src/generated/prisma en un segundo servicio y reporta la exclusión", async () => {
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const root = repo({
      "package.json": JSON.stringify({ private: true, scripts: { dev: "next dev" } }),
      "prisma/schema.prisma": LUBRISUR_SCHEMA,
      // El generator con output custom copia schema.prisma y package.json:
      "src/generated/prisma/schema.prisma": LUBRISUR_SCHEMA,
      "src/generated/prisma/package.json": JSON.stringify({ name: "prisma-client" }),
      "src/generated/prisma/index.js": "module.exports = {};\n",
    });

    const result = await runInit({ cwd: root });

    // Un solo servicio (la raíz), nunca el output del generator.
    expect(result.services.map((service) => service.path)).toEqual(["."]);
    expect(result.excluded).toEqual([
      expect.objectContaining({ path: "src/generated/prisma" }),
    ]);
    // La evidencia Prisma no incluye la copia generada.
    const prisma = result.detected.find((item) => item.kind === "prisma");
    expect(prisma?.evidence).toEqual(["prisma/schema.prisma"]);
  });

  it("excluye outputs de generator aun sin nombre convencional, vía el schema", async () => {
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const schema = LUBRISUR_SCHEMA.replace("../src/generated/prisma", "../client_db/prisma");
    const root = repo({
      "package.json": "{}",
      "prisma/schema.prisma": schema,
      "client_db/prisma/schema.prisma": schema,
      "client_db/prisma/package.json": JSON.stringify({ name: "prisma-client" }),
    });

    const result = await runInit({ cwd: root });

    expect(result.services.map((service) => service.path)).toEqual(["."]);
    expect(result.excluded).toEqual([
      expect.objectContaining({
        path: "client_db/prisma",
        reason: expect.stringContaining("generator Prisma"),
      }),
    ]);
  });
});

describe("init — .gitignore de .proof/ (fallo 3 del informe)", () => {
  it("crea .gitignore con .proof/ cuando no existe y es idempotente", async () => {
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const root = repo({ "package.json": "{}" });

    const first = await runInit({ cwd: root });
    expect(first.gitignoreResult).toBe("created");
    expect(readFileSync(join(root, ".gitignore"), "utf-8")).toContain(".proof/");

    const second = await runInit({ cwd: root });
    expect(second.gitignoreResult).toBe("unchanged");
  });

  it("agrega .proof/ a un .gitignore existente sin tocar el contenido del usuario", async () => {
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const root = repo({
      "package.json": "{}",
      ".gitignore": "node_modules/\n.env\n",
    });

    const result = await runInit({ cwd: root });
    const contents = readFileSync(join(root, ".gitignore"), "utf-8");

    expect(result.gitignoreResult).toBe("updated");
    expect(contents).toContain("node_modules/");
    expect(contents).toContain(".env");
    expect(contents).toContain(".proof/");
  });
});

const OPENAPI_WITH_AUTH = JSON.stringify({
  openapi: "3.0.0",
  info: { title: "api", version: "1.0.0" },
  security: [{ bearerAuth: [] }],
  paths: {
    "/auth/register": {
      post: {
        security: [],
        requestBody: {
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  email: { type: "string", format: "email" },
                  password: { type: "string" },
                },
              },
            },
          },
        },
        responses: { "201": { description: "created" } },
      },
    },
    "/auth/login": {
      post: {
        security: [],
        requestBody: {
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  email: { type: "string", format: "email" },
                  password: { type: "string" },
                },
              },
            },
          },
        },
        responses: {
          "200": {
            description: "ok",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: { token: { type: "string" } },
                },
              },
            },
          },
        },
      },
    },
    "/orders": {
      post: {
        requestBody: {
          content: {
            "application/json": {
              schema: { type: "object", properties: { sku: { type: "string" } } },
            },
          },
        },
        responses: { "201": { description: "created" } },
      },
      get: { responses: { "200": { description: "ok" } } },
    },
  },
});

describe("init — fixtures de identidad HTTP (fallo 5 del informe)", () => {
  it("scaffoldea proof.fixtures.mjs desde la evidencia del spec y lo declara en la config", async () => {
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const root = repo({
      "package.json": "{}",
      Dockerfile: "FROM node:20\n",
      "openapi.json": OPENAPI_WITH_AUTH,
    });

    const result = await runInit({ cwd: root });
    const config = await loadConfig(root);

    expect(result.authFixturesGenerated).toMatchObject({
      loginPath: "/auth/login",
      registerPath: "/auth/register",
      tokenProperty: "token",
    });
    expect(config.fixtures?.beforeAll).toEqual({
      command: "node",
      args: ["proof.fixtures.mjs"],
    });

    const script = readFileSync(join(root, "proof.fixtures.mjs"), "utf-8");
    expect(script).toContain("PROOF_BASE_URL");
    expect(script).toContain("PROOF_FIXTURE_ENV");
    expect(script).toContain("/auth/register");
    expect(script).toContain("/auth/login");
    expect(script).toContain("AUTH_TOKEN=");
  });

  it("sin login público con token no inventa nada: reporta el gap accionable", async () => {
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const spec = JSON.parse(OPENAPI_WITH_AUTH) as {
      paths: Record<string, unknown>;
    };
    delete spec.paths["/auth/login"];
    delete spec.paths["/auth/register"];
    const root = repo({
      "package.json": "{}",
      Dockerfile: "FROM node:20\n",
      "openapi.json": JSON.stringify(spec),
    });

    const result = await runInit({ cwd: root });

    expect(result.authFixturesGenerated).toBeUndefined();
    expect(existsSync(join(root, "proof.fixtures.mjs"))).toBe(false);
    expect(
      result.workloadGenerated?.gaps.some((gap) => gap.includes("PROOF_FIXTURE_ENV")),
    ).toBe(true);
  });
});

const COMPLETE_CONFIG = `export default {
  services: { api: { kind: "node", path: ".", port: 3000 } },
  data: { postgres: { kind: "postgres", version: 16 } },
  flows: [],
  release: { strategy: "migration-first", rollback: "application" },
  policies: [],
  workload: { command: "node", args: ["scripts/e2e.mjs"] },
  coverage: { requiredRoutes: ["POST /orders"] },
  approvals: [],
};\n`;

describe("doctor — preflight de runtime de imagen (fallo 6 del informe)", () => {
  it("detecta Prisma sobre Alpine sin OpenSSL antes de tocar Docker", async () => {
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const root = repo({
      "package.json": "{}",
      Dockerfile: 'FROM node:20-alpine\nCMD ["node", "server.js"]\n',
      "prisma/schema.prisma": LUBRISUR_SCHEMA,
      "proof.config.ts": COMPLETE_CONFIG,
    });

    const findings = await runDoctor({ cwd: root, systemChecks: false });
    const openssl = findings.find((finding) => finding.message.includes("OpenSSL"));

    expect(openssl).toMatchObject({ severity: "HIGH" });
    expect(openssl?.message).toContain("apk add --no-cache openssl");
    expect(openssl?.message).toContain('Servicio "api"');
  });

  it("con OpenSSL instalado en la etapa final no reporta nada", async () => {
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const root = repo({
      "package.json": "{}",
      Dockerfile:
        'FROM node:20-alpine\nRUN apk add --no-cache openssl\nCMD ["node", "server.js"]\n',
      "prisma/schema.prisma": LUBRISUR_SCHEMA,
      "proof.config.ts": COMPLETE_CONFIG,
    });

    const findings = await runDoctor({ cwd: root, systemChecks: false });
    expect(findings.filter((finding) => finding.message.includes("OpenSSL"))).toEqual([]);
  });
});

describe("doctor — operaciones autenticadas sin fixtures (fallo 5 del informe)", () => {
  it("avisa cuando el spec exige identidad y la config no declara fixtures.beforeAll", async () => {
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const root = repo({
      "package.json": "{}",
      Dockerfile: "FROM node:20-bookworm\n",
      "prisma/schema.prisma": LUBRISUR_SCHEMA,
      "openapi.json": OPENAPI_WITH_AUTH,
      "proof.config.ts": COMPLETE_CONFIG,
    });

    const findings = await runDoctor({ cwd: root, systemChecks: false });
    const fixtures = findings.find((finding) => finding.message.includes("fixtures.beforeAll"));

    expect(fixtures).toMatchObject({ severity: "MEDIUM" });
  });
});

describe("doctor — .proof/ frente a Git (fallo 3 del informe)", () => {
  it("evidencia versionada es HIGH; no ignorada es LOW; ignorada no reporta", async () => {
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const root = repo({
      "package.json": "{}",
      ".proof/release-verify-x.json": "{}",
    });
    git(root, ["init", "-q"]);
    git(root, ["config", "user.name", "Proof Tests"]);
    git(root, ["config", "user.email", "proof-tests@example.com"]);

    // No ignorada, sin trackear: LOW.
    const before = await runDoctor({ cwd: root, systemChecks: false });
    expect(
      before.find((finding) => finding.message.includes(".proof/")),
    ).toMatchObject({ severity: "LOW" });

    // Versionada: HIGH con el fix concreto.
    git(root, ["add", ".proof"]);
    git(root, ["commit", "-q", "-m", "oops"]);
    const tracked = await runDoctor({ cwd: root, systemChecks: false });
    const worst = tracked.find((finding) => finding.message.includes("git rm -r --cached"));
    expect(worst).toMatchObject({ severity: "HIGH" });

    // Corregida (init agrega .proof/ a .gitignore y se destrackea): silencio.
    git(root, ["rm", "-r", "-q", "--cached", ".proof"]);
    writeFileSync(join(root, ".gitignore"), ".proof/\n", "utf-8");
    git(root, ["add", ".gitignore"]);
    git(root, ["commit", "-q", "-m", "ignore proof"]);
    const after = await runDoctor({ cwd: root, systemChecks: false });
    expect(after.filter((finding) => finding.message.includes(".proof/"))).toEqual([]);
  });
});
