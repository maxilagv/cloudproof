/**
 * Capa estética de la CLI. Ver tesis 6.1 (filosofía UX) y 22.3: sin agente
 * conversacional, la calidad de --help, los mensajes y la salida humana son
 * superficie crítica de producto desde el primer commit.
 *
 * Reglas duras:
 *  - Colores SOLO cuando el stream es un TTY, sin NO_COLOR y sin TERM=dumb.
 *    Bajo pipes/CI/tests la salida queda en texto plano byte-idéntico.
 *  - La salida --json y el protocolo MCP (stdout) jamás se decoran.
 *  - Determinista: mismo input → mismo output (D-015).
 */

function colorsEnabled(stream: NodeJS.WriteStream): boolean {
  if (process.env["NO_COLOR"] !== undefined) return false;
  if (process.env["TERM"] === "dumb") return false;
  if (process.env["FORCE_COLOR"] === "1") return true;
  return stream.isTTY === true;
}

const stdoutColors = colorsEnabled(process.stdout);

function style(open: number, close: number): (text: string) => string {
  return (text) => (stdoutColors ? `\u001b[${open}m${text}\u001b[${close}m` : text);
}

export const paint = {
  bold: style(1, 22),
  dim: style(2, 22),
  red: style(31, 39),
  green: style(32, 39),
  yellow: style(33, 39),
  blue: style(34, 39),
  magenta: style(35, 39),
  cyan: style(36, 39),
  gray: style(90, 39),
};

export const symbols = {
  ok: stdoutColors ? paint.green("✔") : "√",
  fail: stdoutColors ? paint.red("✖") : "×",
  warn: stdoutColors ? paint.yellow("▲") : "!",
  arrow: stdoutColors ? paint.cyan("→") : "->",
  dot: stdoutColors ? paint.gray("·") : "-",
};

/** Badge coloreado para el enum de conclusión del Proof Bundle. */
export function conclusionBadge(conclusion: string): string {
  if (!stdoutColors) return conclusion;
  const bg =
    conclusion === "VERIFIED"
      ? "\u001b[42;30m" // fondo verde
      : conclusion === "UNSAFE"
        ? "\u001b[41;97m" // fondo rojo
        : "\u001b[43;30m"; // fondo amarillo (INCONCLUSIVE)
  return `${bg} ${conclusion} \u001b[0m`;
}

export function severityLabel(severity: string): string {
  const padded = severity.padEnd(9);
  if (!stdoutColors) return padded;
  if (severity === "CRITICAL") return paint.bold(paint.red(padded));
  if (severity === "HIGH") return paint.red(padded);
  if (severity === "MEDIUM") return paint.yellow(padded);
  return paint.gray(padded);
}

/**
 * Wordmark compacto (figlet "calvin s"). Se muestra en `proof` sin
 * argumentos y encabezando --help; nunca en salidas --json ni en MCP.
 */
export function banner(version: string): string {
  const logo = [
    "┌─┐┬─┐┌─┐┌─┐┌─┐",
    "├─┘├┬┘│ ││ │├┤ ",
    "┴  ┴└─└─┘└─┘┴  ",
  ]
    .map((line) => paint.cyan(line))
    .join("\n");
  const tagline = paint.dim("Evidencia ejecutada, reproducible y firmable — no una opinión.");
  return `\n${logo}  ${paint.gray(`v${version}`)}\n${tagline}\n`;
}

/**
 * Mascota ASCII de Proof: una nube con anteojos, sonrisa y chispas a los
 * costados. Mismos glifos con o sin color (solo el ANSI se apaga bajo
 * NO_COLOR/pipes/CI); vive únicamente en `welcome()` para no repetirse en
 * cada `--help`, donde sigue el wordmark compacto de `banner()`.
 */
export function mascot(): string {
  const cloud = (text: string) => paint.cyan(text);
  const spark = (text: string) => paint.yellow(text);
  return [
    `   ${spark("✧")}              ${spark("✦")}`,
    cloud("      .--.  .--.  .--."),
    cloud("   .-'              '-."),
    `${cloud("  (      ")}${paint.bold("⌐■_■")}${cloud("         )")}`,
    `${cloud("   '-.     ")}${paint.yellow("◡‿◡")}${cloud("     .-'")}`,
    cloud("      '--.........--'"),
    `   ${spark("✦")}              ${spark("✧")}`,
  ].join("\n");
}

/** Bloque de arranque para `proof` sin argumentos. */
export function welcome(version: string): string {
  const row = (command: string, description: string) =>
    `  ${paint.bold(command.padEnd(28))}${paint.dim(description)}`;
  return [
    mascot(),
    `  ${paint.bold("proof")} ${paint.gray(`v${version}`)}`,
    paint.dim("  Evidencia ejecutada, reproducible y firmable — no una opinión."),
    "",
    paint.bold("  Comandos"),
    row("init", "detecta el stack y genera proof.config.ts + AGENTS.md"),
    row("doctor", "valida runtime, Docker, config, workload y cobertura"),
    row("release verify", "prueba A0+S0 → A0+S1 y emite el Proof Bundle"),
    row("reproduce <assertion-id>", "reconstruye un finding en vivo (app + Postgres)"),
    row("cleanup", "elimina contenedores/redes residuales de Proof (--dry-run)"),
    row("bundle sign|verify", "firma Ed25519 y verificación del Proof Bundle"),
    row("check", "release verify + Check Run de GitHub (para CI)"),
    row("mcp serve", "expone la verificación como tools MCP para agentes"),
    "",
    `  ${paint.dim("Empezá con")} ${paint.cyan("proof init")} ${paint.dim("y seguí con")} ${paint.cyan("proof doctor")}${paint.dim(".")}`,
    `  ${paint.dim("Ayuda por comando:")} ${paint.cyan("proof <comando> --help")}`,
    "",
  ].join("\n");
}

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/**
 * Spinner mínimo sobre STDERR (stdout queda limpio para datos). Se apaga
 * solo cuando stderr no es TTY (CI, pipes, MCP) — ahí no escribe nada.
 */
export function startSpinner(label: string): { update(text: string): void; stop(): void } {
  if (!colorsEnabled(process.stderr)) {
    return { update() {}, stop() {} };
  }
  let frame = 0;
  let text = label;
  const render = () => {
    process.stderr.write(`\r\u001b[2K\u001b[36m${SPINNER_FRAMES[frame]}\u001b[39m ${text}`);
    frame = (frame + 1) % SPINNER_FRAMES.length;
  };
  render();
  const timer = setInterval(render, 90);
  return {
    update(next: string) {
      text = next;
    },
    stop() {
      clearInterval(timer);
      process.stderr.write("\r\u001b[2K");
    },
  };
}
