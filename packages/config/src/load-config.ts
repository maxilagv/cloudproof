import { existsSync, lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { createJiti } from "jiti";
import {
  ExecutionProfileSchema,
  ProjectConfigSchema,
  type ExecutionProfile,
  type ProjectConfig,
} from "./schema.js";

const MAX_CONFIG_BYTES = 1024 * 1024;

export interface LoadConfigOptions {
  /** Precede a PROOF_EXECUTION_PROFILE. */
  executionProfile?: ExecutionProfile;
  /** Inyectable para integraciones; default process.env. */
  env?: NodeJS.ProcessEnv;
}

export class ConfigNotFoundError extends Error {
  constructor(searchedPaths: string | string[]) {
    const paths = Array.isArray(searchedPaths) ? searchedPaths : [searchedPaths];
    super(
      `No se encontro una configuracion Proof en ${paths.join(" ni ")}. ` +
        `Corre "proof init" para generarla.`,
    );
    this.name = "ConfigNotFoundError";
  }
}

export class InvalidConfigError extends Error {
  constructor(configPath: string, detail: string) {
    super(`Config Proof invalido (${configPath}):\n${detail}`);
    this.name = "InvalidConfigError";
  }
}

export class ExecutableConfigRejectedError extends Error {
  constructor(configPath: string, profile: ExecutionProfile) {
    super(
      `El perfil ${profile} rechazo ${configPath}: un proof.config.ts ejecutaria codigo del checkout ` +
        `antes de crear el sandbox. Usa proof.config.json (datos puros) o proporciona una ` +
        `configuracion confiable fuera del checkout candidato.`,
    );
    this.name = "ExecutableConfigRejectedError";
  }
}

export class InvalidExecutionProfileError extends Error {
  constructor(value: string) {
    super(
      `PROOF_EXECUTION_PROFILE invalido: "${value}". Valores permitidos: trusted, internal, fork.`,
    );
    this.name = "InvalidExecutionProfileError";
  }
}

export class ExecutionProfileDowngradeError extends Error {
  constructor(requested: ExecutionProfile, locked: ExecutionProfile) {
    super(
      `Se rechazo el downgrade de perfil ${locked} -> ${requested}. ` +
        `PROOF_EXECUTION_PROFILE_LOCKED solo permite conservar o endurecer el aislamiento.`,
    );
    this.name = "ExecutionProfileDowngradeError";
  }
}

const PROFILE_RANK: Record<ExecutionProfile, number> = {
  trusted: 0,
  internal: 1,
  fork: 2,
};

function parseProfile(value: string, variable: string): ExecutionProfile {
  const normalized = value.trim().toLowerCase();
  const parsed = ExecutionProfileSchema.safeParse(normalized);
  if (!parsed.success) {
    throw new InvalidExecutionProfileError(`${variable}=${value}`);
  }
  return parsed.data;
}

/** Override explicito > entorno > trusted (compatibilidad local). */
export function resolveExecutionProfile(
  override?: ExecutionProfile,
  env: NodeJS.ProcessEnv = process.env,
): ExecutionProfile {
  const raw = env["PROOF_EXECUTION_PROFILE"];
  const lockedRaw = env["PROOF_EXECUTION_PROFILE_LOCKED"];
  const hasSelection = override !== undefined || (raw !== undefined && raw.trim() !== "");
  const requested =
    override ??
    (raw === undefined || raw.trim() === ""
      ? "trusted"
      : parseProfile(raw, "PROOF_EXECUTION_PROFILE"));
  if (lockedRaw === undefined || lockedRaw.trim() === "") return requested;

  const locked = parseProfile(lockedRaw, "PROOF_EXECUTION_PROFILE_LOCKED");
  if (hasSelection && PROFILE_RANK[requested] < PROFILE_RANK[locked]) {
    throw new ExecutionProfileDowngradeError(requested, locked);
  }
  return PROFILE_RANK[requested] > PROFILE_RANK[locked] ? requested : locked;
}

function parseCandidate(candidate: unknown, configPath: string): ProjectConfig {
  const parsed = ProjectConfigSchema.safeParse(candidate);
  if (!parsed.success) {
    throw new InvalidConfigError(
      configPath,
      parsed.error.issues
        .map((issue) => `  ${issue.path.join(".")}: ${issue.message}`)
        .join("\n"),
    );
  }
  return parsed.data;
}

/** Rechaza claves duplicadas (incluidas variantes escapadas) antes de JSON.parse. */
function assertNoDuplicateJsonKeys(source: string): void {
  let index = 0;
  const whitespace = (): void => {
    while (/\s/.test(source[index] ?? "")) index += 1;
  };
  const stringToken = (): string => {
    if (source[index] !== '"') throw new SyntaxError(`Se esperaba string en byte ${index}.`);
    const start = index++;
    let escaped = false;
    while (index < source.length) {
      const character = source[index++];
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === '"') {
        return JSON.parse(source.slice(start, index)) as string;
      }
    }
    throw new SyntaxError("String JSON sin cierre.");
  };
  const value = (depth: number): void => {
    if (depth > 128) throw new SyntaxError("JSON excede la profundidad máxima de 128.");
    whitespace();
    const character = source[index];
    if (character === '"') {
      stringToken();
      return;
    }
    if (character === "{") {
      index += 1;
      whitespace();
      const keys = new Set<string>();
      if (source[index] === "}") {
        index += 1;
        return;
      }
      for (;;) {
        whitespace();
        const key = stringToken();
        if (keys.has(key)) throw new SyntaxError(`Clave JSON duplicada: ${key}.`);
        keys.add(key);
        whitespace();
        if (source[index++] !== ":") throw new SyntaxError(`Se esperaba ':' en byte ${index - 1}.`);
        value(depth + 1);
        whitespace();
        const delimiter = source[index++];
        if (delimiter === "}") return;
        if (delimiter !== ",") throw new SyntaxError(`Se esperaba ',' o '}' en byte ${index - 1}.`);
      }
    }
    if (character === "[") {
      index += 1;
      whitespace();
      if (source[index] === "]") {
        index += 1;
        return;
      }
      for (;;) {
        value(depth + 1);
        whitespace();
        const delimiter = source[index++];
        if (delimiter === "]") return;
        if (delimiter !== ",") throw new SyntaxError(`Se esperaba ',' o ']' en byte ${index - 1}.`);
      }
    }
    const tail = source.slice(index);
    const scalar = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(tail)?.[0];
    if (scalar === undefined) throw new SyntaxError(`Valor JSON inválido en byte ${index}.`);
    index += scalar.length;
  };
  value(0);
  whitespace();
  if (index !== source.length) throw new SyntaxError(`Contenido extra en byte ${index}.`);
}

function loadJsonConfig(configPath: string): ProjectConfig {
  const size = statSync(configPath).size;
  if (size > MAX_CONFIG_BYTES) {
    throw new InvalidConfigError(
      configPath,
      `El archivo supera el limite de ${MAX_CONFIG_BYTES} bytes.`,
    );
  }
  const raw = readFileSync(configPath);
  try {
    const json = raw.toString("utf8").replace(/^\uFEFF/, "");
    assertNoDuplicateJsonKeys(json);
    return parseCandidate(JSON.parse(json) as unknown, configPath);
  } catch (error) {
    if (error instanceof InvalidConfigError) throw error;
    const detail = error instanceof Error ? error.message : String(error);
    throw new InvalidConfigError(configPath, `JSON invalido: ${detail}`);
  }
}

/**
 * En perfiles no confiables el archivo de datos debe pertenecer realmente al
 * checkout. Un symlink/junction hacia fuera volveria a introducir datos del
 * host antes de crear el sandbox, aunque el payload fuese JSON.
 */
function assertUntrustedJsonConfig(cwd: string, configPath: string): void {
  const entry = lstatSync(configPath);
  if (!entry.isFile() || entry.isSymbolicLink()) {
    throw new InvalidConfigError(
      configPath,
      "proof.config.json debe ser un archivo regular, no un symlink ni directorio.",
    );
  }
  const realRoot = realpathSync(cwd);
  const realConfig = realpathSync(configPath);
  const rel = relative(realRoot, realConfig);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new InvalidConfigError(
      configPath,
      "proof.config.json resuelve fuera del checkout y fue rechazado.",
    );
  }
}

/**
 * Solo trusted conserva proof.config.ts via jiti. internal/fork aceptan JSON:
 * la politica se decide antes de importar cualquier byte ejecutable del PR.
 */
export async function loadConfig(
  cwd: string = process.cwd(),
  options: LoadConfigOptions = {},
): Promise<ProjectConfig> {
  const profile = resolveExecutionProfile(options.executionProfile, options.env ?? process.env);
  const typescriptPath = resolve(cwd, "proof.config.ts");
  const jsonPath = resolve(cwd, "proof.config.json");

  if (profile !== "trusted") {
    if (existsSync(jsonPath)) {
      assertUntrustedJsonConfig(cwd, jsonPath);
      return loadJsonConfig(jsonPath);
    }
    if (existsSync(typescriptPath)) {
      throw new ExecutableConfigRejectedError(typescriptPath, profile);
    }
    throw new ConfigNotFoundError([jsonPath, typescriptPath]);
  }

  // Prioridad historica para no cambiar proyectos existentes.
  if (!existsSync(typescriptPath)) {
    if (existsSync(jsonPath)) return loadJsonConfig(jsonPath);
    throw new ConfigNotFoundError([typescriptPath, jsonPath]);
  }

  const jiti = createJiti(import.meta.url);
  const mod = (await jiti.import(typescriptPath)) as { default?: unknown };
  return parseCandidate(mod.default ?? mod, typescriptPath);
}
