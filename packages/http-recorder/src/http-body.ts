import { Buffer } from "node:buffer";
import type { IncomingHttpHeaders } from "node:http";
import {
  brotliCompressSync,
  brotliDecompressSync,
  deflateSync,
  gzipSync,
  gunzipSync,
  inflateSync,
} from "node:zlib";

const JSON_CONTENT_TYPE_RE = /^(?:application|text)\/(?:[\w.-]+\+)?json\b/i;
const TEXT_CONTENT_TYPE_RE =
  /^(?:text\/|application\/(?:graphql|javascript|x-www-form-urlencoded|xml)|image\/svg\+xml)/i;
const SQLSTATE_RE = /\bSQLSTATE\s*(?::|=)?\s*([0-9A-Z]{5})\b/i;
const BARE_SQLSTATE_RE = /^[0-9A-Z]{5}$/;

export function headerValue(
  headers: IncomingHttpHeaders | Record<string, string>,
  name: string,
): string | undefined {
  const matchingKey = Object.keys(headers).find((key) => key.toLowerCase() === name.toLowerCase());
  if (matchingKey === undefined) {
    return undefined;
  }

  const value = headers[matchingKey];
  return Array.isArray(value) ? value.join(", ") : value;
}

export function toRecordedHeaders(headers: IncomingHttpHeaders): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers).flatMap(([name, value]) => {
      if (value === undefined) {
        return [];
      }
      return [[name, Array.isArray(value) ? value.join(", ") : value]];
    }),
  );
}

function contentEncodings(headers: IncomingHttpHeaders | Record<string, string>): string[] {
  return (headerValue(headers, "content-encoding") ?? "")
    .split(",")
    .map((encoding) => encoding.trim().toLowerCase())
    .filter((encoding) => encoding !== "" && encoding !== "identity");
}

function decompressBody(
  rawBody: Buffer,
  headers: IncomingHttpHeaders | Record<string, string>,
): Buffer {
  return contentEncodings(headers)
    .reverse()
    .reduce((body, encoding) => {
      if (encoding === "gzip" || encoding === "x-gzip") {
        return gunzipSync(body);
      }
      if (encoding === "deflate") {
        return inflateSync(body);
      }
      if (encoding === "br") {
        return brotliDecompressSync(body);
      }
      throw new Error("Unsupported content encoding: " + encoding);
    }, rawBody);
}

function compressBody(
  rawBody: Buffer,
  headers: IncomingHttpHeaders | Record<string, string>,
): Buffer {
  return contentEncodings(headers).reduce((body, encoding) => {
    if (encoding === "gzip" || encoding === "x-gzip") {
      return gzipSync(body);
    }
    if (encoding === "deflate") {
      return deflateSync(body);
    }
    if (encoding === "br") {
      return brotliCompressSync(body);
    }
    throw new Error("Unsupported content encoding: " + encoding);
  }, rawBody);
}

export function decodeBody(
  rawBody: Buffer,
  headers: IncomingHttpHeaders | Record<string, string>,
): unknown | undefined {
  if (rawBody.length === 0) {
    return undefined;
  }

  let body: Buffer;
  try {
    body = decompressBody(rawBody, headers);
  } catch {
    return Uint8Array.from(rawBody);
  }

  const contentType = headerValue(headers, "content-type") ?? "";
  if (JSON_CONTENT_TYPE_RE.test(contentType)) {
    const text = body.toString("utf8");
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return text;
    }
  }

  if (TEXT_CONTENT_TYPE_RE.test(contentType)) {
    return body.toString("utf8");
  }

  return Uint8Array.from(body);
}

export function encodeBody(
  body: unknown,
  headers: IncomingHttpHeaders | Record<string, string>,
): Buffer | undefined {
  if (body === undefined) {
    return undefined;
  }

  let rawBody: Buffer;
  if (body instanceof Uint8Array) {
    rawBody = Buffer.from(body);
  } else if (body instanceof ArrayBuffer) {
    rawBody = Buffer.from(body);
  } else {
    const contentType = headerValue(headers, "content-type") ?? "";
    if (JSON_CONTENT_TYPE_RE.test(contentType)) {
      rawBody = Buffer.from(JSON.stringify(body), "utf8");
    } else if (typeof body === "string") {
      rawBody = Buffer.from(body, "utf8");
    } else {
      rawBody = Buffer.from(JSON.stringify(body), "utf8");
    }
  }

  return compressBody(rawBody, headers);
}

function headerSqlErrors(headers: IncomingHttpHeaders | Record<string, string>): string[] {
  const value = headerValue(headers, "x-cloudproof-sql-errors") ?? headerValue(headers, "x-cloudproof-sql-error");
  if (value === undefined || value.trim() === "") {
    return [];
  }

  try {
    const parsed = JSON.parse(value) as unknown;
    if (Array.isArray(parsed)) {
      return parsed.filter((item): item is string => typeof item === "string");
    }
  } catch {
    // A single plain-text header is also a valid evidence value.
  }
  return [value];
}

function bodySqlErrors(body: unknown, seen: Set<unknown>): string[] {
  if (typeof body === "string") {
    return SQLSTATE_RE.test(body) ? [body] : [];
  }
  if (body === null || typeof body !== "object" || seen.has(body)) {
    return [];
  }

  seen.add(body);
  if (Array.isArray(body)) {
    return body.flatMap((item) => bodySqlErrors(item, seen));
  }

  const record = body as Record<string, unknown>;
  const code = record.code;
  const message = record.message;
  const ownError =
    typeof code === "string" &&
    BARE_SQLSTATE_RE.test(code) &&
    /\d/.test(code)
      ? ["SQLSTATE " + code + (typeof message === "string" ? ": " + message : "")]
      : [];

  return ownError.concat(Object.values(record).flatMap((value) => bodySqlErrors(value, seen)));
}

export function extractSqlErrors(
  headers: IncomingHttpHeaders | Record<string, string>,
  body: unknown,
): string[] {
  return [...new Set(headerSqlErrors(headers).concat(bodySqlErrors(body, new Set())))];
}

