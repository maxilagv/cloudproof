import type { CommandRunner } from "./command-runner.js";
import { ExecutorError, redactDiagnosticText } from "./errors.js";

/**
 * Readiness REAL de un Postgres containerizado.
 *
 * `pg_isready` vía `docker exec` usa el socket Unix del contenedor y por eso
 * también responde OK durante la ventana de inicialización en la que el
 * entrypoint oficial levanta un postmaster TEMPORAL (initdb + scripts) y lo
 * apaga antes del arranque definitivo ("FATAL: the database system is
 * shutting down", familia SQLSTATE 57P03 — carrera observada en una corrida
 * real). Ese postmaster temporal escucha SOLO por socket Unix; el definitivo
 * es el único que escucha por TCP.
 *
 * La única evidencia de readiness aceptada acá es, por lo tanto:
 *  1. ejecutar SQL real (`SELECT 1`) por TCP contra la base exacta que la
 *     app va a usar — el mismo camino de conexión que tendrá la app;
 *  2. exigir N éxitos consecutivos (default 2) sobre el MISMO postmaster,
 *     comparando `pg_postmaster_start_time()`: un reinicio entre sondas
 *     resetea la cuenta;
 *  3. verificar en cada ciclo que el contenedor siga vivo, con sus logs
 *     como evidencia si murió.
 */

export interface PostgresReadinessAttempt {
  /** Número de sonda (1-based) dentro de esta espera. */
  attempt: number;
  outcome: "ok" | "waiting" | "restarted" | "exited";
  detail: string;
}

export interface PostgresReadinessOptions {
  /** Etiqueta humana para mensajes de error (ej. "S0"). Default: containerId. */
  label?: string;
  user?: string;
  database?: string;
  password?: string;
  timeoutMs?: number;
  pollIntervalMs?: number;
  /** Éxitos consecutivos requeridos sobre el mismo postmaster. Default 2. */
  requiredConsecutive?: number;
  /** Observador de sondas; se invoca solo en transiciones de estado. */
  onAttempt?: (attempt: PostgresReadinessAttempt) => void;
}

const READINESS_DEFAULTS = {
  user: "proof",
  database: "proof",
  password: "proof",
  timeoutMs: 60_000,
  pollIntervalMs: 500,
  requiredConsecutive: 2,
} as const;

/**
 * `1` demuestra ejecución SQL real; `pg_postmaster_start_time()` identifica
 * la instancia exacta de postmaster que respondió, para detectar reinicios
 * entre sondas consecutivas.
 */
const READINESS_PROBE_SQL = "SELECT 1, pg_postmaster_start_time();";

/**
 * Errores transitorios CONOCIDOS de conexión/arranque de PostgreSQL.
 * Deliberadamente NO matchea errores SQL reales (violaciones de constraint,
 * columnas inexistentes, etc.): un error de compatibilidad jamás debe
 * reintentarse — es exactamente la evidencia que Proof existe para capturar.
 */
export const TRANSIENT_POSTGRES_PATTERNS: readonly RegExp[] = [
  /the database system is starting up/i,
  /the database system is shutting down/i,
  /the database system is in recovery mode/i,
  /\b57P03\b/,
  /server closed the connection unexpectedly/i,
  /connection to server .{0,160}(?:failed|refused)/is,
  /could not connect to server/i,
];

export function isTransientPostgresError(text: string): boolean {
  return TRANSIENT_POSTGRES_PATTERNS.some((pattern) => pattern.test(text));
}

export async function waitPostgresTcpReady(
  runner: CommandRunner,
  containerId: string,
  options: PostgresReadinessOptions = {},
): Promise<void> {
  const label = options.label ?? containerId;
  const user = options.user ?? READINESS_DEFAULTS.user;
  const database = options.database ?? READINESS_DEFAULTS.database;
  const password = options.password ?? READINESS_DEFAULTS.password;
  const timeoutMs = options.timeoutMs ?? READINESS_DEFAULTS.timeoutMs;
  const pollIntervalMs = options.pollIntervalMs ?? READINESS_DEFAULTS.pollIntervalMs;
  const requiredConsecutive =
    options.requiredConsecutive ?? READINESS_DEFAULTS.requiredConsecutive;

  const deadline = Date.now() + timeoutMs;
  let attempt = 0;
  let consecutive = 0;
  let postmasterStartedAt: string | undefined;
  let lastEmitted: string | undefined;

  const emit = (outcome: PostgresReadinessAttempt["outcome"], detail: string): void => {
    if (options.onAttempt === undefined) return;
    // Solo transiciones: 120 sondas de "starting up" son UNA entrada, no 120.
    const key = `${outcome}|${detail}`;
    if (key === lastEmitted) return;
    lastEmitted = key;
    options.onAttempt({ attempt, outcome, detail });
  };

  while (Date.now() < deadline) {
    attempt += 1;
    const running = await runner.run("docker", [
      "inspect",
      "-f",
      "{{.State.Running}}",
      containerId,
    ]);
    if (!(running.exitCode === 0 && running.stdout.trim() === "true")) {
      emit("exited", redactDiagnosticText(running.stderr.trim().slice(-300)));
      throw new ExecutorError(
        `El contenedor de Postgres ${label} terminó antes de estar listo.`,
        await containerLogsTail(runner, containerId),
      );
    }

    const probe = await runner.run("docker", [
      "exec",
      "-e",
      `PGPASSWORD=${password}`,
      containerId,
      "psql",
      "-X",
      "-q",
      "-A",
      "-t",
      "-F",
      "|",
      "-v",
      "ON_ERROR_STOP=1",
      "-h",
      "127.0.0.1",
      "-p",
      "5432",
      "-U",
      user,
      "-d",
      database,
      "-c",
      READINESS_PROBE_SQL,
    ]);
    const row = probe.stdout.trim();

    if (probe.exitCode === 0 && row.startsWith("1|")) {
      const startedAt = row.slice(2);
      if (postmasterStartedAt !== undefined && startedAt !== postmasterStartedAt) {
        // El postmaster que respondió NO es el que respondió la sonda
        // anterior: hubo reinicio en el medio. La confirmación arranca de
        // nuevo sobre la instancia nueva.
        consecutive = 1;
        emit("restarted", `pg_postmaster_start_time cambió a ${startedAt}.`);
      } else {
        consecutive += 1;
      }
      postmasterStartedAt = startedAt;
      if (consecutive >= requiredConsecutive) {
        emit(
          "ok",
          `SELECT 1 por TCP confirmado ${consecutive} veces consecutivas (${attempt} sondas).`,
        );
        return;
      }
    } else {
      consecutive = 0;
      postmasterStartedAt = undefined;
      emit(
        "waiting",
        redactDiagnosticText((probe.stderr.trim() || probe.stdout.trim()).slice(-300)),
      );
    }
    await sleep(pollIntervalMs);
  }

  throw new ExecutorError(
    `Postgres ${label} no confirmó SELECT 1 por TCP en ${timeoutMs} ms.`,
    await containerLogsTail(runner, containerId),
  );
}

async function containerLogsTail(
  runner: CommandRunner,
  containerId: string,
): Promise<string[]> {
  const logs = await runner.run("docker", ["logs", "--tail", "80", containerId]);
  return `${logs.stdout}\n${logs.stderr}`
    .split("\n")
    .map((line) => redactDiagnosticText(line.trim()))
    .filter(Boolean)
    .slice(-20);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
