import {
  ExecutionProfileSchema,
  loadConfig,
  resolveExecutionProfile,
  type ExecutionProfile,
  type ProjectConfig,
  type ServiceConfig,
} from "@cloudproof/config";
import {
  planRelease,
  type ReleaseTriagePlan,
  type TriageCommand,
} from "@cloudproof/postgres-verifier";
import { paint, severityLabel } from "../ui.js";
import { createWorktreeSnapshot } from "../worktree-snapshot.js";

export interface ReleasePlanOptions {
  json?: boolean;
  cwd?: string;
  baseSha: string;
  headSha?: string;
  worktree?: boolean;
  service?: string;
  profile?: ExecutionProfile;
  writeOutput?: (text: string) => void;
}

function selectService(
  config: ProjectConfig,
  requested?: string,
): { name: string; config: ServiceConfig } {
  if (requested !== undefined) {
    const service = Object.hasOwn(config.services, requested)
      ? config.services[requested]
      : undefined;
    if (service === undefined) {
      throw new Error(
        `Servicio desconocido "${requested}". Disponibles: ${Object.keys(config.services).join(", ") || "(ninguno)"}.`,
      );
    }
    return { name: requested, config: service };
  }
  const entries = Object.entries(config.services);
  if (entries.length !== 1) {
    throw new Error(
      entries.length === 0
        ? "cloudproof.config.ts no declara servicios."
        : "cloudproof.config.ts declara mas de un servicio; elegi uno con --service <nombre>.",
    );
  }
  const selected = entries[0];
  if (selected === undefined) throw new Error("cloudproof.config.ts no declara servicios.");
  return { name: selected[0], config: selected[1] };
}

function printableCommand(command: TriageCommand): string {
  const quote = (argument: string) =>
    /^[A-Za-z0-9_./:@+-]+$/.test(argument) ? argument : JSON.stringify(argument);
  return [command.command, ...command.args].map(quote).join(" ");
}

export function renderReleasePlan(plan: ReleaseTriagePlan): string {
  const lines = [
    `${paint.bold("RELEASE PLAN:")} ${severityLabel(plan.risk.toUpperCase()).trim()}`,
    `${paint.bold("Decision:")} ${plan.decision} (esto no es VERIFIED)`,
    `${paint.bold("Assurance:")} ${plan.assurance.level}`,
    `${paint.bold("Budget:")} <= ${Math.round(plan.analysis.budgetMs / 1000)}s`,
    `${paint.bold("Changes:")} ${plan.changes.total} total, ${plan.changes.relevant} relevantes`,
  ];

  if (plan.reasons.length === 0) {
    lines.push("", paint.dim("No se detectaron patrones estaticos de riesgo en el rango."));
  } else {
    lines.push("", paint.bold("Reasons:"));
    for (const reason of plan.reasons) {
      lines.push(`${severityLabel(reason.risk.toUpperCase())} ${reason.code}: ${reason.title}`);
      lines.push(`  ${reason.detail}`);
      for (const item of reason.evidence.slice(0, 3)) {
        const location = `${item.path}${item.line === undefined ? "" : `:${item.line}`}`;
        lines.push(`  ${paint.dim(location)}${item.excerpt === undefined ? "" : ` - ${item.excerpt}`}`);
      }
    }
  }

  if (plan.security.flags.length > 0) {
    lines.push("", `${paint.bold("Security:")} ${plan.security.flags.join(", ")}`);
  }
  if (plan.privacy.flags.length > 0) {
    lines.push(`${paint.bold("Privacy:")} ${plan.privacy.flags.join(", ")}`);
  }
  if (!plan.analysis.complete) {
    lines.push("", paint.yellow("El analisis fue incompleto; se exige la matriz completa."));
    for (const diagnostic of plan.analysis.diagnostics) lines.push(`  ${diagnostic}`);
  }

  lines.push(
    "",
    `${paint.bold("Next:")} ${paint.cyan(printableCommand(plan.nextCommand))}`,
    `  ${plan.nextCommand.reason}`,
    paint.dim(`Cache: ${plan.cacheKey}`),
    paint.dim(plan.disclaimer),
    "",
  );
  return lines.join("\n");
}

/** Fast path: reads git/config only; it never starts Docker or executes a workload. */
export async function runReleasePlan(options: ReleasePlanOptions): Promise<ReleaseTriagePlan> {
  const cwd = options.cwd ?? process.cwd();
  const requestedProfile =
    options.profile === undefined ? undefined : ExecutionProfileSchema.parse(options.profile);
  const executionProfile = resolveExecutionProfile(requestedProfile);
  if (options.worktree === true && options.headSha !== undefined) {
    throw new Error("Usa --head-sha o --worktree, no ambos.");
  }
  if (options.worktree !== true && options.headSha === undefined) {
    throw new Error("Falta el candidato: usa --head-sha <sha> o --worktree.");
  }
  if (options.worktree === true && executionProfile !== "trusted") {
    throw new Error("--worktree solo está permitido con el perfil trusted; internal/fork requieren un commit candidato publicado.");
  }
  const snapshot = options.worktree === true ? await createWorktreeSnapshot(cwd) : undefined;
  const headSha = snapshot?.headSha ?? options.headSha;
  if (headSha === undefined) throw new Error("No se pudo resolver el snapshot candidato.");
  let service: { name: string; config: ServiceConfig } | undefined;
  let configurationError: string | undefined;
  try {
    service = selectService(await loadConfig(cwd, { executionProfile }), options.service);
  } catch (error) {
    configurationError = error instanceof Error ? error.message : String(error);
  }

  const plan = await planRelease({
    baseSha: options.baseSha,
    headSha,
    cwd,
    executionProfile,
    ...(service === undefined
      ? {}
      : {
          serviceName: service.name,
          servicePath: service.config.path,
          ...(service.config.prismaSchema === undefined
            ? {}
            : { prismaSchemaPath: service.config.prismaSchema }),
        }),
    configuration:
      configurationError === undefined
        ? { loaded: true }
        : { loaded: false, error: configurationError },
  });

  // Preserve development provenance across the plan -> verify hand-off.
  // Passing only the synthetic SHA would make the next command look like a
  // published candidate commit. `--worktree` snapshots again (same content
  // => same deterministic SHA) and marks the Bundle developmentOnly.
  if (snapshot !== undefined) {
    const keepWorktreeSource = (command: TriageCommand): TriageCommand => {
      if (command.args[0] !== "release" || command.args[1] !== "verify") return command;
      const args: string[] = [];
      for (let index = 0; index < command.args.length; index += 1) {
        if (command.args[index] === "--head-sha") {
          index += 1;
          continue;
        }
        args.push(command.args[index] as string);
      }
      if (!args.includes("--worktree")) args.push("--worktree");
      return {
        ...command,
        args,
        reason: `${command.reason} El candidato se volverá a congelar como snapshot de desarrollo inmutable.`,
      };
    };
    plan.nextCommand = keepWorktreeSource(plan.nextCommand);
    plan.nextActions = plan.nextActions.map(keepWorktreeSource);
  }

  const writeOutput = options.writeOutput ?? ((text: string) => process.stdout.write(text));
  writeOutput(options.json === true ? `${JSON.stringify(plan, null, 2)}\n` : renderReleasePlan(plan));
  return plan;
}
