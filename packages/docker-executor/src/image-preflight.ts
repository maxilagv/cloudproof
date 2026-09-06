/**
 * Preflight ESTÁTICO de requisitos de runtime de la imagen (informe Lubrisur
 * 2026-07: "no detectó por sí solo que Prisma necesitaba OpenSSL dentro de
 * la imagen; el problema apareció recién al construir Docker"). La regla de
 * CloudProof es que un problema demostrable estáticamente debe aparecer en
 * `cloudproof doctor`, no a los N minutos de un build.
 *
 * El análisis entiende multi-stage: solo cuentan la etapa FINAL y sus
 * ancestros por alias (`FROM builder`) — un `apk add openssl` en una etapa
 * de build que no llega a la imagen final NO satisface el requisito.
 *
 * El catálogo es una tabla extensible de requisitos conocidos por stack;
 * hoy cubre los dos modos de fallo documentados de Prisma:
 *  - base Alpine/musl sin OpenSSL (los engines lo cargan en runtime);
 *  - base Debian slim sin libssl (las variantes slim no lo traen).
 * Las bases Debian completas (bookworm/bullseye) y distroless/base ya
 * incluyen OpenSSL y no generan finding.
 */

export interface ImagePreflightFinding {
  rule: "prisma-openssl-alpine" | "prisma-openssl-debian-slim";
  severity: "HIGH";
  message: string;
  /** Citas del Dockerfile que sostienen el finding (ej. la línea FROM). */
  evidence: string[];
}

export interface ImagePreflightInput {
  dockerfileContents: string;
  /** El servicio usa Prisma (schema resuelto); activa las reglas de Prisma. */
  usesPrisma: boolean;
}

interface DockerfileStage {
  /** Alias (`AS nombre`) en minúsculas, si existe. */
  name?: string;
  /** Imagen u alias referenciado por FROM, tal como está escrito. */
  base: string;
  /** Línea 1-indexada del FROM, para evidencia citable. */
  fromLine: number;
  /** Instrucciones RUN/COPY/ADD de la etapa (líneas lógicas). */
  instructions: string[];
}

/** Parse mínimo de etapas; une continuaciones de línea antes de cortar. */
export function parseDockerfileStages(dockerfileContents: string): DockerfileStage[] {
  const stages: DockerfileStage[] = [];
  // Para conservar números de línea reales, las continuaciones se reemplazan
  // por espacios SIN colapsar los saltos (la instrucción queda en su primera
  // línea y las siguientes quedan vacías).
  const logical: string[] = [];
  const rawLines = dockerfileContents.split("\n");
  let buffer = "";
  let bufferStart = 0;
  for (const [index, raw] of rawLines.entries()) {
    const line = raw.replace(/\r$/, "");
    if (buffer === "") bufferStart = index;
    if (/\\\s*$/.test(line)) {
      buffer += line.replace(/\\\s*$/, " ");
      continue;
    }
    logical[bufferStart] = buffer + line;
    buffer = "";
  }
  if (buffer !== "") logical[bufferStart] = buffer;

  for (const [index, line] of logical.entries()) {
    if (line === undefined) continue;
    const from = /^\s*FROM\s+(?:--platform=\S+\s+)?(\S+)(?:\s+AS\s+(\S+))?\s*$/i.exec(line);
    if (from?.[1] !== undefined) {
      stages.push({
        base: from[1],
        fromLine: index + 1,
        instructions: [],
        ...(from[2] === undefined ? {} : { name: from[2].toLowerCase() }),
      });
      continue;
    }
    const stage = stages[stages.length - 1];
    if (stage === undefined) continue;
    if (/^\s*(?:RUN|COPY|ADD)\b/i.test(line)) stage.instructions.push(line.trim());
  }
  return stages;
}

/**
 * Etapa final + ancestros por alias. Las instrucciones heredadas importan:
 * `FROM base AS deps … FROM deps` conserva lo instalado en `deps`.
 */
function effectiveFinalChain(stages: DockerfileStage[]): DockerfileStage[] {
  const last = stages[stages.length - 1];
  if (last === undefined) return [];
  const byName = new Map(
    stages.filter((stage) => stage.name !== undefined).map((stage) => [stage.name, stage]),
  );
  const chain: DockerfileStage[] = [];
  let current: DockerfileStage | undefined = last;
  const visited = new Set<DockerfileStage>();
  while (current !== undefined && !visited.has(current)) {
    visited.add(current);
    chain.push(current);
    current = byName.get(current.base.toLowerCase());
  }
  return chain;
}

/** Imagen externa raíz de la cadena final (resuelve aliases). */
function rootBaseOf(chain: DockerfileStage[]): DockerfileStage | undefined {
  return chain[chain.length - 1];
}

function mentionsOpenssl(chain: DockerfileStage[]): boolean {
  return chain.some((stage) =>
    stage.instructions.some((instruction) => /openssl|libssl/i.test(instruction)),
  );
}

export function preflightImageRuntime(input: ImagePreflightInput): ImagePreflightFinding[] {
  if (!input.usesPrisma) return [];
  const stages = parseDockerfileStages(input.dockerfileContents);
  const chain = effectiveFinalChain(stages);
  const root = rootBaseOf(chain);
  if (root === undefined) return [];
  const base = root.base.toLowerCase();
  if (base === "scratch" || base.includes("$")) return [];
  if (mentionsOpenssl(chain)) return [];

  const evidence = [`FROM ${root.base} (línea ${root.fromLine} del Dockerfile)`];
  if (/(^|[/:@-])alpine/.test(base)) {
    return [
      {
        rule: "prisma-openssl-alpine",
        severity: "HIGH",
        message:
          `La imagen final se basa en "${root.base}" (Alpine/musl) y ninguna etapa efectiva ` +
          `instala OpenSSL; los engines de Prisma lo requieren en runtime y el contenedor ` +
          `fallará al arrancar. Agregá \`RUN apk add --no-cache openssl\` en la etapa final.`,
        evidence,
      },
    ];
  }
  if (/-slim/.test(base)) {
    return [
      {
        rule: "prisma-openssl-debian-slim",
        severity: "HIGH",
        message:
          `La imagen final se basa en "${root.base}" (Debian slim, sin libssl) y ninguna etapa ` +
          `efectiva instala OpenSSL; Prisma no podrá cargar sus engines en runtime. Agregá ` +
          `\`RUN apt-get update && apt-get install -y --no-install-recommends openssl\` en la etapa final.`,
        evidence,
      },
    ];
  }
  return [];
}
