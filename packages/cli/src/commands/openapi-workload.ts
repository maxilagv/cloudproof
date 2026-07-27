import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";

/**
 * Generación de workloads desde OpenAPI (informe 2026-07-18, gate 2 —
 * "el ítem P1 de mayor apalancamiento"). Traduce un spec OpenAPI 3.x a un
 * script Node autocontenido que conduce la app por PROOF_BASE_URL:
 * lecturas primero, escrituras después y una repetición de lecturas al
 * final — así siempre existen probes read-only posteriores a la última
 * escritura, que es lo que el rollback de Proof necesita.
 *
 * Principios:
 *  - Nada se inventa sin evidencia: los cuerpos salen de los schemas del
 *    spec (example/default/enum/tipos), los huecos se REPORTAN como gaps
 *    en vez de rellenarse con magia.
 *  - Datos únicos por corrida: los strings generados llevan el placeholder
 *    {{RUN}} que el script reemplaza por un id por ejecución — las rutas,
 *    en cambio, son deterministas para que coverage.requiredRoutes matchee.
 *  - El script generado es un PUNTO DE PARTIDA editable, no una caja negra.
 */

const SPEC_CANDIDATES = [
  "openapi.json",
  "openapi.yaml",
  "openapi.yml",
  "docs/openapi.json",
  "docs/openapi.yaml",
  "docs/openapi.yml",
  "api/openapi.json",
  "api/openapi.yaml",
  "openapi/openapi.json",
  "openapi/openapi.yaml",
  "swagger.json",
  "swagger.yaml",
];

const METHOD_ORDER = ["get", "head", "post", "put", "patch", "delete"] as const;
const READ_METHODS = new Set(["GET", "HEAD"]);
const MAX_OPERATIONS = 50;
const MAX_SCHEMA_DEPTH = 4;

export interface PlannedStep {
  method: string;
  /** Ruta concreta y determinista (params sintéticos ya rellenados). */
  path: string;
  /** La operación declara seguridad: el script envía AUTH_TOKEN si existe. */
  auth?: boolean;
  body?: unknown;
}

export interface OpenApiWorkloadPlan {
  specPath: string;
  steps: PlannedStep[];
  requiredRoutes: string[];
  rollbackProbeRoutes: string[];
  /** Huecos honestos: qué se saltó o requiere trabajo manual, y por qué. */
  gaps: string[];
}

export interface OpenApiDocument {
  openapi?: string;
  paths?: Record<string, unknown>;
  components?: { schemas?: Record<string, unknown> };
  security?: unknown[];
}

/** Busca un spec OpenAPI 3.x en las ubicaciones convencionales. */
export function findOpenApiSpec(
  cwd: string,
): { path: string; document: OpenApiDocument } | undefined {
  for (const candidate of SPEC_CANDIDATES) {
    const absolute = join(cwd, candidate);
    if (!existsSync(absolute)) continue;
    let parsed: unknown;
    try {
      const raw = readFileSync(absolute, "utf-8").replace(/^\uFEFF/, "");
      parsed = candidate.endsWith(".json") ? JSON.parse(raw) : parseYaml(raw);
    } catch {
      continue;
    }
    if (typeof parsed !== "object" || parsed === null) continue;
    const document = parsed as OpenApiDocument;
    // Solo OpenAPI 3.x: swagger 2.0 modela el body como parameter y no
    // vale la pena una segunda rama de traducción hasta que un repo real
    // lo pida.
    if (typeof document.openapi !== "string" || !document.openapi.startsWith("3")) continue;
    if (typeof document.paths !== "object" || document.paths === null) continue;
    return { path: candidate, document };
  }
  return undefined;
}

/** Resuelve $ref locales (#/components/…) con guardia de ciclos. */
export function resolveRef(document: OpenApiDocument, node: unknown, seen: Set<string>): unknown {
  if (typeof node !== "object" || node === null) return node;
  const ref = (node as { $ref?: unknown }).$ref;
  if (typeof ref !== "string" || !ref.startsWith("#/")) return node;
  if (seen.has(ref)) return {};
  seen.add(ref);
  let target: unknown = document;
  for (const segment of ref.slice(2).split("/")) {
    if (typeof target !== "object" || target === null) return {};
    target = (target as Record<string, unknown>)[segment.replace(/~1/g, "/").replace(/~0/g, "~")];
  }
  return resolveRef(document, target, seen);
}

interface JsonSchema {
  type?: string;
  format?: string;
  example?: unknown;
  default?: unknown;
  enum?: unknown[];
  properties?: Record<string, unknown>;
  required?: string[];
  items?: unknown;
  minimum?: number;
  oneOf?: unknown[];
  anyOf?: unknown[];
  allOf?: unknown[];
}

/**
 * Valor de ejemplo desde un schema, con preferencia por la evidencia del
 * propio spec (example > default > enum) antes que valores sintéticos.
 * Los strings sintéticos llevan {{RUN}} para ser únicos por corrida.
 */
export function exampleFromSchema(
  document: OpenApiDocument,
  rawSchema: unknown,
  depth = 0,
): unknown {
  if (depth > MAX_SCHEMA_DEPTH) return undefined;
  const schema = resolveRef(document, rawSchema, new Set()) as JsonSchema;
  if (typeof schema !== "object" || schema === null) return undefined;
  if (schema.example !== undefined) return schema.example;
  if (schema.default !== undefined) return schema.default;
  if (Array.isArray(schema.enum) && schema.enum.length > 0) return schema.enum[0];
  const composite = schema.oneOf ?? schema.anyOf;
  if (Array.isArray(composite) && composite.length > 0) {
    return exampleFromSchema(document, composite[0], depth + 1);
  }
  if (Array.isArray(schema.allOf) && schema.allOf.length > 0) {
    const merged: Record<string, unknown> = {};
    for (const part of schema.allOf) {
      const value = exampleFromSchema(document, part, depth + 1);
      if (typeof value === "object" && value !== null && !Array.isArray(value)) {
        Object.assign(merged, value);
      }
    }
    return merged;
  }
  switch (schema.type) {
    case "object": {
      const value: Record<string, unknown> = {};
      for (const [name, property] of Object.entries(schema.properties ?? {})) {
        const propertyValue = exampleFromSchema(document, property, depth + 1);
        if (propertyValue !== undefined) value[name] = propertyValue;
      }
      return value;
    }
    case "array": {
      const item = exampleFromSchema(document, schema.items ?? {}, depth + 1);
      return item === undefined ? [] : [item];
    }
    case "integer":
    case "number":
      return schema.minimum ?? 1;
    case "boolean":
      return true;
    case "string":
      switch (schema.format) {
        case "email":
          return "proof-{{RUN}}@example.com";
        case "date-time":
          return "2026-01-01T00:00:00.000Z";
        case "date":
          return "2026-01-01";
        case "uuid":
          return "00000000-0000-4000-8000-000000000000";
        case "uri":
          return "https://example.com/proof";
        default:
          return "proof-{{RUN}}";
      }
    default:
      return schema.properties !== undefined
        ? exampleFromSchema(document, { ...schema, type: "object" }, depth)
        : undefined;
  }
}

interface OperationLike {
  parameters?: unknown[];
  requestBody?: unknown;
  security?: unknown[];
  deprecated?: boolean;
}

/**
 * Valor determinista para un parámetro de ruta/query. A diferencia de los
 * cuerpos, acá NO va {{RUN}}: la ruta debe ser estable para que
 * coverage.requiredRoutes coincida exactamente con lo observado.
 */
function parameterValue(document: OpenApiDocument, parameter: Record<string, unknown>): string {
  const schema = resolveRef(document, parameter["schema"], new Set()) as JsonSchema;
  if (parameter["example"] !== undefined) return String(parameter["example"]);
  if (typeof schema === "object" && schema !== null) {
    if (schema.example !== undefined) return String(schema.example);
    if (Array.isArray(schema.enum) && schema.enum.length > 0) return String(schema.enum[0]);
    if (schema.type === "integer" || schema.type === "number") return "1";
  }
  return "proof-e2e";
}

export function planWorkloadFromOpenApi(
  specPath: string,
  document: OpenApiDocument,
): OpenApiWorkloadPlan {
  const gaps: string[] = [];
  const reads: PlannedStep[] = [];
  const writes: PlannedStep[] = [];
  let operations = 0;
  let skippedNonJson = 0;
  let authOperations = 0;
  let syntheticPathParams = false;

  const globalSecurity = Array.isArray(document.security) && document.security.length > 0;

  for (const [pathTemplate, rawPathItem] of Object.entries(document.paths ?? {})) {
    const pathItem = resolveRef(document, rawPathItem, new Set());
    if (typeof pathItem !== "object" || pathItem === null) continue;
    const pathLevelParameters = Array.isArray((pathItem as OperationLike).parameters)
      ? ((pathItem as OperationLike).parameters as unknown[])
      : [];
    for (const method of METHOD_ORDER) {
      const rawOperation = (pathItem as Record<string, unknown>)[method];
      if (typeof rawOperation !== "object" || rawOperation === null) continue;
      const operation = rawOperation as OperationLike;
      if (operation.deprecated === true) continue;
      if (operations >= MAX_OPERATIONS) {
        const limitGap = `El spec supera las ${MAX_OPERATIONS} operaciones; las restantes no se generaron. Ampliá el script a mano si son relevantes.`;
        if (!gaps.includes(limitGap)) gaps.push(limitGap);
        break;
      }

      const parameters = [...pathLevelParameters, ...(operation.parameters ?? [])]
        .map((parameter) => resolveRef(document, parameter, new Set()))
        .filter(
          (parameter): parameter is Record<string, unknown> =>
            typeof parameter === "object" && parameter !== null,
        );

      let concretePath = pathTemplate;
      for (const parameter of parameters.filter((item) => item["in"] === "path")) {
        const name = String(parameter["name"] ?? "");
        if (name === "") continue;
        syntheticPathParams = true;
        concretePath = concretePath.replace(`{${name}}`, parameterValue(document, parameter));
      }
      if (/\{[^}]+\}/.test(concretePath)) {
        gaps.push(`${method.toUpperCase()} ${pathTemplate}: parámetro de ruta sin declarar; omitido.`);
        continue;
      }
      const requiredQuery = parameters.filter(
        (item) => item["in"] === "query" && item["required"] === true,
      );
      if (requiredQuery.length > 0) {
        const query = requiredQuery
          .map(
            (parameter) =>
              `${encodeURIComponent(String(parameter["name"]))}=${encodeURIComponent(parameterValue(document, parameter))}`,
          )
          .join("&");
        concretePath = `${concretePath}?${query}`;
      }

      let body: unknown;
      const requestBody = resolveRef(document, operation.requestBody, new Set());
      if (typeof requestBody === "object" && requestBody !== null) {
        const content = (requestBody as { content?: Record<string, unknown> }).content ?? {};
        const jsonContent = content["application/json"];
        if (jsonContent === undefined) {
          if (Object.keys(content).length > 0) {
            skippedNonJson += 1;
            gaps.push(
              `${method.toUpperCase()} ${pathTemplate}: requestBody ${Object.keys(content).join("/")} no es JSON; omitido.`,
            );
            continue;
          }
        } else {
          body = exampleFromSchema(
            document,
            (jsonContent as { schema?: unknown }).schema ?? {},
          );
        }
      }

      const operationSecurity = Array.isArray(operation.security)
        ? operation.security.length > 0
        : globalSecurity;
      if (operationSecurity) authOperations += 1;

      const step: PlannedStep = {
        method: method.toUpperCase(),
        path: concretePath,
        ...(operationSecurity ? { auth: true } : {}),
        ...(body === undefined ? {} : { body }),
      };
      (READ_METHODS.has(step.method) ? reads : writes).push(step);
      operations += 1;
    }
  }

  // Escrituras ordenadas por método (POST crea antes de que PUT/DELETE
  // toquen) y una repetición de TODAS las lecturas al final: ese tail es
  // exactamente lo que el rollback A0-después-de-A1 necesita observar.
  const writeRank: Record<string, number> = { POST: 0, PUT: 1, PATCH: 2, DELETE: 3 };
  writes.sort((left, right) => (writeRank[left.method] ?? 9) - (writeRank[right.method] ?? 9));
  const trailingReads = reads.map((step) => ({ ...step }));
  const steps = [...reads, ...writes, ...trailingReads];

  if (authOperations > 0) {
    gaps.push(
      `${authOperations} operación(es) declaran seguridad: configurá fixtures.beforeAll para crear la identidad y exportar AUTH_TOKEN vía PROOF_FIXTURE_ENV; el script lo envía como Bearer si está presente.`,
    );
  }
  if (syntheticPathParams) {
    gaps.push(
      "Los parámetros de ruta se rellenaron con valores sintéticos deterministas; ajustá los que deban referirse a recursos reales creados por el propio workload.",
    );
  }
  if (writes.length === 0) {
    gaps.push(
      "El spec no declara escrituras JSON ejecutables; sin escrituras observables Proof será honestamente INCONCLUSIVE.",
    );
  }
  if (skippedNonJson > 0 && !gaps.some((gap) => gap.includes("no es JSON"))) {
    gaps.push(`${skippedNonJson} operación(es) con cuerpos no-JSON fueron omitidas.`);
  }

  const requiredRoutes = [...new Set(steps.map((step) => `${step.method} ${step.path}`))];
  const rollbackProbeRoutes = [
    ...new Set(trailingReads.map((step) => `${step.method} ${step.path}`)),
  ];
  return { specPath, steps, requiredRoutes, rollbackProbeRoutes, gaps };
}

/** Script Node autocontenido; el único contrato es PROOF_BASE_URL. */
export function renderWorkloadScript(plan: OpenApiWorkloadPlan): string {
  return `#!/usr/bin/env node
// Generado por "proof init" desde ${plan.specPath}.
// Es un punto de partida EDITABLE: Proof reejecuta este workload vía
// PROOF_BASE_URL y compara respuestas y efectos SQL entre versiones.
// Agregá aserciones de negocio y datos realistas cuando quieras — mantené
// las rutas alineadas con coverage.requiredRoutes de proof.config.ts.

const base = process.env.PROOF_BASE_URL;
if (base === undefined || base === "") {
  console.error("PROOF_BASE_URL es obligatorio (lo inyecta proof release verify).");
  process.exit(1);
}

// Datos únicos por corrida: {{RUN}} se reemplaza en los CUERPOS, nunca en
// las rutas (las rutas deben matchear coverage.requiredRoutes).
const runId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const unique = (value) => {
  if (typeof value === "string") return value.split("{{RUN}}").join(runId);
  if (Array.isArray(value)) return value.map(unique);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, unique(v)]));
  }
  return value;
};

// Handoff de fixtures.beforeAll (si está declarado en proof.config.ts).
const authToken = process.env.AUTH_TOKEN;

let serverErrors = 0;
async function call(step) {
  const headers = {};
  if (step.body !== undefined) headers["content-type"] = "application/json";
  if (step.auth === true && authToken !== undefined) {
    headers["authorization"] = \`Bearer \${authToken}\`;
  }
  const response = await fetch(new URL(step.path, base), {
    method: step.method,
    headers,
    ...(step.body === undefined ? {} : { body: JSON.stringify(unique(step.body)) }),
  });
  await response.arrayBuffer();
  console.log(\`\${step.method} \${step.path} -> \${response.status}\`);
  if (response.status >= 500) serverErrors += 1;
}

const PLAN = ${JSON.stringify(plan.steps, null, 2)};

for (const step of PLAN) await call(step);

if (serverErrors > 0) {
  console.error(\`\${serverErrors} respuesta(s) 5xx del baseline.\`);
  process.exit(1);
}
`;
}
