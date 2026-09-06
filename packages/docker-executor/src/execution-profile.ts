import { ExecutorError } from "./errors.js";

export const EXECUTION_PROFILES = ["trusted", "internal", "fork"] as const;
export type ExecutionProfile = (typeof EXECUTION_PROFILES)[number];
export type BuildNetworkMode = "default" | "none";

export interface ExecutionPolicy {
  profile: ExecutionProfile;
  blockEgress: boolean;
  buildNetwork: BuildNetworkMode;
  readOnlyRootFilesystem: boolean;
  rejectSensitiveInputs: boolean;
  requireEphemeralRunner: boolean;
}

const SENSITIVE_NAME =
  /(?:^|[_-])(?:auth(?:orization)?|bearer|cookie|credential|database[_-]?url|pass(?:word|wd)?|private[_-]?key|secret|session|token|api[_-]?key|client[_-]?secret)(?:$|[_-])/i;
const SAFE_INHERITED_ENV = new Set([
  "CI",
  "COLORTERM",
  "COMSPEC",
  "GITHUB_ACTIONS",
  "GITLAB_CI",
  "HOME",
  "LANG",
  "LC_ALL",
  "NO_COLOR",
  "NUMBER_OF_PROCESSORS",
  "OS",
  "PATH",
  "PATHEXT",
  "PROCESSOR_ARCHITECTURE",
  "CLOUDPROOF_EXECUTION_PROFILE",
  "CLOUDPROOF_EXECUTION_PROFILE_LOCKED",
  "CLOUDPROOF_EPHEMERAL_RUNNER",
  "CLOUDPROOF_SECRETLESS_RUNNER",
  "SYSTEMDRIVE",
  "SYSTEMROOT",
  "TEMP",
  "TERM",
  "TMP",
  "USERPROFILE",
  "WINDIR",
]);
const ENVIRONMENT_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const SAFE_IMAGE_REFERENCE =
  /^(?:[A-Za-z0-9](?:[A-Za-z0-9._-]*)(?::[0-9]+)?\/)*(?:[A-Za-z0-9](?:[A-Za-z0-9._-]*))(?:[:@][A-Za-z0-9][A-Za-z0-9._:+-]*)?$/;

export function resolveExecutionProfile(
  override?: ExecutionProfile,
  env: NodeJS.ProcessEnv = process.env,
): ExecutionProfile {
  const parse = (raw: string, variable: string): ExecutionProfile => {
    const normalized = raw.trim().toLowerCase();
    if ((EXECUTION_PROFILES as readonly string[]).includes(normalized)) {
      return normalized as ExecutionProfile;
    }
    throw new ExecutorError(
      `${variable} invalido: "${raw}". Usa trusted, internal o fork.`,
    );
  };
  const raw = env["CLOUDPROOF_EXECUTION_PROFILE"];
  const lockRaw = env["CLOUDPROOF_EXECUTION_PROFILE_LOCKED"];
  const hasSelection = override !== undefined || (raw !== undefined && raw.trim() !== "");
  const requested =
    override ??
    (raw === undefined || raw.trim() === ""
      ? "trusted"
      : parse(raw, "CLOUDPROOF_EXECUTION_PROFILE"));
  if (lockRaw === undefined || lockRaw.trim() === "") return requested;

  const locked = parse(lockRaw, "CLOUDPROOF_EXECUTION_PROFILE_LOCKED");
  const rank: Record<ExecutionProfile, number> = { trusted: 0, internal: 1, fork: 2 };
  if (hasSelection && rank[requested] < rank[locked]) {
    throw new ExecutorError(
      `Se rechazo el downgrade de perfil ${locked} -> ${requested}; ` +
        "CLOUDPROOF_EXECUTION_PROFILE_LOCKED solo permite endurecer el aislamiento.",
    );
  }
  return rank[requested] > rank[locked] ? requested : locked;
}

export function isEphemeralRunner(env: NodeJS.ProcessEnv = process.env): boolean {
  const marker = env["CLOUDPROOF_EPHEMERAL_RUNNER"]?.trim().toLowerCase();
  return marker === "1" || marker === "true";
}

export function isSecretlessRunner(env: NodeJS.ProcessEnv = process.env): boolean {
  const marker = env["CLOUDPROOF_SECRETLESS_RUNNER"]?.trim().toLowerCase();
  return marker === "1" || marker === "true";
}

/**
 * trusted < internal < fork. Un workload es codigo arbitrario del checkout,
 * no una operacion de orquestacion. fork nunca puede correrlo en el host que
 * controla Docker; internal exige una maquina efimera declarada sin secretos.
 */
export function assertHostWorkloadAllowed(
  profile: ExecutionProfile,
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (profile === "trusted") return;
  if (profile === "fork") {
    throw new ExecutorError(
      "El perfil fork prohibe ejecutar el workload en el host de orquestacion. " +
        "Hace falta un worker aislado sin credenciales ni acceso al socket Docker.",
    );
  }
  if (!isEphemeralRunner(env) || !isSecretlessRunner(env)) {
    throw new ExecutorError(
      "El perfil internal solo permite workload host en un runner efimero y sin secretos. " +
        "Declara CLOUDPROOF_EPHEMERAL_RUNNER=1 y CLOUDPROOF_SECRETLESS_RUNNER=1 despues de aislarlo.",
    );
  }
}

export function executionPolicy(
  profile: ExecutionProfile,
  overrides: {
    blockEgress?: boolean;
    buildNetwork?: BuildNetworkMode;
    readOnlyRootFilesystem?: boolean;
  } = {},
): ExecutionPolicy {
  const defaults =
    profile === "trusted"
      ? { blockEgress: true, buildNetwork: "default" as const, readOnlyRootFilesystem: false }
      : profile === "internal"
        ? { blockEgress: true, buildNetwork: "default" as const, readOnlyRootFilesystem: true }
        : { blockEgress: true, buildNetwork: "none" as const, readOnlyRootFilesystem: true };

  if (profile === "fork") {
    if (overrides.blockEgress === false) {
      throw new ExecutorError("El perfil fork no permite desactivar el bloqueo de egress.");
    }
    if (overrides.buildNetwork === "default") {
      throw new ExecutorError("El perfil fork exige docker build --network=none.");
    }
    if (overrides.readOnlyRootFilesystem === false) {
      throw new ExecutorError("El perfil fork exige root filesystem de solo lectura.");
    }
  }

  return {
    profile,
    blockEgress: overrides.blockEgress ?? defaults.blockEgress,
    buildNetwork: overrides.buildNetwork ?? defaults.buildNetwork,
    readOnlyRootFilesystem:
      overrides.readOnlyRootFilesystem ?? defaults.readOnlyRootFilesystem,
    rejectSensitiveInputs: profile === "fork",
    requireEphemeralRunner: profile === "fork",
  };
}

export function isSensitiveName(name: string): boolean {
  return SENSITIVE_NAME.test(name);
}

export function looksSensitiveValue(value: string): boolean {
  if (/-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----/.test(value)) return true;
  if (/\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,}|AKIA[A-Z0-9]{16})\b/.test(value)) {
    return true;
  }
  if (/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/.test(value)) return true;
  try {
    const url = new URL(value);
    return url.password !== "" || url.username !== "";
  } catch {
    return false;
  }
}

export function assertValidEnvironment(
  env: Record<string, string>,
  profile: ExecutionProfile,
  options: { allowCloudProofDatabaseUrl?: boolean } = {},
): void {
  for (const [name, value] of Object.entries(env)) {
    if (!ENVIRONMENT_NAME.test(name)) {
      throw new ExecutorError(`Nombre de variable de entorno invalido: "${name}".`);
    }
    if (value.includes("\u0000") || value.includes("\n") || value.includes("\r")) {
      throw new ExecutorError(`La variable ${name} contiene un separador no permitido.`);
    }
    if (profile !== "fork") continue;

    const cloudproofDatabaseUrl =
      options.allowCloudProofDatabaseUrl === true &&
      name === "DATABASE_URL" &&
      /^postgres(?:ql)?:\/\/cloudproof:cloudproof@cloudproof-pg-[A-Za-z0-9_.-]+:5432\/cloudproof$/.test(value);
    if (!cloudproofDatabaseUrl && (isSensitiveName(name) || looksSensitiveValue(value))) {
      throw new ExecutorError(
        `El perfil fork rechazo la variable sensible ${name}. ` +
          `Los secretos del repo/runner no pueden entrar al contenedor candidato.`,
      );
    }
  }
}

export function assertSafeBuildArgs(
  args: Record<string, string>,
  profile: ExecutionProfile,
): void {
  assertValidEnvironment(args, profile);
  if (profile === "trusted") return;
  for (const [name, value] of Object.entries(args)) {
    if (isSensitiveName(name) || looksSensitiveValue(value)) {
      throw new ExecutorError(
        `El perfil ${profile} rechazo el build arg sensible ${name}. ` +
          `Usa una imagen preconstruida o secretos BuildKit fuera de CloudProof.`,
      );
    }
  }
}

/** Entorno minimo heredable por procesos que manejan un checkout no confiable. */
export function environmentForProfile(
  profile: ExecutionProfile,
  source: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  if (profile === "trusted") {
    return Object.fromEntries(
      Object.entries(source).filter((entry): entry is [string, string] => entry[1] !== undefined),
    );
  }
  return Object.fromEntries(
    Object.entries(source).filter(
      (entry): entry is [string, string] =>
        entry[1] !== undefined && SAFE_INHERITED_ENV.has(entry[0].toUpperCase()),
    ),
  );
}

export function assertSafeImageReference(image: string, label = "imagen"): void {
  if (image.length > 512 || !SAFE_IMAGE_REFERENCE.test(image)) {
    throw new ExecutorError(`${label} Docker invalida: "${image}".`);
  }
}
