import {
  exampleFromSchema,
  resolveRef,
  type OpenApiDocument,
} from "./openapi-workload.js";

/**
 * Fixtures de identidad HTTP generados desde OpenAPI (informe Lubrisur
 * 2026-07: "no puede completar pruebas de negocio autenticadas si la
 * aplicación no provee un fixture HTTP"). CloudProof no toca la base por diseño
 * — la identidad se crea por la MISMA superficie HTTP observada — así que
 * la mejora es bajar el costo de preparar ese fixture a casi cero:
 *
 *  - `planAuthFixtures` busca EVIDENCIA en el spec: operaciones públicas de
 *    registro/login y la propiedad token declarada en la respuesta del
 *    login. Nada se inventa: sin esa evidencia no se genera script y el
 *    hueco se reporta como gap accionable.
 *  - `renderAuthFixtureScript` emite un cloudproof.fixtures.mjs editable que
 *    cumple el contrato de fixtures.beforeAll: llama por CLOUDPROOF_BASE_URL
 *    (los exchanges quedan como prefijo replayable) y exporta AUTH_TOKEN
 *    vía CLOUDPROOF_FIXTURE_ENV. Falla cerrado: cualquier respuesta no-2xx o un
 *    token ausente abortan la corrida con instrucción concreta.
 */

const LOGIN_PATH = /(log-?in|sign-?in|authenticate|token|session)/i;
const REGISTER_PATH = /(register|sign-?up)/i;
const TOKEN_PROPERTIES = [
  "token",
  "accessToken",
  "access_token",
  "jwt",
  "idToken",
  "id_token",
  "sessionToken",
  "session_token",
];
const MAX_TOKEN_DEPTH = 2;

export interface AuthIssuerStep {
  method: "POST";
  path: string;
  body?: unknown;
}

export interface AuthFixturePlan {
  /** Operaciones del spec que declaran seguridad: la evidencia de que hace falta identidad. */
  authOperations: number;
  /** POST público que crea la identidad, si el spec lo declara. */
  register?: AuthIssuerStep;
  /** POST público cuya respuesta declara una propiedad token. */
  login?: AuthIssuerStep;
  /** Ruta punteada de la propiedad token en la respuesta del login (ej. "data.token"). */
  tokenProperty?: string;
  /** Huecos honestos: qué evidencia faltó y qué debe completarse a mano. */
  gaps: string[];
}

interface OperationLike {
  security?: unknown[];
  deprecated?: boolean;
  requestBody?: unknown;
  responses?: Record<string, unknown>;
}

const METHODS = ["get", "head", "post", "put", "patch", "delete", "options"] as const;

function operationsOf(
  document: OpenApiDocument,
): Array<{ method: string; path: string; operation: OperationLike }> {
  const collected: Array<{ method: string; path: string; operation: OperationLike }> = [];
  for (const [path, rawPathItem] of Object.entries(document.paths ?? {})) {
    const pathItem = resolveRef(document, rawPathItem, new Set());
    if (typeof pathItem !== "object" || pathItem === null) continue;
    for (const method of METHODS) {
      const rawOperation = (pathItem as Record<string, unknown>)[method];
      if (typeof rawOperation !== "object" || rawOperation === null) continue;
      const operation = rawOperation as OperationLike;
      if (operation.deprecated === true) continue;
      collected.push({ method: method.toUpperCase(), path, operation });
    }
  }
  return collected;
}

function requiresAuth(document: OpenApiDocument, operation: OperationLike): boolean {
  if (Array.isArray(operation.security)) return operation.security.length > 0;
  return Array.isArray(document.security) && document.security.length > 0;
}

/** Cuántas operaciones exigen identidad; 0 significa "no hacen falta fixtures de auth". */
export function countAuthOperations(document: OpenApiDocument): number {
  return operationsOf(document).filter(({ operation }) => requiresAuth(document, operation))
    .length;
}

/**
 * Propiedad token (string) declarada en la respuesta 200/201 de una
 * operación, buscada hasta 2 niveles (cubre envoltorios tipo data.token).
 * Devuelve la ruta punteada o undefined: sin evidencia no hay token.
 */
function tokenPropertyOf(
  document: OpenApiDocument,
  operation: OperationLike,
): string | undefined {
  for (const status of ["200", "201"]) {
    const response = resolveRef(document, operation.responses?.[status], new Set());
    if (typeof response !== "object" || response === null) continue;
    const content = (response as { content?: Record<string, unknown> }).content ?? {};
    const json = content["application/json"];
    if (typeof json !== "object" || json === null) continue;
    const found = findTokenProperty(
      document,
      (json as { schema?: unknown }).schema,
      [],
      MAX_TOKEN_DEPTH,
    );
    if (found !== undefined) return found;
  }
  return undefined;
}

function findTokenProperty(
  document: OpenApiDocument,
  rawSchema: unknown,
  prefix: string[],
  depth: number,
): string | undefined {
  if (depth < 0) return undefined;
  const schema = resolveRef(document, rawSchema, new Set());
  if (typeof schema !== "object" || schema === null) return undefined;
  const properties = (schema as { properties?: Record<string, unknown> }).properties ?? {};
  for (const name of TOKEN_PROPERTIES) {
    const property = resolveRef(document, properties[name], new Set());
    if (typeof property !== "object" || property === null) continue;
    const type = (property as { type?: unknown }).type;
    if (type === "string" || type === undefined) return [...prefix, name].join(".");
  }
  for (const [name, property] of Object.entries(properties)) {
    const nested = findTokenProperty(document, property, [...prefix, name], depth - 1);
    if (nested !== undefined) return nested;
  }
  return undefined;
}

function jsonBodyOf(document: OpenApiDocument, operation: OperationLike): unknown {
  const requestBody = resolveRef(document, operation.requestBody, new Set());
  if (typeof requestBody !== "object" || requestBody === null) return undefined;
  const content = (requestBody as { content?: Record<string, unknown> }).content ?? {};
  const json = content["application/json"];
  if (typeof json !== "object" || json === null) return undefined;
  return exampleFromSchema(document, (json as { schema?: unknown }).schema ?? {});
}

export function planAuthFixtures(document: OpenApiDocument): AuthFixturePlan {
  const gaps: string[] = [];
  const authOperations = countAuthOperations(document);
  if (authOperations === 0) return { authOperations, gaps };

  const publicPosts = operationsOf(document).filter(
    ({ method, operation }) => method === "POST" && !requiresAuth(document, operation),
  );

  // Login: POST público con nombre de ruta inequívoco Y token declarado en la
  // respuesta. Exigir ambas señales evita adoptar un endpoint casual que
  // devuelva una propiedad llamada "token".
  const loginCandidates = publicPosts
    .filter(({ path }) => LOGIN_PATH.test(path))
    .map((candidate) => ({
      ...candidate,
      tokenProperty: tokenPropertyOf(document, candidate.operation),
    }))
    .filter(
      (candidate): candidate is typeof candidate & { tokenProperty: string } =>
        candidate.tokenProperty !== undefined,
    )
    .sort((left, right) => left.path.localeCompare(right.path));
  const login = loginCandidates[0];

  const registerCandidate = publicPosts
    .filter(({ path }) => REGISTER_PATH.test(path) && path !== login?.path)
    .sort((left, right) => left.path.localeCompare(right.path))[0];

  if (login === undefined) {
    gaps.push(
      `${authOperations} operación(es) declaran seguridad pero el spec no expone un POST público de login con un token en la respuesta; ` +
        "escribí fixtures.beforeAll a mano (contrato: crear identidad vía CLOUDPROOF_BASE_URL y exportar AUTH_TOKEN en CLOUDPROOF_FIXTURE_ENV). " +
        "Si la app no tiene registro público, sembrá la identidad con fixtures.bootstrapSql (un .sql aplicado tras las migraciones, antes del workload).",
    );
    return { authOperations, gaps };
  }

  const loginBody = jsonBodyOf(document, login.operation);
  const registerBody =
    registerCandidate === undefined ? undefined : jsonBodyOf(document, registerCandidate.operation);
  if (registerCandidate === undefined) {
    gaps.push(
      `El spec no declara un POST público de registro; cloudproof.fixtures.mjs asume que las credenciales de ${login.path} ya existen. ` +
        "Creá el usuario semilla con fixtures.bootstrapSql (INSERT con hash literal, aplicado tras las migraciones) y usá esas credenciales en el login del fixture.",
    );
  }

  return {
    authOperations,
    ...(registerCandidate === undefined
      ? {}
      : {
          register: {
            method: "POST",
            path: registerCandidate.path,
            ...(registerBody === undefined ? {} : { body: registerBody }),
          },
        }),
    login: {
      method: "POST",
      path: login.path,
      ...(loginBody === undefined ? {} : { body: loginBody }),
    },
    tokenProperty: login.tokenProperty,
    gaps,
  };
}

/** Acceso seguro a la ruta punteada del token en el JS emitido (ej. "data.token" → ?.data?.token). */
function tokenAccessExpression(tokenProperty: string): string {
  return `session${tokenProperty
    .split(".")
    .map((segment) => `?.${segment}`)
    .join("")}`;
}

/**
 * Script Node autocontenido para fixtures.beforeAll. Solo se llama cuando el
 * plan tiene login + tokenProperty (evidencia completa); el contrato con el
 * ejecutor es CLOUDPROOF_BASE_URL + CLOUDPROOF_FIXTURE_ENV.
 */
export function renderAuthFixtureScript(plan: AuthFixturePlan, specPath: string): string {
  const login = plan.login;
  const tokenProperty = plan.tokenProperty;
  if (login === undefined || tokenProperty === undefined) {
    throw new Error("renderAuthFixtureScript requiere un plan con login y tokenProperty.");
  }
  const steps = [...(plan.register === undefined ? [] : [plan.register])];
  return `#!/usr/bin/env node
// Generado por "cloudproof init" desde ${specPath}.
// Contrato de fixtures.beforeAll (identidad y datos efímeros ANTES del workload):
//  - Toda preparación pasa por CLOUDPROOF_BASE_URL (el proxy de captura de CloudProof):
//    los exchanges quedan grabados como prefijo replayable de cada celda.
//  - Las variables para el workload (AUTH_TOKEN) se exportan escribiendo
//    líneas KEY=VALUE en el archivo apuntado por CLOUDPROOF_FIXTURE_ENV.
//  - Nunca toca la base de datos: las escrituras deben ser HTTP observables.
// Es un punto de partida EDITABLE: ajustá cuerpos y rutas a tu negocio.

import { appendFileSync } from "node:fs";

const base = process.env.CLOUDPROOF_BASE_URL;
const envFile = process.env.CLOUDPROOF_FIXTURE_ENV;
if (!base || !envFile) {
  console.error("CLOUDPROOF_BASE_URL y CLOUDPROOF_FIXTURE_ENV son obligatorios (los inyecta cloudproof release verify).");
  process.exit(1);
}

// El MISMO runId en registro y login: las credenciales deben coincidir.
const runId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const unique = (value) => {
  if (typeof value === "string") return value.split("{{RUN}}").join(runId);
  if (Array.isArray(value)) return value.map(unique);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, unique(v)]));
  }
  return value;
};

async function call(step) {
  const response = await fetch(new URL(step.path, base), {
    method: step.method,
    headers: step.body === undefined ? {} : { "content-type": "application/json" },
    ...(step.body === undefined ? {} : { body: JSON.stringify(unique(step.body)) }),
  });
  const text = await response.text();
  console.log(\`\${step.method} \${step.path} -> \${response.status}\`);
  if (!response.ok) {
    console.error(\`Fixture falló en \${step.method} \${step.path} (\${response.status}): \${text.slice(0, 500)}\`);
    process.exit(1);
  }
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

${steps.map((step) => `await call(${JSON.stringify(step)});`).join("\n")}
const session = await call(${JSON.stringify(login)});
const token = ${tokenAccessExpression(tokenProperty)};
if (typeof token !== "string" || token === "") {
  console.error(
    "La respuesta de ${login.path} no trajo la propiedad '${tokenProperty}' esperada; ajustá cloudproof.fixtures.mjs a la forma real de la respuesta.",
  );
  process.exit(1);
}
appendFileSync(envFile, \`AUTH_TOKEN=\${token}\\n\`);
`;
}
