import type { Policy, PolicyViolation } from "../policy.js";

/**
 * Referenciada como "no-destructive-migrations" en cloudproof.config.ts
 * (tesis, sección 5.1). Bloquea si alguna assertion del namespace
 * "postgres.*" falló — es decir, si la app antigua no puede operar
 * sobre el schema migrado. Desde V-2 (auditoría 2026-07-20), ese
 * namespace incluye las assertions `postgres.static.*` que
 * verifyRelease deriva del triage estático (DDL destructivo y otras
 * operaciones "critical") antes de ejecutar ningún workload — no solo
 * lo que el workload dinámico llegó a ejercitar.
 */
export const noDestructiveMigrations: Policy = {
  id: "no-destructive-migrations",
  description:
    "La aplicación actualmente desplegada debe seguir funcionando después de aplicar la migración candidata.",
  evaluate(bundle) {
    const violations: PolicyViolation[] = [];
    const failedPostgresAssertions = bundle.assertions.filter(
      (a) =>
        a.id.startsWith("postgres.") &&
        a.result === "fail" &&
        a.approval === undefined,
    );

    if (failedPostgresAssertions.length > 0) {
      violations.push({
        policyId: "no-destructive-migrations",
        message: "La migración candidata rompe la aplicación actualmente desplegada.",
        relatedAssertionIds: failedPostgresAssertions.map((a) => a.id),
      });
    }

    return violations;
  },
};
