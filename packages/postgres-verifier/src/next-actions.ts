import type { Assertion, Conclusion, Coverage, NextAction } from "@cloudproof/schema";

/**
 * Deriva las nextActions de un bundle: la lista tipada de "qué falta y cómo
 * cerrarlo" que hace accionable cualquier veredicto no VERIFIED. Es una
 * función pura y determinista espejo de finalConclusion(): misma evidencia,
 * mismas acciones.
 *
 * Invariante: UNSAFE e INCONCLUSIVE siempre producen al menos una acción;
 * VERIFIED produce cero.
 */

export interface NextActionContext {
  /** cloudproof.config.ts declara un workload. */
  workloadDeclared: boolean;
  /** Cantidad de exchanges HTTP grabados por el Recorder. */
  observedExchanges: number;
  /** Hubo al menos una escritura HTTP (POST/PUT/PATCH/DELETE). */
  observedWrites: boolean;
  /** Rutas de coverage.requiredRoutes no ejercitadas por el workload. */
  missingRoutes: string[];
}

const RERUN_VERIFY =
  "then re-run `cloudproof release verify` with the same --base-sha/--head-sha until the conclusion is VERIFIED";

/** Etapas cuya ausencia de evidencia es un prerequisito de infraestructura. */
const INFRA_STAGE_IDS = new Set([
  "build.base",
  "postgres.baseline-schema",
  "postgres.baseline.schema-stable",
]);

export function deriveNextActions(
  assertions: Assertion[],
  coverage: Coverage,
  conclusion: Conclusion,
  context: NextActionContext,
): NextAction[] {
  if (conclusion === "VERIFIED") return [];

  if (conclusion === "UNSAFE") {
    const failing = assertions.filter(
      (assertion) =>
        assertion.result === "fail" &&
        assertion.mandatory !== false &&
        assertion.approval === undefined &&
        assertion.id !== "workload.baseline",
    );
    return failing.map((assertion): NextAction => {
      if (assertion.remediation !== undefined) {
        return {
          kind: "apply-remediation",
          assertionId: assertion.id,
          instruction:
            `Apply the "${assertion.remediation.pattern}" remediation steps of assertion ` +
            `${assertion.id} to the candidate migration/application, ${RERUN_VERIFY}. ` +
            `Do not add an approval yourself: approvals are a human decision.`,
          ...(assertion.reproduction === undefined ? {} : { command: assertion.reproduction }),
        };
      }
      return {
        kind: "fix-failure",
        assertionId: assertion.id,
        instruction:
          `Assertion ${assertion.id} failed reproducibly (${assertion.evidence[0] ?? "see bundle evidence"}). ` +
          `Fix the candidate migration or application, ${RERUN_VERIFY}.`,
        ...(assertion.reproduction === undefined ? {} : { command: assertion.reproduction }),
      };
    });
  }

  // INCONCLUSIVE — en orden de causa raíz.
  const baseline = assertions.find((assertion) => assertion.id === "workload.baseline");
  if (baseline?.result === "fail") {
    return [
      {
        kind: "fix-baseline",
        assertionId: "workload.baseline",
        instruction:
          `The workload fails on the CURRENT version before any migration ` +
          `(${baseline.evidence[0] ?? "see bundle evidence"}). Fix the suite or the base app first; ` +
          `nothing can be attributed to the migration until the baseline passes.`,
        ...(baseline.reproduction === undefined ? {} : { command: baseline.reproduction }),
      },
    ];
  }

  // Historia de migraciones del commit base irreplayable (informe Lubrisur
  // 2026-07, 2ª ronda): es LA causa raíz — ninguna otra acción (workload,
  // coverage) puede ejecutarse sin un S0, así que la acción es única y
  // lleva la atribución y los caminos seguros ya resueltos.
  const migrationHistory = assertions.find(
    (assertion) => assertion.id === "postgres.migration-history" && assertion.result !== "pass",
  );
  if (migrationHistory !== undefined) {
    const cause =
      migrationHistory.evidence[1] ?? migrationHistory.evidence[0] ?? "unreplayable history";
    return [
      {
        kind: "repair-migration-history",
        assertionId: "postgres.migration-history",
        instruction:
          `The BASE commit's migration history cannot be replayed on an empty database (${cause}). ` +
          `This pre-dates the candidate: S0 is built from the base commit alone, so the new changes ` +
          `are NOT the cause. Do NOT edit already-applied migrations — Prisma checksums would ` +
          `diverge from production. Safe options, in order: ` +
          `(1) declare data.<name>.schemaBaseline in cloudproof.config.ts pointing to a SQL dump of ` +
          `the DEPLOYED database that includes the _prisma_migrations table ` +
          `(pg_dump "$DATABASE_URL" --schema-only --no-owner --no-privileges, plus ` +
          `pg_dump "$DATABASE_URL" --data-only --table=_prisma_migrations --no-owner --no-privileges); ` +
          `CloudProof will then build S0 from that dump and apply only the migrations production has ` +
          `not applied yet — the exact transition production will execute; ` +
          `(2) if --base-sha does not match what is actually deployed, re-run against the real deployed SHA; ` +
          `(3) repair the history in a DEDICATED release by squashing to a new baseline with ` +
          `prisma migrate diff + prisma migrate resolve, verified on a staging copy first. ` +
          `Once one path is applied, ${RERUN_VERIFY}.`,
        ...(migrationHistory.reproduction === undefined
          ? {}
          : { command: migrationHistory.reproduction }),
      },
    ];
  }

  const infraSkipped = assertions.filter(
    (assertion) =>
      assertion.result === "skipped" &&
      assertion.mandatory !== false &&
      INFRA_STAGE_IDS.has(assertion.id),
  );
  if (infraSkipped.length > 0) {
    return infraSkipped.map((assertion) => {
      const cause =
        assertion.evidence[2] ?? assertion.evidence[1] ?? assertion.evidence[0] ?? "unknown cause";
      return {
        kind: "rerun-stage" as const,
        assertionId: assertion.id,
        instruction:
          `Stage ${assertion.id} produced no evidence (${cause}). ` +
          `Address the cause, ${RERUN_VERIFY}.`,
        ...(assertion.reproduction === undefined ? {} : { command: assertion.reproduction }),
      };
    });
  }

  const actions: NextAction[] = [];

  if (coverage.source === "unknown") {
    actions.push({
      kind: "declare-coverage",
      configPath: "coverage.requiredRoutes",
      instruction:
        "Declare the mandatory route universe in cloudproof.config.ts under coverage.requiredRoutes " +
        '(e.g. ["POST /payments", "GET /payments"]). Without it the cloudproof cannot claim complete coverage, ' +
        RERUN_VERIFY + ".",
    });
  }

  for (const route of context.missingRoutes) {
    actions.push({
      kind: "exercise-route",
      subject: route,
      instruction:
        `Required route ${route} was never exercised by the workload. Add (or fix) a test in the ` +
        `declared workload that calls ${route} through CLOUDPROOF_BASE_URL, ${RERUN_VERIFY}.`,
    });
  }

  if (!context.workloadDeclared) {
    actions.push({
      kind: "add-workload",
      configPath: "workload",
      instruction:
        "Declare a workload in cloudproof.config.ts (e.g. your e2e suite) that drives the service " +
        "through the URL in the CLOUDPROOF_BASE_URL environment variable, " +
        RERUN_VERIFY +
        ".",
    });
  } else if (context.observedExchanges === 0) {
    actions.push({
      kind: "add-workload",
      configPath: "workload",
      instruction:
        "The declared workload produced no recorded HTTP traffic. Make sure it sends its requests " +
        "to the URL in CLOUDPROOF_BASE_URL (not a hardcoded host/port), " +
        RERUN_VERIFY +
        ".",
    });
  } else if (!context.observedWrites) {
    actions.push({
      kind: "add-write-workload",
      instruction:
        "The workload performed no HTTP writes (POST/PUT/PATCH/DELETE), so schema compatibility for " +
        "writes is unproven. Add a test that writes through CLOUDPROOF_BASE_URL, " +
        RERUN_VERIFY +
        ".",
    });
  }

  const otherSkipped = assertions.filter(
    (assertion) =>
      assertion.result === "skipped" &&
      assertion.mandatory !== false &&
      !INFRA_STAGE_IDS.has(assertion.id) &&
      !assertion.id.startsWith("coverage.") &&
      // Sin escrituras observadas, el skip de sql-effects es consecuencia del
      // workload y ya está cubierto por add-write-workload.
      !(assertion.id === "postgres.sql-effects" && !context.observedWrites),
  );
  for (const assertion of otherSkipped) {
    actions.push({
      kind: "rerun-stage",
      assertionId: assertion.id,
      instruction:
        `Mandatory evidence for ${assertion.id} is unavailable ` +
        `(${assertion.evidence[0] ?? "unknown cause"}). Address the cause, ${RERUN_VERIFY}.`,
      ...(assertion.reproduction === undefined ? {} : { command: assertion.reproduction }),
    });
  }

  if (actions.length === 0) {
    // Red de seguridad del invariante: p.ej. un fallo aprobado impidió
    // ejecutar los estados restantes (cloudproof.execution-complete ausente).
    actions.push({
      kind: "rerun-stage",
      instruction:
        "Mandatory cloudproof states did not complete (an approved stage failure or missing evidence " +
        "prevented full execution). Inspect the bundle assertions, address the cause, " +
        RERUN_VERIFY +
        ".",
    });
  }

  return actions.slice(0, 50);
}
