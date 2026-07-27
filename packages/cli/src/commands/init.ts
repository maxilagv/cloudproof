import { writeFileSync, existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";
import { spawnSync } from "node:child_process";
import { parse as parseYaml } from "yaml";
import { paint, symbols } from "../ui.js";
import {
  findOpenApiSpec,
  planWorkloadFromOpenApi,
  renderWorkloadScript,
} from "./openapi-workload.js";
import { planAuthFixtures, renderAuthFixtureScript } from "./auth-fixtures.js";
import { nodeDetector } from "@proof/plugin-node";
import { postgresDetector } from "@proof/plugin-postgres";
import { prismaDetector } from "@proof/plugin-prisma";
import { githubActionsDetector } from "@proof/plugin-github-actions";
import {
  classifyGeneratedPath,
  prismaGeneratorOutputs,
  type Detector,
} from "@proof/plugin-sdk";

/**
 * Ver tesis, sección 6.3 ("Ejemplo de primera experiencia") y 15.2
 * (Fase 1: "proof init y detección de repositorio").
 *
 * Corre los detectores del MVP (Fase 1-2: node, postgres, prisma,
 * github-actions — ver tesis 19.1) y, si no existe, escribe un
 * proof.config.ts de partida. NO genera todavía "immediate findings"
 * de seguridad (eso requiere @proof/postgres-verifier, que está
 * corriendo release verify real, no detección de stack).
 *
 * La detección de servicios (gate 1.E, primera corrida real) elige como
 * servicio a los directorios que pueden CONSTRUIRSE — package.json más un
 * Dockerfile propio (estándar o con nombre custom que matchee el servicio)
 * — y trata la ubicación de Prisma como un dato aparte (prismaSchema),
 * porque en monorepos reales el schema suele vivir en un paquete compartido
 * o anidado bajo src/, no junto al Dockerfile.
 *
 * Genera/actualiza además AGENTS.md (tesis 8.2 e I-012): un bloque
 * gestionado entre markers que le dice a cualquier agente de IA que entre
 * al repo que existe una capa de verificación y cómo usar su resultado.
 * El bloque se reemplaza en cada init; el resto del archivo es del usuario.
 */
const DETECTORS: Detector[] = [nodeDetector, postgresDetector, prismaDetector, githubActionsDetector];

const IGNORED_DIRECTORIES = new Set(["node_modules", ".git", "dist", ".next", ".turbo", "coverage"]);

export interface InitOptions {
  json?: boolean;
  cwd?: string;
}

export interface DetectedService {
  name: string;
  path: string;
  kind: "nextjs" | "node";
  /** Ruta worktree-relativa cuando el Dockerfile no es `<path>/Dockerfile`. */
  dockerfile?: string;
  /** Ruta worktree-relativa cuando el schema no está en la convención. */
  prismaSchema?: string;
  /** --build-arg adoptados del docker-compose del repo (evidencia real). */
  buildArgs?: Record<string, string>;
}

/** Candidato descartado como servicio, con la evidencia de por qué. */
export interface ExcludedServiceCandidate {
  path: string;
  reason: string;
}

export interface InitResult {
  detected: Array<{ kind: string; evidence: string[] }>;
  services: DetectedService[];
  /** Directorios con package.json que NO son servicios (código generado, etc.). */
  excluded: ExcludedServiceCandidate[];
  configWritten: boolean;
  configPath: string;
  /** Config de datos puros para perfiles internal/fork (solo en scaffolds nuevos). */
  jsonConfigPath?: string;
  jsonConfigWritten?: boolean;
  agentsPath: string;
  /** "created" | "updated" | "unchanged" para AGENTS.md. */
  agentsResult: "created" | "updated" | "unchanged";
  /** Gestión de .gitignore: .proof/ es evidencia local y nunca debe versionarse. */
  gitignorePath: string;
  gitignoreResult: "created" | "updated" | "unchanged";
  /** Workload generado desde OpenAPI cuando el repo no declara e2e propio. */
  workloadGenerated?: {
    scriptPath: string;
    specPath: string;
    steps: number;
    routes: number;
    gaps: string[];
  };
  /** Fixture de identidad HTTP generado desde la evidencia del spec OpenAPI. */
  authFixturesGenerated?: {
    scriptPath: string;
    loginPath: string;
    registerPath?: string;
    tokenProperty: string;
    gaps: string[];
  };
}

interface WorkloadSetup {
  workload?: { command: string; args: string[] };
  coverage?: { requiredRoutes: string[]; rollbackProbeRoutes?: string[] };
  fixtures?: { beforeAll: { command: string; args: string[] } };
}

export async function runInit(options: InitOptions = {}): Promise<InitResult> {
  const cwd = options.cwd ?? process.cwd();
  const results = await Promise.all(DETECTORS.map((d) => d.detect(cwd)));
  const detected = results.filter((r) => r.detected).map((r) => ({ kind: r.kind, evidence: r.evidence }));
  const { services, excluded } = detectServices(cwd, detected);

  const configPath = join(cwd, "proof.config.ts");
  const jsonConfigPath = join(cwd, "proof.config.json");
  const configAlreadyExisted = existsSync(configPath);
  let configWritten = false;
  let jsonConfigWritten = false;

  // Workload: primero la evidencia del repo (script e2e propio); si no hay,
  // se genera uno desde OpenAPI (gate 2 del informe 2026-07-18) con
  // coverage.requiredRoutes real en vez del ejemplo comentado.
  const repoWorkload = detectedWorkload(cwd);
  const setup: WorkloadSetup = repoWorkload === undefined ? {} : { workload: repoWorkload };
  let workloadGenerated: InitResult["workloadGenerated"];
  let authFixturesGenerated: InitResult["authFixturesGenerated"];
  if (!configAlreadyExisted && setup.workload === undefined) {
    const spec = findOpenApiSpec(cwd);
    if (spec !== undefined) {
      const plan = planWorkloadFromOpenApi(spec.path, spec.document);
      if (plan.steps.length > 0) {
        const scriptPath = join(cwd, "proof.workload.mjs");
        if (!existsSync(scriptPath)) {
          writeFileSync(scriptPath, renderWorkloadScript(plan), "utf-8");
        }
        setup.workload = { command: "node", args: ["proof.workload.mjs"] };
        setup.coverage = {
          requiredRoutes: plan.requiredRoutes,
          ...(plan.rollbackProbeRoutes.length === 0
            ? {}
            : { rollbackProbeRoutes: plan.rollbackProbeRoutes }),
        };
        workloadGenerated = {
          scriptPath,
          specPath: plan.specPath,
          steps: plan.steps.length,
          routes: plan.requiredRoutes.length,
          gaps: plan.gaps,
        };

        // Identidad HTTP (informe Lubrisur): si el spec declara operaciones
        // con seguridad Y expone login público con token en la respuesta,
        // se scaffoldea el fixture completo; sin esa evidencia, el hueco se
        // reporta como gap accionable en vez de inventar rutas.
        const fixturePlan = planAuthFixtures(spec.document);
        if (fixturePlan.login !== undefined && fixturePlan.tokenProperty !== undefined) {
          const fixtureScriptPath = join(cwd, "proof.fixtures.mjs");
          if (!existsSync(fixtureScriptPath)) {
            writeFileSync(
              fixtureScriptPath,
              renderAuthFixtureScript(fixturePlan, spec.path),
              "utf-8",
            );
          }
          setup.fixtures = { beforeAll: { command: "node", args: ["proof.fixtures.mjs"] } };
          authFixturesGenerated = {
            scriptPath: fixtureScriptPath,
            loginPath: fixturePlan.login.path,
            ...(fixturePlan.register === undefined
              ? {}
              : { registerPath: fixturePlan.register.path }),
            tokenProperty: fixturePlan.tokenProperty,
            gaps: fixturePlan.gaps,
          };
        } else {
          workloadGenerated.gaps.push(...fixturePlan.gaps);
        }
      }
    }
  }

  if (!configAlreadyExisted) {
    writeFileSync(configPath, buildConfigTemplate(detected, services, setup), "utf-8");
    configWritten = true;
    if (!existsSync(jsonConfigPath)) {
      writeFileSync(
        jsonConfigPath,
        `${JSON.stringify(buildJsonConfig(detected, services, setup), null, 2)}\n`,
        "utf-8",
      );
      jsonConfigWritten = true;
    }
  }

  const agentsPath = join(cwd, "AGENTS.md");
  const agentsResult = syncAgentsFile(agentsPath, services);
  const gitignorePath = join(cwd, ".gitignore");
  const gitignoreResult = ensureProofIgnored(cwd, gitignorePath);

  const result: InitResult = {
    detected,
    services,
    excluded,
    configWritten,
    configPath,
    jsonConfigPath,
    jsonConfigWritten,
    agentsPath,
    agentsResult,
    gitignorePath,
    gitignoreResult,
    ...(workloadGenerated === undefined ? {} : { workloadGenerated }),
    ...(authFixturesGenerated === undefined ? {} : { authFixturesGenerated }),
  };

  if (options.json) {
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  } else {
    printHuman(result);
  }

  return result;
}

// ------------------------------------------------------- detección de servicios

function listDirectories(root: string): string[] {
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !IGNORED_DIRECTORIES.has(entry.name))
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

/**
 * Git is already a Proof prerequisite, so its ignore engine is the source of
 * truth for generated outputs. Falling back to the fixed directory list keeps
 * `init` able to report a missing Git installation or repository.
 */
function gitIgnoredDirectories(cwd: string, relativePaths: string[]): Set<string> {
  if (relativePaths.length === 0) return new Set();
  const normalized = relativePaths.map((path) => path.replace(/\\/g, "/"));
  const probes = normalized.flatMap((path) => [path, `${path}/package.json`]);
  const result = spawnSync("git", ["check-ignore", "-z", "--stdin"], {
    cwd,
    input: `${probes.join("\0")}\0`,
    encoding: "utf-8",
    windowsHide: true,
  });
  if (result.status !== 0) return new Set();
  const matches = new Set(
    String(result.stdout)
      .split("\0")
      .filter((path) => path.length > 0)
      .map((path) => path.replace(/\\/g, "/")),
  );
  return new Set(
    normalized.filter((path) => matches.has(path) || matches.has(`${path}/package.json`)),
  );
}

/**
 * Directorios con package.json hasta 3 niveles (sin la raíz). El código
 * generado se descarta ANTES de considerarlo servicio (informe Lubrisur:
 * el cliente Prisma en src/generated/prisma trae su propio package.json y
 * no es una aplicación) — y cada descarte queda registrado con su razón
 * para que `proof init` lo muestre en vez de fallar en silencio.
 */
function packageDirectories(
  cwd: string,
  generatorOutputs: readonly string[],
  excluded: ExcludedServiceCandidate[],
): string[] {
  const found: string[] = [];
  const visit = (relativePath: string, depth: number): void => {
    if (depth > 3) return;
    const children = listDirectories(join(cwd, relativePath)).map((entry) =>
      relativePath === "" ? entry : `${relativePath}/${entry}`,
    );
    const ignored = gitIgnoredDirectories(cwd, children);
    for (const child of children) {
      if (ignored.has(child)) continue;
      const verdict = classifyGeneratedPath(child, generatorOutputs);
      if (verdict.generated) {
        // Registrar TODOS los package.json del subárbol generado (el cliente
        // Prisma vive en src/generated/prisma, no en src/generated).
        recordGeneratedPackages(cwd, child, depth, verdict.reason ?? "código generado", excluded);
        continue;
      }
      if (existsSync(join(cwd, child, "package.json"))) found.push(child);
      visit(child, depth + 1);
    }
  };
  visit("", 1);
  return found;
}

/** package.json dentro de un subárbol generado, para reportarlos como excluidos. */
function recordGeneratedPackages(
  cwd: string,
  relativePath: string,
  depth: number,
  reason: string,
  excluded: ExcludedServiceCandidate[],
): void {
  if (depth > 4) return;
  if (existsSync(join(cwd, relativePath, "package.json"))) {
    excluded.push({ path: relativePath, reason });
    return;
  }
  for (const child of listDirectories(join(cwd, relativePath))) {
    recordGeneratedPackages(cwd, `${relativePath}/${child}`, depth + 1, reason, excluded);
  }
}

/**
 * Dockerfile propio de un servicio. Además de `<dir>/Dockerfile`, reconoce
 * variantes con nombre custom en `<dir>/`, `<dir>/docker/` y `docker/` de
 * la raíz (el patrón real de inbox-zero y similares). Preferencia:
 * PRIMERO los nombres de producción (`Dockerfile.prod[uction]`,
 * `prod[uction].Dockerfile`) — Proof verifica releases, no contenedores de
 * desarrollo — y después el match por nombre de servicio
 * (`Dockerfile.<name>` / `<name>.Dockerfile`).
 */
function serviceDockerfile(
  cwd: string,
  servicePath: string,
  serviceName: string,
): { standard: true } | { standard: false; dockerfile: string } | undefined {
  if (existsSync(join(cwd, servicePath, "Dockerfile"))) return { standard: true };

  const prodPattern = /^(dockerfile\.(prod|production)|(prod|production)\.dockerfile)$/i;
  const namePattern = new RegExp(
    `^(dockerfile\\.${escapeRegExp(serviceName)}|${escapeRegExp(serviceName)}\\.dockerfile)$`,
    "i",
  );
  // En dirs propios del servicio alcanza cualquier variante; en el docker/
  // compartido de la raíz se exige además un match por nombre — un
  // Dockerfile.prod compartido no puede atribuirse a TODOS los workspaces.
  const searchDirectories: Array<{ directory: string; requireNameMatch: boolean }> =
    servicePath === "."
      ? [
          { directory: ".", requireNameMatch: false },
          { directory: "docker", requireNameMatch: false },
        ]
      : [
          { directory: servicePath, requireNameMatch: false },
          { directory: `${servicePath}/docker`, requireNameMatch: false },
          { directory: "docker", requireNameMatch: true },
        ];
  for (const { directory, requireNameMatch } of searchDirectories) {
    const absolute = join(cwd, directory);
    if (!existsSync(absolute)) continue;
    let entries: string[];
    try {
      entries = readdirSync(absolute);
    } catch {
      continue;
    }
    const nameMatch = entries.find((entry) => namePattern.test(entry));
    if (requireNameMatch && nameMatch === undefined) continue;
    const match = entries.find((entry) => prodPattern.test(entry)) ?? nameMatch;
    if (match !== undefined) {
      const relativePath = directory === "." ? match : `${directory}/${match}`;
      return { standard: false, dockerfile: relativePath };
    }
  }
  return undefined;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Si el docker-compose del repo construye el MISMO Dockerfile, sus
 * build.args son evidencia de cómo se construye la imagen de verdad
 * (rallly, por ejemplo, exige SELF_HOSTED=true para producir el output
 * standalone). Se adoptan tal cual; nada se inventa.
 */
function composeBuildArgs(cwd: string, dockerfileRelative: string): Record<string, string> | undefined {
  const normalizedTarget = dockerfileRelative.replace(/\\/g, "/").replace(/^\.\//, "");
  for (const composeName of ["compose.yml", "compose.yaml", "docker-compose.yml", "docker-compose.yaml"]) {
    const composePath = join(cwd, composeName);
    if (!existsSync(composePath)) continue;
    let parsed: unknown;
    try {
      parsed = parseYaml(readFileSync(composePath, "utf-8"));
    } catch {
      continue;
    }
    const services =
      typeof parsed === "object" && parsed !== null
        ? (parsed as { services?: Record<string, unknown> }).services
        : undefined;
    if (services === undefined || typeof services !== "object") continue;
    for (const entry of Object.values(services)) {
      if (typeof entry !== "object" || entry === null) continue;
      const build = (entry as { build?: unknown }).build;
      if (typeof build !== "object" || build === null) continue;
      const { dockerfile, args } = build as { dockerfile?: unknown; args?: unknown };
      if (typeof dockerfile !== "string") continue;
      if (dockerfile.replace(/\\/g, "/").replace(/^\.\//, "") !== normalizedTarget) continue;

      const collected: Record<string, string> = {};
      if (Array.isArray(args)) {
        for (const item of args) {
          if (typeof item !== "string") continue;
          const separator = item.indexOf("=");
          if (separator > 0) {
            collected[item.slice(0, separator)] = item.slice(separator + 1);
          }
        }
      } else if (typeof args === "object" && args !== null) {
        for (const [key, value] of Object.entries(args as Record<string, unknown>)) {
          if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
            collected[key] = String(value);
          }
        }
      }
      return Object.keys(collected).length > 0 ? collected : undefined;
    }
  }
  return undefined;
}

/** Targets --schema desde la evidencia del detector prisma. */
function prismaTargets(detected: InitResult["detected"]): string[] {
  const prisma = detected.find((result) => result.kind === "prisma");
  if (prisma === undefined) return [];
  return prisma.evidence
    .map((evidence) => evidence.replace(/\\/g, "/"))
    .filter((evidence) => evidence.endsWith("schema.prisma") || evidence.endsWith("schema/"))
    .map((evidence) => evidence.replace(/\/+$/, ""));
}

/** El schema que el executor NO resolvería por convención para `path`. */
function explicitPrismaSchema(targets: string[], servicePath: string): string | undefined {
  if (targets.length === 0) return undefined;
  const conventional = new Set(
    servicePath === "."
      ? ["prisma/schema.prisma", "prisma/schema"]
      : [
          `${servicePath}/prisma/schema.prisma`,
          `${servicePath}/prisma/schema`,
          "prisma/schema.prisma",
          "prisma/schema",
        ],
  );
  if (targets.some((target) => conventional.has(target))) return undefined;
  // Preferir un schema dentro del servicio (peppermint: apps/api/src/prisma/…),
  // después el único global (rallly: packages/database/prisma/…).
  const underService = targets.filter((target) => target.startsWith(`${servicePath}/`));
  return underService[0] ?? [...targets].sort()[0];
}

function serviceName(path: string, used: Set<string>): string {
  const candidate = basename(path).replace(/[^a-zA-Z0-9_]/g, "_");
  const base = path === "." ? "api" : candidate === "" ? "service" : candidate;
  let name = base;
  let suffix = 2;
  while (used.has(name)) {
    name = `${base}_${suffix}`;
    suffix += 1;
  }
  used.add(name);
  return name;
}

function serviceKind(cwd: string, servicePath: string): "nextjs" | "node" {
  const packagePath = join(cwd, servicePath, "package.json");
  if (!existsSync(packagePath)) return "node";
  try {
    const pkg = JSON.parse(readFileSync(packagePath, "utf-8").replace(/^\uFEFF/, "")) as {
      dependencies?: Record<string, unknown>;
      devDependencies?: Record<string, unknown>;
      scripts?: Record<string, unknown>;
    };
    const hasNextDependency =
      Object.hasOwn(pkg.dependencies ?? {}, "next") ||
      Object.hasOwn(pkg.devDependencies ?? {}, "next");
    const hasNextScript = Object.values(pkg.scripts ?? {}).some(
      (script) => typeof script === "string" && /(^|\s)next(?:\s|$)/.test(script),
    );
    return hasNextDependency || hasNextScript ? "nextjs" : "node";
  } catch {
    return "node";
  }
}

export interface ServiceDetection {
  services: DetectedService[];
  excluded: ExcludedServiceCandidate[];
}

export function detectServices(
  cwd: string,
  detected: InitResult["detected"],
): ServiceDetection {
  const targets = prismaTargets(detected);
  // Los `output` declarados por los generators de los schemas FUENTE marcan
  // qué subárboles son código generado (aunque no usen nombres obvios).
  const generatorOutputs = targets
    .filter((target) => target.endsWith("schema.prisma"))
    .flatMap((target) => prismaGeneratorOutputs(cwd, join(cwd, target)));
  const used = new Set<string>();
  const excluded: ExcludedServiceCandidate[] = [];
  const services: DetectedService[] = [];

  // Sub-servicios construibles: package.json + Dockerfile propio.
  for (const path of packageDirectories(cwd, generatorOutputs, excluded)) {
    const name = basename(path).replace(/[^a-zA-Z0-9_]/g, "_") || "service";
    const dockerfile = serviceDockerfile(cwd, path, name);
    if (dockerfile === undefined) continue;
    const schema = explicitPrismaSchema(targets, path);
    const dockerfileRelative = dockerfile.standard ? `${path}/Dockerfile` : dockerfile.dockerfile;
    const buildArgs = composeBuildArgs(cwd, dockerfileRelative);
    services.push({
      name: serviceName(path, used),
      path,
      kind: serviceKind(cwd, path),
      ...(dockerfile.standard ? {} : { dockerfile: dockerfile.dockerfile }),
      ...(schema === undefined ? {} : { prismaSchema: schema }),
      ...(buildArgs === undefined ? {} : { buildArgs }),
    });
  }
  if (services.length > 0) return { services, excluded };

  // Sin sub-servicios: la raíz como único servicio si es construible.
  if (existsSync(join(cwd, "package.json"))) {
    const rootDockerfile = serviceDockerfile(cwd, ".", "api");
    const schema = explicitPrismaSchema(targets, ".");
    if (rootDockerfile !== undefined) {
      const dockerfileRelative = rootDockerfile.standard ? "Dockerfile" : rootDockerfile.dockerfile;
      const buildArgs = composeBuildArgs(cwd, dockerfileRelative);
      return {
        services: [
          {
            name: serviceName(".", used),
            path: ".",
            kind: serviceKind(cwd, "."),
            ...(rootDockerfile.standard ? {} : { dockerfile: rootDockerfile.dockerfile }),
            ...(schema === undefined ? {} : { prismaSchema: schema }),
            ...(buildArgs === undefined ? {} : { buildArgs }),
          },
        ],
        excluded,
      };
    }
  }

  // Último recurso: derivar del schema Prisma (comportamiento previo).
  // doctor va a señalar el Dockerfile faltante. La evidencia Prisma ya viene
  // filtrada de copias generadas, así que ningún output (ej. src/generated)
  // puede volver a colarse como servicio por esta vía.
  const fallbackPaths = [
    ...new Set(
      targets.map((target) => {
        const marker = target.lastIndexOf("/prisma/");
        return marker < 0 ? "." : target.slice(0, marker) || ".";
      }),
    ),
  ];
  return {
    services: (fallbackPaths.length > 0 ? fallbackPaths : ["."]).map((path) => ({
      name: serviceName(path, used),
      path,
      kind: serviceKind(cwd, path),
    })),
    excluded,
  };
}

// ------------------------------------------------------------------- workload

function detectedWorkload(cwd: string): { command: string; args: string[] } | undefined {
  const packagePath = join(cwd, "package.json");
  if (!existsSync(packagePath)) return undefined;
  try {
    const pkg = JSON.parse(readFileSync(packagePath, "utf-8").replace(/^\uFEFF/, "")) as {
      scripts?: Record<string, string>;
    };
    const script = ["test:e2e", "e2e"].find((name) => pkg.scripts?.[name] !== undefined);
    if (script === undefined) return undefined;
    const command = existsSync(join(cwd, "pnpm-lock.yaml"))
      ? "pnpm"
      : existsSync(join(cwd, "yarn.lock"))
        ? "yarn"
        : existsSync(join(cwd, "bun.lockb")) || existsSync(join(cwd, "bun.lock"))
          ? "bun"
          : "npm";
    return { command, args: ["run", script] };
  } catch {
    return undefined;
  }
}

// ------------------------------------------------------------------- template

function renderService(service: DetectedService): string {
  const fields = [
    `kind: ${JSON.stringify(service.kind)}`,
    `path: ${JSON.stringify(service.path)}`,
    ...(service.dockerfile === undefined
      ? []
      : [`dockerfile: ${JSON.stringify(service.dockerfile)}`]),
    ...(service.prismaSchema === undefined
      ? []
      : [`prismaSchema: ${JSON.stringify(service.prismaSchema)}`]),
    ...(service.buildArgs === undefined
      ? []
      : [`buildArgs: ${JSON.stringify(service.buildArgs)}`]),
  ];
  return `    ${JSON.stringify(service.name)}: { ${fields.join(", ")} },`;
}

function buildJsonConfig(
  detected: InitResult["detected"],
  services: DetectedService[],
  setup: WorkloadSetup,
): Record<string, unknown> {
  return {
    services: Object.fromEntries(
      services.map((service) => [
        service.name,
        {
          kind: service.kind,
          path: service.path,
          ...(service.dockerfile === undefined ? {} : { dockerfile: service.dockerfile }),
          ...(service.prismaSchema === undefined
            ? {}
            : { prismaSchema: service.prismaSchema }),
          ...(service.buildArgs === undefined ? {} : { buildArgs: service.buildArgs }),
        },
      ]),
    ),
    data: detected.some((result) => result.kind === "postgres")
      ? { postgres: { kind: "postgres", version: 16 } }
      : {},
    flows: [],
    release: { strategy: "migration-first", rollback: "application" },
    policies: ["no-destructive-migrations"],
    ...(setup.workload === undefined ? {} : { workload: setup.workload }),
    ...(setup.coverage === undefined ? {} : { coverage: setup.coverage }),
    ...(setup.fixtures === undefined ? {} : { fixtures: setup.fixtures }),
    approvals: [],
  };
}

function buildConfigTemplate(
  detected: InitResult["detected"],
  services: DetectedService[],
  setup: WorkloadSetup,
): string {
  const detectedKinds = detected.map((result) => result.kind);
  const hasPostgres = detectedKinds.includes("postgres");
  const renderedServices = services.map(renderService).join("\n");

  const workloadBlock =
    setup.workload === undefined
      ? "  // Declarar workload antes de verificar; sin tráfico Proof será INCONCLUSIVE.\n"
      : `  workload: ${JSON.stringify(setup.workload)},\n`;
  const coverageBlock =
    setup.coverage === undefined
      ? "  // Declarar todas las rutas obligatorias. Sin este universo Proof será INCONCLUSIVE.\n  // coverage: { requiredRoutes: [\"POST /payments\", \"GET /payments\"] },\n"
      : `  coverage: ${JSON.stringify(setup.coverage, null, 2).split("\n").join("\n  ")},\n`;

  return `// Generado por "proof init". Es un objeto plano para que el repo no
// necesite instalar @proof/config. Ver tesis, secciones 5.1 y 15.2.
export default {
  services: {
${renderedServices}
  },
  data: {${hasPostgres ? '\n    postgres: { kind: "postgres", version: 16 },' : ""}
  },
  flows: [],
  release: { strategy: "migration-first", rollback: "application" },
  policies: ["no-destructive-migrations"],
${workloadBlock}${coverageBlock}${
    setup.fixtures === undefined
      ? "  // Si la API exige identidad, prepará usuario/token vía HTTP acá; sin\n  // registro público, sembrá la identidad con bootstrapSql (se aplica tras\n  // las migraciones, antes del workload, y su digest queda en el Bundle):\n  // fixtures: { beforeAll: { command: \"node\", args: [\"proof.fixtures.mjs\"] }, bootstrapSql: \"proof.seed.sql\" },\n"
      : `  fixtures: ${JSON.stringify(setup.fixtures)},\n`
  }  // proof doctor clasifica las variables de .env.example por uso real del
  // código; si sabe más que la heurística, declaralo:
  // env: { required: ["DATABASE_URL"], optional: ["ARCA_API_KEY"] },
  approvals: [],
};
`;
}

// ------------------------------------------------------------------ .gitignore

/**
 * `.proof/` contiene evidencia local (bundles, claves de firma), nunca
 * configuración: no debe versionarse (informe Lubrisur: el bundle quedó como
 * archivo sin trackear). Idempotente por dos vías: si el engine de Git ya lo
 * ignora (regla local, global o anidada) no se toca nada; si no, se agrega
 * una única línea `.proof/` al .gitignore de la raíz.
 */
export function ensureProofIgnored(
  cwd: string,
  gitignorePath: string,
): "created" | "updated" | "unchanged" {
  const probe = spawnSync("git", ["check-ignore", "-q", ".proof/probe"], {
    cwd,
    encoding: "utf-8",
    windowsHide: true,
  });
  if (probe.status === 0) return "unchanged";

  const managedBlock = "# Evidencia local de Proof (proof release verify)\n.proof/\n";
  if (!existsSync(gitignorePath)) {
    writeFileSync(gitignorePath, managedBlock, "utf-8");
    return "created";
  }
  const current = readFileSync(gitignorePath, "utf-8");
  // Cobertura sin git instalado: una línea equivalente ya presente alcanza.
  const alreadyListed = current
    .split(/\r?\n/)
    .some((line) => /^\/?\.proof\/?$/.test(line.trim()));
  if (alreadyListed) return "unchanged";
  writeFileSync(gitignorePath, `${current.replace(/\n*$/, "\n\n")}${managedBlock}`, "utf-8");
  return "updated";
}

// ------------------------------------------------------------------ AGENTS.md

const AGENTS_BEGIN = "<!-- proof:agents:begin -->";
const AGENTS_END = "<!-- proof:agents:end -->";

/**
 * Contenido del bloque gestionado de AGENTS.md. En inglés porque es la
 * convención del formato y su consumidor primario es un agente de IA
 * (tesis 8.1: el agente es quien consume la evidencia al momento de
 * ejecutar). Determinista: mismo repo detectado → mismo bloque.
 */
export function buildAgentsBlock(services: DetectedService[]): string {
  const serviceFlag =
    services.length > 1
      ? " In this monorepo also pass `--service <name>` from the Proof config."
      : "";
  return `${AGENTS_BEGIN}
## Proof — release evidence (mandatory for agents)

Proof is the external evidence gate for this repository. Static reasoning and
ordinary tests are useful, but neither is permission to claim release safety.

Before declaring a code, dependency, runtime, build, CI, schema, or migration
change complete, run the bounded fast path:

\`\`\`sh
proof release plan --base-sha <deployed-sha> --head-sha <candidate-sha>
\`\`\`

or call \`proof_release_plan\` over MCP. A plan always returns
\`PLAN_ONLY_NOT_VERIFIED\`; it can route work but can never prove safety. Follow
its typed \`nextCommand\`. When execution is required, run
\`proof release verify\` (or \`proof_release_verify\`) and cite the resulting
Bundle.${serviceFlag}

While iterating on UNCOMMITTED local changes, run
\`proof release verify --worktree --base-sha <deployed-sha>\` (trusted profile
only): Proof freezes the working tree into an immutable snapshot commit and
verifies that exact content. Use it to iterate; a merge/release gate still
requires verifying a pushed commit.

For untrusted forks use \`--profile fork\` on a secretless isolated runner and
keep \`PROOF_EXECUTION_PROFILE_LOCKED=fork\`. Never downgrade a locked profile.
Fork/internal profiles consume \`proof.config.json\` as data; executable config
from the candidate is rejected. If the selected profile rejects a host workload,
report the blocker and do not substitute trust for missing evidence.

Interpret \`conclusion\` as a typed enum:

- \`VERIFIED\`: every mandatory state ran with complete declared coverage. A
  local v1 receipt only supports the current trusted session; a merge/trust
  gate must require v2, freshness, content-verified evidence and trusted signatures.
- \`UNSAFE\`: do not declare done or merge. Apply deterministic remediation,
  then re-run. Agents must never create their own approval.
- \`INCONCLUSIVE\`: not safe. Execute every typed \`nextAction\` and re-run.

The full gate covers A0/A1 × S0/S1, two rolling schedules, SQL effects, and A0
rollback after A1 writes. Reproduce a finding with
\`proof reproduce <assertion-id>\`. Workloads must use \`PROOF_BASE_URL\`.
Never edit \`.proof/\`; it contains evidence, not configuration.
${AGENTS_END}`;
}

/**
 * Crea AGENTS.md, reemplaza el bloque gestionado si ya existe, o lo agrega
 * al final si el archivo existe sin markers. Idempotente por contenido.
 */
function syncAgentsFile(
  agentsPath: string,
  services: DetectedService[],
): "created" | "updated" | "unchanged" {
  const block = buildAgentsBlock(services);
  if (!existsSync(agentsPath)) {
    writeFileSync(agentsPath, `${block}\n`, "utf-8");
    return "created";
  }
  const current = readFileSync(agentsPath, "utf-8");
  const begin = current.indexOf(AGENTS_BEGIN);
  const end = current.indexOf(AGENTS_END);
  const next =
    begin >= 0 && end > begin
      ? current.slice(0, begin) + block + current.slice(end + AGENTS_END.length)
      : `${current.replace(/\n*$/, "\n\n")}${block}\n`;
  if (next === current) return "unchanged";
  writeFileSync(agentsPath, next, "utf-8");
  return "updated";
}

function printHuman(result: InitResult): void {
  process.stdout.write(
    `${symbols.ok} Detected: ${paint.bold(result.detected.map((d) => d.kind).join(", ") || "(nada — revisá manualmente)")}\n`,
  );
  process.stdout.write(
    `${symbols.ok} Services: ${
      result.services
        .map(
          (service) =>
            `${paint.bold(service.name)} ${paint.dim(`(${service.path}${service.dockerfile === undefined ? "" : `, dockerfile: ${service.dockerfile}`})`)}`,
        )
        .join(", ") || "(ninguno)"
    }\n`,
  );
  for (const candidate of result.excluded) {
    process.stdout.write(
      `${symbols.dot} ${paint.dim(`Descartado como servicio: ${candidate.path} — ${candidate.reason}.`)}\n`,
    );
  }
  process.stdout.write(
    result.configWritten
      ? `${symbols.ok} Generated: ${result.configPath}\n`
      : `${symbols.dot} ${paint.dim(`${result.configPath} ya existe, no se sobrescribió.`)}\n`,
  );
  if (result.jsonConfigPath !== undefined) {
    process.stdout.write(
      result.jsonConfigWritten === true
        ? `${symbols.ok} Generated: ${result.jsonConfigPath} ${paint.dim("(config data-only para internal/fork)")}\n`
        : `${symbols.dot} ${paint.dim(`${result.jsonConfigPath} no se modificó.`)}\n`,
    );
  }
  process.stdout.write(
    result.agentsResult === "created"
      ? `${symbols.ok} Generated: ${result.agentsPath} ${paint.dim("(instrucciones para agentes de IA)")}\n`
      : result.agentsResult === "updated"
        ? `${symbols.ok} Updated: ${result.agentsPath} ${paint.dim("(bloque gestionado de Proof)")}\n`
        : `${symbols.dot} ${paint.dim(`${result.agentsPath} ya está al día.`)}\n`,
  );
  process.stdout.write(
    result.gitignoreResult === "created"
      ? `${symbols.ok} Generated: ${result.gitignorePath} ${paint.dim("(.proof/ es evidencia local, nunca se versiona)")}\n`
      : result.gitignoreResult === "updated"
        ? `${symbols.ok} Updated: ${result.gitignorePath} ${paint.dim("(agregado .proof/)")}\n`
        : `${symbols.dot} ${paint.dim(".proof/ ya está ignorado por Git.")}\n`,
  );
  if (result.workloadGenerated !== undefined) {
    const generated = result.workloadGenerated;
    process.stdout.write(
      `${symbols.ok} Generated: ${generated.scriptPath} ${paint.dim(
        `(workload desde ${generated.specPath}: ${generated.steps} paso(s), ${generated.routes} ruta(s) en coverage)`,
      )}\n`,
    );
    for (const gap of generated.gaps) {
      process.stdout.write(`  ${symbols.warn} ${paint.yellow(gap)}\n`);
    }
  }
  if (result.authFixturesGenerated !== undefined) {
    const fixtures = result.authFixturesGenerated;
    process.stdout.write(
      `${symbols.ok} Generated: ${fixtures.scriptPath} ${paint.dim(
        `(identidad HTTP: ${fixtures.registerPath === undefined ? "" : `${fixtures.registerPath} → `}${fixtures.loginPath}, token en "${fixtures.tokenProperty}")`,
      )}\n`,
    );
    for (const gap of fixtures.gaps) {
      process.stdout.write(`  ${symbols.warn} ${paint.yellow(gap)}\n`);
    }
  }
  process.stdout.write(`\nNext: ${paint.cyan("proof doctor")}\n`);
}
