import { z } from "zod";

/**
 * Ver tesis, sección 7.4 — las únicas tres conclusiones permitidas.
 * VERIFIED nunca se infiere: solo se emite cuando todas las afirmaciones
 * obligatorias fueron ejercitadas y pasaron.
 */
export const ConclusionSchema = z.enum(["VERIFIED", "UNSAFE", "INCONCLUSIVE"]);

export type Conclusion = z.infer<typeof ConclusionSchema>;
