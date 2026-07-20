import { z } from "zod";

/**
 * INCONCLUSIVE accionable: un veredicto que no es VERIFIED debe decir
 * exactamente qué falta y cómo cerrarlo (tesis 7.4: "no finge seguridad;
 * solicita acciones" — acá esas acciones se vuelven datos tipados, no prosa).
 *
 * Invariante: un bundle UNSAFE o INCONCLUSIVE contiene al menos una
 * nextAction; un bundle VERIFIED contiene cero. Un agente puede ejecutar
 * la lista y volver a correr `proof release verify` sin intervención humana
 * (excepto approvals, que son siempre decisión humana).
 */

export const NextActionKindSchema = z.enum([
  /** El workload falla sobre A0+S0: nada es atribuible a la migración. */
  "fix-baseline",
  /** Falta declarar coverage.requiredRoutes en proof.config.ts. */
  "declare-coverage",
  /** Una ruta obligatoria no fue ejercitada por el workload. */
  "exercise-route",
  /** Falta declarar (o corregir) el workload en proof.config.ts. */
  "add-workload",
  /** El workload no ejecutó ninguna escritura HTTP observable. */
  "add-write-workload",
  /** Una etapa obligatoria no produjo evidencia; hay que re-ejecutarla. */
  "rerun-stage",
  /** Existe una receta determinista: aplicarla y re-verificar. */
  "apply-remediation",
  /** Fallo reproducible sin receta de catálogo: inspeccionar y corregir. */
  "fix-failure",
]);

export const NextActionSchema = z.object({
  kind: NextActionKindSchema,
  /** Instrucción concreta y autosuficiente para un humano o un agente. */
  instruction: z.string().min(1).max(16_384),
  /** Assertion del bundle a la que responde esta acción, si aplica. */
  assertionId: z.string().min(1).max(256).optional(),
  /** Objeto de la acción, ej. la ruta "POST /payments". */
  subject: z.string().min(1).max(2_048).optional(),
  /** Campo de proof.config.ts a tocar, ej. "coverage.requiredRoutes". */
  configPath: z.string().min(1).max(2_048).optional(),
  /** Comando exacto asociado, ej. "proof reproduce <id>". */
  command: z.string().min(1).max(16_384).optional(),
});

export type NextActionKind = z.infer<typeof NextActionKindSchema>;
export type NextAction = z.infer<typeof NextActionSchema>;
