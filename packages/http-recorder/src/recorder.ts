/**
 * Capture design: Recorder runs a local HTTP proxy instead of instrumenting a
 * test runner. Tests only need their base URL pointed at the proxy, so the
 * mechanism is independent of Jest/Vitest/etc. and of the HTTP client they use.
 * Reverse-proxy mode can forward to an HTTP or HTTPS app; forward-proxy mode
 * accepts absolute-form HTTP requests. TLS CONNECT interception is deliberately
 * excluded because it would require generating and trusting a local CA.
 */
import { Buffer } from "node:buffer";
import {
  createServer,
  request as requestHttp,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type OutgoingHttpHeaders,
  type Server,
  type ServerResponse,
} from "node:http";
import { request as requestHttps } from "node:https";
import type { AddressInfo } from "node:net";
import { decodeBody, extractSqlErrors, headerValue, toRecordedHeaders } from "./http-body.js";
import type { RecordedExchange, RecordedRequest, RecordedResponse } from "./types.js";
import {
  assertSafeHttpTarget,
  isLoopbackHost,
  resolveHttpExecutionProfile,
  type HttpExecutionProfile,
} from "./http-security.js";
import {
  redactExchangesForEvidence,
  type RedactedEvidence,
  type RedactionPolicy,
} from "./redaction.js";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_BODY_BYTES = 10 * 1024 * 1024;
const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

export interface RecorderOptions {
  /** Base URL of the baseline app. Omit it when using HTTP forward-proxy mode. */
  targetUrl?: string;
  host?: string;
  port?: number;
  timeoutMs?: number;
  maxBodyBytes?: number;
  executionProfile?: HttpExecutionProfile;
  /** Solo trusted puede habilitar el modo forward proxy. */
  allowForwardProxy?: boolean;
}

interface ProxiedResponse {
  status: number;
  headers: IncomingHttpHeaders;
  body: Buffer;
}

type RecorderState = "idle" | "starting" | "recording" | "stopped";

function positiveInteger(value: number, name: string, allowZero = false): number {
  if (!Number.isSafeInteger(value) || value < (allowZero ? 0 : 1)) {
    throw new TypeError(name + " must be " + (allowZero ? "a non-negative" : "a positive") + " integer");
  }
  return value;
}

function describeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/[\r\n]+/g, " ");
}

function logicalPath(rawUrl: string): string {
  const parsed = new URL(rawUrl, "http://proof-recorder.invalid");
  return parsed.pathname + parsed.search;
}

function joinBasePath(baseUrl: URL, requestPath: string): URL {
  const requestUrl = new URL(requestPath, "http://proof-recorder.invalid");
  const target = new URL(baseUrl.toString());
  const prefix = target.pathname === "/" ? "" : target.pathname.replace(/\/$/, "");
  target.pathname = prefix + "/" + requestUrl.pathname.replace(/^\/+/, "");
  target.search = requestUrl.search;
  target.hash = "";
  return target;
}

function connectionSpecificHeaders(headers: IncomingHttpHeaders): Set<string> {
  return new Set(
    (headerValue(headers, "connection") ?? "")
      .split(",")
      .map((name) => name.trim().toLowerCase())
      .filter(Boolean),
  );
}

function requestHeadersForTarget(
  headers: IncomingHttpHeaders,
  target: URL,
  bodyLength: number,
): OutgoingHttpHeaders {
  const connectionHeaders = connectionSpecificHeaders(headers);
  const forwarded: OutgoingHttpHeaders = {};

  for (const [name, value] of Object.entries(headers)) {
    const lowerName = name.toLowerCase();
    if (
      value === undefined ||
      HOP_BY_HOP_HEADERS.has(lowerName) ||
      connectionHeaders.has(lowerName) ||
      lowerName === "host" ||
      lowerName === "content-length"
    ) {
      continue;
    }
    forwarded[name] = value;
  }

  forwarded.host = target.host;
  if (bodyLength > 0 || headerValue(headers, "content-length") !== undefined) {
    forwarded["content-length"] = String(bodyLength);
  }
  return forwarded;
}

function responseHeadersForClient(headers: IncomingHttpHeaders): OutgoingHttpHeaders {
  const connectionHeaders = connectionSpecificHeaders(headers);
  return Object.fromEntries(
    Object.entries(headers).filter(([name, value]) => {
      const lowerName = name.toLowerCase();
      return (
        value !== undefined &&
        !HOP_BY_HOP_HEADERS.has(lowerName) &&
        !connectionHeaders.has(lowerName)
      );
    }),
  );
}

function readRequestBody(request: IncomingMessage, maxBodyBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let totalBytes = 0;

    request.on("data", (chunk: Buffer | string) => {
      const buffer = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
      totalBytes += buffer.length;
      if (totalBytes > maxBodyBytes) {
        reject(new Error("Request body exceeds the " + maxBodyBytes + " byte capture limit"));
        request.destroy();
        return;
      }
      chunks.push(buffer);
    });
    request.once("end", () => resolve(Buffer.concat(chunks)));
    request.once("aborted", () => reject(new Error("Client aborted the request")));
    request.once("error", reject);
  });
}

function proxyRequest(
  target: URL,
  method: string,
  headers: OutgoingHttpHeaders,
  body: Buffer,
  timeoutMs: number,
  maxBodyBytes: number,
): Promise<ProxiedResponse> {
  return new Promise((resolve, reject) => {
    const request = target.protocol === "https:" ? requestHttps : requestHttp;
    let settled = false;
    const finishWithError = (error: unknown): void => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(error);
      }
    };

    const upstreamRequest = request(target, { method, headers }, (upstreamResponse) => {
      const chunks: Buffer[] = [];
      let totalBytes = 0;

      upstreamResponse.on("data", (chunk: Buffer | string) => {
        const buffer = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
        totalBytes += buffer.length;
        if (totalBytes > maxBodyBytes) {
          const error = new Error(
            "Response body exceeds the " + maxBodyBytes + " byte capture limit",
          );
          upstreamResponse.destroy(error);
          finishWithError(error);
          return;
        }
        chunks.push(buffer);
      });
      upstreamResponse.once("end", () => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        resolve({
          status: upstreamResponse.statusCode ?? 502,
          headers: upstreamResponse.headers,
          body: Buffer.concat(chunks),
        });
      });
      upstreamResponse.once("aborted", () =>
        finishWithError(new Error("Baseline app aborted the response")),
      );
      upstreamResponse.once("error", finishWithError);
    });

    const timer = setTimeout(() => {
      upstreamRequest.destroy(
        new Error("Baseline app timed out after " + timeoutMs + "ms"),
      );
    }, timeoutMs);

    upstreamRequest.once("error", finishWithError);
    upstreamRequest.end(body);
  });
}

function recordedRequest(
  request: IncomingMessage,
  path: string,
  rawBody: Buffer,
): RecordedRequest {
  const result: RecordedRequest = {
    method: request.method ?? "GET",
    path,
    headers: toRecordedHeaders(request.headers),
  };
  const body = decodeBody(rawBody, request.headers);
  if (body !== undefined) {
    result.body = body;
  }
  return result;
}

function recordedResponse(response: ProxiedResponse): RecordedResponse {
  const result: RecordedResponse = { status: response.status };
  const body = decodeBody(response.body, response.headers);
  if (body !== undefined) {
    result.body = body;
  }
  const sqlErrors = extractSqlErrors(response.headers, body);
  if (sqlErrors.length > 0) {
    result.sqlErrors = sqlErrors;
  }
  return result;
}

export class Recorder {
  private readonly targetUrl: URL | undefined;
  private readonly host: string;
  private readonly port: number;
  private readonly timeoutMs: number;
  private readonly maxBodyBytes: number;
  private readonly executionProfile: HttpExecutionProfile;
  private readonly allowForwardProxy: boolean;
  private readonly exchanges = new Map<number, RecordedExchange>();
  private server: Server | undefined;
  private state: RecorderState = "idle";
  private activeRequests = 0;
  private nextSequence = 0;

  constructor(options: RecorderOptions = {}) {
    this.executionProfile = resolveHttpExecutionProfile(options.executionProfile);
    this.targetUrl = options.targetUrl === undefined ? undefined : new URL(options.targetUrl);
    if (this.targetUrl !== undefined) {
      assertSafeHttpTarget(this.targetUrl, this.executionProfile, "Recorder targetUrl");
    }
    this.host = options.host ?? DEFAULT_HOST;
    if (this.executionProfile !== "trusted" && !isLoopbackHost(this.host)) {
      throw new TypeError(`Recorder host must be loopback under ${this.executionProfile} profile`);
    }
    if (this.executionProfile !== "trusted" && options.allowForwardProxy === true) {
      throw new TypeError(`${this.executionProfile} profile forbids HTTP forward-proxy mode`);
    }
    this.allowForwardProxy = options.allowForwardProxy ?? this.executionProfile === "trusted";
    this.port = positiveInteger(options.port ?? 0, "Recorder port", true);
    this.timeoutMs = positiveInteger(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, "Recorder timeoutMs");
    this.maxBodyBytes = positiveInteger(
      options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES,
      "Recorder maxBodyBytes",
    );
  }

  /** Starts the local proxy and resolves with the base URL tests should use. */
  start(): Promise<string> {
    if (this.state !== "idle") {
      throw new Error("Recorder.start can only be called once per Recorder instance");
    }

    this.state = "starting";
    const server = createServer((request, response) => {
      void this.handleRequest(request, response);
    });
    server.on("connect", (_request, socket) => {
      socket.end(
        "HTTP/1.1 501 Not Implemented\r\n" +
          "Connection: close\r\n" +
          "Content-Type: text/plain\r\n\r\n" +
          "HTTPS CONNECT interception is not supported; use reverse-proxy mode instead.\n",
      );
    });
    server.on("clientError", (_error, socket) => {
      if (socket.writable) {
        socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
      }
    });
    this.server = server;
    server.requestTimeout = Math.min(this.timeoutMs + 5_000, 120_000);
    server.headersTimeout = Math.min(server.requestTimeout, 30_000);
    server.keepAliveTimeout = 5_000;
    server.maxHeadersCount = 128;

    return new Promise((resolve, reject) => {
      const onError = (error: Error): void => {
        this.state = "idle";
        this.server = undefined;
        reject(error);
      };
      server.once("error", onError);
      server.listen(this.port, this.host, () => {
        server.off("error", onError);
        this.state = "recording";
        resolve(this.proxyUrl);
      });
    });
  }

  get proxyUrl(): string {
    const address = this.server?.address();
    if (address === undefined || address === null || typeof address === "string") {
      throw new Error("Recorder proxy is not listening yet; await Recorder.start()");
    }
    const info = address as AddressInfo;
    const host = info.family === "IPv6" ? "[" + info.address + "]" : info.address;
    return "http://" + host + ":" + info.port;
  }

  stop(): RecordedExchange[] {
    if (this.state !== "recording") {
      throw new Error("Recorder.stop requires a successfully started recorder");
    }
    if (this.activeRequests > 0) {
      throw new Error(
        "Recorder.stop called with " + this.activeRequests + " request(s) still in flight",
      );
    }

    this.state = "stopped";
    const server = this.server;
    if (server?.listening === true) {
      server.close();
      server.closeIdleConnections();
    }
    return this.getExchanges();
  }

  getExchanges(): RecordedExchange[] {
    return [...this.exchanges.entries()]
      .sort(([left], [right]) => left - right)
      .map(([, exchange]) => exchange);
  }

  /** Copia segura para persistencia; getExchanges()/stop() siguen crudos para replay. */
  getEvidenceExchanges(
    policy: RedactionPolicy = {},
  ): RedactedEvidence<RecordedExchange[]> {
    return redactExchangesForEvidence(this.getExchanges(), policy);
  }

  private targetFor(rawUrl: string): URL {
    if (this.targetUrl !== undefined) {
      return joinBasePath(this.targetUrl, logicalPath(rawUrl));
    }

    if (!this.allowForwardProxy) {
      throw new Error(
        "Forward-proxy mode is disabled; Recorder needs an explicit targetUrl",
      );
    }

    let target: URL;
    try {
      target = new URL(rawUrl);
    } catch {
      throw new Error(
        "Forward-proxy requests must use an absolute HTTP URL, or Recorder needs targetUrl",
      );
    }
    assertSafeHttpTarget(target, this.executionProfile, "Recorder forward target");
    return target;
  }

  private async handleRequest(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const sequence = this.nextSequence++;
    this.activeRequests += 1;
    let rawBody: Buffer = Buffer.alloc(0);
    const path = logicalPath(request.url ?? "/");

    try {
      rawBody = await readRequestBody(request, this.maxBodyBytes);
      const target = this.targetFor(request.url ?? "/");
      const baseline = await proxyRequest(
        target,
        request.method ?? "GET",
        requestHeadersForTarget(request.headers, target, rawBody.length),
        rawBody,
        this.timeoutMs,
        this.maxBodyBytes,
      );

      response.writeHead(baseline.status, responseHeadersForClient(baseline.headers));
      response.end(baseline.body);
      this.exchanges.set(sequence, {
        request: recordedRequest(request, path, rawBody),
        baselineResponse: recordedResponse(baseline),
      });
    } catch (error) {
      const detail = "HTTP proxy error: " + describeError(error);
      const failureBody = { error: "Baseline request failed", detail };
      if (!response.headersSent && !response.destroyed) {
        response.writeHead(502, { "content-type": "application/json; charset=utf-8" });
        response.end(JSON.stringify(failureBody));
      } else if (!response.destroyed) {
        response.end();
      }
      this.exchanges.set(sequence, {
        request: recordedRequest(request, path, rawBody),
        baselineResponse: { status: 502, body: failureBody, sqlErrors: [detail] },
      });
    } finally {
      this.activeRequests -= 1;
    }
  }
}
