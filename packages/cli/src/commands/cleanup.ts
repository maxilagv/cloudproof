import {
  sweepResidues,
  type CommandRunner,
  type SweepReport,
} from "@proof/docker-executor";
import { paint, symbols } from "../ui.js";

/**
 * `proof cleanup`: barrido de primera clase de los residuos Docker de Proof
 * (P0 del informe 2026-07-18). La base ya existía — labels dev.proof.owner /
 * dev.proof.run y sweepAll() — pero solo se ejecutaba implícitamente; este
 * comando la expone con --dry-run para inspeccionar antes de eliminar.
 *
 * Solo toca recursos etiquetados por Proof: jamás un contenedor ajeno.
 */
export interface CleanupOptions {
  json?: boolean;
  dryRun?: boolean;
  /** Inyección para tests; la CLI usa el SpawnRunner por defecto. */
  runner?: CommandRunner;
  /** Canal de salida inyectable; MCP usa un sink para no corromper stdio. */
  writeOutput?: (text: string) => void;
}

export function cleanupExitCode(report: SweepReport): 0 | 1 {
  return report.failures.length > 0 ? 1 : 0;
}

export async function runCleanup(options: CleanupOptions = {}): Promise<SweepReport> {
  const report = await sweepResidues(options.runner, {
    ...(options.dryRun === undefined ? {} : { dryRun: options.dryRun }),
  });
  const writeOutput = options.writeOutput ?? ((text: string) => process.stdout.write(text));
  writeOutput(
    options.json
      ? JSON.stringify({ version: "1", ...report }, null, 2) + "\n"
      : renderCleanupReport(report),
  );
  return report;
}

/** Render puro (testeable sin Docker) del reporte humano. */
export function renderCleanupReport(report: SweepReport): string {
  const lines: string[] = [];
  const total = report.containers.length + report.networks.length;
  if (total === 0) {
    return `${symbols.ok} ${paint.green("Sin residuos de Proof: no hay contenedores ni redes con label dev.proof.owner.")}\n`;
  }

  const describe = (residue: { name: string; runId?: string }) =>
    `  ${symbols.dot} ${residue.name}${residue.runId === undefined ? "" : paint.dim(`  [run ${residue.runId}]`)}`;
  if (report.containers.length > 0) {
    lines.push(paint.bold(`Contenedores (${report.containers.length}):`));
    for (const container of report.containers) lines.push(describe(container));
  }
  if (report.networks.length > 0) {
    lines.push(paint.bold(`Redes (${report.networks.length}):`));
    for (const network of report.networks) lines.push(describe(network));
  }
  lines.push("");

  if (!report.removed) {
    lines.push(
      `${symbols.warn} ${paint.yellow("--dry-run: no se eliminó nada.")} ${paint.dim("Corré")} ${paint.cyan("proof cleanup")} ${paint.dim("para eliminarlos.")}`,
    );
  } else if (report.failures.length === 0) {
    lines.push(
      `${symbols.ok} ${paint.green(
        `Eliminados ${report.containers.length} contenedor(es) y ${report.networks.length} red(es).`,
      )}`,
    );
  } else {
    for (const failure of report.failures) {
      lines.push(`${symbols.fail} ${paint.red(failure)}`);
    }
    lines.push(
      `${symbols.warn} ${paint.yellow(
        `${report.failures.length} recurso(s) no pudieron eliminarse; el resto fue barrido.`,
      )}`,
    );
  }
  lines.push("");
  return lines.join("\n");
}
