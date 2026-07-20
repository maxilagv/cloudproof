import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  ExecutionProfileSchema,
  loadConfig,
  resolveExecutionProfile,
  type ExecutionProfile,
  type ProjectConfig,
  type ServiceConfig,
} from "@proof/config";
import { verifyRelease } from "@proof/postgres-verifier";
import { ComposeExecutor } from "@proof/docker-executor";
import { evaluatePolicies, getPolicy, type PolicyViolation } from "@proof/policy-engine";
import { COMPLETE_RELEASE_MATRIX_STATES, type ProofBundle } from "@proof/schema";
import { conclusionBadge, paint, startSpinner } from "../ui.js";

/**
 * Ver tesis, sección 19.2 (user story principal) y 19.3 (flujo técnico).
 * Comando núcleo de la cuña del MVP. La salida humana sigue el formato de
 * la demo canónica (tesis 19.5).
 */
export interface ReleaseVerifyOptions {
  json?: boolean;
  cwd?: string;
  baseSha: string;
  headSha: string;
  service?: string;
  profile?: ExecutionProfile;
  /** Canal de salida inyectable; MCP usa un sink para no corromper stdio. */
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
        ? "proof.config.ts no declara servicios."
        : "proof.config.ts declara más de un servicio; elegí uno con --service <nombre>.",
    );
  }
  const selected = entries[0];
  if (selected === undefined) throw new Error("proof.config.ts no declara servicios.");
  return { name: selected[0], config: selected[1] };
}

export async function runReleaseVerify(options: ReleaseVerifyOptions): Promise<ProofBundle> {
  const cwd = options.cwd ?? process.cwd();
  const requestedProfile =
    options.profile === undefined ? undefined : ExecutionProfileSchema.parse(options.profile);
  const executionProfile = resolveExecutionProfile(requestedProfile);
  const config = await loadConfig(cwd, { executionProfile });
  const service = selectService(config, options.service);
  // Validar policies antes del trabajo caro para no descubrir un id futuro o
  // desconocido después de construir imágenes y correr el workload.
  config.policies.forEach((policyId) => getPolicy(policyId));
  const postgres = Object.values(config.data).find((source) => source.kind === "postgres");
  if (postgres === undefined) {
    throw new Error(
      "proof.config.ts no declara una fuente data.* con kind \"postgres\"; " +
        "release verify de Fase 1 no eligió una base por defecto.",
    );
  }
  const executor = new ComposeExecutor({
    repoRoot: cwd,
    executionProfile,
    ...(postgres?.version === undefined
      ? {}
      : { postgresImage: `postgres:${postgres.version}-alpine` }),
    ...(service.config.readinessTimeoutMs === undefined
      ? {}
      : { readinessTimeoutMs: service.config.readinessTimeoutMs }),
  });

  // Progreso en stderr (tesis 6.1: salida progresiva); mudo bajo --json,
  // pipes y MCP porque el spinner solo escribe cuando stderr es un TTY.
  const spinner =
    options.json === true
      ? { update() {}, stop() {} }
      : startSpinner(
          `release verify ${paint.dim(`${options.baseSha.slice(0, 12)} → ${options.headSha.slice(0, 12)}`)} — construyendo imágenes y ejecutando la matriz…`,
        );

  let bundle: ProofBundle;
  try {
    bundle = await verifyRelease(
      {
        baseSha: options.baseSha,
        headSha: options.headSha,
        serviceName: service.name,
        servicePath: service.config.path,
        ...(service.config.port === undefined ? {} : { servicePort: service.config.port }),
        ...(service.config.prismaSchema === undefined
          ? {}
          : { prismaSchema: service.config.prismaSchema }),
        ...(service.config.dockerfile === undefined
          ? {}
          : { serviceDockerfile: service.config.dockerfile }),
        ...(service.config.buildContext === undefined
          ? {}
          : { serviceBuildContext: service.config.buildContext }),
        ...(service.config.buildArgs === undefined
          ? {}
          : { serviceBuildArgs: service.config.buildArgs }),
        ...(service.config.env === undefined ? {} : { serviceEnv: service.config.env }),
        runner: executor.runId,
        cwd,
        ...(config.workload !== undefined ? { workload: config.workload } : {}),
        ...(config.workload?.timeoutMs === undefined
          ? {}
          : { workloadTimeoutMs: config.workload.timeoutMs }),
        ...(config.fixtures?.beforeAll === undefined
          ? {}
          : {
              fixtures: {
                beforeAll: {
                  command: config.fixtures.beforeAll.command,
                  args: config.fixtures.beforeAll.args,
                  ...(config.fixtures.beforeAll.timeoutMs === undefined
                    ? {}
                    : { timeoutMs: config.fixtures.beforeAll.timeoutMs }),
                },
              },
            }),
        ...(config.coverage === undefined
          ? {}
          : { requiredRoutes: config.coverage.requiredRoutes }),
        ...(config.coverage?.rollbackProbeRoutes === undefined
          ? {}
          : { rollbackProbeRoutes: config.coverage.rollbackProbeRoutes }),
        approvals: config.approvals.map((approval) => ({
          assertionId: approval.assertionId,
          reason: approval.reason,
          ...(approval.expiresAt === undefined ? {} : { expiresAt: approval.expiresAt }),
        })),
        executionProfile,
      },
      executor,
    );
  } finally {
    spinner.stop();
    // verifyRelease baja sus contenedores en finally; esto elimina además
    // la red de la corrida y cualquier residuo etiquetado.
    await executor.disposeRun().catch(() => undefined);
  }

  const violations = evaluatePolicies(config.policies, bundle);

  const proofDir = join(cwd, ".proof");
  mkdirSync(proofDir, { recursive: true });
  const bundlePath = join(proofDir, `release-verify-${bundle.provenance.runner}.json`);
  writeFileSync(bundlePath, JSON.stringify(bundle, null, 2), "utf-8");

  const writeOutput = options.writeOutput ?? ((text: string) => process.stdout.write(text));
  writeOutput(
    options.json
      ? JSON.stringify({ version: "1", bundle, violations, bundlePath }, null, 2) + "\n"
      : renderHumanReport(bundle, violations, bundlePath),
  );

  return bundle;
}

/**
 * Render puro (testeable sin Docker) del reporte humano, calcado de la
 * demo canónica de la tesis (19.5). El bloque "Recommended:" es la vista
 * humana del campo `remediation` del bundle — la receta la produce el
 * catálogo determinista de @proof/postgres-verifier a partir de SQLSTATE
 * observados, nunca una conclusión generativa (D-015). El bloque "Next:"
 * es la vista humana de `nextActions` (INCONCLUSIVE accionable).
 */
export function renderHumanReport(
  bundle: ProofBundle,
  violations: PolicyViolation[],
  bundlePath: string,
): string {
  const lines: string[] = [];
  const baseline = bundle.assertions.find((a) => a.id === "workload.baseline");
  if (baseline !== undefined) {
    lines.push(
      `Tests normales: ${baseline.result === "pass" ? paint.green("PASS") : paint.red("FAIL")}`,
    );
  }
  const migration = bundle.assertions.find((assertion) => assertion.id === "postgres.migration-candidate");
  const legacyApplied =
    migration === undefined &&
    bundle.assertions.some((assertion) => assertion.id.startsWith("postgres.old-app-new-schema."));
  lines.push(
    `Migration: ${
      migration?.result === "pass" || legacyApplied
        ? paint.green("APPLIED")
        : migration?.result === "fail"
          ? paint.red("FAILED")
          : paint.yellow("NOT RUN")
    }`,
  );
  lines.push("");
  lines.push(`${paint.bold("RELEASE PROOF:")} ${conclusionBadge(bundle.conclusion)}`);

  const failing = bundle.assertions.filter(
    (a) => a.result === "fail" && a.id !== "workload.baseline" && a.approval === undefined,
  );
  const approved = bundle.assertions.filter((assertion) => assertion.approval !== undefined);
  const allEvidence = failing.flatMap((a) => a.evidence);
  const hasSqlErrors = allEvidence.some((line) => /SQLSTATE/i.test(line));

  if (bundle.conclusion === "UNSAFE") {
    const failedState = failing[0]?.state;
    lines.push(
      failedState === "BUILD_A1"
        ? "Candidate application image cannot be built."
        : failedState === "MIGRATE_S0_TO_S1"
          ? "Candidate migration cannot be applied to the populated baseline."
          : failing.some((assertion) => assertion.id.endsWith(".startup"))
            ? "Old application cannot start on migrated schema."
            : hasSqlErrors
              ? "Old application cannot write to migrated schema."
              : "Old application behaves differently on migrated schema.",
    );
    for (const line of allEvidence) lines.push(line);
  }

  if (bundle.conclusion === "INCONCLUSIVE") {
    const fingerprintUnavailable = bundle.assertions.find(
      (assertion) =>
        assertion.result === "skipped" &&
        assertion.mandatory !== false &&
        assertion.evidence.some((line) => /fingerprint|pg_catalog/i.test(line)),
    );
    if (baseline?.result === "fail") {
      lines.push(
        "Baseline tests failed on the current version; nothing can be attributed to the migration.",
      );
      for (const line of baseline.evidence) lines.push(line);
    } else if (fingerprintUnavailable !== undefined) {
      lines.push(
        `Schema fingerprint failed at ${fingerprintUnavailable.id}:`,
        ...fingerprintUnavailable.evidence,
      );
    } else if (bundle.coverage.source === "unknown") {
      lines.push(
        "Coverage universe is unknown. Declare `coverage.requiredRoutes` in proof.config.ts.",
      );
    } else if (bundle.coverage.complete === false) {
      lines.push("Required route coverage is incomplete; inspect skipped coverage assertions.");
    } else {
      const skipped = bundle.assertions.filter(
        (assertion) => assertion.mandatory !== false && assertion.result === "skipped",
      );
      const approvedIncomplete =
        approved.length > 0 &&
        !bundle.assertions.some(
          (assertion) =>
            assertion.id === "proof.execution-complete" && assertion.result === "pass",
        );
      if (skipped.length > 0) {
        lines.push("Mandatory evidence is unavailable:");
        for (const assertion of skipped) {
          lines.push(`${assertion.id}: ${assertion.evidence.join(" ")}`);
        }
      } else if (approvedIncomplete) {
        lines.push("An approved stage failure prevented the remaining proof states from running.");
      } else {
        lines.push(
          "No write workload observed. Declare `workload` in proof.config.ts so proof can exercise the transition.",
        );
      }
    }
    if (bundle.nextActions.length > 0) {
      lines.push("", paint.bold("Next:"));
      bundle.nextActions.forEach((action, index) => {
        lines.push(`${paint.cyan(`${index + 1}.`)} ${action.instruction}`);
      });
    }
  }

  for (const assertion of approved) {
    lines.push(
      `APPROVED CHANGE: ${assertion.id} — ${assertion.approval?.reason ?? "sin razón"}`,
    );
  }

  // Vista humana de la primera receta del catálogo; el JSON conserva todas.
  const remediation = failing.find((assertion) => assertion.remediation !== undefined)
    ?.remediation;
  if (remediation !== undefined) {
    lines.push("", paint.bold("Recommended:"));
    for (const step of remediation.steps) {
      lines.push(`${paint.cyan(`${step.order}.`)} ${step.title}`);
    }
  }

  const reproduction = failing.find((a) => a.reproduction !== undefined)?.reproduction;
  if (reproduction !== undefined) {
    lines.push("", `Reproduce: ${paint.cyan(reproduction)}`);
  }

  for (const violation of violations) {
    lines.push(`${paint.red(`[policy] ${violation.policyId}:`)} ${violation.message}`);
  }

  const matrixCells = renderMatrixCells(bundle.assertions);
  if (matrixCells.length > 0) {
    lines.push("", paint.bold("Matriz de ejecución:"), ...matrixCells);
  }

  lines.push("", paint.dim(`Bundle: ${bundlePath}`), "");
  return lines.join("\n");
}

/**
 * Vista celda por celda de la matriz A0/A1 × S0/S1 (P2 del informe
 * 2026-07-18): los datos ya viven en el Bundle — cada assertion lleva su
 * `state` — así que acá solo se agregan por estado, nunca se recalculan.
 * Un fallo aprobado no tiñe la celda de FAIL: la approval ya se listó
 * arriba como APPROVED CHANGE.
 */
export function renderMatrixCells(assertions: ProofBundle["assertions"]): string[] {
  if (!assertions.some((assertion) => assertion.state !== undefined)) return [];
  return COMPLETE_RELEASE_MATRIX_STATES.map((state) => {
    const cell = assertions.filter((assertion) => assertion.state === state);
    const label = `  ${state.padEnd(28)}`;
    if (cell.length === 0) return `${label}${paint.dim("sin evidencia")}`;
    if (cell.some((a) => a.result === "fail" && a.approval === undefined)) {
      return `${label}${paint.red("FAIL")}`;
    }
    if (cell.some((a) => a.result === "skipped" && a.mandatory !== false)) {
      return `${label}${paint.yellow("SKIPPED")}`;
    }
    if (cell.some((a) => a.approval !== undefined)) {
      return `${label}${paint.yellow("APPROVED")}`;
    }
    return `${label}${paint.green("PASS")}`;
  });
}
