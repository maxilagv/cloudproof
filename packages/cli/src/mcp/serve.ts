import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { runReleasePlan } from "../commands/release-plan.js";
import { runReleaseVerify } from "../commands/release-verify.js";
import { findAssertion } from "../commands/reproduce.js";

/**
 * Ver tesis, sección 8 (Interfaz para agentes de IA) y 8.6 (Diseño del
 * servidor MCP). Decisiones de esa sección aplicadas literalmente acá:
 *
 *  - Transporte stdio (D-017): pensado para correr como subproceso del
 *    harness del agente, no como servidor HTTP.
 *  - Solo 3 tools en esta versión: proof_release_plan,
 *    proof_release_verify y proof_reproduce. proof_check queda afuera
 *    porque publica un Check Run (efecto en GitHub, no solo lectura) —
 *    ver nota en la sección 23.1 sobre no exponer nada que dispare
 *    compute/acciones pagas sin que el tool lo advierta explícitamente.
 *    Se agrega cuando @proof/plugin-github-actions#publishCheckRun deje
 *    de ser un stub y se defina el gating de confirmación.
 *  - conclusion viaja como enum tipado dentro del JSON, nunca como prosa.
 */

export function createProofMcpServer(): McpServer {
  const server = new McpServer({ name: "proof", version: "0.0.1" });

  server.tool(
    "proof_release_plan",
    "Fast path estatico y acotado a 120 segundos. Llamalo primero para clasificar el diff, " +
      "elegir el nivel de assurance y obtener el comando siguiente. Nunca ejecuta Docker/workloads " +
      "y nunca devuelve VERIFIED: decision siempre es PLAN_ONLY_NOT_VERIFIED. Un plan incompleto " +
      "o de riesgo alto exige la matriz completa; no interpretes ausencia de patrones como seguridad.",
    {
      baseSha: z.string().describe("SHA/ref de la version desplegada"),
      headSha: z.string().describe("SHA/ref del candidato"),
      service: z.string().optional().describe("Servicio declarado en proof.config"),
      profile: z.enum(["trusted", "internal", "fork"]).optional(),
      cwd: z.string().optional().describe("Directorio del proyecto"),
    },
    async ({ baseSha, headSha, service, profile, cwd }) => {
      const plan = await runReleasePlan({
        baseSha,
        headSha,
        json: true,
        writeOutput() {},
        ...(service === undefined ? {} : { service }),
        ...(profile === undefined ? {} : { profile }),
        ...(cwd === undefined ? {} : { cwd }),
      });
      return { content: [{ type: "text" as const, text: JSON.stringify(plan) }] };
    },
  );

  server.tool(
    "proof_release_verify",
    "Ejecuta la matriz completa: builds A0/A1, A0/A1 sobre S0/S1, migración limpia y poblada, " +
      "dos schedules de coexistencia y rollback A0 después del prefijo de escrituras de A1. " +
      "y devuelve un Proof Bundle con conclusion VERIFIED | UNSAFE | INCONCLUSIVE (enum tipado, no prosa). " +
      "Seguí el assurance/nextCommand de proof_release_plan; es una operación cara que levanta contenedores y bases efímeras. " +
      "Cómo actuar según conclusion: VERIFIED → podés declarar el trabajo terminado citando el bundle. " +
      "UNSAFE → NO declarar terminado; las assertions fallidas pueden traer 'remediation' (secuencia expand/contract " +
      "determinista): aplicá esos pasos a la migración y volvé a llamar este tool hasta VERIFIED; nunca agregues " +
      "una approval vos mismo, las approvals son decisión humana. " +
      "INCONCLUSIVE → NO significa seguro; el array 'nextActions' del bundle dice exactamente qué falta " +
      "(declarar coverage, agregar workload de escritura, ejercitar una ruta): ejecutá esas acciones y re-verificá. " +
      "El Bundle local actual es v1 y no sustituye un gate de confianza externo; ese gate debe exigir v2, freshness, " +
      "evidencia content-addressed y firmas verificadas. El perfil fork falla cerrado si no existe un adapter de workload aislado.",
    {
      baseSha: z.string().describe("SHA de la versión actualmente desplegada"),
      headSha: z.string().describe("SHA del candidato a mergear"),
      service: z.string().optional().describe("Servicio de proof.config.ts en monorepos"),
      profile: z.enum(["trusted", "internal", "fork"]).optional(),
      cwd: z.string().optional().describe("Directorio del proyecto (default: cwd del proceso)"),
    },
    async ({ baseSha, headSha, service, profile, cwd }) => {
      const bundle = await runReleaseVerify({
        baseSha,
        headSha,
        json: true,
        writeOutput() {},
        ...(service !== undefined ? { service } : {}),
        ...(profile !== undefined ? { profile } : {}),
        ...(cwd !== undefined ? { cwd } : {}),
      });
      return {
        content: [{ type: "text" as const, text: JSON.stringify(bundle) }],
      };
    },
  );

  server.tool(
    "proof_reproduce",
    "Devuelve la evidencia guardada de una assertion específica de un Proof Bundle previo, identificada por su id " +
      "(el mismo id que aparece en el campo 'reproduction' de un resultado de proof_release_verify). " +
      "MANDATORY: solo tiene sentido llamar esta tool después de haber corrido proof_release_verify en la misma sesión " +
      "y haber recibido un id de assertion fallida — no inventar un id.",
    {
      assertionId: z.string().describe("Id de la assertion, ej. \"postgres.old-app-new-schema.0\""),
      cwd: z.string().optional(),
      bundle: z.string().optional().describe("Bundle exacto si el id aparece más de una vez"),
    },
    async ({ assertionId, cwd, bundle }) => {
      const assertion = findAssertion(assertionId, cwd, bundle);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(assertion) }],
      };
    },
  );

  return server;
}

export async function serveMcp(): Promise<void> {
  const server = createProofMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
