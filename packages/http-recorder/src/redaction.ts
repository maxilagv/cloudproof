import type {
  RecordedExchange,
  RecordedRequest,
  RecordedResponse,
  ReplayResult,
} from "./types.js";

const POLICY_ID = "cloudproof-safe-evidence-v1";
const DEFAULT_REPLACEMENT = "[REDACTED]";
const DEFAULT_SENSITIVE_HEADERS = [
  "authorization",
  "cookie",
  "proxy-authorization",
  "set-cookie",
  "x-access-token",
  "x-api-key",
  "x-auth-token",
  "x-csrf-token",
  "x-forwarded-client-cert",
  "x-xsrf-token",
] as const;
const DEFAULT_SENSITIVE_QUERY = [
  "access_token",
  "api_key",
  "apikey",
  "auth",
  "authorization",
  "client_secret",
  "code",
  "cookie",
  "key",
  "password",
  "passwd",
  "refresh_token",
  "secret",
  "session",
  "sig",
  "signature",
  "token",
] as const;
const DEFAULT_SENSITIVE_JSON_KEYS = [
  "accessToken",
  "address",
  "apiKey",
  "authorization",
  "birthDate",
  "cardNumber",
  "clientSecret",
  "cookie",
  "creditCard",
  "cvc",
  "cvv",
  "dateOfBirth",
  "documentNumber",
  "email",
  "firstName",
  "fullName",
  "idToken",
  "lastName",
  "passphrase",
  "password",
  "phone",
  "privateKey",
  "refreshToken",
  "secret",
  "session",
  "sessionId",
  "ssn",
  "token",
  "username",
] as const;

export interface RedactionPolicy {
  replacement?: string;
  sensitiveHeaders?: readonly string[];
  sensitiveQueryParameters?: readonly string[];
  sensitiveJsonKeys?: readonly string[];
  /** Valores efimeros conocidos (secrets de test); nunca aparecen en metadata. */
  literalSecrets?: readonly string[];
  /** true por default: blobs no interpretables nunca se persisten. */
  redactOpaqueBodies?: boolean;
}

export interface RedactionSummary {
  policyId: typeof POLICY_ID;
  replacement: string;
  totalRedactions: number;
  headers: number;
  queryParameters: number;
  requestBodyValues: number;
  responseBodyValues: number;
  stringPatterns: number;
  opaqueBodies: number;
}

export interface RedactedEvidence<T> {
  value: T;
  redaction: RedactionSummary;
}

interface ResolvedPolicy {
  replacement: string;
  headers: Set<string>;
  query: Set<string>;
  jsonKeys: Set<string>;
  redactOpaqueBodies: boolean;
  literalSecrets: string[];
}

type BodyKind = "request" | "response";

function resolvePolicy(policy: RedactionPolicy): ResolvedPolicy {
  const replacement = policy.replacement ?? DEFAULT_REPLACEMENT;
  if (
    replacement.length < 1 ||
    replacement.length > 128 ||
    /[\r\n\u0000]/.test(replacement)
  ) {
    throw new TypeError("Redaction replacement must be 1-128 characters without CR/LF/NUL");
  }
  return {
    replacement,
    headers: new Set(
      [...DEFAULT_SENSITIVE_HEADERS, ...(policy.sensitiveHeaders ?? [])].map((name) =>
        name.toLowerCase(),
      ),
    ),
    query: new Set(
      [...DEFAULT_SENSITIVE_QUERY, ...(policy.sensitiveQueryParameters ?? [])].map((name) =>
        name.toLowerCase(),
      ),
    ),
    jsonKeys: new Set(
      [...DEFAULT_SENSITIVE_JSON_KEYS, ...(policy.sensitiveJsonKeys ?? [])].map((name) =>
        name.replace(/[-_\s]/g, "").toLowerCase(),
      ),
    ),
    redactOpaqueBodies: policy.redactOpaqueBodies ?? true,
    literalSecrets: [...new Set(policy.literalSecrets ?? [])]
      .filter((value) => value.length >= 4 && value !== replacement)
      .sort((left, right) => right.length - left.length),
  };
}

function emptySummary(replacement: string): RedactionSummary {
  return {
    policyId: POLICY_ID,
    replacement,
    totalRedactions: 0,
    headers: 0,
    queryParameters: 0,
    requestBodyValues: 0,
    responseBodyValues: 0,
    stringPatterns: 0,
    opaqueBodies: 0,
  };
}

function increment(summary: RedactionSummary, field: keyof Omit<RedactionSummary, "policyId" | "replacement" | "totalRedactions">): void {
  summary[field] += 1;
  summary.totalRedactions += 1;
}

function headerIsSensitive(name: string, policy: ResolvedPolicy): boolean {
  const normalized = name.toLowerCase();
  return (
    policy.headers.has(normalized) ||
    /(?:^|[-_])(?:auth|cookie|credential|secret|session|token|api[-_]?key)(?:$|[-_])/i.test(
      normalized,
    )
  );
}

function jsonKeyIsSensitive(name: string, policy: ResolvedPolicy): boolean {
  const normalized = name.replace(/[-_\s]/g, "").toLowerCase();
  return (
    policy.jsonKeys.has(normalized) ||
    /(?:password|passwd|passphrase|privatekey|secret|session|token|apikey|clientsecret|authorization|cookie)/i.test(
      normalized,
    )
  );
}

function redactString(
  input: string,
  policy: ResolvedPolicy,
  summary: RedactionSummary,
): string {
  const patterns = [
    /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z ]+ )?PRIVATE KEY-----/g,
    /\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi,
    /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,
    /\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,}|AKIA[A-Z0-9]{16})\b/g,
    /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?):\/\/[^\s:/?#]+:[^\s@/?#]+@/gi,
    /\b(?:authorization|cookie|credential|password|passwd|private[_-]?key|secret|session|token|api[_-]?key|client[_-]?secret)\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi,
    /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi,
  ];
  let output = input;
  for (const secret of policy.literalSecrets) {
    if (!output.includes(secret)) continue;
    const pieces = output.split(secret);
    output = pieces.join(policy.replacement);
    for (let index = 1; index < pieces.length; index += 1) {
      increment(summary, "stringPatterns");
    }
  }
  for (const pattern of patterns) {
    output = output.replace(pattern, () => {
      increment(summary, "stringPatterns");
      return policy.replacement;
    });
  }
  return output;
}

function redactBody(
  value: unknown,
  kind: BodyKind,
  policy: ResolvedPolicy,
  summary: RedactionSummary,
  seen: WeakMap<object, unknown>,
): unknown {
  if (typeof value === "string") return redactString(value, policy, summary);
  if (value === null || typeof value !== "object") return value;

  if (value instanceof Uint8Array || value instanceof ArrayBuffer) {
    if (!policy.redactOpaqueBodies) {
      return value instanceof Uint8Array ? Uint8Array.from(value) : value.slice(0);
    }
    increment(summary, "opaqueBodies");
    return {
      redacted: true,
      media: "opaque-binary",
      byteLength: value.byteLength,
    };
  }

  const known = seen.get(value);
  if (known !== undefined) return known;

  if (Array.isArray(value)) {
    const output: unknown[] = [];
    seen.set(value, output);
    for (const item of value) output.push(redactBody(item, kind, policy, summary, seen));
    return output;
  }

  const output: Record<string, unknown> = {};
  seen.set(value, output);
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (jsonKeyIsSensitive(key, policy)) {
      output[key] = policy.replacement;
      increment(summary, kind === "request" ? "requestBodyValues" : "responseBodyValues");
    } else {
      output[key] = redactBody(item, kind, policy, summary, seen);
    }
  }
  return output;
}

function redactHeaders(
  headers: Record<string, string>,
  policy: ResolvedPolicy,
  summary: RedactionSummary,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers).map(([name, value]) => {
      if (headerIsSensitive(name, policy)) {
        increment(summary, "headers");
        return [name, policy.replacement];
      }
      return [name, redactString(value, policy, summary)];
    }),
  );
}

function redactPath(
  path: string,
  policy: ResolvedPolicy,
  summary: RedactionSummary,
): string {
  const url = new URL(path, "http://cloudproof-redaction.invalid");
  const pathname = url.pathname
    .split("/")
    .map((segment) => {
      let decoded = segment;
      try {
        decoded = decodeURIComponent(segment);
      } catch {
        // Un escape inválido se conserva y pasa por los patrones de texto.
      }
      if (
        /^(?:\d{6,}|[0-9a-f]{8}-[0-9a-f-]{27,}|[A-Za-z0-9_-]{32,})$/i.test(decoded)
      ) {
        increment(summary, "stringPatterns");
        return policy.replacement;
      }
      return redactString(decoded, policy, summary);
    })
    .join("/");
  const clean = new URLSearchParams();
  for (const [name, value] of url.searchParams) {
    if (policy.query.has(name.toLowerCase())) {
      clean.append(name, policy.replacement);
      increment(summary, "queryParameters");
    } else {
      clean.append(name, redactString(value, policy, summary));
    }
  }
  const search = clean.toString();
  return pathname + (search === "" ? "" : `?${search}`);
}

function redactRequest(
  request: RecordedRequest,
  policy: ResolvedPolicy,
  summary: RedactionSummary,
): RecordedRequest {
  return {
    method: request.method,
    path: redactPath(request.path, policy, summary),
    headers: redactHeaders(request.headers, policy, summary),
    ...(request.body === undefined
      ? {}
      : { body: redactBody(request.body, "request", policy, summary, new WeakMap()) }),
  };
}

function redactResponse(
  response: RecordedResponse,
  policy: ResolvedPolicy,
  summary: RedactionSummary,
): RecordedResponse {
  return {
    status: response.status,
    ...(response.body === undefined
      ? {}
      : { body: redactBody(response.body, "response", policy, summary, new WeakMap()) }),
    ...(response.sqlErrors === undefined
      ? {}
      : {
          sqlErrors: response.sqlErrors.map((error) => redactString(error, policy, summary)),
        }),
  };
}

/**
 * Devuelve una copia sanitizada. Nunca muta el exchange crudo que Replayer
 * necesita para preservar cookies/tokens durante la corrida.
 */
export function redactExchangeForEvidence(
  exchange: RecordedExchange,
  policyInput: RedactionPolicy = {},
): RedactedEvidence<RecordedExchange> {
  const policy = resolvePolicy(policyInput);
  const summary = emptySummary(policy.replacement);
  return {
    value: {
      request: redactRequest(exchange.request, policy, summary),
      baselineResponse: redactResponse(exchange.baselineResponse, policy, summary),
    },
    redaction: summary,
  };
}

export function redactReplayResultForEvidence(
  result: ReplayResult,
  policyInput: RedactionPolicy = {},
): RedactedEvidence<ReplayResult> {
  const policy = resolvePolicy(policyInput);
  const summary = emptySummary(policy.replacement);
  return {
    value: {
      exchange: {
        request: redactRequest(result.exchange.request, policy, summary),
        baselineResponse: redactResponse(result.exchange.baselineResponse, policy, summary),
      },
      candidateResponse: redactResponse(result.candidateResponse, policy, summary),
      matches: result.matches,
    },
    redaction: summary,
  };
}

export function redactExchangesForEvidence(
  exchanges: readonly RecordedExchange[],
  policyInput: RedactionPolicy = {},
): RedactedEvidence<RecordedExchange[]> {
  const policy = resolvePolicy(policyInput);
  const summary = emptySummary(policy.replacement);
  return {
    value: exchanges.map((exchange) => ({
      request: redactRequest(exchange.request, policy, summary),
      baselineResponse: redactResponse(exchange.baselineResponse, policy, summary),
    })),
    redaction: summary,
  };
}

/** Sanitiza stderr, logs, output tails y mensajes antes de persistirlos. */
export function redactTextForEvidence(
  input: string,
  policyInput: RedactionPolicy = {},
): RedactedEvidence<string> {
  const policy = resolvePolicy(policyInput);
  const summary = emptySummary(policy.replacement);
  return {
    value: redactString(input, policy, summary),
    redaction: summary,
  };
}
