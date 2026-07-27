import { createRequire } from "node:module";
import { Command } from "commander";
import { banner, paint } from "./ui.js";

/**
 * Ver tesis, sección 6.1 (Filosofía UX) y 6.7 (taxonomía de comandos por
 * fase). Solo se registran acá los comandos de Fase 1-2 (D-016) — no
 * agregar `map`, `impact`, `preview`, `dev`, `observe`, `diagnose`,
 * `incident convert` ni `policy explain` hasta validar la cuña.
 *
 * Sin agente conversacional (D-015/22.3), --help y las sugerencias ante
 * un comando desconocido son la única "interpretación" que existe: se
 * activan las sugerencias por distancia de edición de commander y el
 * banner encabeza toda la ayuda. El protocolo MCP nunca pasa por acá
 * más que para despachar `mcp serve`, que no imprime nada en stdout.
 *
 * Los comandos se importan de forma DIFERIDA dentro de cada action:
 * `proof`, `proof --version` y `proof --help` no cargan el executor ni el
 * SDK de MCP, así el primer contacto es instantáneo y no requiere Docker.
 */

const { version: CLI_VERSION } = createRequire(import.meta.url)("../package.json") as {
  version: string;
};

export { CLI_VERSION };

export function buildProgram(): Command {
  const program = new Command();

  program
    .name("proof")
    .description("Evidence Plane determinista para cambios stateful")
    .version(CLI_VERSION, "-v, --version", "muestra la versión")
    .showSuggestionAfterError(true)
    .showHelpAfterError(paint.dim("(corré `proof --help` para ver los comandos disponibles)"))
    .addHelpText("beforeAll", banner(CLI_VERSION))
    .addHelpText(
      "after",
      [
        "",
        paint.bold("Ejemplos"),
        `  ${paint.cyan("proof init")}                        ${paint.dim("detecta el stack y genera proof.config.ts")}`,
        `  ${paint.cyan("proof release plan --base-sha <deployed> --head-sha <candidato>")}`,
        `  ${paint.cyan("proof release verify --base-sha <deployed> --head-sha <candidato>")}`,
        `  ${paint.cyan("proof reproduce <assertion-id>")}    ${paint.dim("reconstruye un finding en vivo")}`,
        "",
      ].join("\n"),
    );

  program
    .command("init")
    .description("Detecta el stack del repositorio y genera proof.config.ts + AGENTS.md")
    .option("--json", "salida en JSON")
    .action(async (opts) => {
      const { runInit } = await import("./commands/init.js");
      await runInit({ json: opts.json });
    });

  program
    .command("doctor")
    .description(
      "Valida runtime, Docker, disco, historial Git, secretos versionados, configuración, workload, cobertura y approvals",
    )
    .option("--json", "salida en JSON")
    .action(async (opts) => {
      const { doctorExitCode, runDoctor } = await import("./commands/doctor.js");
      const findings = await runDoctor({ json: opts.json });
      process.exitCode = doctorExitCode(findings);
    });

  const release = program
    .command("release")
    .description("Verificación de releases (matriz A0/A1 × S0/S1)");
  release
    .command("plan")
    .description("Triage estatico acotado (<2 min); planifica, nunca emite VERIFIED")
    .requiredOption("--base-sha <sha>", "SHA de la version desplegada")
    .option("--head-sha <sha>", "SHA del candidato")
    .option("--worktree", "planifica un snapshot inmutable del worktree sin crear un commit en la rama")
    .option("--service <name>", "servicio declarado en proof.config")
    .option("--profile <profile>", "trusted, internal o fork")
    .option("--json", "salida en JSON")
    .action(async (opts) => {
      const { runReleasePlan } = await import("./commands/release-plan.js");
      await runReleasePlan({
        baseSha: opts.baseSha,
        headSha: opts.headSha,
        worktree: opts.worktree,
        json: opts.json,
        service: opts.service,
        profile: opts.profile,
      });
    });
  release
    .command("verify")
    .description("Ejecuta la matriz adaptativa exigida por el diff; genera un Proof Bundle")
    .requiredOption("--base-sha <sha>", "SHA de la versión desplegada")
    .option("--head-sha <sha>", "SHA del candidato")
    .option("--worktree", "verifica un snapshot inmutable del worktree sin crear un commit en la rama")
    .option("--service <name>", "servicio declarado en proof.config")
    .option("--profile <profile>", "trusted, internal o fork")
    .option("--json", "salida en JSON")
    .action(async (opts) => {
      const { runReleaseVerify } = await import("./commands/release-verify.js");
      await runReleaseVerify({
        baseSha: opts.baseSha,
        headSha: opts.headSha,
        worktree: opts.worktree,
        json: opts.json,
        service: opts.service,
        profile: opts.profile,
      });
    });

  program
    .command("reproduce <assertionId>")
    .description("Muestra y reproduce localmente un finding de un Proof Bundle previo")
    .option("--json", "salida en JSON")
    .option("--bundle <path>", "Proof Bundle exacto cuando el id aparece en más de una corrida")
    .option("--cleanup", "elimina los contenedores y la red de esta reproducción")
    .action(async (assertionId, opts) => {
      const { runReproduce } = await import("./commands/reproduce.js");
      await runReproduce(assertionId, {
        json: opts.json,
        bundle: opts.bundle,
        cleanup: opts.cleanup,
      });
    });

  const bundle = program
    .command("bundle")
    .description("Firma, verificación e inspección de Proof Bundles");
  bundle
    .command("keygen")
    .description("Genera el par Ed25519 de firma local en .proof/keys/")
    .option("--force", "regenera aunque ya exista una clave")
    .option("--json", "salida en JSON")
    .action(async (opts) => {
      const { runBundleKeygen } = await import("./commands/bundle.js");
      runBundleKeygen({ json: opts.json, force: opts.force });
    });
  bundle
    .command("sign <bundle>")
    .description("Firma el payload canónico del Bundle (Ed25519, DSSE PAE)")
    .option("--key <path>", "clave privada PEM; default .proof/keys/proof-signing.key")
    .option("--json", "salida en JSON")
    .action(async (bundlePath, opts) => {
      const { runBundleSign } = await import("./commands/bundle.js");
      runBundleSign(bundlePath, { json: opts.json, key: opts.key });
    });
  bundle
    .command("verify <bundle>")
    .description("Verifica integridad y firma; sin clave pública nunca declara confianza")
    .option("--key <path>", "clave pública PEM; default .proof/keys/proof-signing.pub")
    .option("--attestation <path>", "attestation; default <bundle>.attestation.json")
    .option("--json", "salida en JSON")
    .action(async (bundlePath, opts) => {
      const { bundleVerifyExitCode, runBundleVerify } = await import("./commands/bundle.js");
      const report = runBundleVerify(bundlePath, {
        json: opts.json,
        key: opts.key,
        attestation: opts.attestation,
      });
      process.exitCode = bundleVerifyExitCode(report);
    });
  bundle
    .command("inspect <bundle>")
    .description("Resumen humano/JSON de un Proof Bundle: veredicto, matriz, cobertura")
    .option("--json", "salida en JSON")
    .action(async (bundlePath, opts) => {
      const { runBundleInspect } = await import("./commands/bundle.js");
      runBundleInspect(bundlePath, { json: opts.json });
    });

  program
    .command("cleanup")
    .description("Elimina contenedores y redes residuales de Proof (label dev.proof.owner)")
    .option("--dry-run", "lista los residuos sin eliminarlos")
    .option("--json", "salida en JSON")
    .action(async (opts) => {
      const { cleanupExitCode, runCleanup } = await import("./commands/cleanup.js");
      const report = await runCleanup({ json: opts.json, dryRun: opts.dryRun });
      process.exitCode = cleanupExitCode(report);
    });

  program
    .command("check")
    .description("Corre release verify y publica un GitHub Check Run (pensado para correr en CI)")
    .requiredOption("--base-sha <sha>", "SHA de la versión desplegada")
    .requiredOption("--head-sha <sha>", "SHA del candidato")
    .action(async (opts) => {
      const { runCheck } = await import("./commands/check.js");
      await runCheck({ baseSha: opts.baseSha, headSha: opts.headSha });
    });

  const mcp = program
    .command("mcp")
    .description("Interfaz para agentes de IA (Model Context Protocol)");
  mcp
    .command("serve")
    .description("Levanta el servidor MCP sobre stdio")
    .action(async () => {
      const { serveMcp } = await import("./mcp/serve.js");
      await serveMcp();
    });

  return program;
}
