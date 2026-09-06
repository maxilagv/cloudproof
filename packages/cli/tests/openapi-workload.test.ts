import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createServer, type Server } from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { loadConfig } from "@cloudproof/config";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  exampleFromSchema,
  findOpenApiSpec,
  planWorkloadFromOpenApi,
  renderWorkloadScript,
} from "../src/commands/openapi-workload.js";
import { runInit } from "../src/commands/init.js";

const roots: string[] = [];
const servers: Server[] = [];

function repo(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "cloudproof-openapi-"));
  roots.push(root);
  for (const [relativePath, contents] of Object.entries(files)) {
    const absolutePath = join(root, relativePath);
    mkdirSync(dirname(absolutePath), { recursive: true });
    writeFileSync(absolutePath, contents, "utf-8");
  }
  return root;
}

afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  await Promise.all(
    servers
      .splice(0)
      .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
});

/** Spec de referencia: CRUD con auth, $ref, path param, query obligatoria. */
const ORDERS_SPEC = {
  openapi: "3.1.0",
  info: { title: "orders", version: "1" },
  security: [],
  paths: {
    "/orders": {
      get: {
        parameters: [
          { name: "status", in: "query", required: true, schema: { enum: ["open"] } },
        ],
        responses: { "200": { description: "ok" } },
      },
      post: {
        security: [{ bearer: [] }],
        requestBody: {
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/NewOrder" },
            },
          },
        },
        responses: { "201": { description: "created" } },
      },
    },
    "/orders/{id}": {
      parameters: [{ name: "id", in: "path", required: true, schema: { type: "integer" } }],
      get: { responses: { "200": { description: "ok" } } },
      delete: { responses: { "204": { description: "gone" } } },
    },
    "/upload": {
      post: {
        requestBody: { content: { "multipart/form-data": { schema: { type: "object" } } } },
        responses: { "200": { description: "ok" } },
      },
    },
    "/legacy": {
      get: { deprecated: true, responses: { "200": { description: "ok" } } },
    },
  },
  components: {
    schemas: {
      NewOrder: {
        type: "object",
        required: ["customerEmail"],
        properties: {
          customerEmail: { type: "string", format: "email" },
          amount: { type: "number", minimum: 5 },
          currency: { enum: ["ARS", "USD"] },
          note: { type: "string" },
        },
      },
    },
  },
} as const;

describe("planWorkloadFromOpenApi", () => {
  it("ordena lecturas → escrituras → lecturas de cola, y deriva coverage y probes", () => {
    const plan = planWorkloadFromOpenApi("openapi.json", structuredClone(ORDERS_SPEC));

    const sequence = plan.steps.map((step) => `${step.method} ${step.path}`);
    expect(sequence).toEqual([
      "GET /orders?status=open",
      "GET /orders/1",
      "POST /orders",
      "DELETE /orders/1",
      "GET /orders?status=open",
      "GET /orders/1",
    ]);
    expect(plan.requiredRoutes).toEqual([
      "GET /orders?status=open",
      "GET /orders/1",
      "POST /orders",
      "DELETE /orders/1",
    ]);
    expect(plan.rollbackProbeRoutes).toEqual(["GET /orders?status=open", "GET /orders/1"]);

    const post = plan.steps.find((step) => step.method === "POST" && step.path === "/orders");
    expect(post?.auth).toBe(true);
    expect(post?.body).toEqual({
      customerEmail: "cloudproof-{{RUN}}@example.com",
      amount: 5,
      currency: "ARS",
      note: "cloudproof-{{RUN}}",
    });

    const gapsText = plan.gaps.join("\n");
    expect(gapsText).toContain("1 operación(es) declaran seguridad");
    expect(gapsText).toContain("fixtures.beforeAll");
    expect(gapsText).toContain("multipart/form-data no es JSON");
    // El deprecated no aparece ni como paso ni como gap.
    expect(sequence.join("\n")).not.toContain("/legacy");
  });

  it("exampleFromSchema prefiere example/default/enum del spec antes que sintetizar", () => {
    const document = { openapi: "3.1.0", paths: {} };
    expect(exampleFromSchema(document, { type: "string", example: "real" })).toBe("real");
    expect(exampleFromSchema(document, { type: "integer", default: 7 })).toBe(7);
    expect(exampleFromSchema(document, { enum: ["a", "b"] })).toBe("a");
    expect(exampleFromSchema(document, { type: "array", items: { type: "boolean" } })).toEqual([
      true,
    ]);
  });
});

describe("renderWorkloadScript — el script generado corre de verdad", () => {
  it("ejecuta el plan contra CLOUDPROOF_BASE_URL con datos únicos y Bearer del fixture", async () => {
    const plan = planWorkloadFromOpenApi("openapi.json", structuredClone(ORDERS_SPEC));
    const root = repo({ "cloudproof.workload.mjs": renderWorkloadScript(plan) });

    const seen: Array<{ method: string; url: string; auth?: string; body: string }> = [];
    const server = createServer((request, response) => {
      let body = "";
      request.on("data", (chunk: Buffer) => (body += chunk.toString()));
      request.on("end", () => {
        seen.push({
          method: request.method ?? "",
          url: request.url ?? "",
          ...(request.headers.authorization === undefined
            ? {}
            : { auth: request.headers.authorization }),
          body,
        });
        response.statusCode = 200;
        response.end("{}");
      });
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("missing port");

    // execFile async: el server vive en este proceso y una espera síncrona
    // bloquearía el event loop que debe responderle al script.
    await promisify(execFile)(process.execPath, [join(root, "cloudproof.workload.mjs")], {
      env: {
        ...process.env,
        CLOUDPROOF_BASE_URL: `http://127.0.0.1:${address.port}`,
        AUTH_TOKEN: "tok-fixture",
      },
      encoding: "utf-8",
    });

    expect(seen.map((request) => `${request.method} ${request.url}`)).toEqual([
      "GET /orders?status=open",
      "GET /orders/1",
      "POST /orders",
      "DELETE /orders/1",
      "GET /orders?status=open",
      "GET /orders/1",
    ]);
    const post = seen.find((request) => request.method === "POST");
    expect(post?.auth).toBe("Bearer tok-fixture");
    const body = JSON.parse(post?.body ?? "{}") as { customerEmail: string; note: string };
    // {{RUN}} fue reemplazado por un id de corrida real.
    expect(body.customerEmail).toMatch(/^cloudproof-[a-z0-9]+@example\.com$/);
    expect(body.note).not.toContain("{{RUN}}");
  });
});

describe("cloudproof init con OpenAPI (gate 2b, informe 2026-07-18)", () => {
  it("sin e2e propio genera cloudproof.workload.mjs y coverage real; el config carga", async () => {
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const root = repo({
      "package.json": JSON.stringify({ private: true, scripts: {} }),
      Dockerfile: "FROM node:20\n",
      "openapi.json": JSON.stringify(ORDERS_SPEC),
      "prisma/schema.prisma":
        'datasource db {\n  provider = "postgresql"\n  url = env("DATABASE_URL")\n}\n',
    });

    const result = await runInit({ cwd: root });
    expect(result.workloadGenerated).toMatchObject({
      specPath: "openapi.json",
      steps: 6,
      routes: 4,
    });

    const config = await loadConfig(root);
    expect(config.workload).toEqual({ command: "node", args: ["cloudproof.workload.mjs"] });
    expect(config.coverage?.requiredRoutes).toContain("POST /orders");
    expect(config.coverage?.rollbackProbeRoutes).toContain("GET /orders/1");
  });

  it("con e2e propio NO genera workload desde OpenAPI (la evidencia del repo gana)", async () => {
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const root = repo({
      "package.json": JSON.stringify({
        private: true,
        scripts: { "test:e2e": "node e2e.mjs" },
      }),
      "pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
      Dockerfile: "FROM node:20\n",
      "openapi.json": JSON.stringify(ORDERS_SPEC),
      "prisma/schema.prisma":
        'datasource db {\n  provider = "postgresql"\n  url = env("DATABASE_URL")\n}\n',
    });

    const result = await runInit({ cwd: root });
    expect(result.workloadGenerated).toBeUndefined();
    const config = await loadConfig(root);
    expect(config.workload).toEqual({ command: "pnpm", args: ["run", "test:e2e"] });
  });

  it("findOpenApiSpec ignora specs swagger 2.0 y archivos rotos", () => {
    const root = repo({
      "swagger.json": JSON.stringify({ swagger: "2.0", paths: {} }),
      "openapi.yaml": "esto: [no es un spec",
    });
    expect(findOpenApiSpec(root)).toBeUndefined();
  });
});
