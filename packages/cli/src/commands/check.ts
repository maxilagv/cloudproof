import { toCheckRunSummary, publishCheckRun } from "@proof/plugin-github-actions";
import { runReleaseVerify, type ReleaseVerifyOptions } from "./release-verify.js";

/**
 * Ver tesis, sección 15.3 (Fase 2: "Check Run único") y objetivo no
 * negociable de la sección 3.3 ("un solo reporte por PR, sin spam").
 * Wrapper orquestado sobre release-verify pensado para correr dentro de
 * un job de GitHub Actions (ver .github/workflows en el repo del usuario,
 * no en este monorepo).
 */
export async function runCheck(options: ReleaseVerifyOptions): Promise<void> {
  const bundle = await runReleaseVerify(options);
  const summary = toCheckRunSummary(bundle);
  await publishCheckRun(summary);
}
