import type { Policy } from "../policy.js";

/**
 * Referenciada en el ejemplo de cloudproof.config.ts (tesis, sección 5.1),
 * pero "Critical Flows as Code" (sección 10.3) es funcionalidad de fases
 * posteriores a la cuña del MVP (sección 19 no la incluye en el alcance).
 *
 * Se registra el id acá para que cloudproof.config.ts pueda referenciarlo sin
 * romper la validación del schema, pero evaluate() falla explícitamente
 * en vez de simular un resultado — mismo principio que en
 * @cloudproof/postgres-verifier: no fabricar evidencia.
 */
export const criticalFlowsPass: Policy = {
  id: "critical-flows-pass",
  description: "Los flujos críticos declarados en cloudproof.config.ts deben pasar contra el release candidato.",
  evaluate() {
    throw new Error(
      "critical-flows-pass: Critical Flows as Code no está implementado todavía (fuera del alcance del MVP, ver tesis sección 19.1). No referenciar esta policy en cloudproof.config.ts hasta Fase 3+.",
    );
  },
};
