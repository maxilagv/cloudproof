import spawn from "cross-spawn";
import {
  assertHostWorkloadAllowed,
  assertValidEnvironment,
  environmentForProfile,
  isSensitiveName,
  looksSensitiveValue,
  resolveExecutionProfile,
  type ExecutionProfile,
} from "./execution-profile.js";
import { redactDiagnosticText } from "./errors.js";

/**
 * Abstracción mínima sobre spawn para poder testear la orquestación de
 * docker/git sin ejecutar nada real (los unit tests inyectan un FakeRunner
 * que registra las invocaciones exactas).
 *
 * Usa cross-spawn en vez de child_process.spawn: en Windows los comandos
 * de workload típicos (npm/pnpm/yarn) son shims .cmd que spawn sin shell
 * no puede ejecutar (ENOENT). cross-spawn los resuelve con quoting seguro
 * sin recurrir a shell:true (gate 1.E, corrida real en Windows).
 *
 * run() NUNCA rechaza por exit code distinto de cero — devuelve el
 * resultado y el caller decide. Solo rechaza por timeout o por no poder
 * lanzar el proceso (ej. docker no instalado).
 */

export interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface RunOptions {
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  /** Limites duros durante streaming; evitan acumular salida hostil en memoria. */
  maxStdoutBytes?: number;
  maxStderrBytes?: number;
  /** Default true; false usa solo options.env. */
  inheritEnv?: boolean;
}

export interface CommandRunner {
  run(command: string, args: string[], options?: RunOptions): Promise<CommandResult>;
}

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_OUTPUT_BYTES = 16 * 1024 * 1024;

export interface SpawnRunnerOptions {
  executionProfile?: ExecutionProfile;
  baseEnv?: NodeJS.ProcessEnv;
  /** workload activa el gate de codigo arbitrario; orchestrator es default. */
  role?: "orchestrator" | "workload";
}

function validateCommand(command: string, args: string[]): void {
  if (
    command.trim() === "" ||
    command.length > 1_024 ||
    /[\u0000-\u001f\u007f]/.test(command)
  ) {
    throw new TypeError("El ejecutable debe ser un nombre/ruta valida sin caracteres de control.");
  }
  if (args.length > 4_096) throw new TypeError("Demasiados argumentos de proceso.");
  if (args.some((arg) => arg.length > 65_536 || arg.includes("\u0000"))) {
    throw new TypeError("Un argumento de proceso es invalido o demasiado grande.");
  }
}

/** Nunca incluye valores de env/build args ni credenciales de URLs. */
export function safeCommandDescription(command: string, args: string[]): string {
  let hideNext = false;
  const rendered = args.map((arg) => {
    if (hideNext) {
      hideNext = false;
      return "[REDACTED]";
    }
    if (/^--?(?:e|env|env-file|build-arg|password|token|secret|api[-_]?key)$/i.test(arg)) {
      hideNext = true;
      return arg;
    }
    const assignment = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/s.exec(arg);
    if (
      assignment?.[1] !== undefined &&
      (isSensitiveName(assignment[1]) || looksSensitiveValue(assignment[2] ?? ""))
    ) {
      return `${assignment[1]}=[REDACTED]`;
    }
    try {
      const url = new URL(arg);
      if (url.username !== "" || url.password !== "") {
        url.username = "[REDACTED]";
        url.password = "[REDACTED]";
        return url.toString();
      }
    } catch {
      // No es URL: se muestra como argumento ordinario.
    }
    return arg;
  });
  return [command, ...rendered].join(" ");
}

export class SpawnRunner implements CommandRunner {
  private readonly executionProfile: ExecutionProfile;
  private readonly baseEnv: NodeJS.ProcessEnv;
  private readonly role: "orchestrator" | "workload";

  constructor(options: SpawnRunnerOptions = {}) {
    this.baseEnv = options.baseEnv ?? process.env;
    this.executionProfile = resolveExecutionProfile(options.executionProfile, this.baseEnv);
    // En perfiles no confiables, un runner sin rol explicito se trata como
    // workload (fail-closed). Los componentes de infraestructura deben pedir
    // role:"orchestrator" de forma deliberada.
    this.role =
      options.role ?? (this.executionProfile === "trusted" ? "orchestrator" : "workload");
    // Falla antes de builds/containers: descubrir el límite recién al lanzar
    // el workload dejaría una corrida fork parcialmente ejecutada.
    if (this.role === "workload") {
      assertHostWorkloadAllowed(this.executionProfile, this.baseEnv);
    }
  }

  async run(command: string, args: string[], options: RunOptions = {}): Promise<CommandResult> {
    if (this.role === "workload") assertHostWorkloadAllowed(this.executionProfile, this.baseEnv);
    validateCommand(command, args);
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const maxStdoutBytes = options.maxStdoutBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
    const maxStderrBytes = options.maxStderrBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
    if (
      !Number.isSafeInteger(timeoutMs) ||
      timeoutMs < 1 ||
      !Number.isSafeInteger(maxStdoutBytes) ||
      maxStdoutBytes < 1 ||
      !Number.isSafeInteger(maxStderrBytes) ||
      maxStderrBytes < 1
    ) {
      throw new TypeError("timeoutMs y los limites de salida deben ser enteros positivos.");
    }
    if (options.env !== undefined) {
      assertValidEnvironment(options.env, this.executionProfile);
    }
    const inherited =
      options.inheritEnv === false
        ? {}
        : environmentForProfile(this.executionProfile, this.baseEnv);

    return new Promise<CommandResult>((resolve, reject) => {
      const child = spawn(command, args, {
        cwd: options.cwd,
        env: { ...inherited, ...options.env },
        windowsHide: true,
      });

      let stdout = "";
      let stderr = "";
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let settled = false;
      if (child.stdout === null || child.stderr === null) {
        settled = true;
        reject(new Error(`No se pudo capturar la salida de "${command}".`));
        return;
      }

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        child.kill();
        reject(
          new Error(
            `Timeout tras ${timeoutMs} ms: ${safeCommandDescription(command, args)}\n${redactDiagnosticText(stderr.slice(-2000))}`,
          ),
        );
      }, timeoutMs);

      child.stdout.on("data", (chunk: Buffer | string) => {
        if (settled) return;
        const rendered = chunk.toString();
        stdoutBytes += Buffer.byteLength(rendered, "utf8");
        if (stdoutBytes > maxStdoutBytes) {
          settled = true;
          clearTimeout(timer);
          child.kill();
          reject(new Error(`La salida stdout de "${command}" excedio ${maxStdoutBytes} bytes.`));
          return;
        }
        stdout += rendered;
      });
      child.stderr.on("data", (chunk: Buffer | string) => {
        if (settled) return;
        const rendered = chunk.toString();
        stderrBytes += Buffer.byteLength(rendered, "utf8");
        if (stderrBytes > maxStderrBytes) {
          settled = true;
          clearTimeout(timer);
          child.kill();
          reject(new Error(`La salida stderr de "${command}" excedio ${maxStderrBytes} bytes.`));
          return;
        }
        stderr += rendered;
      });

      child.on("error", (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(new Error(`No se pudo ejecutar "${command}": ${redactDiagnosticText(error.message)}`));
      });

      child.on("close", (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ stdout, stderr, exitCode: code ?? -1 });
      });
    });
  }
}
