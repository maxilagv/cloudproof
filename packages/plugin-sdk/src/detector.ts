/**
 * Ver tesis, sección 5.2 ("Sistema de plugins"). El MVP (sección 19.1)
 * solo necesita la capacidad de "detector" — el resto (fixtures, mocks,
 * analizadores custom, targets de ejecución) es Fase 2+ y no se define
 * acá todavía para no inventar una API que nadie validó con un plugin
 * real (mismo espíritu que D-016 aplicado al plugin API).
 */

export interface DetectionResult {
  detected: boolean;
  /** Ej. "postgres", "prisma", "github-actions". Debe coincidir con el DataKind/ServiceKind de @proof/config cuando aplique. */
  kind: string;
  /** Evidencia legible de por qué se detectó (ej. archivo encontrado), para que "proof init" pueda mostrarla. */
  evidence: string[];
}

export interface Detector {
  id: string;
  detect(projectRoot: string): Promise<DetectionResult>;
}
