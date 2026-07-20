import { z } from "zod";

/**
 * Ver tesis, sección 7.6 (secuencia expand/contract): "el producto no debe
 * limitarse a reportar que una migración es peligrosa. Debe proponer una
 * secuencia operacional segura". La receta es SIEMPRE producto de un catálogo
 * determinista (SQLSTATE observado + estado de ejecución), nunca de un LLM
 * (D-005/D-015: "el modelo interpreta, el runtime demuestra").
 *
 * El consumidor primario es un agente de IA (tesis sección 8): con esta
 * estructura el loop es verify → UNSAFE + receta → aplicar receta →
 * re-verify → VERIFIED, sin interpretar prosa.
 */

export const RemediationPhaseSchema = z.enum(["expand", "deploy", "backfill", "contract"]);

export const RemediationStepSchema = z.object({
  order: z.number().int().positive(),
  phase: RemediationPhaseSchema,
  /** Título corto estilo demo canónica (tesis 19.5), ej. "Add nullable column". */
  title: z.string().min(1).max(2_048),
  /** Instrucción precisa, con tabla/columna concretas cuando la evidencia las expone. */
  detail: z.string().min(1).max(16_384),
});

export const RemediationStrategySchema = z.enum(["expand-contract", "safe-sequence"]);

export const RemediationSchema = z.object({
  /** Id estable del patrón en el catálogo determinista, ej. "postgres.not-null-column-old-app-writes". */
  pattern: z.string().min(1).max(256),
  strategy: RemediationStrategySchema,
  summary: z.string().min(1).max(16_384),
  steps: z
    .array(RemediationStepSchema)
    .min(1)
    .max(8, { message: "Una receta es una secuencia corta y aplicable, no un runbook." }),
  /** Evidencia exacta que disparó la receta — auditabilidad del determinismo. */
  triggeredBy: z.array(z.string().min(1).max(16_384)).min(1).max(5),
});

export type RemediationPhase = z.infer<typeof RemediationPhaseSchema>;
export type RemediationStep = z.infer<typeof RemediationStepSchema>;
export type RemediationStrategy = z.infer<typeof RemediationStrategySchema>;
export type Remediation = z.infer<typeof RemediationSchema>;
