import { SpawnRunner, type CommandRunner } from "./command-runner.js";
import { ExecutorError } from "./errors.js";

/**
 * Inventario y barrido de residuos Docker de CloudProof.
 *
 * Todo contenedor y red que CloudProof crea lleva el label dev.cloudproof.owner
 * (y dev.cloudproof.run con el id de corrida). Este módulo es la única fuente
 * de verdad para encontrarlos y eliminarlos: lo consumen sweepAll() del
 * executor y el comando `cloudproof cleanup` (con soporte --dry-run, P0 del
 * informe 2026-07-18).
 */

export const OWNER_LABEL = "dev.cloudproof.owner=cloudproof";

export interface DockerResidue {
  id: string;
  name: string;
  /** Valor del label dev.cloudproof.run; ausente en recursos sin corrida asociada. */
  runId?: string;
}

export interface ResidueReport {
  containers: DockerResidue[];
  networks: DockerResidue[];
}

export interface SweepReport extends ResidueReport {
  /** false bajo --dry-run: se listó sin eliminar. */
  removed: boolean;
  /** Recursos que Docker no pudo eliminar, con su stderr acotado. */
  failures: string[];
}

const RUN_LABEL_KEY = "dev.cloudproof.run";

function parseResidueLines(stdout: string): DockerResidue[] {
  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [id, name, runId] = line.split("\t");
      return {
        id: id ?? "",
        name: name ?? "",
        ...(runId === undefined || runId === "" ? {} : { runId }),
      };
    })
    .filter((residue) => residue.id !== "");
}

/** Lista contenedores y redes de CloudProof sin tocarlos. Requiere daemon activo. */
export async function collectResidues(
  runner: CommandRunner = new SpawnRunner({ role: "orchestrator" }),
): Promise<ResidueReport> {
  const containers = await runner.run("docker", [
    "ps",
    "-a",
    "--filter",
    `label=${OWNER_LABEL}`,
    "--format",
    `{{.ID}}\t{{.Names}}\t{{.Label "${RUN_LABEL_KEY}"}}`,
  ]);
  if (containers.exitCode !== 0) {
    throw new ExecutorError("Docker no pudo listar los contenedores de CloudProof.", [
      containers.stderr.trim().slice(-500),
    ]);
  }
  const networks = await runner.run("docker", [
    "network",
    "ls",
    "--filter",
    `label=${OWNER_LABEL}`,
    "--format",
    `{{.ID}}\t{{.Name}}\t{{.Label "${RUN_LABEL_KEY}"}}`,
  ]);
  if (networks.exitCode !== 0) {
    throw new ExecutorError("Docker no pudo listar las redes de CloudProof.", [
      networks.stderr.trim().slice(-500),
    ]);
  }
  return {
    containers: parseResidueLines(containers.stdout),
    networks: parseResidueLines(networks.stdout),
  };
}

/**
 * Elimina (o solo lista, con dryRun) todo residuo etiquetado por CloudProof.
 * Los contenedores caen antes que las redes: una red con contenedores
 * conectados no puede eliminarse. Un recurso ya desaparecido entre el
 * listado y el rm no cuenta como fallo.
 */
export async function sweepResidues(
  runner: CommandRunner = new SpawnRunner({ role: "orchestrator" }),
  options: { dryRun?: boolean } = {},
): Promise<SweepReport> {
  const report = await collectResidues(runner);
  if (options.dryRun === true) {
    return { ...report, removed: false, failures: [] };
  }
  const failures: string[] = [];
  for (const container of report.containers) {
    const result = await runner.run("docker", ["rm", "-f", container.id]);
    if (result.exitCode !== 0 && !/no such container/i.test(result.stderr)) {
      failures.push(`contenedor ${container.name}: ${result.stderr.trim().slice(-300)}`);
    }
  }
  for (const network of report.networks) {
    const result = await runner.run("docker", ["network", "rm", network.id]);
    if (result.exitCode !== 0 && !/no such network|not found/i.test(result.stderr)) {
      failures.push(`red ${network.name}: ${result.stderr.trim().slice(-300)}`);
    }
  }
  return { ...report, removed: true, failures };
}
