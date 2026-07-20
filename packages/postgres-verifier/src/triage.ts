import { createHash } from "node:crypto";
import { basename, posix } from "node:path";
import { performance } from "node:perf_hooks";
import {
  SpawnRunner,
  resolveExecutionProfile,
  type CommandResult,
  type CommandRunner,
  type ExecutionProfile,
} from "@proof/docker-executor";
import type { ExecutionState } from "@proof/schema";

/**
 * Static, deterministic release triage.  This module deliberately emits a
 * plan, never a release verdict: only the executed matrix may produce
 * VERIFIED evidence.
 */

export const TRIAGE_DURATION_BUDGET_MS = 120_000;
export const TRIAGE_RULESET_VERSION = "release-triage/2026-07-15.1";

const MAX_COMMAND_STDOUT_BYTES = 2 * 1024 * 1024;
const MAX_COMMAND_STDERR_BYTES = 64 * 1024;
const MAX_FILE_BYTES = 512 * 1024;
const MAX_CHANGED_FILES = 10_000;
const MAX_CONTENT_FILES = 96;
const MAX_PUBLIC_CHANGED_FILES = 500;
const MAX_REASONS = 200;
const GIT_COMMAND_TIMEOUT_MS = 15_000;

export type TriageRisk = "low" | "medium" | "high" | "critical" | "unknown";
export type AssuranceLevel = "PLAN_ONLY" | "TARGETED_RELEASE_MATRIX" | "FULL_RELEASE_MATRIX";

export type RequiredMatrixState = ExecutionState;

export type ChangeCategory =
  | "migration"
  | "prisma-schema"
  | "sql"
  | "build"
  | "dependency"
  | "proof-config"
  | "runtime-config"
  | "automation"
  | "application"
  | "privacy"
  | "documentation"
  | "other";

export type ChangeStatus = "added" | "modified" | "deleted" | "renamed" | "copied" | "unknown";

export interface TriageChangedFile {
  path: string;
  status: ChangeStatus;
  category: ChangeCategory;
  previousPath?: string;
  baseContentSha256?: string;
  headContentSha256?: string;
}

export interface TriageEvidence {
  path: string;
  side: "base" | "head" | "diff" | "metadata";
  line?: number;
  excerpt?: string;
}

export interface TriageReason {
  code: string;
  risk: Exclude<TriageRisk, "unknown">;
  title: string;
  detail: string;
  evidence: TriageEvidence[];
}

export interface TriageCommand {
  command: string;
  args: string[];
  reason: string;
}

export interface ReleaseTriageInput {
  baseSha: string;
  headSha: string;
  cwd?: string;
  serviceName?: string;
  servicePath?: string;
  prismaSchemaPath?: string;
  executionProfile?: ExecutionProfile;
  durationBudgetMs?: number;
  configuration?: {
    loaded: boolean;
    error?: string;
  };
}

export interface ReleaseTriagePlan {
  kind: "proof.release-plan";
  version: "1";
  decision: "PLAN_ONLY_NOT_VERIFIED";
  ruleset: string;
  subject: {
    baseRef: string;
    headRef: string;
    baseSha?: string;
    headSha?: string;
    service?: { name: string; path: string };
  };
  risk: TriageRisk;
  assurance: {
    level: AssuranceLevel;
    executionRequired: boolean;
    requiredStates: RequiredMatrixState[];
    rationale: string;
  };
  analysis: {
    complete: boolean;
    executionProfile: ExecutionProfile;
    budgetMs: number;
    changedFilesInspected: number;
    contentFilesInspected: number;
    diagnostics: string[];
  };
  changes: {
    total: number;
    relevant: number;
    byCategory: Record<ChangeCategory, number>;
    files: TriageChangedFile[];
    filesTruncated: boolean;
  };
  reasons: TriageReason[];
  security: {
    reviewRequired: boolean;
    forkProfileRequired: boolean;
    flags: string[];
  };
  privacy: {
    reviewRequired: boolean;
    bundleRedactionRequired: true;
    flags: string[];
  };
  cacheKey: string;
  cacheReusable: boolean;
  nextCommand: TriageCommand;
  nextActions: TriageCommand[];
  disclaimer: string;
}

interface RawChangedFile {
  statusCode: string;
  path: string;
  previousPath?: string;
}

interface FileSnapshot {
  content: string;
  sha256: string;
}

interface InspectedFile extends TriageChangedFile {
  base?: FileSnapshot;
  head?: FileSnapshot;
}

interface PlanningState {
  complete: boolean;
  diagnostics: string[];
  reasons: TriageReason[];
  securityFlags: Set<string>;
  privacyFlags: Set<string>;
}

const RISK_RANK: Record<Exclude<TriageRisk, "unknown">, number> = {
  low: 0,
  medium: 1,
  high: 2,
  critical: 3,
};

const CATEGORY_ORDER: ChangeCategory[] = [
  "migration",
  "prisma-schema",
  "sql",
  "build",
  "dependency",
  "proof-config",
  "runtime-config",
  "automation",
  "application",
  "privacy",
  "documentation",
  "other",
];

const FULL_MATRIX: RequiredMatrixState[] = [
  "BUILD_A0",
  "BUILD_A1",
  "A0_S0",
  "A1_S0",
  "MIGRATE_S0_TO_S1",
  "A0_S1",
  "A1_S1",
  "COEXIST_A0_A1_S1",
  "ROLLBACK_A0_AFTER_A1_WRITES",
  "SQL_EFFECTS",
];

const TARGETED_MATRIX: RequiredMatrixState[] = [
  "BUILD_A0",
  "BUILD_A1",
  "A0_S0",
  "A1_S0",
  "A1_S1",
];

function emptyCategoryCounts(): Record<ChangeCategory, number> {
  return Object.fromEntries(CATEGORY_ORDER.map((category) => [category, 0])) as Record<
    ChangeCategory,
    number
  >;
}

function normalizeRepoPath(path: string): string {
  return posix.normalize(path.replaceAll("\\", "/")).replace(/^\.\//, "");
}

function isPathInsideRepo(path: string): boolean {
  const normalized = normalizeRepoPath(path);
  return (
    normalized !== "" &&
    normalized.length <= 1_024 &&
    normalized !== "." &&
    normalized !== ".." &&
    !normalized.startsWith("../") &&
    !normalized.startsWith("/") &&
    !/^[A-Za-z]:\//.test(normalized) &&
    !/[\u0000-\u001f\u007f]/.test(normalized)
  );
}

function isMigration(path: string): boolean {
  return (
    /(^|\/)migrations?\/.*\.sql$/i.test(path) ||
    /(^|\/)migration\.sql$/i.test(path) ||
    /(^|\/)migration_lock\.toml$/i.test(path)
  );
}

function isPrismaSchema(path: string, configured?: string): boolean {
  const normalizedConfigured = configured === undefined ? undefined : normalizeRepoPath(configured);
  return (
    (normalizedConfigured !== undefined && path === normalizedConfigured) ||
    /(^|\/)schema\.prisma$/i.test(path) ||
    /(^|\/)prisma\/schema\/.*\.prisma$/i.test(path)
  );
}

function categoryFor(path: string, servicePath?: string, prismaSchemaPath?: string): ChangeCategory {
  const lower = path.toLowerCase();
  const name = basename(lower);
  if (isMigration(path)) return "migration";
  if (isPrismaSchema(path, prismaSchemaPath) || lower.endsWith(".prisma")) return "prisma-schema";
  if (lower.endsWith(".sql")) return "sql";
  if (
    name === "dockerfile" ||
    name.startsWith("dockerfile.") ||
    name === ".dockerignore" ||
    /(^|\/)(docker-)?compose(\.[^.]+)?\.ya?ml$/i.test(path)
  ) {
    return "build";
  }
  if (
    name === "package.json" ||
    /(^|\/)(pnpm-lock\.yaml|package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|bun\.lockb?)$/i.test(
      path,
    )
  ) {
    return "dependency";
  }
  if (/^proof\.config\.(ts|js|mjs|cjs|json)$/i.test(path)) return "proof-config";
  if (
    /(^|\/)(\.env($|\.)|.*\.pem$|.*\.key$|secrets?\.(ya?ml|json)$)/i.test(path)
  ) {
    return "privacy";
  }
  if (/^\.github\/workflows\/.*\.ya?ml$/i.test(path) || /(^|\/)(jenkinsfile|\.gitlab-ci\.yml)$/i.test(path)) {
    return "automation";
  }
  if (
    /(^|\/)(tsconfig(\.[^.]+)?\.json|next\.config\..+|vite\.config\..+|webpack\.config\..+|\.npmrc|\.pnpmfile\.cjs)$/i.test(
      path,
    )
  ) {
    return "runtime-config";
  }
  if (/\.(md|mdx|txt|rst|adoc)$/i.test(path) || /(^|\/)docs?\//i.test(path)) {
    return "documentation";
  }

  const normalizedService = servicePath === undefined ? undefined : normalizeRepoPath(servicePath);
  const isServiceFile =
    normalizedService === undefined ||
    normalizedService === "." ||
    path === normalizedService ||
    path.startsWith(`${normalizedService}/`);
  if (isServiceFile && /\.(c?js|mjs|jsx|ts|tsx)$/i.test(path)) return "application";
  if (normalizedService !== undefined && isServiceFile && /\.json$/i.test(path)) {
    return "application";
  }
  return "other";
}

function statusFor(code: string): ChangeStatus {
  const kind = code[0];
  if (kind === "A") return "added";
  if (kind === "M" || kind === "T") return "modified";
  if (kind === "D") return "deleted";
  if (kind === "R") return "renamed";
  if (kind === "C") return "copied";
  return "unknown";
}

function parseNameStatusZ(output: string): RawChangedFile[] {
  const fields = output.split("\0");
  if (fields.at(-1) === "") fields.pop();
  const files: RawChangedFile[] = [];
  let index = 0;
  while (index < fields.length) {
    const statusCode = fields[index++];
    if (statusCode === undefined || statusCode === "") throw new Error("git diff devolvio un status vacio.");
    const kind = statusCode[0];
    if (kind === "R" || kind === "C") {
      const previousPath = fields[index++];
      const path = fields[index++];
      if (previousPath === undefined || path === undefined) {
        throw new Error("git diff devolvio un rename/copy incompleto.");
      }
      files.push({ statusCode, previousPath: normalizeRepoPath(previousPath), path: normalizeRepoPath(path) });
    } else {
      const path = fields[index++];
      if (path === undefined) throw new Error("git diff devolvio una entrada incompleta.");
      files.push({ statusCode, path: normalizeRepoPath(path) });
    }
  }
  return files;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function safeDiagnostic(value: unknown): string {
  const raw = value instanceof Error ? value.message : String(value);
  return raw
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z ]+ )?PRIVATE KEY-----/g, "[REDACTED]")
    .replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, "[REDACTED]")
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, "[REDACTED]")
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,}|AKIA[A-Z0-9]{16})\b/g, "[REDACTED]")
    .replace(/((?:token|password|secret|authorization|cookie|api[-_]?key)\s*[:=]\s*)\S+/gi, "$1[REDACTED]")
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[REDACTED]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 500);
}

function safeExcerpt(value: string): string {
  return value
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/'(?:''|[^'])*'/g, "'[REDACTED]'")
    .replace(/("[^"\r\n]+"\s*:\s*)"(?:\\.|[^"\\])*"/g, '$1"[REDACTED]"')
    .replace(
      /((?:token|password|passwd|secret|authorization|cookie|api[-_]?key|private[-_]?key|email|phone|address)\s*[:=]\s*)[^\s,;]+/gi,
      "$1[REDACTED]",
    )
    .replace(/(bearer\s+)[A-Za-z0-9._~+/=-]+/gi, "$1[REDACTED]")
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[REDACTED]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 240);
}

function validateRef(ref: string, label: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._/@~-]{0,127}$/.test(ref) || ref.includes("..")) {
    throw new Error(`${label} no es una referencia git segura.`);
  }
}

function publicRef(ref: string): string {
  return /^[A-Za-z0-9][A-Za-z0-9._/@~-]{0,127}$/.test(ref) && !ref.includes("..")
    ? ref
    : "[INVALID_REF]";
}

class GitReader {
  private readonly startedAt = performance.now();
  readonly diagnostics: string[] = [];

  constructor(
    private readonly runner: CommandRunner,
    private readonly cwd: string,
    readonly budgetMs: number,
  ) {}

  private remainingMs(): number {
    return this.budgetMs - (performance.now() - this.startedAt);
  }

  async run(args: string[], allowExitCodes: number[] = [0]): Promise<CommandResult> {
    const remaining = this.remainingMs();
    if (remaining <= 0) throw new Error(`Triage excedio su presupuesto de ${this.budgetMs} ms.`);
    const result = await this.runner.run("git", args, {
      cwd: this.cwd,
      timeoutMs: Math.max(1, Math.floor(Math.min(GIT_COMMAND_TIMEOUT_MS, remaining))),
      maxStdoutBytes: MAX_COMMAND_STDOUT_BYTES,
      maxStderrBytes: MAX_COMMAND_STDERR_BYTES,
    });
    if (Buffer.byteLength(result.stdout, "utf8") > MAX_COMMAND_STDOUT_BYTES) {
      throw new Error(`La salida de git excedio ${MAX_COMMAND_STDOUT_BYTES} bytes.`);
    }
    if (Buffer.byteLength(result.stderr, "utf8") > MAX_COMMAND_STDERR_BYTES) {
      throw new Error(`El stderr de git excedio ${MAX_COMMAND_STDERR_BYTES} bytes.`);
    }
    if (!allowExitCodes.includes(result.exitCode)) {
      throw new Error(
        `git ${args[0] ?? "command"} fallo con codigo ${result.exitCode}: ${safeDiagnostic(result.stderr)}`,
      );
    }
    return result;
  }

  async resolveCommit(ref: string): Promise<string> {
    const result = await this.run(["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`]);
    const commit = result.stdout.trim().toLowerCase();
    if (!/^[0-9a-f]{40,64}$/.test(commit)) throw new Error(`git no resolvio ${ref} a un commit completo.`);
    return commit;
  }

  async show(commit: string, path: string): Promise<FileSnapshot> {
    if (!isPathInsideRepo(path)) throw new Error(`Ruta git fuera del repositorio: ${path}`);
    const result = await this.run([
      "show",
      "--no-ext-diff",
      "--no-textconv",
      "--format=",
      "--end-of-options",
      `${commit}:${path}`,
    ]);
    if (Buffer.byteLength(result.stdout, "utf8") > MAX_FILE_BYTES) {
      throw new Error(`El contenido de ${path} excedio el limite de ${MAX_FILE_BYTES} bytes.`);
    }
    if (result.stdout.includes("\0")) throw new Error(`${path} parece binario y no puede analizarse estaticamente.`);
    if (result.stdout.includes("\uFFFD")) throw new Error(`${path} no es UTF-8 valido.`);
    if (result.stdout.startsWith("version https://git-lfs.github.com/spec/v1")) {
      throw new Error(`${path} es un puntero Git LFS; el blob real no esta disponible para triage.`);
    }
    return { content: result.stdout, sha256: sha256(result.stdout) };
  }
}

function evidence(path: string, side: TriageEvidence["side"], content?: string, index?: number): TriageEvidence {
  const line = content === undefined || index === undefined ? undefined : content.slice(0, index).split("\n").length;
  const sourceLine =
    content === undefined || index === undefined
      ? undefined
      : content.slice(index).split("\n", 1)[0]?.slice(0, 500);
  return {
    path,
    side,
    ...(line === undefined ? {} : { line }),
    ...(sourceLine === undefined || safeExcerpt(sourceLine) === ""
      ? {}
      : { excerpt: safeExcerpt(sourceLine) }),
  };
}

function addReason(state: PlanningState, reason: TriageReason): void {
  const first = reason.evidence[0];
  const key = `${reason.code}\0${first?.path ?? ""}\0${first?.line ?? ""}`;
  const alreadyPresent = state.reasons.some((candidate) => {
    const candidateFirst = candidate.evidence[0];
    return `${candidate.code}\0${candidateFirst?.path ?? ""}\0${candidateFirst?.line ?? ""}` === key;
  });
  if (alreadyPresent) return;
  if (state.reasons.length >= MAX_REASONS) {
    state.complete = false;
    state.securityFlags.add("REASON_OUTPUT_LIMIT_REACHED");
    if (!state.diagnostics.includes(`Se alcanzo el limite de ${MAX_REASONS} findings de triage.`)) {
      state.diagnostics.push(`Se alcanzo el limite de ${MAX_REASONS} findings de triage.`);
    }
    return;
  }
  state.reasons.push(reason);
}

function statementMatches(content: string, expression: RegExp): Array<{ index: number; text: string }> {
  const withoutBlockComments = content.replace(/\/\*[\s\S]*?\*\//g, (comment) =>
    comment.replace(/[^\n]/g, " "),
  );
  const uncommented = withoutBlockComments
    .split("\n")
    .map((line) => line.replace(/--.*$/, (comment) => " ".repeat(comment.length)))
    .join("\n");
  const statements: Array<{ index: number; text: string }> = [];
  for (const match of uncommented.matchAll(expression)) {
    if (match.index !== undefined) statements.push({ index: match.index, text: match[0] });
  }
  return statements;
}

function sqlReason(
  state: PlanningState,
  file: InspectedFile,
  code: string,
  risk: Exclude<TriageRisk, "unknown">,
  title: string,
  detail: string,
  expression: RegExp,
  filter?: (statement: string, fullContent: string, index: number) => boolean,
): void {
  const content = file.head?.content;
  if (content === undefined) return;
  for (const match of statementMatches(content, expression)) {
    if (filter !== undefined && !filter(match.text, content, match.index)) continue;
    if (file.base?.content.includes(match.text) === true) continue;
    addReason(state, {
      code,
      risk,
      title,
      detail,
      evidence: [evidence(file.path, "head", content, match.index)],
    });
  }
}

function inspectSql(state: PlanningState, file: InspectedFile): void {
  sqlReason(
    state,
    file,
    "DESTRUCTIVE_DDL",
    "critical",
    "DDL destructivo detectado",
    "DROP/TRUNCATE puede romper A0, destruir datos o volver inviable el rollback.",
    /\b(?:DROP\s+(?:TABLE|COLUMN|SCHEMA|TYPE|DATABASE|VIEW|MATERIALIZED\s+VIEW)|TRUNCATE\b|ALTER\s+TABLE[\s\S]{0,300}?\bDROP\s+(?:COLUMN|CONSTRAINT))[^;]*;?/gi,
  );
  sqlReason(
    state,
    file,
    "RENAME_BREAKS_OLD_APP",
    "high",
    "Rename incompatible con A0",
    "Renombrar tablas o columnas suele invalidar las consultas de la aplicacion desplegada.",
    /\bALTER\s+(?:TABLE|TYPE)[\s\S]{0,300}?\bRENAME\s+(?:COLUMN\s+\S+\s+TO|TO)\s+\S+[^;]*;?/gi,
  );
  sqlReason(
    state,
    file,
    "ADD_NOT_NULL_WITHOUT_DEFAULT",
    "critical",
    "Columna NOT NULL sin transicion segura",
    "Una columna obligatoria sin default/backfill rompe escrituras de A0 y puede fallar sobre filas existentes.",
    /\bALTER\s+TABLE[\s\S]{0,300}?\bADD\s+(?:COLUMN\s+)?[^;]*?\bNOT\s+NULL\b[^;]*;?/gi,
    (statement) => !/\bDEFAULT\b/i.test(statement),
  );
  sqlReason(
    state,
    file,
    "SET_NOT_NULL_WITHOUT_BACKFILL",
    "high",
    "Validacion NOT NULL potencialmente insegura",
    "SET NOT NULL requiere demostrar backfill previo y compatibilidad de escrituras durante la ventana mixta.",
    /\bALTER\s+TABLE[\s\S]{0,300}?\bALTER\s+(?:COLUMN\s+)?\S+\s+SET\s+NOT\s+NULL\b[^;]*;?/gi,
    (statement, full, index) => {
      const table = /ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?([^\s;]+)/i.exec(statement)?.[1];
      return (
        table === undefined ||
        !new RegExp(
          `\\bUPDATE\\s+${table.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`,
          "i",
        ).test(full.slice(0, index))
      );
    },
  );
  sqlReason(
    state,
    file,
    "VOLATILE_DEFAULT_REWRITES_TABLE",
    "high",
    "Default volatil puede reescribir la tabla",
    "Funciones volatiles en ADD COLUMN DEFAULT fuerzan evaluacion por fila y amplian locks/tiempo de migracion.",
    /\bALTER\s+TABLE[\s\S]{0,300}?\bADD\s+(?:COLUMN\s+)?[^;]*?\bDEFAULT\s+(?:now\s*\(|clock_timestamp\s*\(|random\s*\(|gen_random_uuid\s*\(|uuid_generate_v\d\s*\(|nextval\s*\()[^;]*;?/gi,
  );
  sqlReason(
    state,
    file,
    "BLOCKING_UNIQUE_VALIDATION",
    "high",
    "Unicidad requiere validacion de datos y locks",
    "UNIQUE puede fallar por duplicados y bloquear escrituras; requiere preflight y estrategia operacional.",
    /\b(?:ADD\s+(?:CONSTRAINT\s+\S+\s+)?UNIQUE\b|CREATE\s+UNIQUE\s+INDEX(?!\s+CONCURRENTLY))[^;]*;?/gi,
  );
  sqlReason(
    state,
    file,
    "BLOCKING_FOREIGN_KEY_VALIDATION",
    "high",
    "Foreign key validada en linea",
    "Una FK sin NOT VALID puede escanear la tabla, fallar por datos historicos y adquirir locks amplios.",
    /\bADD\s+(?:CONSTRAINT\s+\S+\s+)?FOREIGN\s+KEY\b[^;]*;?/gi,
    (statement) => !/\bNOT\s+VALID\b/i.test(statement),
  );
  sqlReason(
    state,
    file,
    "DEFERRED_CONSTRAINT_NEEDS_VALIDATION",
    "medium",
    "Constraint diferida pendiente de validacion",
    "NOT VALID reduce el lock inicial, pero el release debe planificar VALIDATE CONSTRAINT y medir su escaneo.",
    /\bADD\s+(?:CONSTRAINT\s+\S+\s+)?(?:FOREIGN\s+KEY|CHECK\s*\()[^;]*\bNOT\s+VALID\b[^;]*;?/gi,
  );
  sqlReason(
    state,
    file,
    "CONSTRAINT_VALIDATION_SCAN",
    "high",
    "Validacion de constraint sobre datos existentes",
    "VALIDATE CONSTRAINT puede escanear una tabla grande y competir con trafico activo.",
    /\bALTER\s+TABLE\b[^;]*\bVALIDATE\s+CONSTRAINT\b[^;]*;?/gi,
  );
  sqlReason(
    state,
    file,
    "BLOCKING_CHECK_VALIDATION",
    "high",
    "Check constraint validada en linea",
    "CHECK sin NOT VALID puede escanear datos existentes y extender la ventana de lock.",
    /\bADD\s+(?:CONSTRAINT\s+\S+\s+)?CHECK\s*\([^;]*;?/gi,
    (statement) => !/\bNOT\s+VALID\b/i.test(statement),
  );
  sqlReason(
    state,
    file,
    "BLOCKING_INDEX_BUILD",
    "high",
    "Indice construido con lock de escrituras",
    "CREATE INDEX sin CONCURRENTLY puede bloquear escrituras en tablas activas.",
    /\bCREATE\s+(?:UNIQUE\s+)?INDEX(?!\s+CONCURRENTLY)\b[^;]*;?/gi,
  );
  sqlReason(
    state,
    file,
    "CONCURRENT_INDEX_REQUIRES_SPECIAL_EXECUTION",
    "medium",
    "Indice concurrente requiere orquestacion especial",
    "CREATE INDEX CONCURRENTLY reduce locks, pero no puede ejecutarse dentro de una transaccion normal.",
    /\bCREATE\s+(?:UNIQUE\s+)?INDEX\s+CONCURRENTLY\b[^;]*;?/gi,
  );
  sqlReason(
    state,
    file,
    "EXPLICIT_TABLE_LOCK",
    "critical",
    "Lock explicito de tabla",
    "LOCK TABLE puede detener trafico de produccion; necesita presupuesto y timeout explicitos.",
    /\bLOCK\s+(?:TABLE\s+)?[^;]*;?/gi,
  );
  sqlReason(
    state,
    file,
    "ALTER_COLUMN_TYPE",
    "high",
    "Cambio de tipo potencialmente bloqueante",
    "ALTER COLUMN TYPE puede reescribir la tabla y romper lectores/escritores de la version anterior.",
    /\bALTER\s+TABLE[\s\S]{0,300}?\bALTER\s+(?:COLUMN\s+)?\S+\s+(?:SET\s+DATA\s+)?TYPE\b[^;]*;?/gi,
  );
  sqlReason(
    state,
    file,
    "PROCEDURAL_OR_PRIVILEGED_SQL",
    "high",
    "SQL procedural o privilegiado",
    "La migracion contiene una superficie que requiere revision de seguridad y ejecucion aislada.",
    /\b(?:SECURITY\s+DEFINER|COPY\b[^;]*\bPROGRAM\b|CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION|DO\s+\$\$|CREATE\s+EXTENSION)\b[^;]*;?/gi,
  );
  sqlReason(
    state,
    file,
    "BULK_DATA_REWRITE",
    "medium",
    "Backfill o rewrite de datos",
    "UPDATE/DELETE masivo dentro de una migracion necesita limites, batching y observacion de locks.",
    /\b(?:UPDATE|DELETE\s+FROM)\s+[^;]+;?/gi,
  );
  sqlReason(
    state,
    file,
    "BLOCKING_MAINTENANCE_COMMAND",
    "critical",
    "Mantenimiento bloqueante dentro del release",
    "VACUUM FULL, CLUSTER o REINDEX pueden tomar locks incompatibles con trafico normal.",
    /\b(?:VACUUM\s+FULL|CLUSTER\b|REINDEX\b)[^;]*;?/gi,
  );
  sqlReason(
    state,
    file,
    "PARTITION_TOPOLOGY_CHANGE",
    "high",
    "Topologia de particiones modificada",
    "ATTACH/DETACH PARTITION requiere validar constraints y locks sobre tablas padre e hija.",
    /\bALTER\s+TABLE\b[^;]*\b(?:ATTACH|DETACH)\s+PARTITION\b[^;]*;?/gi,
  );

  const content = file.head?.content ?? "";
  if (/\b(?:email|phone|address|password|passwd|secret|token|ssn|dni|document|birth|health|card)\b/i.test(content)) {
    state.privacyFlags.add("SENSITIVE_SCHEMA_SIGNAL");
  }
  const privilegedSql = /\b(?:SECURITY\s+DEFINER|COPY\b[^;]*\bPROGRAM\b|CREATE\s+EXTENSION)\b/i;
  if (privilegedSql.test(content) && !privilegedSql.test(file.base?.content ?? "")) {
    state.securityFlags.add("PRIVILEGED_SQL_CHANGED");
  }
}

function normalizedPrismaLines(content: string): Set<string> {
  return new Set(
    content
      .split("\n")
      .map((line) => line.replace(/\/\/.*$/, "").trim())
      .filter(Boolean),
  );
}

function inspectPrisma(state: PlanningState, file: InspectedFile): void {
  const head = file.head?.content;
  if (head === undefined) return;
  const baseLines = normalizedPrismaLines(file.base?.content ?? "");
  const baseModels = new Set(
    [...(file.base?.content ?? "").matchAll(/^\s*model\s+(\w+)\s*\{/gim)]
      .map((match) => match[1])
      .filter((model): model is string => model !== undefined),
  );
  const lines = head.split("\n");
  let currentModel: string | undefined;
  lines.forEach((rawLine, zeroBasedLine) => {
    const line = rawLine.replace(/\/\/.*$/, "").trim();
    const modelStart = /^model\s+(\w+)\s*\{/.exec(line)?.[1];
    if (modelStart !== undefined) currentModel = modelStart;
    if (line === "}") currentModel = undefined;
    if (line === "" || baseLines.has(line)) return;
    const existingModel = currentModel !== undefined && baseModels.has(currentModel);
    if (existingModel && (/^@@?unique\b/.test(line) || /@unique\b/.test(line))) {
      addReason(state, {
        code: "PRISMA_UNIQUE_ADDED",
        risk: "high",
        title: "Unicidad agregada en Prisma",
        detail: "La unicidad requiere preflight de duplicados y prueba sobre datos poblados.",
        evidence: [{ path: file.path, side: "head", line: zeroBasedLine + 1, excerpt: safeExcerpt(rawLine) }],
      });
    }
    if (
      existingModel &&
      /^\w+\s+(?:String|Int|BigInt|Float|Decimal|Boolean|DateTime|Json|Bytes)(?:\[\])?\s*(?:@|$)/.test(line) &&
      !/^\w+\s+\S+\?/.test(line) &&
      !/@(?:default|id)\b/.test(line)
    ) {
      addReason(state, {
        code: "PRISMA_REQUIRED_FIELD_ADDED",
        risk: "high",
        title: "Campo obligatorio agregado en Prisma",
        detail: "Un campo requerido sin default visible necesita expand/backfill/contract y prueba de A0 sobre S1.",
        evidence: [{ path: file.path, side: "head", line: zeroBasedLine + 1, excerpt: safeExcerpt(rawLine) }],
      });
    }
    if (/\b(?:email|phone|address|password|passwd|secret|token|ssn|dni|document|birth|health|card)\b/i.test(line)) {
      state.privacyFlags.add("SENSITIVE_SCHEMA_SIGNAL");
    }
  });
}

function inspectDockerfile(state: PlanningState, file: InspectedFile): void {
  const content = file.head?.content;
  if (content === undefined) return;
  const rules: Array<{
    code: string;
    risk: Exclude<TriageRisk, "unknown">;
    title: string;
    detail: string;
    expression: RegExp;
    securityFlag: string;
    hideExcerpt?: boolean;
  }> = [
    {
      code: "DOCKER_REMOTE_CODE_PIPE",
      risk: "critical",
      title: "Ejecucion remota no fijada en build",
      detail: "Descargar y ejecutar contenido con pipe introduce codigo no autenticado en la imagen.",
      expression: /\b(?:curl|wget)\b[^\n|]*\|\s*(?:sh|bash)\b/gi,
      securityFlag: "UNTRUSTED_REMOTE_BUILD_CODE",
    },
    {
      code: "DOCKER_REMOTE_ADD",
      risk: "high",
      title: "ADD remoto en Dockerfile",
      detail: "El artefacto remoto debe fijarse por digest y verificarse antes de incorporarlo.",
      expression: /^\s*ADD\s+https?:\/\//gim,
      securityFlag: "UNPINNED_REMOTE_BUILD_INPUT",
    },
    {
      code: "DOCKER_LATEST_TAG",
      risk: "medium",
      title: "Imagen base mutable",
      detail: "Una etiqueta latest impide reproducir el mismo build y debilita provenance.",
      expression: /^\s*FROM\s+\S+:latest(?:\s|$)/gim,
      securityFlag: "MUTABLE_BASE_IMAGE",
    },
    {
      code: "DOCKER_SECRET_INSTRUCTION",
      risk: "high",
      title: "Posible secreto en ARG/ENV",
      detail: "Los secretos no deben persistirse en capas ni exponerse como build args.",
      expression: /^\s*(?:ARG|ENV)\s+\S*(?:TOKEN|PASSWORD|PASSWD|SECRET|API_KEY|PRIVATE_KEY)\S*/gim,
      securityFlag: "BUILD_SECRET_SURFACE",
      hideExcerpt: true,
    },
  ];
  for (const rule of rules) {
    for (const match of content.matchAll(rule.expression)) {
      if (match.index === undefined) continue;
      if (file.base?.content.includes(match[0]) === true) continue;
      addReason(state, {
        code: rule.code,
        risk: rule.risk,
        title: rule.title,
        detail: rule.detail,
        evidence: [
          rule.hideExcerpt
            ? { path: file.path, side: "head", line: content.slice(0, match.index).split("\n").length }
            : evidence(file.path, "head", content, match.index),
        ],
      });
      state.securityFlags.add(rule.securityFlag);
    }
  }
}

function inspectPackageJson(state: PlanningState, file: InspectedFile): void {
  if (basename(file.path).toLowerCase() !== "package.json" || file.head === undefined) return;
  try {
    const parsed = JSON.parse(file.head.content) as { scripts?: Record<string, unknown> };
    const baseParsed =
      file.base === undefined
        ? undefined
        : (JSON.parse(file.base.content) as { scripts?: Record<string, unknown> });
    const lifecycle = ["preinstall", "install", "postinstall", "prepare"];
    for (const script of lifecycle) {
      const command = parsed.scripts?.[script];
      if (typeof command !== "string") continue;
      if (baseParsed?.scripts?.[script] === command) continue;
      addReason(state, {
        code: "DEPENDENCY_LIFECYCLE_SCRIPT",
        risk: "high",
        title: `Lifecycle script ${script} presente`,
        detail: "Los scripts de instalacion ejecutan codigo durante el build y requieren el perfil aislado para forks.",
        evidence: [{ path: file.path, side: "head", excerpt: `scripts.${script}=[REDACTED]` }],
      });
      state.securityFlags.add("DEPENDENCY_INSTALL_CODE_CHANGED");
    }
  } catch (error) {
    state.complete = false;
    state.diagnostics.push(`No se pudo parsear ${file.path}: ${safeDiagnostic(error)}`);
  }
}

function inspectAutomation(state: PlanningState, file: InspectedFile): void {
  const content = file.head?.content;
  if (content === undefined) return;
  if (/\bpull_request_target\s*:/i.test(content) && !/\bpull_request_target\s*:/i.test(file.base?.content ?? "")) {
    const index = content.search(/\bpull_request_target\s*:/i);
    addReason(state, {
      code: "PRIVILEGED_FORK_WORKFLOW",
      risk: "critical",
      title: "Workflow privilegiado para forks",
      detail: "pull_request_target puede combinar secretos del repositorio base con codigo controlado por un fork.",
      evidence: [evidence(file.path, "head", content, index)],
    });
    state.securityFlags.add("PRIVILEGED_FORK_WORKFLOW_CHANGED");
  }
}

function inspectFiles(state: PlanningState, files: InspectedFile[]): void {
  const addedMigrations = files.filter((file) => file.category === "migration" && file.status === "added");
  const prismaChanges = files.filter((file) => file.category === "prisma-schema");

  for (const file of files) {
    if (file.status === "unknown") {
      state.complete = false;
      addReason(state, {
        code: "UNMERGED_OR_UNKNOWN_CHANGE",
        risk: "high",
        title: "Cambio git no clasificable",
        detail: "El rango contiene un estado que el triage no puede interpretar de forma segura.",
        evidence: [{ path: file.path, side: "metadata" }],
      });
    }
    if (
      file.category === "migration" &&
      (file.status === "modified" || file.status === "deleted" || file.status === "renamed" || file.status === "copied")
    ) {
      addReason(state, {
        code: "MIGRATION_HISTORY_REWRITTEN",
        risk: "critical",
        title: "Historial de migraciones reescrito",
        detail: "Modificar, borrar o renombrar una migracion existente crea drift entre bases que ya la aplicaron.",
        evidence: [{ path: file.path, side: "metadata", ...(file.previousPath === undefined ? {} : { excerpt: `antes: ${safeExcerpt(file.previousPath)}` }) }],
      });
    }
    if (/migration_lock\.toml$/i.test(file.path) && file.status !== "added") {
      addReason(state, {
        code: "MIGRATION_LOCK_CHANGED",
        risk: "high",
        title: "Metadata de migraciones modificada",
        detail: "Cambiar migration_lock puede alterar el proveedor o romper reproducibilidad del historial.",
        evidence: [{ path: file.path, side: "metadata" }],
      });
    }

    if ((file.category === "migration" || file.category === "sql") && file.path.toLowerCase().endsWith(".sql")) {
      inspectSql(state, file);
    }
    if (file.category === "prisma-schema") inspectPrisma(state, file);
    if (file.category === "build" && /^dockerfile(?:\.|$)/i.test(basename(file.path))) inspectDockerfile(state, file);
    if (file.category === "dependency") inspectPackageJson(state, file);
    if (file.category === "automation") inspectAutomation(state, file);

    if (file.category === "build") state.securityFlags.add("BUILD_SURFACE_CHANGED");
    if (file.category === "dependency") state.securityFlags.add("DEPENDENCY_GRAPH_CHANGED");
    if (file.category === "proof-config") state.securityFlags.add("EXECUTABLE_PROOF_CONFIG_CHANGED");
    if (file.category === "automation") state.securityFlags.add("CI_AUTOMATION_CHANGED");
    if (file.category === "privacy") {
      state.securityFlags.add("SECRET_BEARING_FILE_CHANGED");
      state.privacyFlags.add("SECRET_BEARING_FILE_CHANGED");
    }
    if (/record|replay|telemetry|trace|logging|audit/i.test(file.path)) {
      state.privacyFlags.add("OBSERVABILITY_OR_CAPTURE_CODE_CHANGED");
    }
    if (
      (file.category === "proof-config" || file.category === "runtime-config") &&
      /(?:token|password|passwd|secret|authorization|cookie|api[-_]?key|private[-_]?key)/i.test(
        file.head?.content ?? "",
      )
    ) {
      state.privacyFlags.add("SENSITIVE_CONFIG_SIGNAL");
    }
  }

  const firstByCategory = (category: ChangeCategory) => files.find((file) => file.category === category);
  const genericReasons: Array<{
    category: ChangeCategory;
    code: string;
    risk: Exclude<TriageRisk, "unknown">;
    title: string;
    detail: string;
  }> = [
    {
      category: "migration",
      code: "DATABASE_MIGRATION_CHANGED",
      risk: "medium",
      title: "Migracion de base modificada",
      detail: "Toda migracion requiere la matriz A0/A1 x S0/S1, incluso cuando el lint no encuentra un patron peligroso.",
    },
    {
      category: "prisma-schema",
      code: "PRISMA_SCHEMA_CHANGED",
      risk: "medium",
      title: "Contrato Prisma modificado",
      detail: "El cliente generado y el schema desplegado deben comprobarse en ambas direcciones de compatibilidad.",
    },
    {
      category: "sql",
      code: "SQL_SURFACE_CHANGED",
      risk: "medium",
      title: "SQL de release modificado",
      detail: "El analisis textual no demuestra locks, volumen ni comportamiento contra datos reales.",
    },
    {
      category: "build",
      code: "BUILD_DEFINITION_CHANGED",
      risk: "medium",
      title: "Definicion de build modificada",
      detail: "Se requiere reconstruir A0/A1 y comprobar startup con el perfil de ejecucion correspondiente.",
    },
    {
      category: "dependency",
      code: "DEPENDENCY_GRAPH_CHANGED",
      risk: "medium",
      title: "Grafo de dependencias modificado",
      detail: "El lockfile o manifest puede cambiar runtime, scripts de instalacion y reproducibilidad.",
    },
    {
      category: "proof-config",
      code: "EXECUTABLE_PROOF_CONFIG_CHANGED",
      risk: "high",
      title: "Configuracion ejecutable de Proof modificada",
      detail: "El plan de verificacion cambio dentro del candidato y debe tratarse como codigo no confiable en forks.",
    },
    {
      category: "runtime-config",
      code: "RUNTIME_CONFIG_CHANGED",
      risk: "medium",
      title: "Configuracion de runtime modificada",
      detail: "La compatibilidad no puede inferirse solo del diff de configuracion.",
    },
    {
      category: "automation",
      code: "CI_AUTOMATION_CHANGED",
      risk: "high",
      title: "Automatizacion de CI modificada",
      detail: "Los permisos, secretos y condiciones de ejecucion deben revisarse antes de confiar en el recibo.",
    },
    {
      category: "application",
      code: "APPLICATION_RUNTIME_CHANGED",
      risk: "medium",
      title: "Codigo de aplicacion modificado",
      detail: "Se requiere al menos la matriz enfocada para comprobar build, startup y contrato HTTP/SQL.",
    },
    {
      category: "privacy",
      code: "SECRET_OR_PRIVATE_DATA_FILE_CHANGED",
      risk: "high",
      title: "Archivo sensible modificado",
      detail: "No se inspecciona su contenido; exige redaccion, aislamiento y revision de exposicion accidental.",
    },
  ];
  for (const generic of genericReasons) {
    const file = firstByCategory(generic.category);
    if (file === undefined) continue;
    addReason(state, {
      code: generic.code,
      risk: generic.risk,
      title: generic.title,
      detail: generic.detail,
      evidence: [{ path: file.path, side: "metadata" }],
    });
  }

  if (prismaChanges.length > 0 && addedMigrations.length === 0) {
    addReason(state, {
      code: "PRISMA_SCHEMA_WITHOUT_NEW_MIGRATION",
      risk: "high",
      title: "Schema Prisma cambio sin migracion nueva",
      detail: "El candidato puede compilar contra un schema que nunca se aplica a la base desplegada.",
      evidence: prismaChanges.slice(0, 5).map((file) => ({ path: file.path, side: "metadata" })),
    });
  }
  if (addedMigrations.length > 0 && prismaChanges.length === 0) {
    addReason(state, {
      code: "MIGRATION_WITHOUT_PRISMA_SCHEMA_CHANGE",
      risk: "medium",
      title: "Migracion SQL sin cambio de schema Prisma",
      detail: "Puede ser intencional, pero requiere confirmar drift y compatibilidad del cliente generado.",
      evidence: addedMigrations.slice(0, 5).map((file) => ({ path: file.path, side: "metadata" })),
    });
  }
}

function relevantCategory(category: ChangeCategory): boolean {
  return category !== "documentation" && category !== "other";
}

function shouldReadContent(category: ChangeCategory): boolean {
  return [
    "migration",
    "prisma-schema",
    "sql",
    "build",
    "dependency",
    "proof-config",
    "runtime-config",
    "automation",
  ].includes(category);
}

function reasonOrder(left: TriageReason, right: TriageReason): number {
  const risk = RISK_RANK[right.risk] - RISK_RANK[left.risk];
  if (risk !== 0) return risk;
  const code = left.code.localeCompare(right.code);
  if (code !== 0) return code;
  const leftEvidence = left.evidence[0];
  const rightEvidence = right.evidence[0];
  return `${leftEvidence?.path ?? ""}:${leftEvidence?.line ?? 0}`.localeCompare(
    `${rightEvidence?.path ?? ""}:${rightEvidence?.line ?? 0}`,
  );
}

function deriveAssurance(
  risk: TriageRisk,
  files: InspectedFile[],
): ReleaseTriagePlan["assurance"] {
  const databaseChanged = files.some((file) =>
    ["migration", "prisma-schema", "sql"].includes(file.category),
  );
  const executableChanged = files.some((file) =>
    ["build", "dependency", "proof-config", "runtime-config", "automation", "application", "privacy"].includes(
      file.category,
    ),
  );
  if (risk === "unknown" || databaseChanged || risk === "critical" || risk === "high") {
    return {
      level: "FULL_RELEASE_MATRIX",
      executionRequired: true,
      requiredStates: FULL_MATRIX,
      rationale:
        risk === "unknown"
          ? "El analisis estatico no pudo acotar el riesgo; se exige la matriz completa."
          : databaseChanged
            ? "Cambio de datos/schema: se exige compatibilidad A0/A1, coexistencia y rollback."
            : "El riesgo alto o critico no puede cerrarse con evidencia estatica.",
    };
  }
  if (executableChanged || risk === "medium") {
    return {
      level: "TARGETED_RELEASE_MATRIX",
      executionRequired: true,
      requiredStates: TARGETED_MATRIX,
      rationale: "Cambio ejecutable/build/runtime: se exige build y compatibilidad del candidato.",
    };
  }
  return {
    level: "PLAN_ONLY",
    executionRequired: false,
    requiredStates: [],
    rationale: "No se detectaron superficies ejecutables ni de datos; el plan no certifica el release.",
  };
}

function planCacheKey(
  input: ReleaseTriageInput,
  baseSha: string | undefined,
  headSha: string | undefined,
  files: InspectedFile[],
  complete: boolean,
  executionProfile: ExecutionProfile,
): string {
  const material = {
    ruleset: TRIAGE_RULESET_VERSION,
    base: baseSha ?? sha256(input.baseSha),
    head: headSha ?? sha256(input.headSha),
    serviceName: input.serviceName ?? null,
    servicePath: input.servicePath ?? null,
    prismaSchemaPath: input.prismaSchemaPath ?? null,
    executionProfile,
    complete,
    files: files
      .map((file) => ({
        path: file.path,
        previousPath: file.previousPath ?? null,
        status: file.status,
        category: file.category,
        base: file.base?.sha256 ?? null,
        head: file.head?.sha256 ?? null,
      }))
      .sort((left, right) => left.path.localeCompare(right.path)),
  };
  return `sha256:${sha256(JSON.stringify(material))}`;
}

function commandsFor(
  input: ReleaseTriageInput,
  baseSha: string | undefined,
  headSha: string | undefined,
  executionProfile: ExecutionProfile,
  assurance: ReleaseTriagePlan["assurance"],
): { nextCommand: TriageCommand; nextActions: TriageCommand[] } {
  const verifyArgs = [
    "release",
    "verify",
    "--base-sha",
    baseSha ?? publicRef(input.baseSha),
    "--head-sha",
    headSha ?? publicRef(input.headSha),
    ...(input.serviceName === undefined ? [] : ["--service", input.serviceName]),
    "--profile",
    executionProfile,
  ];
  const verify: TriageCommand = {
    command: "proof",
    args: verifyArgs,
    reason: assurance.executionRequired
      ? "Ejecutar la matriz requerida; este plan estatico nunca emite VERIFIED."
      : "No se exige matriz por este diff; ejecuta verify si la politica requiere un recibo VERIFIED.",
  };
  if (input.configuration?.loaded === false) {
    const doctor: TriageCommand = {
      command: "proof",
      args: ["doctor"],
      reason: "Corregir o generar proof.config antes de ejecutar la matriz.",
    };
    return { nextCommand: doctor, nextActions: [doctor, verify] };
  }
  return { nextCommand: verify, nextActions: [verify] };
}

/**
 * Produces a bounded static plan using only `git` with argument arrays.  Any
 * missing/truncated evidence yields risk=unknown and a full matrix plan.
 */
export async function planRelease(
  input: ReleaseTriageInput,
  runner?: CommandRunner,
): Promise<ReleaseTriagePlan> {
  const cwd = input.cwd ?? process.cwd();
  const executionProfile = resolveExecutionProfile(input.executionProfile);
  const requestedBudget = input.durationBudgetMs ?? TRIAGE_DURATION_BUDGET_MS;
  const budgetMs =
    Number.isFinite(requestedBudget) && requestedBudget > 0
      ? Math.max(1, Math.min(Math.floor(requestedBudget), TRIAGE_DURATION_BUDGET_MS))
      : TRIAGE_DURATION_BUDGET_MS;
  const git = new GitReader(
    runner ?? new SpawnRunner({ executionProfile, role: "orchestrator" }),
    cwd,
    budgetMs,
  );
  const state: PlanningState = {
    complete: true,
    diagnostics: [],
    reasons: [],
    securityFlags: new Set<string>(),
    privacyFlags: new Set<string>(),
  };
  let baseSha: string | undefined;
  let headSha: string | undefined;
  let files: InspectedFile[] = [];

  if (input.configuration?.loaded === false) {
    state.complete = false;
    state.diagnostics.push(
      `Configuracion no disponible: ${safeDiagnostic(input.configuration.error ?? "error desconocido")}`,
    );
    state.securityFlags.add("CONFIGURATION_NOT_VALIDATED");
  }

  try {
    validateRef(input.baseSha, "baseSha");
    validateRef(input.headSha, "headSha");
    if (input.serviceName !== undefined && !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(input.serviceName)) {
      throw new Error("serviceName no es seguro para un plan reproducible.");
    }
    if (
      input.servicePath !== undefined &&
      normalizeRepoPath(input.servicePath) !== "." &&
      !isPathInsideRepo(input.servicePath)
    ) {
      throw new Error("servicePath debe ser relativo al repositorio.");
    }
    if (input.prismaSchemaPath !== undefined && !isPathInsideRepo(input.prismaSchemaPath)) {
      throw new Error("prismaSchemaPath debe ser relativo al repositorio.");
    }
    [baseSha, headSha] = await Promise.all([
      git.resolveCommit(input.baseSha),
      git.resolveCommit(input.headSha),
    ]);

    const ancestry = await git.run(["merge-base", "--is-ancestor", baseSha, headSha], [0, 1]);
    if (ancestry.exitCode === 1) {
      addReason(state, {
        code: "NON_LINEAR_RELEASE_RANGE",
        risk: "high",
        title: "Base desplegada no es ancestro del candidato",
        detail: "El rango puede omitir drift o mezclar historiales; el verify debe usar snapshots exactos.",
        evidence: [{ path: "(git history)", side: "metadata", excerpt: `${baseSha.slice(0, 12)} !< ${headSha.slice(0, 12)}` }],
      });
    }

    const diff = await git.run([
      "diff",
      "--name-status",
      "-z",
      "--find-renames=90%",
      "--no-ext-diff",
      "--no-textconv",
      baseSha,
      headSha,
      "--",
    ]);
    const rawFiles = parseNameStatusZ(diff.stdout);
    if (rawFiles.length > MAX_CHANGED_FILES) {
      throw new Error(`El rango contiene ${rawFiles.length} archivos; limite ${MAX_CHANGED_FILES}.`);
    }
    for (const file of rawFiles) {
      if (!isPathInsideRepo(file.path) || (file.previousPath !== undefined && !isPathInsideRepo(file.previousPath))) {
        throw new Error(`git devolvio una ruta fuera del repositorio: ${file.path}`);
      }
    }

    files = rawFiles
      .map((raw): InspectedFile => ({
        path: raw.path,
        status: statusFor(raw.statusCode),
        category: categoryFor(
          raw.path,
          executionProfile === "trusted" ? input.servicePath : undefined,
          input.prismaSchemaPath,
        ),
        ...(raw.previousPath === undefined ? {} : { previousPath: raw.previousPath }),
      }))
      .sort((left, right) => left.path.localeCompare(right.path));

    const contentFiles = files.filter((file) => shouldReadContent(file.category));
    if (contentFiles.length > MAX_CONTENT_FILES) {
      state.complete = false;
      state.diagnostics.push(
        `Hay ${contentFiles.length} archivos relevantes; solo se inspeccionan ${MAX_CONTENT_FILES}.`,
      );
      state.securityFlags.add("ANALYSIS_LIMIT_REACHED");
    }

    const selected = contentFiles.slice(0, MAX_CONTENT_FILES);
    const batchSize = 8;
    for (let offset = 0; offset < selected.length; offset += batchSize) {
      const batch = selected.slice(offset, offset + batchSize);
      await Promise.all(
        batch.map(async (file) => {
          try {
            const basePath = file.previousPath ?? file.path;
            const [base, head] = await Promise.all([
              file.status === "added" ? Promise.resolve(undefined) : git.show(baseSha!, basePath),
              file.status === "deleted" ? Promise.resolve(undefined) : git.show(headSha!, file.path),
            ]);
            if (base !== undefined) file.base = base;
            if (head !== undefined) file.head = head;
          } catch (error) {
            state.complete = false;
            state.diagnostics.push(`Contenido no inspeccionado (${file.path}): ${safeDiagnostic(error)}`);
            state.securityFlags.add("CONTENT_ANALYSIS_INCOMPLETE");
          }
        }),
      );
    }

    inspectFiles(state, files);
  } catch (error) {
    state.complete = false;
    state.diagnostics.push(safeDiagnostic(error));
    state.securityFlags.add("GIT_ANALYSIS_INCOMPLETE");
  }

  if (!state.complete) {
    addReason(state, {
      code: "ANALYSIS_INCOMPLETE",
      risk: "high",
      title: "Triage incompleto",
      detail: "Proof no pudo inspeccionar toda la evidencia; no es seguro reducir la matriz.",
      evidence: [{ path: "(triage)", side: "metadata" }],
    });
  }

  const reasons = state.reasons.sort(reasonOrder);
  const risk: TriageRisk = state.complete
    ? reasons.reduce<Exclude<TriageRisk, "unknown">>(
        (current, reason) => (RISK_RANK[reason.risk] > RISK_RANK[current] ? reason.risk : current),
        "low",
      )
    : "unknown";
  const assurance = deriveAssurance(risk, files);
  const byCategory = emptyCategoryCounts();
  for (const file of files) byCategory[file.category] += 1;
  const commands = commandsFor(input, baseSha, headSha, executionProfile, assurance);
  const publicFiles = files.slice(0, MAX_PUBLIC_CHANGED_FILES).map((file): TriageChangedFile => ({
    path: file.path,
    status: file.status,
    category: file.category,
    ...(file.previousPath === undefined ? {} : { previousPath: file.previousPath }),
    ...(file.base === undefined ? {} : { baseContentSha256: file.base.sha256 }),
    ...(file.head === undefined ? {} : { headContentSha256: file.head.sha256 }),
  }));

  return {
    kind: "proof.release-plan",
    version: "1",
    decision: "PLAN_ONLY_NOT_VERIFIED",
    ruleset: TRIAGE_RULESET_VERSION,
    subject: {
      baseRef: publicRef(input.baseSha),
      headRef: publicRef(input.headSha),
      ...(baseSha === undefined ? {} : { baseSha }),
      ...(headSha === undefined ? {} : { headSha }),
      ...(input.serviceName === undefined || input.servicePath === undefined
        ? {}
        : { service: { name: input.serviceName, path: input.servicePath } }),
    },
    risk,
    assurance,
    analysis: {
      complete: state.complete,
      executionProfile,
      budgetMs,
      changedFilesInspected: files.length,
      contentFilesInspected: files.filter((file) => file.base !== undefined || file.head !== undefined).length,
      diagnostics: [...new Set(state.diagnostics)].sort().slice(0, 20),
    },
    changes: {
      total: files.length,
      relevant: files.filter((file) => relevantCategory(file.category)).length,
      byCategory,
      files: publicFiles,
      filesTruncated: files.length > MAX_PUBLIC_CHANGED_FILES,
    },
    reasons,
    security: {
      reviewRequired: state.securityFlags.size > 0,
      forkProfileRequired:
        executionProfile === "fork" || state.securityFlags.size > 0 || assurance.executionRequired,
      flags: [...state.securityFlags].sort(),
    },
    privacy: {
      reviewRequired: state.privacyFlags.size > 0,
      bundleRedactionRequired: true,
      flags: [...state.privacyFlags].sort(),
    },
    cacheKey: planCacheKey(input, baseSha, headSha, files, state.complete, executionProfile),
    cacheReusable: state.complete,
    nextCommand: commands.nextCommand,
    nextActions: commands.nextActions,
    disclaimer:
      "Static triage only. This artifact can route work but cannot certify behavior or emit VERIFIED.",
  };
}
