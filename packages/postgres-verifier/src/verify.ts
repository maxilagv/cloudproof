import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SpawnRunner,
  type CommandRunner,
  type DatabaseSchemaFingerprint,
  type DockerExecutor,
  type ExecutionProfile,
  type RunningContainer,
  type SqlEffectSnapshot,
} from "@proof/docker-executor";
import {
  Recorder,
  Replayer,
  redactExchangeForEvidence,
  redactTextForEvidence,
  type RecordedExchange,
  type ReplayResult,
} from "@proof/http-recorder";
import {
  deriveConclusion,
  type Approval,
  type Assertion,
  type Conclusion,
  type Coverage,
  type ExecutionState,
  type ProofBundle,
} from "@proof/schema";
import { RELEASE_MATRIX } from "./matrix.js";
import { deriveNextActions } from "./next-actions.js";
import { withRemediation } from "./remediation.js";

export interface WorkloadSpec {
  command: string;
  args?: string[];
}

export interface FixtureSpec {
  command: string;
  args?: string[];
  timeoutMs?: number;
}

/**
 * Contrato de fixtures (informe 2026-07-18, gate 2): `beforeAll` corre a
 * través del MISMO proxy de captura que el workload, antes que él. Sus
 * exchanges quedan grabados como prefijo replayable — cada celda de la
 * matriz recrea identidad/datos al hacer replay del prefijo — y puede
 * entregar variables al workload (p.ej. un token) escribiendo KEY=VALUE en
 * el archivo apuntado por PROOF_FIXTURE_ENV.
 */
export interface FixturesSpec {
  beforeAll?: FixtureSpec;
}

export interface VerifyApproval {
  assertionId: string;
  reason: string;
  expiresAt?: string;
}

export interface VerifyInput {
  baseSha: string;
  headSha: string;
  serviceName?: string;
  servicePath: string;
  servicePort?: number;
  prismaSchema?: string;
  serviceDockerfile?: string;
  serviceBuildContext?: string;
  serviceBuildArgs?: Record<string, string>;
  serviceEnv?: Record<string, string>;
  runner: string;
  cwd?: string;
  workload?: WorkloadSpec;
  workloadTimeoutMs?: number;
  fixtures?: FixturesSpec;
  /** Universo obligatorio. Sin declaración, Proof nunca concluye VERIFIED. */
  requiredRoutes?: string[];
  /** GET/HEAD/OPTIONS capturados después de la última escritura. */
  rollbackProbeRoutes?: string[];
  approvals?: VerifyApproval[];
  executionProfile?: ExecutionProfile;
}

const WRITE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const READ_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

const MATRIX_OBLIGATIONS: Record<ExecutionState, readonly string[]> = {
  BUILD_A0: ["image"],
  BUILD_A1: ["image"],
  A0_S0: ["baseline", "checkpoint"],
  A1_S0: ["clean-replay"],
  MIGRATE_S0_TO_S1: ["clean", "populated"],
  A0_S1: ["clean-replay", "populated-observation"],
  COEXIST_A0_A1_S1: ["a0-first", "a1-first"],
  A1_S1: ["clean-replay", "populated-observation"],
  ROLLBACK_A0_AFTER_A1_WRITES: ["a1-write-prefix", "a0-read-tail"],
  SQL_EFFECTS: ["aggregate"],
};

export function finalConclusion(
  assertions: Pick<Assertion, "id" | "result" | "mandatory" | "approval">[],
  coverage: Coverage,
  observedMethods: string[],
): Conclusion {
  const baseline = assertions.find((assertion) => assertion.id === "workload.baseline");
  if (baseline?.result === "fail") return "INCONCLUSIVE";
  const base = deriveConclusion(assertions, coverage);
  if (base !== "VERIFIED") return base;
  const executionComplete = assertions.some(
    (assertion) => assertion.id === "proof.execution-complete" && assertion.result === "pass",
  );
  if (!executionComplete) return "INCONCLUSIVE";
  return observedMethods.some((method) => WRITE_METHODS.has(method.toUpperCase()))
    ? "VERIFIED"
    : "INCONCLUSIVE";
}

function routeSlug(method: string, path: string): string {
  const canonical = `${method.toUpperCase()}\u0000${path}`;
  const readable = `${method} ${path}`
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  const digest = createHash("sha256").update(canonical).digest("hex").slice(0, 12);
  return `${readable === "" ? "root" : readable}-${digest}`;
}

function activeApproval(
  id: string,
  approvals: VerifyApproval[],
  now = Date.now(),
): Approval | undefined {
  const configured = approvals.find((approval) => approval.assertionId === id);
  if (configured === undefined) return undefined;
  if (configured.expiresAt !== undefined) {
    const expiresAt = Date.parse(configured.expiresAt);
    if (!Number.isFinite(expiresAt) || expiresAt <= now) return undefined;
  }
  return {
    reason: configured.reason,
    ...(configured.expiresAt === undefined ? {} : { expiresAt: configured.expiresAt }),
  };
}

function applyApproval(assertion: Assertion, approvals: VerifyApproval[]): Assertion {
  if (assertion.result !== "fail") return assertion;
  const approval = activeApproval(assertion.id, approvals);
  return approval === undefined ? assertion : { ...assertion, approval };
}

export interface RouteAssertionOptions {
  idPrefix?: string;
  state?: ExecutionState;
  label?: string;
}

/** Agrupa por ruta y conserva solo un exchange ya redactado para reproducción. */
export function routeAssertions(
  results: ReplayResult[],
  approvals: VerifyApproval[] = [],
  options: RouteAssertionOptions = {},
): Assertion[] {
  const idPrefix = options.idPrefix ?? "postgres.old-app-new-schema";
  const state = options.state ?? "A0_S1";
  const label = options.label ?? "A0 sobre S1";
  const groups = new Map<
    string,
    { method: string; path: string; total: number; failures: ReplayResult[] }
  >();
  for (const result of results) {
    const method = result.exchange.request.method.toUpperCase();
    const path = result.exchange.request.path;
    const key = `${method}\u0000${path}`;
    const group = groups.get(key) ?? { method, path, total: 0, failures: [] };
    group.total += 1;
    if (!result.matches) group.failures.push(result);
    groups.set(key, group);
  }

  return [...groups.values()].map((group): Assertion => {
    const id = `${idPrefix}.${routeSlug(group.method, group.path)}`;
    const firstFailure = group.failures[0];
    if (firstFailure === undefined) {
      return {
        id,
        result: "pass",
        mandatory: true,
        evidence: [`${label}: ${group.method} ${group.path} matched ${group.total}/${group.total}.`],
        state,
      };
    }

    const sqlErrors = [
      ...new Set(group.failures.flatMap((failure) => failure.candidateResponse.sqlErrors ?? [])),
    ]
      .map((line) => redactTextForEvidence(line).value)
      .slice(0, 5);
    const evidence = [
      `${label}: ${group.method} ${group.path} failed ${group.failures.length}/${group.total}.`,
      `HTTP ${firstFailure.candidateResponse.status} (baseline ${firstFailure.exchange.baselineResponse.status}).`,
      ...sqlErrors,
    ];
    const safeExchange = redactExchangeForEvidence(firstFailure.exchange);
    if (safeExchange.redaction.totalRedactions > 0) {
      evidence.push(
        `Privacy redaction ${safeExchange.redaction.policyId}: ${safeExchange.redaction.totalRedactions} value(s) masked.`,
      );
    }
    if (
      sqlErrors.length === 0 &&
      firstFailure.candidateResponse.status === firstFailure.exchange.baselineResponse.status
    ) {
      evidence.push("La respuesta difiere del baseline con el mismo status HTTP.");
    }
    return applyApproval(
      {
        id,
        result: "fail",
        mandatory: true,
        evidence,
        state,
        reproduction: `proof reproduce ${id}`,
        reproductionContext: {
          kind: "live-state",
          state,
          exchange: safeExchange.value,
        },
      },
      approvals,
    );
  });
}

const FIXTURE_ENVIRONMENT_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const FIXTURE_ENVIRONMENT_LIMIT = 64;

/**
 * Parser del archivo PROOF_FIXTURE_ENV: líneas KEY=VALUE, comentarios con #.
 * Solo acepta nombres de entorno válidos y descarta reservados: el fixture
 * no puede redirigir el workload (PROOF_BASE_URL) ni inyectar flags al
 * runtime del host (NODE_OPTIONS, PATH). Los valores con saltos de línea son
 * imposibles por construcción (una línea = una variable).
 */
export function parseFixtureEnvironment(contents: string): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const line of contents.split("\n")) {
    if (Object.keys(environment).length >= FIXTURE_ENVIRONMENT_LIMIT) break;
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    const separator = trimmed.indexOf("=");
    if (separator <= 0) continue;
    const name = trimmed.slice(0, separator).trim();
    const value = trimmed.slice(separator + 1);
    if (!FIXTURE_ENVIRONMENT_NAME.test(name)) continue;
    const upper = name.toUpperCase();
    if (upper === "PROOF_BASE_URL" || upper === "PROOF_FIXTURE_ENV") continue;
    if (upper === "NODE_OPTIONS" || upper === "PATH") continue;
    if (value.includes("\u0000") || value.includes("\r")) continue;
    environment[name] = value;
  }
  return environment;
}

function outputTail(output: string, lines: number): string[] {
  return redactTextForEvidence(output)
    .value.split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(-lines);
}

function errorEvidence(error: unknown): string[] {
  const message = error instanceof Error ? error.message : String(error);
  const structured =
    typeof error === "object" &&
    error !== null &&
    "evidence" in error &&
    Array.isArray((error as { evidence?: unknown }).evidence)
      ? (error as { evidence: unknown[] }).evidence.filter(
          (item): item is string => typeof item === "string",
        )
      : [];
  return [message.split("\n")[0] ?? message, ...structured]
    .map((line) => redactTextForEvidence(line).value)
    .filter(Boolean)
    .slice(0, 20);
}

function normalizeRoute(route: string): string {
  const [method = "", ...path] = route.trim().split(/\s+/);
  return `${method.toUpperCase()} ${path.join(" ")}`;
}

function routeOf(exchange: RecordedExchange): string {
  return normalizeRoute(`${exchange.request.method} ${exchange.request.path}`);
}

function coverageFor(
  exchanges: RecordedExchange[],
  requiredRoutes: string[] | undefined,
): { coverage: Coverage; assertions: Assertion[]; missingRoutes: string[] } {
  const observed = new Set(exchanges.map(routeOf));
  if (requiredRoutes === undefined) {
    return {
      coverage: {
        routesObserved: observed.size,
        routesDetected: 0,
        routesRequired: 0,
        source: "unknown",
        complete: false,
      },
      assertions: [
        {
          id: "coverage.routes-declared",
          result: "skipped",
          mandatory: true,
          evidence: ["No se declaró coverage.requiredRoutes; la cobertura es desconocida."],
        },
      ],
      missingRoutes: [],
    };
  }
  const required = [...new Set(requiredRoutes.map(normalizeRoute))];
  const missing = required.filter((route) => !observed.has(route));
  return {
    coverage: {
      routesObserved: observed.size,
      routesDetected: required.length,
      routesRequired: required.length,
      source: "declared",
      complete: missing.length === 0,
    },
    assertions: missing.map((route) => {
      const [method = "", ...path] = route.split(" ");
      return {
        id: `coverage.route.${routeSlug(method, path.join(" "))}`,
        result: "skipped" as const,
        mandatory: true,
        evidence: [`La ruta obligatoria ${route} no fue ejercitada por el workload.`],
      };
    }),
    missingRoutes: missing,
  };
}

interface EffectDelta {
  table: string;
  inserted: number;
  updated: number;
  deleted: number;
}

function effectDelta(before: SqlEffectSnapshot, after: SqlEffectSnapshot): EffectDelta[] {
  const beforeByTable = new Map(before.tables.map((table) => [table.table, table]));
  const afterByTable = new Map(after.tables.map((table) => [table.table, table]));
  const names = [...new Set([...beforeByTable.keys(), ...afterByTable.keys()])].sort();
  return names
    .map((table) => {
      const left = beforeByTable.get(table);
      const right = afterByTable.get(table);
      return {
        table,
        inserted: (right?.inserted ?? 0) - (left?.inserted ?? 0),
        updated: (right?.updated ?? 0) - (left?.updated ?? 0),
        deleted: (right?.deleted ?? 0) - (left?.deleted ?? 0),
      };
    })
    .filter((delta) => delta.inserted !== 0 || delta.updated !== 0 || delta.deleted !== 0);
}

function describeEffects(effects: EffectDelta[]): string[] {
  return effects.map(
    (effect) =>
      `${effect.table}: +${effect.inserted} insert, +${effect.updated} update, +${effect.deleted} delete`,
  );
}

interface SqlEffectAssertionOptions {
  id: string;
  state: ExecutionState;
  candidateLabel: string;
  requireBaselineWrites?: boolean;
}

function sqlEffectAssertion(
  baselineBefore: SqlEffectSnapshot | undefined,
  baselineAfter: SqlEffectSnapshot | undefined,
  candidateBefore: SqlEffectSnapshot | undefined,
  candidateAfter: SqlEffectSnapshot | undefined,
  approvals: VerifyApproval[],
  options: SqlEffectAssertionOptions,
): Assertion {
  if (
    baselineBefore === undefined ||
    baselineAfter === undefined ||
    candidateBefore === undefined ||
    candidateAfter === undefined
  ) {
    return {
      id: options.id,
      result: "skipped",
      mandatory: true,
      state: options.state,
      evidence: ["No fue posible capturar ambos puntos de corte SQL."],
    };
  }
  const baseline = effectDelta(baselineBefore, baselineAfter);
  const candidate = effectDelta(candidateBefore, candidateAfter);
  if ((options.requireBaselineWrites ?? true) && baseline.length === 0) {
    return {
      id: options.id,
      result: "skipped",
      mandatory: true,
      state: options.state,
      evidence: ["El workload baseline no produjo escrituras PostgreSQL observables."],
    };
  }
  if (JSON.stringify(baseline) === JSON.stringify(candidate)) {
    return {
      id: options.id,
      result: "pass",
      mandatory: true,
      state: options.state,
      evidence:
        candidate.length === 0
          ? [`${options.candidateLabel}: sin escrituras observables.`]
          : describeEffects(candidate)
              .map((line) => `${options.candidateLabel} ${line}`)
              .slice(0, 10),
    };
  }
  return applyApproval(
    {
      id: options.id,
      result: "fail",
      mandatory: true,
      state: options.state,
      evidence: [
        "Los efectos SQL observables difieren del baseline.",
        ...describeEffects(baseline).map((line) => `baseline ${line}`),
        ...describeEffects(candidate).map((line) => `${options.candidateLabel} ${line}`),
      ].slice(0, 20),
      reproduction: `proof reproduce ${options.id}`,
      reproductionContext: { kind: "rerun-proof", state: options.state },
    },
    approvals,
  );
}

function zeroSqlEffectsAssertion(
  id: string,
  state: ExecutionState,
  before: SqlEffectSnapshot | undefined,
  after: SqlEffectSnapshot | undefined,
  approvals: VerifyApproval[],
  label: string,
): Assertion {
  if (before === undefined || after === undefined) {
    return {
      id,
      result: "skipped",
      mandatory: true,
      state,
      evidence: [`No se capturaron los efectos SQL de ${label}.`],
    };
  }
  const delta = effectDelta(before, after);
  if (delta.length === 0) {
    return {
      id,
      result: "pass",
      mandatory: true,
      state,
      evidence: [`${label} no produjo escrituras observables.`],
    };
  }
  return applyApproval(
    {
      id,
      result: "fail",
      mandatory: true,
      state,
      evidence: [`${label} debía ser read-only.`, ...describeEffects(delta)].slice(0, 20),
    },
    approvals,
  );
}

interface SchemaFingerprintCapture {
  fingerprint?: DatabaseSchemaFingerprint;
  errorEvidence?: string[];
}

function schemaStableAssertion(
  id: string,
  state: ExecutionState,
  before: SchemaFingerprintCapture,
  after: SchemaFingerprintCapture,
  approvals: VerifyApproval[],
): Assertion {
  if (before.fingerprint === undefined || after.fingerprint === undefined) {
    return {
      id,
      result: "skipped",
      mandatory: true,
      state,
      evidence: [
        "No se pudo fingerprintar pg_catalog en ambos puntos de corte.",
        ...(before.errorEvidence ?? []),
        ...(after.errorEvidence ?? []),
      ].slice(0, 20),
    };
  }
  if (before.fingerprint.digest === after.fingerprint.digest) {
    return {
      id,
      result: "pass",
      mandatory: true,
      state,
      evidence: [`Schema estable: ${before.fingerprint.digest}.`],
    };
  }
  return applyApproval(
    {
      id,
      result: "fail",
      mandatory: true,
      state,
      evidence: [
        `El schema cambió dentro de la celda (${before.fingerprint.digest} -> ${after.fingerprint.digest}); el estado declarado dejó de ser válido.`,
      ],
      reproduction: `proof reproduce ${id}`,
      reproductionContext: { kind: "rerun-proof", state },
    },
    approvals,
  );
}

function replayCardinalityAssertion(
  id: string,
  state: ExecutionState,
  expected: number,
  results: ReplayResult[],
  approvals: VerifyApproval[],
): Assertion {
  const assertion: Assertion = {
    id,
    result: results.length === expected ? "pass" : "fail",
    mandatory: true,
    state,
    evidence: [`Replay cardinality: expected ${expected}, produced ${results.length}.`],
  };
  return assertion.result === "fail" ? applyApproval(assertion, approvals) : assertion;
}

function stageFailure(
  id: string,
  state: ExecutionState,
  error: unknown,
  approvals: VerifyApproval[],
  inconclusive = false,
): Assertion {
  const assertion: Assertion = {
    id,
    result: inconclusive ? "skipped" : "fail",
    mandatory: true,
    state,
    evidence: errorEvidence(error),
    reproduction: `proof reproduce ${id}`,
    reproductionContext: { kind: "rerun-proof", state },
  };
  return inconclusive ? assertion : applyApproval(assertion, approvals);
}

function aggregateReplayAssertion(
  id: string,
  state: ExecutionState,
  results: ReplayResult[],
  expected: number,
  approvals: VerifyApproval[],
  passEvidence: string,
): Assertion {
  const complete = results.length === expected;
  const matches = complete && results.every((result) => result.matches);
  return applyApproval(
    {
      id,
      result: matches ? "pass" : "fail",
      mandatory: true,
      state,
      evidence: matches
        ? [passEvidence]
        : [
            `Replay incompleto o divergente: ${results.filter((result) => result.matches).length}/${expected} coincidieron.`,
          ],
    },
    approvals,
  );
}

export async function verifyRelease(
  input: VerifyInput,
  executor: DockerExecutor,
  workloadRunner?: CommandRunner,
): Promise<ProofBundle> {
  const effectiveWorkloadRunner =
    input.workload === undefined
      ? undefined
      : (workloadRunner ??
        new SpawnRunner({
          ...(input.executionProfile === undefined
            ? {}
            : { executionProfile: input.executionProfile }),
          role: "workload",
        }));
  const assertions: Assertion[] = [];
  const started: RunningContainer[] = [];
  const artifacts: string[] = [];
  const approvals = input.approvals ?? [];
  const effectAssertions: Assertion[] = [];
  const completed = new Map<ExecutionState, Set<string>>();
  if (input.executionProfile !== undefined) artifacts.push(`execution-profile=${input.executionProfile}`);

  let recorder: Recorder | undefined;
  let exchanges: RecordedExchange[] = [];
  let missingRoutes: string[] = [];
  let coverage: Coverage = {
    routesObserved: 0,
    routesDetected: input.requiredRoutes?.length ?? 0,
    routesRequired: input.requiredRoutes?.length ?? 0,
    source: input.requiredRoutes === undefined ? "unknown" : "declared",
    complete: false,
  };

  const mark = (state: ExecutionState, obligation: string): void => {
    const values = completed.get(state) ?? new Set<string>();
    values.add(obligation);
    completed.set(state, values);
  };
  const missingObligations = (): string[] =>
    RELEASE_MATRIX.flatMap((entry) =>
      MATRIX_OBLIGATIONS[entry.id]
        .filter((obligation) => !completed.get(entry.id)?.has(obligation))
        .map((obligation) => `${entry.id}:${obligation}`),
    );

  const bundle = (): ProofBundle => {
    const counts = new Map<string, number>();
    for (const assertion of assertions) counts.set(assertion.id, (counts.get(assertion.id) ?? 0) + 1);
    const duplicates = [...counts.entries()].filter(([, count]) => count > 1).map(([id]) => id);
    const finalized =
      duplicates.length === 0
        ? assertions
        : [
            ...assertions,
            {
              id: "proof.assertion-ids-unique",
              result: "fail" as const,
              mandatory: true,
              state: "SQL_EFFECTS" as const,
              evidence: [`Assertion ids duplicados: ${duplicates.slice(0, 10).join(", ")}.`],
            },
          ];
    const enriched = finalized.map(withRemediation);
    const observedMethods = exchanges.map((exchange) => exchange.request.method);
    const conclusion = finalConclusion(enriched, coverage, observedMethods);
    return {
      version: "1",
      subject: {
        baseSha: input.baseSha,
        headSha: input.headSha,
        ...(input.serviceName === undefined
          ? {}
          : { service: { name: input.serviceName, path: input.servicePath } }),
      },
      conclusion,
      assertions: enriched,
      coverage,
      provenance: {
        runner: input.runner,
        artifacts,
        createdAt: new Date().toISOString(),
        environment: {
          node: process.versions.node,
          platform: process.platform,
          arch: process.arch,
        },
        // Sondas de readiness y reintentos transitorios del ejecutor: un
        // transitorio reintentado queda en la evidencia, no desaparece.
        ...(() => {
          const attempts = executor.attemptLog?.() ?? [];
          return attempts.length === 0 ? {} : { executorAttempts: [...attempts] };
        })(),
      },
      nextActions: deriveNextActions(enriched, coverage, conclusion, {
        workloadDeclared: input.workload !== undefined,
        observedExchanges: exchanges.length,
        observedWrites: observedMethods.some((method) => WRITE_METHODS.has(method.toUpperCase())),
        missingRoutes,
      }),
    };
  };

  const pgSpec = (sha: string, label: "S0" | "S1", cloneFromContainerId?: string) => ({
    label,
    migrationsUpToSha: sha,
    servicePath: input.servicePath,
    ...(input.prismaSchema === undefined ? {} : { prismaSchema: input.prismaSchema }),
    ...(cloneFromContainerId === undefined ? {} : { cloneFromContainerId }),
  });
  const appEnv = (databaseUrl: string): Record<string, string> => ({
    ...(input.serviceEnv ?? {}),
    DATABASE_URL: databaseUrl,
    ...(input.servicePort === undefined ? {} : { PORT: String(input.servicePort) }),
  });
  const buildExtras = {
    ...(input.serviceDockerfile === undefined ? {} : { dockerfile: input.serviceDockerfile }),
    ...(input.serviceBuildContext === undefined
      ? {}
      : { buildContext: input.serviceBuildContext }),
    ...(input.serviceBuildArgs === undefined ? {} : { buildArgs: input.serviceBuildArgs }),
  };
  const httpOptions =
    input.executionProfile === undefined ? {} : { executionProfile: input.executionProfile };

  const untrack = (containerId: string): void => {
    const index = started.findIndex((container) => container.id === containerId);
    if (index >= 0) started.splice(index, 1);
  };
  const teardownTracked = async (container: RunningContainer): Promise<boolean> => {
    try {
      await executor.teardown(container.id);
      untrack(container.id);
      return true;
    } catch {
      return false;
    }
  };
  const captureEffects = async (
    database: RunningContainer,
  ): Promise<SqlEffectSnapshot | undefined> => {
    try {
      return await executor.captureSqlEffects(database.id);
    } catch {
      return undefined;
    }
  };
  const captureSchema = async (
    database: RunningContainer,
  ): Promise<SchemaFingerprintCapture> => {
    try {
      return { fingerprint: await executor.captureSchemaFingerprint(database.id) };
    } catch (error) {
      return { errorEvidence: errorEvidence(error) };
    }
  };
  const startClone = async (
    source: RunningContainer,
    sha: string,
    label: "S0" | "S1",
  ): Promise<RunningContainer> => {
    const database = await executor.startEphemeralPostgres(pgSpec(sha, label, source.id));
    started.push(database);
    return database;
  };

  let baselinePreStart: SqlEffectSnapshot | undefined;
  let baselinePostStart: SqlEffectSnapshot | undefined;
  let baselinePostWorkload: SqlEffectSnapshot | undefined;

  try {
    let baseImage: string;
    let candidateImage: string;
    try {
      baseImage = await executor.buildImage({
        sha: input.baseSha,
        servicePath: input.servicePath,
        ...buildExtras,
      });
      const digest = await executor.imageDigest(baseImage);
      artifacts.push(`A0=${digest}`);
      assertions.push({
        id: "build.base",
        result: "pass",
        mandatory: true,
        state: "BUILD_A0",
        evidence: [digest],
      });
      mark("BUILD_A0", "image");
    } catch (error) {
      assertions.push(stageFailure("build.base", "BUILD_A0", error, approvals, true));
      return bundle();
    }
    try {
      candidateImage = await executor.buildImage({
        sha: input.headSha,
        servicePath: input.servicePath,
        ...buildExtras,
      });
      const digest = await executor.imageDigest(candidateImage);
      artifacts.push(`A1=${digest}`);
      assertions.push({
        id: "build.candidate",
        result: "pass",
        mandatory: true,
        state: "BUILD_A1",
        evidence: [digest],
      });
      mark("BUILD_A1", "image");
    } catch (error) {
      assertions.push(stageFailure("build.candidate", "BUILD_A1", error, approvals));
      return bundle();
    }

    let seedS0: RunningContainer;
    let baselineDb: RunningContainer;
    try {
      seedS0 = await executor.startEphemeralPostgres(pgSpec(input.baseSha, "S0"));
      started.push(seedS0);
      baselineDb = await startClone(seedS0, input.baseSha, "S0");
      assertions.push({
        id: "postgres.baseline-schema",
        result: "pass",
        mandatory: true,
        state: "A0_S0",
        evidence: ["S0 baseline fue clonado desde un seed inmutable."],
      });
    } catch (error) {
      assertions.push(stageFailure("postgres.baseline-schema", "A0_S0", error, approvals, true));
      return bundle();
    }

    const baselineSchemaBefore = await captureSchema(baselineDb);
    baselinePreStart = await captureEffects(baselineDb);
    let baselineApp: RunningContainer;
    try {
      baselineApp = await executor.startApp(baseImage, appEnv(baselineDb.connectionUrl ?? ""));
      started.push(baselineApp);
      assertions.push({
        id: "postgres.baseline.startup",
        result: "pass",
        mandatory: true,
        state: "A0_S0",
        evidence: ["A0 alcanzó readiness sobre S0."],
      });
    } catch (error) {
      assertions.push(stageFailure("workload.baseline", "A0_S0", error, approvals, true));
      return bundle();
    }
    const baselineSchemaAfterStart = await captureSchema(baselineDb);
    baselinePostStart = await captureEffects(baselineDb);
    const baselineSchemaAssertion = schemaStableAssertion(
      "postgres.baseline.schema-stable",
      "A0_S0",
      baselineSchemaBefore,
      baselineSchemaAfterStart,
      approvals,
    );
    assertions.push(baselineSchemaAssertion);
    if (baselineSchemaAssertion.result !== "pass") {
      await teardownTracked(baselineApp);
      return bundle();
    }

    let baselineBroken = false;
    if (input.workload === undefined) {
      assertions.push({
        id: "workload.baseline",
        result: "skipped",
        mandatory: true,
        state: "A0_S0",
        evidence: ["No se declaró workload; no existe tráfico atribuible para la matriz."],
      });
      await teardownTracked(baselineApp);
      return bundle();
    }
    recorder = new Recorder({ targetUrl: baselineApp.connectionUrl ?? "", ...httpOptions });
    try {
      const proxyUrl = await recorder.start();

      // Fixtures HTTP: corren ANTES del workload contra el mismo proxy. Sus
      // exchanges son un prefijo replayable — así cada celda de la matriz
      // recrea identidad/datos — y su env exportado (token, ids) llega al
      // workload sin que el workload sepa cómo autenticarse.
      let fixtureEnvironment: Record<string, string> = {};
      let fixturesBroken = false;
      if (input.fixtures?.beforeAll !== undefined) {
        const fixture = input.fixtures.beforeAll;
        const fixtureDirectory = mkdtempSync(join(tmpdir(), "proof-fixtures-"));
        const fixtureEnvPath = join(fixtureDirectory, "fixture.env");
        try {
          const fixtureResult = await effectiveWorkloadRunner!.run(
            fixture.command,
            fixture.args ?? [],
            {
              cwd: input.cwd ?? process.cwd(),
              env: { PROOF_BASE_URL: proxyUrl, PROOF_FIXTURE_ENV: fixtureEnvPath },
              timeoutMs: fixture.timeoutMs ?? 300_000,
            },
          );
          const fixtureExchangeCount = recorder.getExchanges().length;
          const fixtureEffects = await captureEffects(baselineDb);
          if (fixtureResult.exitCode !== 0) {
            fixturesBroken = true;
            assertions.push({
              id: "workload.fixtures",
              result: "skipped",
              mandatory: true,
              state: "A0_S0",
              evidence: [
                `fixtures.beforeAll salió con código ${fixtureResult.exitCode}; el entorno no quedó preparado y ningún resultado es atribuible.`,
                ...outputTail(`${fixtureResult.stdout}\n${fixtureResult.stderr}`, 8),
              ],
            });
          } else {
            fixtureEnvironment = existsSync(fixtureEnvPath)
              ? parseFixtureEnvironment(readFileSync(fixtureEnvPath, "utf-8"))
              : {};
            const handedOff = Object.keys(fixtureEnvironment).sort();
            assertions.push({
              id: "workload.fixtures",
              result: "pass",
              mandatory: true,
              state: "A0_S0",
              evidence: [
                `fixtures.beforeAll grabó ${fixtureExchangeCount} exchange(s) como prefijo replayable del workload.`,
                // Solo NOMBRES de variables: los valores (tokens) jamás
                // entran a la evidencia.
                ...(handedOff.length === 0
                  ? []
                  : [
                      `${handedOff.length} variable(s) entregadas al workload vía PROOF_FIXTURE_ENV: ${handedOff.slice(0, 10).join(", ")}.`,
                    ]),
                ...(baselinePostStart !== undefined && fixtureEffects !== undefined
                  ? describeEffects(effectDelta(baselinePostStart, fixtureEffects)).map(
                      (line) => `fixtures ${line}`,
                    )
                  : []),
              ].slice(0, 20),
            });
          }
        } finally {
          rmSync(fixtureDirectory, { recursive: true, force: true });
        }
      }
      if (fixturesBroken) {
        exchanges = recorder.stop();
        recorder = undefined;
        baselineBroken = true;
      } else {
        const workloadResult = await effectiveWorkloadRunner!.run(
          input.workload.command,
          input.workload.args ?? [],
          {
            cwd: input.cwd ?? process.cwd(),
            // El env del fixture nunca puede pisar PROOF_BASE_URL: el orden
            // del spread lo garantiza además del filtro del parser.
            env: { ...fixtureEnvironment, PROOF_BASE_URL: proxyUrl },
            timeoutMs: input.workloadTimeoutMs ?? 600_000,
          },
        );
        exchanges = recorder.stop();
        recorder = undefined;
        const unhealthy = exchanges.filter(
          (exchange) =>
            exchange.baselineResponse.status >= 500 ||
            (exchange.baselineResponse.sqlErrors?.length ?? 0) > 0,
        );
        baselineBroken = workloadResult.exitCode !== 0 || unhealthy.length > 0;
        assertions.push({
          id: "workload.baseline",
          result: baselineBroken ? "fail" : "pass",
          mandatory: true,
          state: "A0_S0",
          evidence: baselineBroken
            ? [
                `Workload exit=${workloadResult.exitCode}; respuestas baseline no saludables=${unhealthy.length}.`,
                ...outputTail(`${workloadResult.stdout}\n${workloadResult.stderr}`, 8),
              ]
            : [`${exchanges.length} exchange(s) capturados sin HTTP 5xx ni error SQL observable.`],
          ...(baselineBroken
            ? {
                reproduction: "proof reproduce workload.baseline",
                reproductionContext: { kind: "rerun-proof" as const, state: "A0_S0" as const },
              }
            : {}),
        });
      }
    } catch (error) {
      if (recorder !== undefined) {
        try {
          exchanges = recorder.stop();
        } catch {
          exchanges = [];
        }
        recorder = undefined;
      }
      baselineBroken = true;
      assertions.push(stageFailure("workload.baseline", "A0_S0", error, approvals, true));
    }
    const baselineCleanup = await teardownTracked(baselineApp);
    if (!baselineCleanup) {
      baselineBroken = true;
      assertions.push({
        id: "postgres.baseline.cleanup",
        result: "skipped",
        mandatory: true,
        state: "A0_S0",
        evidence: ["A0 no terminó limpiamente; los contadores SQL pueden estar incompletos."],
      });
    }
    baselinePostWorkload = await captureEffects(baselineDb);
    const coverageResult = coverageFor(exchanges, input.requiredRoutes);
    coverage = coverageResult.coverage;
    missingRoutes = coverageResult.missingRoutes;
    assertions.push(...coverageResult.assertions);
    if (
      baselineSchemaBefore.fingerprint !== undefined &&
      baselineSchemaAfterStart.fingerprint !== undefined &&
      baselinePreStart !== undefined &&
      baselinePostStart !== undefined &&
      baselinePostWorkload !== undefined &&
      baselineCleanup &&
      !baselineBroken
    ) {
      mark("A0_S0", "baseline");
    }
    if (baselineBroken || exchanges.length === 0) return bundle();

    let lastWriteIndex = -1;
    exchanges.forEach((exchange, index) => {
      if (WRITE_METHODS.has(exchange.request.method.toUpperCase())) lastWriteIndex = index;
    });
    if (lastWriteIndex < 0) {
      assertions.push({
        id: "workload.write-observed",
        result: "skipped",
        mandatory: true,
        state: "A0_S0",
        evidence: ["El workload no produjo ningún método HTTP de escritura."],
      });
      return bundle();
    }
    assertions.push({
      id: "workload.write-observed",
      result: "pass",
      mandatory: true,
      state: "A0_S0",
      evidence: [`Última escritura capturada en el ordinal ${lastWriteIndex}.`],
    });
    const preparationExchanges = exchanges.slice(0, lastWriteIndex + 1);
    const trailingReads = exchanges
      .slice(lastWriteIndex + 1)
      .filter((exchange) => READ_METHODS.has(exchange.request.method.toUpperCase()));
    const declaredProbes = input.rollbackProbeRoutes?.map(normalizeRoute);
    const probeSet = declaredProbes === undefined ? undefined : new Set(declaredProbes);
    const observationProbes =
      probeSet === undefined
        ? trailingReads
        : trailingReads.filter((exchange) => probeSet.has(routeOf(exchange)));
    const missingProbes =
      declaredProbes?.filter(
        (route) => !observationProbes.some((exchange) => routeOf(exchange) === route),
      ) ?? [];
    assertions.push({
      id: "postgres.rollback.probes-available",
      result: observationProbes.length > 0 && missingProbes.length === 0 ? "pass" : "skipped",
      mandatory: true,
      state: "ROLLBACK_A0_AFTER_A1_WRITES",
      evidence:
        observationProbes.length > 0 && missingProbes.length === 0
          ? [
              `${observationProbes.length} probe(s) read-only ${probeSet === undefined ? "derivados" : "declarados"} después de la última escritura.`,
            ]
          : [
              missingProbes.length > 0
                ? `Probes declarados no capturados en el tail: ${missingProbes.join(", ")}.`
                : "No existe un GET/HEAD/OPTIONS posterior a la última escritura.",
            ],
    });

    // Reconstruye exactamente el checkpoint posterior a la última escritura.
    let checkpointS0: RunningContainer;
    try {
      checkpointS0 = await startClone(seedS0, input.baseSha, "S0");
      const schemaBefore = await captureSchema(checkpointS0);
      const app = await executor.startApp(baseImage, appEnv(checkpointS0.connectionUrl ?? ""));
      started.push(app);
      const schemaAfterStart = await captureSchema(checkpointS0);
      const schemaStartup = schemaStableAssertion(
        "postgres.baseline-checkpoint.schema-startup",
        "A0_S0",
        schemaBefore,
        schemaAfterStart,
        approvals,
      );
      assertions.push(schemaStartup);
      if (schemaStartup.result !== "pass") {
        await teardownTracked(app);
        return bundle();
      }
      const results = await new Replayer(httpOptions).replay(
        preparationExchanges,
        app.connectionUrl ?? "",
      );
      assertions.push(
        replayCardinalityAssertion(
          "postgres.baseline-checkpoint.cardinality",
          "A0_S0",
          preparationExchanges.length,
          results,
          approvals,
        ),
        aggregateReplayAssertion(
          "postgres.baseline-checkpoint.replay",
          "A0_S0",
          results,
          preparationExchanges.length,
          approvals,
          "A0 reconstruyó el checkpoint posterior a la última escritura.",
        ),
      );
      const schemaAfterReplay = await captureSchema(checkpointS0);
      const schemaRuntime = schemaStableAssertion(
        "postgres.baseline-checkpoint.schema-runtime",
        "A0_S0",
        schemaBefore,
        schemaAfterReplay,
        approvals,
      );
      assertions.push(schemaRuntime);
      const cleaned = await teardownTracked(app);
      if (
        results.length !== preparationExchanges.length ||
        !results.every((result) => result.matches) ||
        schemaRuntime.result !== "pass" ||
        !cleaned
      ) {
        assertions.push({
          id: "postgres.baseline-checkpoint.complete",
          result: "skipped",
          mandatory: true,
          state: "A0_S0",
          evidence: ["El checkpoint poblado no quedó atribuible; no se migrará."],
        });
        return bundle();
      }
      mark("A0_S0", "checkpoint");
    } catch (error) {
      assertions.push(stageFailure("postgres.baseline-checkpoint", "A0_S0", error, approvals, true));
      return bundle();
    }

    let cleanS1Seed: RunningContainer;
    let populatedS1Seed: RunningContainer;
    try {
      cleanS1Seed = await startClone(seedS0, input.headSha, "S1");
      populatedS1Seed = await startClone(checkpointS0, input.headSha, "S1");
      assertions.push({
        id: "postgres.migration-candidate",
        result: "pass",
        mandatory: true,
        state: "MIGRATE_S0_TO_S1",
        evidence: [
          "Migración aplicada sobre S0 limpio.",
          "Migración aplicada sobre el checkpoint S0 poblado hasta la última escritura.",
        ],
      });
      mark("MIGRATE_S0_TO_S1", "clean");
      mark("MIGRATE_S0_TO_S1", "populated");
      if (!(await teardownTracked(checkpointS0))) {
        assertions.push({
          id: "postgres.baseline-checkpoint.cleanup",
          result: "skipped",
          mandatory: true,
          state: "A0_S0",
          evidence: ["No se pudo cerrar el checkpoint S0 después de clonarlo."],
        });
      }
    } catch (error) {
      assertions.push(stageFailure("postgres.migration-candidate", "MIGRATE_S0_TO_S1", error, approvals));
      return bundle();
    }

    interface ReplayCell {
      state: "A1_S0" | "A0_S1" | "A1_S1";
      image: string;
      source: RunningContainer;
      schemaSha: string;
      schemaLabel: "S0" | "S1";
      idPrefix: string;
      label: string;
    }

    const runReplayCell = async (cell: ReplayCell): Promise<boolean> => {
      let database: RunningContainer | undefined;
      let app: RunningContainer | undefined;
      try {
        database = await startClone(cell.source, cell.schemaSha, cell.schemaLabel);
        const schemaBefore = await captureSchema(database);
        const effectsPreStart = await captureEffects(database);
        app = await executor.startApp(cell.image, appEnv(database.connectionUrl ?? ""));
        started.push(app);
        assertions.push({
          id: `${cell.idPrefix}.startup`,
          result: "pass",
          mandatory: true,
          state: cell.state,
          evidence: [`${cell.label} alcanzó readiness.`],
        });
        const schemaPostStart = await captureSchema(database);
        const effectsPostStart = await captureEffects(database);
        const startupSchema = schemaStableAssertion(
          `${cell.idPrefix}.schema-startup`,
          cell.state,
          schemaBefore,
          schemaPostStart,
          approvals,
        );
        assertions.push(startupSchema);
        const startupEffects = sqlEffectAssertion(
          baselinePreStart,
          baselinePostStart,
          effectsPreStart,
          effectsPostStart,
          approvals,
          {
            id: `${cell.idPrefix}.startup-effects`,
            state: cell.state,
            candidateLabel: `${cell.label} startup`,
            requireBaselineWrites: false,
          },
        );
        assertions.push(startupEffects);
        effectAssertions.push(startupEffects);
        if (startupSchema.result !== "pass") return false;

        const results = await new Replayer(httpOptions).replay(
          exchanges,
          app.connectionUrl ?? "",
        );
        assertions.push(
          replayCardinalityAssertion(
            `${cell.idPrefix}.cardinality`,
            cell.state,
            exchanges.length,
            results,
            approvals,
          ),
          ...routeAssertions(results, approvals, {
            idPrefix: cell.idPrefix,
            state: cell.state,
            label: cell.label,
          }),
        );
        const schemaPostReplay = await captureSchema(database);
        const runtimeSchema = schemaStableAssertion(
          `${cell.idPrefix}.schema-runtime`,
          cell.state,
          schemaBefore,
          schemaPostReplay,
          approvals,
        );
        assertions.push(runtimeSchema);
        const appCleaned = await teardownTracked(app);
        app = undefined;
        if (!appCleaned) {
          assertions.push({
            id: `${cell.idPrefix}.cleanup-app`,
            result: "skipped",
            mandatory: true,
            state: cell.state,
            evidence: ["La app no terminó; no se atribuyen los contadores SQL finales."],
          });
        }
        const effectsPostWorkload = appCleaned ? await captureEffects(database) : undefined;
        const workloadEffects = sqlEffectAssertion(
          baselinePostStart,
          baselinePostWorkload,
          effectsPostStart,
          effectsPostWorkload,
          approvals,
          {
            id: `${cell.idPrefix}.workload-effects`,
            state: cell.state,
            candidateLabel: `${cell.label} workload`,
          },
        );
        assertions.push(workloadEffects);
        effectAssertions.push(workloadEffects);
        const databaseCleaned = await teardownTracked(database);
        database = undefined;
        if (!databaseCleaned) {
          assertions.push({
            id: `${cell.idPrefix}.cleanup-database`,
            result: "skipped",
            mandatory: true,
            state: cell.state,
            evidence: ["La base efímera no terminó limpiamente."],
          });
        }
        return (
          results.length === exchanges.length &&
          schemaBefore.fingerprint !== undefined &&
          startupSchema.result === "pass" &&
          runtimeSchema.result === "pass" &&
          startupEffects.result !== "skipped" &&
          workloadEffects.result !== "skipped" &&
          appCleaned &&
          databaseCleaned
        );
      } catch (error) {
        assertions.push(stageFailure(`${cell.idPrefix}.execution`, cell.state, error, approvals));
        return false;
      } finally {
        if (app !== undefined) await teardownTracked(app);
        if (database !== undefined) await teardownTracked(database);
      }
    };

    const runPopulatedObservation = async (
      state: "A0_S1" | "A1_S1",
      image: string,
      idPrefix: string,
      label: string,
    ): Promise<boolean> => {
      if (observationProbes.length === 0 || missingProbes.length > 0) {
        assertions.push({
          id: `${idPrefix}.populated-observation`,
          result: "skipped",
          mandatory: true,
          state,
          evidence: ["No hay probes atribuibles posteriores a la última escritura."],
        });
        return false;
      }
      let database: RunningContainer | undefined;
      let app: RunningContainer | undefined;
      try {
        database = await startClone(populatedS1Seed, input.headSha, "S1");
        const schemaBefore = await captureSchema(database);
        app = await executor.startApp(image, appEnv(database.connectionUrl ?? ""));
        started.push(app);
        const schemaPostStart = await captureSchema(database);
        const startupSchema = schemaStableAssertion(
          `${idPrefix}.populated-schema-startup`,
          state,
          schemaBefore,
          schemaPostStart,
          approvals,
        );
        assertions.push(startupSchema);
        if (startupSchema.result !== "pass") return false;
        const effectsBeforeProbe = await captureEffects(database);
        const results = await new Replayer(httpOptions).replay(
          observationProbes,
          app.connectionUrl ?? "",
        );
        assertions.push(
          replayCardinalityAssertion(
            `${idPrefix}.populated-cardinality`,
            state,
            observationProbes.length,
            results,
            approvals,
          ),
          ...routeAssertions(results, approvals, {
            idPrefix: `${idPrefix}.populated`,
            state,
            label: `${label} sobre datos migrados`,
          }),
        );
        const schemaPostReplay = await captureSchema(database);
        const runtimeSchema = schemaStableAssertion(
          `${idPrefix}.populated-schema-runtime`,
          state,
          schemaBefore,
          schemaPostReplay,
          approvals,
        );
        assertions.push(runtimeSchema);
        const appCleaned = await teardownTracked(app);
        app = undefined;
        const effectsAfterProbe = appCleaned ? await captureEffects(database) : undefined;
        const readOnly = zeroSqlEffectsAssertion(
          `${idPrefix}.populated-read-only`,
          state,
          effectsBeforeProbe,
          effectsAfterProbe,
          approvals,
          `${label} populated probes`,
        );
        assertions.push(readOnly);
        effectAssertions.push(readOnly);
        const databaseCleaned = await teardownTracked(database);
        database = undefined;
        return (
          results.length === observationProbes.length &&
          startupSchema.result === "pass" &&
          runtimeSchema.result === "pass" &&
          readOnly.result !== "skipped" &&
          appCleaned &&
          databaseCleaned
        );
      } catch (error) {
        assertions.push(stageFailure(`${idPrefix}.populated-execution`, state, error, approvals));
        return false;
      } finally {
        if (app !== undefined) await teardownTracked(app);
        if (database !== undefined) await teardownTracked(database);
      }
    };

    if (
      await runReplayCell({
        state: "A1_S0",
        image: candidateImage,
        source: seedS0,
        schemaSha: input.baseSha,
        schemaLabel: "S0",
        idPrefix: "postgres.candidate-old-schema",
        label: "A1 on S0",
      })
    ) {
      mark("A1_S0", "clean-replay");
    }
    const a0s1Clean = await runReplayCell({
      state: "A0_S1",
      image: baseImage,
      source: cleanS1Seed,
      schemaSha: input.headSha,
      schemaLabel: "S1",
      idPrefix: "postgres.old-app-new-schema",
      label: "A0 on S1",
    });
    if (a0s1Clean) mark("A0_S1", "clean-replay");
    if (
      await runPopulatedObservation(
        "A0_S1",
        baseImage,
        "postgres.old-app-new-schema",
        "A0 on S1",
      )
    ) {
      mark("A0_S1", "populated-observation");
    }
    const a1s1Clean = await runReplayCell({
      state: "A1_S1",
      image: candidateImage,
      source: cleanS1Seed,
      schemaSha: input.headSha,
      schemaLabel: "S1",
      idPrefix: "postgres.candidate-new-schema",
      label: "A1 on S1",
    });
    if (a1s1Clean) mark("A1_S1", "clean-replay");
    if (
      await runPopulatedObservation(
        "A1_S1",
        candidateImage,
        "postgres.candidate-new-schema",
        "A1 on S1",
      )
    ) {
      mark("A1_S1", "populated-observation");
    }

    const runCoexistenceSchedule = async (first: "A0" | "A1"): Promise<boolean> => {
      const state = "COEXIST_A0_A1_S1" as const;
      const suffix = first.toLowerCase();
      const prefix = `postgres.rolling-coexistence.${suffix}-first`;
      let database: RunningContainer | undefined;
      let oldApp: RunningContainer | undefined;
      let newApp: RunningContainer | undefined;
      try {
        database = await startClone(cleanS1Seed, input.headSha, "S1");
        const schemaBefore = await captureSchema(database);
        oldApp = await executor.startApp(baseImage, appEnv(database.connectionUrl ?? ""));
        started.push(oldApp);
        const schemaAfterA0 = await captureSchema(database);
        newApp = await executor.startApp(candidateImage, appEnv(database.connectionUrl ?? ""));
        started.push(newApp);
        const schemaAfterA1 = await captureSchema(database);
        const a0Schema = schemaStableAssertion(
          `${prefix}.a0-schema-startup`,
          state,
          schemaBefore,
          schemaAfterA0,
          approvals,
        );
        const a1Schema = schemaStableAssertion(
          `${prefix}.a1-schema-startup`,
          state,
          schemaBefore,
          schemaAfterA1,
          approvals,
        );
        assertions.push(a0Schema, a1Schema, {
          id: `${prefix}.startup`,
          result: "pass",
          mandatory: true,
          state,
          evidence: ["A0 y A1 alcanzaron readiness simultáneamente sobre el mismo S1."],
        });
        if (a0Schema.result !== "pass" || a1Schema.result !== "pass") return false;
        const effectsBeforeReplay = await captureEffects(database);
        const results: ReplayResult[] = [];
        const schedule: string[] = [];
        const replayer = new Replayer(httpOptions);
        for (let index = 0; index < exchanges.length; index += 1) {
          const exchange = exchanges[index];
          if (exchange === undefined) throw new Error(`Exchange ${index} ausente.`);
          const servedBy = (index + (first === "A0" ? 0 : 1)) % 2 === 0 ? "A0" : "A1";
          const target = servedBy === "A0" ? oldApp.connectionUrl : newApp.connectionUrl;
          const result = await replayer.replay([exchange], target ?? "");
          if (result.length !== 1 || result[0] === undefined) {
            throw new Error(`Schedule ${first}-first perdió el exchange ${index}.`);
          }
          results.push(result[0]);
          if (schedule.length < 10) {
            const safe = redactExchangeForEvidence(exchange).value.request;
            schedule.push(`#${index} ${servedBy} ${safe.method} ${safe.path}`);
          }
        }
        assertions.push(
          {
            id: `${prefix}.schedule`,
            result: "pass",
            mandatory: true,
            state,
            evidence: schedule,
          },
          replayCardinalityAssertion(
            `${prefix}.cardinality`,
            state,
            exchanges.length,
            results,
            approvals,
          ),
          ...routeAssertions(results, approvals, {
            idPrefix: prefix,
            state,
            label: `Rolling ${first}-first`,
          }),
        );
        const schemaPostReplay = await captureSchema(database);
        const runtimeSchema = schemaStableAssertion(
          `${prefix}.schema-runtime`,
          state,
          schemaBefore,
          schemaPostReplay,
          approvals,
        );
        assertions.push(runtimeSchema);
        const newCleaned = await teardownTracked(newApp);
        newApp = undefined;
        const oldCleaned = await teardownTracked(oldApp);
        oldApp = undefined;
        const effectsAfterReplay = newCleaned && oldCleaned ? await captureEffects(database) : undefined;
        const effects = sqlEffectAssertion(
          baselinePostStart,
          baselinePostWorkload,
          effectsBeforeReplay,
          effectsAfterReplay,
          approvals,
          {
            id: `${prefix}.workload-effects`,
            state,
            candidateLabel: `coexistence ${first}-first`,
          },
        );
        assertions.push(effects);
        effectAssertions.push(effects);
        const databaseCleaned = await teardownTracked(database);
        database = undefined;
        return (
          results.length === exchanges.length &&
          runtimeSchema.result === "pass" &&
          effects.result !== "skipped" &&
          newCleaned &&
          oldCleaned &&
          databaseCleaned
        );
      } catch (error) {
        assertions.push(stageFailure(`${prefix}.execution`, state, error, approvals));
        return false;
      } finally {
        if (newApp !== undefined) await teardownTracked(newApp);
        if (oldApp !== undefined) await teardownTracked(oldApp);
        if (database !== undefined) await teardownTracked(database);
      }
    };
    if (await runCoexistenceSchedule("A0")) mark("COEXIST_A0_A1_S1", "a0-first");
    if (await runCoexistenceSchedule("A1")) mark("COEXIST_A0_A1_S1", "a1-first");

    const runRollback = async (): Promise<boolean> => {
      const state = "ROLLBACK_A0_AFTER_A1_WRITES" as const;
      if (observationProbes.length === 0 || missingProbes.length > 0) {
        assertions.push({
          id: "postgres.rollback.read-tail",
          result: "skipped",
          mandatory: true,
          state,
          evidence: ["Rollback exige al menos un probe read-only posterior a la última escritura."],
        });
        return false;
      }
      let database: RunningContainer | undefined;
      let candidate: RunningContainer | undefined;
      let oldApp: RunningContainer | undefined;
      try {
        database = await startClone(cleanS1Seed, input.headSha, "S1");
        const schemaBefore = await captureSchema(database);
        candidate = await executor.startApp(candidateImage, appEnv(database.connectionUrl ?? ""));
        started.push(candidate);
        const schemaAfterCandidateStart = await captureSchema(database);
        const candidateStartupSchema = schemaStableAssertion(
          "postgres.rollback.a1-schema-startup",
          state,
          schemaBefore,
          schemaAfterCandidateStart,
          approvals,
        );
        assertions.push(candidateStartupSchema);
        if (candidateStartupSchema.result !== "pass") return false;
        const preparation = await new Replayer(httpOptions).replay(
          preparationExchanges,
          candidate.connectionUrl ?? "",
        );
        assertions.push(
          replayCardinalityAssertion(
            "postgres.rollback.a1-cardinality",
            state,
            preparationExchanges.length,
            preparation,
            approvals,
          ),
          ...routeAssertions(preparation, approvals, {
            idPrefix: "postgres.rollback.a1-prefix",
            state,
            label: "A1 rollback preparation",
          }),
        );
        const schemaAfterCandidateReplay = await captureSchema(database);
        const candidateRuntimeSchema = schemaStableAssertion(
          "postgres.rollback.a1-schema-runtime",
          state,
          schemaBefore,
          schemaAfterCandidateReplay,
          approvals,
        );
        assertions.push(candidateRuntimeSchema);
        const candidateCleaned = await teardownTracked(candidate);
        candidate = undefined;
        const prepared =
          preparation.length === preparationExchanges.length &&
          preparation.every((result) => result.matches) &&
          candidateRuntimeSchema.result === "pass" &&
          candidateCleaned;
        assertions.push(
          applyApproval(
            {
              id: "postgres.rollback.a1-writes",
              result: prepared ? "pass" : "fail",
              mandatory: true,
              state,
              evidence: prepared
                ? ["A1 ejecutó exactamente el prefijo hasta la última escritura y cerró su pool."]
                : ["A1 no pudo producir un checkpoint atribuible para rollback."],
            },
            approvals,
          ),
        );
        if (!prepared) return false;
        mark(state, "a1-write-prefix");

        const schemaBeforeOld = await captureSchema(database);
        oldApp = await executor.startApp(baseImage, appEnv(database.connectionUrl ?? ""));
        started.push(oldApp);
        const schemaAfterOldStart = await captureSchema(database);
        const oldStartupSchema = schemaStableAssertion(
          "postgres.rollback.a0-schema-startup",
          state,
          schemaBeforeOld,
          schemaAfterOldStart,
          approvals,
        );
        assertions.push(oldStartupSchema, {
          id: "postgres.rollback.old-app-startup",
          result: "pass",
          mandatory: true,
          state,
          evidence: ["A0 alcanzó readiness después del prefijo de escrituras de A1."],
        });
        if (oldStartupSchema.result !== "pass") return false;
        const effectsBeforeProbe = await captureEffects(database);
        const probeResults = await new Replayer(httpOptions).replay(
          observationProbes,
          oldApp.connectionUrl ?? "",
        );
        assertions.push(
          replayCardinalityAssertion(
            "postgres.rollback.a0-probe-cardinality",
            state,
            observationProbes.length,
            probeResults,
            approvals,
          ),
          ...routeAssertions(probeResults, approvals, {
            idPrefix: "postgres.rollback.a0-read-tail",
            state,
            label: "A0 after A1 writes",
          }),
        );
        const schemaAfterOldReplay = await captureSchema(database);
        const oldRuntimeSchema = schemaStableAssertion(
          "postgres.rollback.a0-schema-runtime",
          state,
          schemaBeforeOld,
          schemaAfterOldReplay,
          approvals,
        );
        assertions.push(oldRuntimeSchema);
        const oldCleaned = await teardownTracked(oldApp);
        oldApp = undefined;
        const effectsAfterProbe = oldCleaned ? await captureEffects(database) : undefined;
        const readOnly = zeroSqlEffectsAssertion(
          "postgres.rollback.a0-read-tail-effects",
          state,
          effectsBeforeProbe,
          effectsAfterProbe,
          approvals,
          "Rollback read tail",
        );
        assertions.push(readOnly);
        effectAssertions.push(readOnly);
        const databaseCleaned = await teardownTracked(database);
        database = undefined;
        const complete =
          probeResults.length === observationProbes.length &&
          oldRuntimeSchema.result === "pass" &&
          readOnly.result !== "skipped" &&
          oldCleaned &&
          databaseCleaned;
        if (complete) mark(state, "a0-read-tail");
        return complete;
      } catch (error) {
        assertions.push(stageFailure("postgres.rollback.execution", state, error, approvals));
        return false;
      } finally {
        if (oldApp !== undefined) await teardownTracked(oldApp);
        if (candidate !== undefined) await teardownTracked(candidate);
        if (database !== undefined) await teardownTracked(database);
      }
    };
    await runRollback();

    const effectUnavailable = effectAssertions.some((assertion) => assertion.result === "skipped");
    const effectFailed = effectAssertions.some(
      (assertion) => assertion.result === "fail" && assertion.approval === undefined,
    );
    const aggregateEffects: Assertion = {
      id: "postgres.sql-effects.matrix",
      result: effectUnavailable ? "skipped" : effectFailed ? "fail" : "pass",
      mandatory: true,
      state: "SQL_EFFECTS",
      evidence: [
        `${effectAssertions.length} comparación(es) con puntos pre-start, post-readiness y post-workload.`,
      ],
    };
    assertions.push(aggregateEffects);
    if (!effectUnavailable) mark("SQL_EFFECTS", "aggregate");

    const missing = missingObligations();
    assertions.push({
      id: "proof.execution-complete",
      result: missing.length === 0 ? "pass" : "skipped",
      mandatory: true,
      state: "SQL_EFFECTS",
      evidence:
        missing.length === 0
          ? ["Todas las obligaciones de la matriz release/rollback fueron ejecutadas."]
          : [`Obligaciones sin evidencia completa: ${missing.slice(0, 20).join(", ")}.`],
    });
    return bundle();
  } finally {
    if (recorder !== undefined) {
      try {
        recorder.stop();
      } catch {
        // disposeRun del caller conserva el barrido por label.
      }
    }
    for (const container of [...started].reverse()) {
      try {
        await executor.teardown(container.id);
      } catch {
        // El caller ejecuta disposeRun como segunda barrera.
      }
    }
  }
}

export function newRunId(): string {
  return randomUUID();
}

export { RELEASE_MATRIX };
