import type { ProofBundle } from "@proof/schema";

/**
 * Ver tesis, sección 19.3 paso 10 ("Publicar Check Run y comando de
 * reproducción") y objetivo no negociable de la sección 3.3: "un solo
 * reporte por PR, sin spam". Usa la GitHub Checks API (S10 en el
 * Apéndice E de la tesis).
 *
 * NO IMPLEMENTADO: requiere autenticación de la GitHub App (control
 * plane, repo proof-cloud) antes de poder llamar a la API real. Este
 * paquete solo define el mapeo de datos, no el transporte HTTP.
 */
export interface CheckRunSummary {
  title: string;
  summary: string;
  conclusion: "success" | "failure" | "neutral";
}

export function toCheckRunSummary(bundle: ProofBundle): CheckRunSummary {
  const conclusionMap: Record<ProofBundle["conclusion"], CheckRunSummary["conclusion"]> = {
    VERIFIED: "success",
    UNSAFE: "failure",
    INCONCLUSIVE: "neutral",
  };

  const failedAssertions = bundle.assertions.filter((a) => a.result === "fail");

  return {
    title: `RELEASE PROOF: ${bundle.conclusion}`,
    summary:
      failedAssertions.length === 0
        ? "Todas las afirmaciones obligatorias pasaron."
        : failedAssertions.map((a) => `${a.id}: ${a.evidence.join(" | ")}`).join("\n"),
    conclusion: conclusionMap[bundle.conclusion],
  };
}

export async function publishCheckRun(_summary: CheckRunSummary): Promise<void> {
  throw new Error("publishCheckRun: no implementado (requiere GitHub App, ver repo proof-cloud, Fase 2)");
}
