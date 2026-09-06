import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import {
  createServer,
  request as requestHttp,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { Recorder, Replayer } from "../src/index.js";

type TestHandler = (request: IncomingMessage, response: ServerResponse) => void | Promise<void>;

const openServers = new Set<Server>();
const openRecorders = new Set<Recorder>();

async function startApp(handler: TestHandler): Promise<{ server: Server; url: string }> {
  const server = createServer((request, response) => {
    Promise.resolve(handler(request, response)).catch((error: unknown) => {
      response.statusCode = 500;
      response.end(error instanceof Error ? error.message : String(error));
    });
  });
  openServers.add(server);

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address() as AddressInfo;
  return { server, url: "http://127.0.0.1:" + address.port };
}

async function closeServer(server: Server): Promise<void> {
  openServers.delete(server);
  if (!server.listening) {
    return;
  }
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)));
    server.closeAllConnections();
  });
}

async function requestBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

async function getThroughForwardProxy(proxyUrl: string, targetUrl: string): Promise<number> {
  const proxy = new URL(proxyUrl);
  const target = new URL(targetUrl);
  return new Promise((resolve, reject) => {
    const request = requestHttp(
      {
        hostname: proxy.hostname,
        port: proxy.port,
        method: "GET",
        path: target.toString(),
        headers: { host: target.host },
      },
      (response) => {
        response.resume();
        response.once("end", () => resolve(response.statusCode ?? 0));
      },
    );
    request.once("error", reject);
    request.end();
  });
}

function track(recorder: Recorder): Recorder {
  openRecorders.add(recorder);
  return recorder;
}

function stop(recorder: Recorder) {
  const exchanges = recorder.stop();
  openRecorders.delete(recorder);
  return exchanges;
}

afterEach(async () => {
  for (const recorder of openRecorders) {
    try {
      recorder.stop();
    } catch {
      // A failed test may leave a recorder starting or with an active request.
    }
  }
  openRecorders.clear();
  await Promise.all([...openServers].map(closeServer));
});

describe("Recorder and Replayer", () => {
  it("records a real HTTP workload and replays 100% of it against the unchanged app", async () => {
    const app = await startApp(async (request, response) => {
      if (request.method === "POST" && request.url === "/items?include=meta") {
        const input = JSON.parse((await requestBody(request)).toString("utf8")) as unknown;
        json(response, 201, {
          id: randomUUID(),
          createdAt: new Date().toISOString(),
          input,
        });
        return;
      }
      if (request.method === "GET" && request.url === "/health") {
        json(response, 200, { ok: true });
        return;
      }
      json(response, 404, { error: "not found" });
    });
    const recorder = track(new Recorder({ targetUrl: app.url }));
    const proxyUrl = await recorder.start();

    const createResponse = await fetch(proxyUrl + "/items?include=meta", {
      method: "POST",
      headers: { "content-type": "application/json", "x-test-case": "create-item" },
      body: JSON.stringify({ name: "cloudproof" }),
    });
    expect(createResponse.status).toBe(201);
    expect(await createResponse.json()).toMatchObject({ input: { name: "cloudproof" } });
    expect((await fetch(proxyUrl + "/health")).status).toBe(200);

    const exchanges = stop(recorder);
    expect(exchanges).toHaveLength(2);
    expect(exchanges[0]?.request).toMatchObject({
      method: "POST",
      path: "/items?include=meta",
      body: { name: "cloudproof" },
    });

    const results = await new Replayer().replay(exchanges, app.url);
    expect(results).toHaveLength(2);
    expect(results.every((result) => result.matches)).toBe(true);
  });

  it("supports absolute-form HTTP forward-proxy requests without a configured target", async () => {
    const app = await startApp((_request, response) => {
      json(response, 200, { mode: "forward-proxy" });
    });
    const recorder = track(new Recorder());
    const proxyUrl = await recorder.start();

    expect(await getThroughForwardProxy(proxyUrl, app.url + "/forward?ok=1")).toBe(200);
    const exchanges = stop(recorder);

    expect(exchanges[0]?.request.path).toBe("/forward?ok=1");
    const [result] = await new Replayer().replay(exchanges, app.url);
    expect(result?.matches).toBe(true);
  });

  it("reports a body change in the candidate response", async () => {
    let version = "baseline";
    const app = await startApp((_request, response) => {
      json(response, 200, { version });
    });
    const recorder = track(new Recorder({ targetUrl: app.url }));
    const proxyUrl = await recorder.start();
    await fetch(proxyUrl + "/version");
    const exchanges = stop(recorder);

    version = "candidate";
    const [result] = await new Replayer().replay(exchanges, app.url);

    expect(result?.matches).toBe(false);
    expect(result?.candidateResponse.body).toEqual({ version: "candidate" });
  });

  it("turns an unavailable candidate into mismatch evidence instead of throwing", async () => {
    const app = await startApp((_request, response) => {
      json(response, 200, { ok: true });
    });
    const recorder = track(new Recorder({ targetUrl: app.url }));
    const proxyUrl = await recorder.start();
    await fetch(proxyUrl + "/health");
    const exchanges = stop(recorder);
    await closeServer(app.server);

    const [result] = await new Replayer({ timeoutMs: 250 }).replay(exchanges, app.url);

    expect(result?.matches).toBe(false);
    expect(result?.candidateResponse.status).toBe(0);
    expect(result?.candidateResponse.sqlErrors?.[0]).toMatch(/^HTTP replay error:/);
  });

  it("turns a candidate timeout into mismatch evidence", async () => {
    let shouldHang = false;
    const app = await startApp((_request, response) => {
      if (shouldHang) {
        return;
      }
      json(response, 200, { ok: true });
    });
    const recorder = track(new Recorder({ targetUrl: app.url }));
    const proxyUrl = await recorder.start();
    await fetch(proxyUrl + "/slow");
    const exchanges = stop(recorder);

    shouldHang = true;
    const [result] = await new Replayer({ timeoutMs: 100 }).replay(exchanges, app.url);

    expect(result?.matches).toBe(false);
    expect(result?.candidateResponse.status).toBe(0);
    expect(result?.candidateResponse.sqlErrors?.[0]).toContain("timed out after 100ms");
  });

  it("extracts SQLSTATE evidence from a candidate error response", async () => {
    let candidate = false;
    const app = await startApp((_request, response) => {
      if (candidate) {
        json(response, 500, { code: "23502", message: "currency cannot be null" });
        return;
      }
      json(response, 201, { saved: true });
    });
    const recorder = track(new Recorder({ targetUrl: app.url }));
    const proxyUrl = await recorder.start();
    await fetch(proxyUrl + "/orders", { method: "POST" });
    const exchanges = stop(recorder);

    candidate = true;
    const [result] = await new Replayer().replay(exchanges, app.url);

    expect(result?.matches).toBe(false);
    expect(result?.candidateResponse.sqlErrors).toEqual([
      "SQLSTATE 23502: currency cannot be null",
    ]);
  });
});

describe("normalizadores (calibración gate 1.E)", () => {
  it("normaliza ids/tokens opacos por clave sin tocar campos de negocio", async () => {
    const { normalizeBody } = await import("../dist/index.js");

    const normalized = normalizeBody({
      token: "DYrAc3JYkKxdfergWVaO2RUHUN9JzTH1",
      user: {
        id: "JS9rknoYLXlVrxwk4HmxmyojV0B4hxgs",
        accountId: 12345678,
        email: "cloudproof@example.com",
        name: "CloudProof E2E",
        createdAt: "2026-07-15T01:28:28.435Z",
      },
      status: "paid",
      currency: "EUR",
      amount: 991,
    }) as Record<string, unknown>;

    expect(normalized["token"]).toBe("<volatile-id>");
    const user = normalized["user"] as Record<string, unknown>;
    expect(user["id"]).toBe("<volatile-id>");
    expect(user["accountId"]).toBe("<volatile-id>");
    expect(user["createdAt"]).toBe("<timestamp>");
    // Campos de negocio intactos: un breaking change acá DEBE detectarse.
    expect(user["email"]).toBe("cloudproof@example.com");
    expect(normalized["status"]).toBe("paid");
    expect(normalized["currency"]).toBe("EUR");
    expect(normalized["amount"]).toBe(991);
  });

  it("no normaliza strings cortos ni con espacios aunque la clave sea volátil", async () => {
    const { normalizeBody } = await import("../dist/index.js");

    const normalized = normalizeBody({ id: "abc", token: "two words here" }) as Record<
      string,
      unknown
    >;

    expect(normalized["id"]).toBe("abc");
    expect(normalized["token"]).toBe("two words here");
  });

  it("V-1: no normaliza ids numéricos de baja cardinalidad aunque la clave sea volátil", async () => {
    // Regresión (auditoría adversarial 2026-07-20): antes de este fix,
    // cualquier número bajo una clave volátil se borraba sin importar su
    // magnitud. Un customerId chico (referencia relacional de negocio, no
    // un id opaco generado) debe seguir siendo comparable — de lo
    // contrario un IDOR/join roto que devuelve la fila de otro cliente
    // normaliza igual en baseline y candidato y el mismatch desaparece.
    const { normalizeBody } = await import("../dist/index.js");

    const normalized = normalizeBody({
      customerId: 7,
      orderId: 42,
      accountId: 12345678,
    }) as Record<string, unknown>;

    expect(normalized["customerId"]).toBe(7);
    expect(normalized["orderId"]).toBe(42);
    // ≥8 dígitos: mismo umbral que ya regía para strings, sigue opaco.
    expect(normalized["accountId"]).toBe("<volatile-id>");
  });
});
