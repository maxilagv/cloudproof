export const HTTP_EXECUTION_PROFILES = ["trusted", "internal", "fork"] as const;
export type HttpExecutionProfile = (typeof HTTP_EXECUTION_PROFILES)[number];

const RANK: Record<HttpExecutionProfile, number> = { trusted: 0, internal: 1, fork: 2 };
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "[::1]", "localhost"]);

function parseProfile(raw: string, variable: string): HttpExecutionProfile {
  const normalized = raw.trim().toLowerCase();
  if ((HTTP_EXECUTION_PROFILES as readonly string[]).includes(normalized)) {
    return normalized as HttpExecutionProfile;
  }
  throw new TypeError(`${variable} must be trusted, internal or fork`);
}

export function resolveHttpExecutionProfile(
  override?: HttpExecutionProfile,
  env: NodeJS.ProcessEnv = process.env,
): HttpExecutionProfile {
  const raw = env["CLOUDPROOF_EXECUTION_PROFILE"];
  const lockRaw = env["CLOUDPROOF_EXECUTION_PROFILE_LOCKED"];
  const selected =
    override ??
    (raw === undefined || raw.trim() === ""
      ? "trusted"
      : parseProfile(raw, "CLOUDPROOF_EXECUTION_PROFILE"));
  const explicitlySelected = override !== undefined || (raw !== undefined && raw.trim() !== "");
  if (lockRaw === undefined || lockRaw.trim() === "") return selected;
  const locked = parseProfile(lockRaw, "CLOUDPROOF_EXECUTION_PROFILE_LOCKED");
  if (explicitlySelected && RANK[selected] < RANK[locked]) {
    throw new TypeError(`Execution profile downgrade ${locked} -> ${selected} was rejected`);
  }
  return RANK[selected] > RANK[locked] ? selected : locked;
}

export function isLoopbackHost(hostname: string): boolean {
  return LOOPBACK_HOSTS.has(hostname.toLowerCase());
}

export function assertSafeHttpTarget(
  target: URL,
  profile: HttpExecutionProfile,
  label: string,
): void {
  if (target.protocol !== "http:" && target.protocol !== "https:") {
    throw new TypeError(`${label} must use http: or https:`);
  }
  if (target.username !== "" || target.password !== "") {
    throw new TypeError(`${label} must not contain URL credentials`);
  }
  if (profile !== "trusted" && !isLoopbackHost(target.hostname)) {
    throw new TypeError(`${label} must target loopback under ${profile} profile`);
  }
}
