import { Buffer } from "node:buffer";
import {
  request as requestHttp,
  type OutgoingHttpHeaders,
} from "node:http";
import { request as requestHttps } from "node:https";
import { decodeBody, encodeBody, extractSqlErrors, headerValue } from "./http-body.js";
import { normalizeBody } from "./normalizers.js";
import type { RecordedExchange, RecordedResponse, ReplayResult } from "./types.js";
import {
  assertSafeHttpTarget,
  resolveHttpExecutionProfile,
  type HttpExecutionProfile,
} from "./http-security.js";

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_BODY_BYTES = 10 * 1024 * 1024;
const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "content-length",
  "host",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

export interface ReplayerOptions {
  timeoutMs?: number;
  maxBodyBytes?: number;
  executionProfile?: HttpExecutionProfile;
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(name + " must be a positive integer");
  }
  return value;
}

function describeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/[\r\n]+/g, " ");
}

function targetForExchange(targetUrl: string, recordedPath: string): URL {
  const target = new URL(targetUrl);
  if (target.protocol !== "http:" && target.protocol !== "https:") {
    throw new TypeError("Replay targetUrl must use http: or https:");
  }

  const path = new URL(recordedPath, "http://proof-replayer.invalid");
  const prefix = target.pathname === "/" ? "" : target.pathname.replace(/\/$/, "");
  target.pathname = prefix + "/" + path.pathname.replace(/^\/+/, "");
  target.search = path.search;
  target.hash = "";
  return target;
}

function replayHeaders(
  headers: Record<string, string>,
  target: URL,
  body: Buffer | undefined,
): OutgoingHttpHeaders {
  const connectionHeaders = new Set(
    (headerValue(headers, "connection") ?? "")
      .split(",")
      .map((name) => name.trim().toLowerCase())
      .filter(Boolean),
  );
  const replayed: OutgoingHttpHeaders = {};

  for (const [name, value] of Object.entries(headers)) {
    const lowerName = name.toLowerCase();
    if (HOP_BY_HOP_HEADERS.has(lowerName) || connectionHeaders.has(lowerName)) {
      continue;
    }
    replayed[name] = value;
  }
  replayed.host = target.host;
  if (body !== undefined) {
    replayed["content-length"] = String(body.length);
  }
  return replayed;
}

function replayRequest(
  exchange: RecordedExchange,
  targetUrl: string,
  timeoutMs: number,
  maxBodyBytes: number,
): Promise<RecordedResponse> {
  return new Promise((resolve, reject) => {
    let target: URL;
    let body: Buffer | undefined;
    try {
      target = targetForExchange(targetUrl, exchange.request.path);
      body = encodeBody(exchange.request.body, exchange.request.headers);
    } catch (error) {
      reject(error);
      return;
    }

    const request = target.protocol === "https:" ? requestHttps : requestHttp;
    let settled = false;
    const finishWithError = (error: unknown): void => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(error);
      }
    };

    const candidateRequest = request(
      target,
      {
        method: exchange.request.method,
        headers: replayHeaders(exchange.request.headers, target, body),
      },
      (candidateResponse) => {
        const chunks: Buffer[] = [];
        let totalBytes = 0;

        candidateResponse.on("data", (chunk: Buffer | string) => {
          const buffer = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
          totalBytes += buffer.length;
          if (totalBytes > maxBodyBytes) {
            const error = new Error(
              "Candidate response exceeds the " + maxBodyBytes + " byte replay limit",
            );
            candidateResponse.destroy(error);
            finishWithError(error);
            return;
          }
          chunks.push(buffer);
        });
        candidateResponse.once("end", () => {
          if (settled) {
            return;
          }
          settled = true;
          clearTimeout(timer);
          const decodedBody = decodeBody(Buffer.concat(chunks), candidateResponse.headers);
          const response: RecordedResponse = { status: candidateResponse.statusCode ?? 0 };
          if (decodedBody !== undefined) {
            response.body = decodedBody;
          }
          const sqlErrors = extractSqlErrors(candidateResponse.headers, decodedBody);
          if (sqlErrors.length > 0) {
            response.sqlErrors = sqlErrors;
          }
          resolve(response);
        });
        candidateResponse.once("aborted", () =>
          finishWithError(new Error("Candidate app aborted the response")),
        );
        candidateResponse.once("error", finishWithError);
      },
    );

    const timer = setTimeout(() => {
      candidateRequest.destroy(new Error("Candidate app timed out after " + timeoutMs + "ms"));
    }, timeoutMs);

    candidateRequest.once("error", finishWithError);
    candidateRequest.end(body);
  });
}

/**
 * Compares the response status and recursively-normalized body. Observable SQL
 * errors always make an exchange fail, even when an app happens to return the
 * same HTTP status/body as the baseline.
 */
export function compareExchange(
  exchange: RecordedExchange,
  candidateResponse: ReplayResult["candidateResponse"],
): ReplayResult {
  const baselineNormalized = normalizeBody(exchange.baselineResponse.body);
  const candidateNormalized = normalizeBody(candidateResponse.body);

  const matches =
    exchange.baselineResponse.status === candidateResponse.status &&
    JSON.stringify(baselineNormalized) === JSON.stringify(candidateNormalized) &&
    (candidateResponse.sqlErrors ?? []).length === 0;

  return { exchange, candidateResponse, matches };
}

export class Replayer {
  private readonly timeoutMs: number;
  private readonly maxBodyBytes: number;
  private readonly executionProfile: HttpExecutionProfile;

  constructor(options: ReplayerOptions = {}) {
    this.executionProfile = resolveHttpExecutionProfile(options.executionProfile);
    this.timeoutMs = positiveInteger(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, "Replayer timeoutMs");
    this.maxBodyBytes = positiveInteger(
      options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES,
      "Replayer maxBodyBytes",
    );
  }

  async replay(exchanges: RecordedExchange[], targetUrl: string): Promise<ReplayResult[]> {
    const validatedTarget = new URL(targetUrl);
    assertSafeHttpTarget(validatedTarget, this.executionProfile, "Replay targetUrl");
    const results: ReplayResult[] = [];

    // Workloads are stateful by default: preserve capture order instead of
    // parallelizing requests whose effects may feed later requests.
    for (const exchange of exchanges) {
      let candidateResponse: RecordedResponse;
      try {
        candidateResponse = await replayRequest(
          exchange,
          targetUrl,
          this.timeoutMs,
          this.maxBodyBytes,
        );
      } catch (error) {
        candidateResponse = {
          status: 0,
          sqlErrors: ["HTTP replay error: " + describeError(error)],
        };
      }
      results.push(compareExchange(exchange, candidateResponse));
    }

    return results;
  }
}
