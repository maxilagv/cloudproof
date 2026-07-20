import type { CommandRunner, CommandResult, RunOptions } from "../dist/index.js";

export interface RecordedCall {
  command: string;
  args: string[];
}

export type Responder = (
  command: string,
  args: string[],
  callIndex: number,
) => Partial<CommandResult> | undefined;

/**
 * CommandRunner de test: registra cada invocación y responde según reglas.
 * Devolver undefined desde el responder equivale a exit 0 sin salida.
 */
export class FakeRunner implements CommandRunner {
  readonly calls: RecordedCall[] = [];

  constructor(private readonly responder: Responder = () => undefined) {}

  async run(command: string, args: string[], _options?: RunOptions): Promise<CommandResult> {
    const index = this.calls.length;
    this.calls.push({ command, args });
    const partial = this.responder(command, args, index) ?? {};
    return {
      stdout: partial.stdout ?? "",
      stderr: partial.stderr ?? "",
      exitCode: partial.exitCode ?? 0,
    };
  }

  /** Línea completa "cmd arg1 arg2..." de cada llamada, para asserts legibles. */
  lines(): string[] {
    return this.calls.map((call) => [call.command, ...call.args].join(" "));
  }

  /** Cantidad de llamadas cuya línea completa contiene TODOS los fragmentos. */
  count(...fragments: string[]): number {
    return this.lines().filter((line) => fragments.every((f) => line.includes(f))).length;
  }
}

/** Compone responders: gana el primero que devuelva algo distinto de undefined. */
export function compose(...responders: Responder[]): Responder {
  return (command, args, index) => {
    for (const responder of responders) {
      const result = responder(command, args, index);
      if (result !== undefined) return result;
    }
    return undefined;
  };
}

/** Responder para un worktree ya cacheado en disco: resuelve SHAs sin git real. */
export function gitCachedWorktree(fullSha: string): Responder {
  return (command, args) => {
    if (command !== "git") return undefined;
    const line = args.join(" ");
    if (line.includes("rev-parse") && line.includes("^{commit}")) {
      return { stdout: `${fullSha}\n` };
    }
    if (line.endsWith("rev-parse HEAD")) {
      return { stdout: `${fullSha}\n` };
    }
    return undefined;
  };
}
