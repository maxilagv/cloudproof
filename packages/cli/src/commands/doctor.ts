import { existsSync, readFileSync, readdirSync, statfsSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { createConnection } from "node:net";
import { spawnSync } from "node:child_process";
import semver from "semver";
import { loadConfig, type ProjectConfig } from "@proof/config";
import { isPrismaSchemaTarget, preflightImageRuntime } from "@proof/docker-executor";
import { classifyEnvKeys } from "./env-classifier.js";
import { countAuthOperations } from "./auth-fixtures.js";
import { findOpenApiSpec } from "./openapi-workload.js";
import { paint, severityLabel, symbols } from "../ui.js";

export type Severity = "CRITICAL" | "HIGH" | "MEDIUM" | "LOW";

export interface DoctorFinding {
  severity: Severity;
  message: string;
}

export interface DoctorOptions {
  json?: boolean;
  cwd?: string;
  /** Inyección para tests; la CLI siempre conserva el default true. */
  systemChecks?: boolean;
}

/** HIGH/CRITICAL findings mean the repository is not ready for verification. */
export function doctorExitCode(findings: DoctorFinding[]): 0 | 1 {
  return findings.some(
    (finding) => finding.severity === "CRITICAL" || finding.severity === "HIGH",
  )
    ? 1
    : 0;
}

function commandAvailable(command: string): boolean {
  const lookup = process.platform === "win32" ? "where.exe" : "which";
  const result = spawnSync(lookup, [command], { encoding: "utf-8", windowsHide: true });
  return result.status === 0;
}

function checkRuntime(command: string, args: string[], label: string): DoctorFinding[] {
  if (!commandAvailable(command)) {
    return [{ severity: "CRITICAL", message: `${label} no está instalado o no está en PATH.` }];
  }
  const result = spawnSync(command, args, {
    encoding: "utf-8",
    timeout: 30_000,
    windowsHide: true,
  });
  if (result.status !== 0) {
    return [
      {
        severity: "CRITICAL",
        message: `${label} está instalado pero no responde correctamente: ${String(result.stderr).trim().slice(-500)}`,
      },
    ];
  }
  return [];
}

/** Config cargable o undefined; los errores de carga los reporta checkProject. */
async function tryLoadConfig(cwd: string): Promise<ProjectConfig | undefined> {
  try {
    return await loadConfig(cwd);
  } catch {
    return undefined;
  }
}

export async function runDoctor(options: DoctorOptions = {}): Promise<DoctorFinding[]> {
  const cwd = resolve(options.cwd ?? process.cwd());
  const config = await tryLoadConfig(cwd);
  const findings: DoctorFinding[] = [
    ...checkNodeVersion(cwd),
    ...(await checkEnvDrift(cwd, config)),
    ...checkProofDirIgnored(cwd),
    ...(options.systemChecks === false
      ? []
      : [
          ...checkRuntime("git", ["--version"], "Git"),
          ...checkRuntime("docker", ["info"], "Docker daemon"),
          ...checkDiskSpace(cwd),
          ...checkGitHistory(cwd),
          ...checkTrackedSecrets(cwd),
        ]),
    ...(await checkProject(cwd)),
    ...checkImageRuntime(cwd, config),
    ...checkAuthFixtures(cwd, config),
    ...(options.systemChecks === false ? [] : await checkServicePorts(cwd)),
  ];

  if (options.json) {
    process.stdout.write(JSON.stringify({ version: "1", findings }, null, 2) + "\n");
  } else {
    printHuman(findings);
  }
  return findings;
}

function checkNodeVersion(cwd: string): DoctorFinding[] {
  const packageJsonPath = join(cwd, "package.json");
  if (!existsSync(packageJsonPath)) return [];
  let pkg: { engines?: { node?: string } };
  try {
    // El replace tolera el BOM que dejan varios editores de Windows.
    pkg = JSON.parse(readFileSync(packageJsonPath, "utf-8").replace(/^\uFEFF/, "")) as typeof pkg;
  } catch {
    return [{ severity: "HIGH", message: "package.json no contiene JSON válido." }];
  }
  const requiredRange = pkg.engines?.node;
  if (requiredRange === undefined) return [];
  if (semver.validRange(requiredRange) === null) {
    return [
      { severity: "MEDIUM", message: `engines.node "${requiredRange}" no es un rango semver válido.` },
    ];
  }
  if (!semver.satisfies(process.versions.node, requiredRange, { includePrerelease: true })) {
    return [
      {
        severity: "HIGH",
        message: `Node local es v${process.versions.node}, fuera de engines.node "${requiredRange}".`,
      },
    ];
  }
  return [];
}

const ENV_SURFACE_SKIP = new Set([
  ".git",
  ".proof",
  ".next",
  ".turbo",
  "node_modules",
  "dist",
  "build",
  "coverage",
]);

function environmentReferenceFiles(cwd: string, roots: string[]): string[] {
  const files: string[] = [];
  const visited = new Set<string>();
  const visit = (directory: string): void => {
    if (files.length >= 2_000 || visited.has(directory)) return;
    visited.add(directory);
    try {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        if (files.length >= 2_000) break;
        if (entry.isDirectory()) {
          if (!ENV_SURFACE_SKIP.has(entry.name)) visit(join(directory, entry.name));
          continue;
        }
        if (
          entry.isFile() &&
          (/^(?:Dockerfile(?:\..+)?|compose(?:\..+)?\.ya?ml|prisma\.config\.[cm]?[jt]s)$/i.test(entry.name) ||
            /\.(?:prisma|ya?ml)$/i.test(entry.name))
        ) {
          files.push(join(directory, entry.name));
        }
      }
    } catch {
      // Optional/unreadable directories do not create an env requirement.
    }
  };
  for (const root of roots) {
    const absolute = resolve(cwd, root);
    if (insideProject(cwd, absolute)) visit(absolute);
  }
  return [...new Set(files)];
}

function referencedEnvironmentNames(files: string[], candidates: Set<string>): Set<string> {
  const referenced = new Set<string>();
  for (const file of files) {
    let contents: string;
    try {
      contents = readFileSync(file, "utf-8");
    } catch {
      continue;
    }
    if (Buffer.byteLength(contents, "utf8") > 512 * 1024) continue;
    for (const name of candidates) {
      if (referenced.has(name)) continue;
      const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      if (new RegExp(`(?:env\\(["']${escaped}["']\\)|\\$\\{${escaped}(?::-[^}]*)?\\}|\\b${escaped}\\b)`).test(contents)) {
        referenced.add(name);
      }
    }
  }
  return referenced;
}

function checkEnvDrift(
  cwd: string,
  config?: ProjectConfig,
): DoctorFinding[] {
  const examplePath = join(cwd, ".env.example");
  const envPath = join(cwd, ".env");
  if (!existsSync(examplePath)) return [];
  const declaredKeys = parseEnvKeys(readFileSync(examplePath, "utf-8"));
  const fileKeys = existsSync(envPath)
    ? parseEnvKeys(readFileSync(envPath, "utf-8"))
    : new Set<string>();
  const configuredKeys = new Set(
    config === undefined
      ? []
      : Object.values(config.services).flatMap((service) => [
          ...Object.keys(service.env ?? {}),
          ...Object.keys(service.buildArgs ?? {}),
        ]),
  );
  const missing = [...declaredKeys].filter(
    (key) =>
      !fileKeys.has(key) && !configuredKeys.has(key) && process.env[key] === undefined,
  );
  if (missing.length === 0) return [];

  const inferred = classifyEnvKeys(cwd, new Set(missing));
  const requiredOverride = new Set(config?.env?.required ?? []);
  const optionalOverride = new Set(config?.env?.optional ?? []);
  // Tercera señal: referencias fuera del código JS/TS (Dockerfile, compose,
  // prisma env("...")). Cubre DATABASE_URL-solo-en-schema y similares, donde
  // no existe una lectura process.env que clasificar.
  const surfaceOnly = referencedEnvironmentNames(
    environmentReferenceFiles(
      cwd,
      config === undefined ? ["."] : Object.values(config.services).map((service) => service.path),
    ),
    new Set(missing.filter((name) => inferred.get(name)?.usage === "unreferenced")),
  );
  const relevant = missing.filter(
    (name) =>
      requiredOverride.has(name) ||
      (!optionalOverride.has(name) &&
        (inferred.get(name)?.usage === "required" || surfaceOnly.has(name))),
  );
  const conditional = missing.filter(
    (name) =>
      optionalOverride.has(name) ||
      (!requiredOverride.has(name) && inferred.get(name)?.usage === "conditional"),
  );
  const unrelated = missing.filter(
    (name) => !relevant.includes(name) && !conditional.includes(name),
  );
  const findings: DoctorFinding[] = [];
  if (relevant.length > 0) {
    const shown = relevant.slice(0, 10).join(", ");
    const extra = relevant.length > 10 ? ` (+${relevant.length - 10} más)` : "";
    findings.push({
      severity: "MEDIUM",
      message:
        `${relevant.length} variable(s) ausentes son requeridas por lecturas sin fallback en la superficie verificada: ` +
        `${shown}${extra}. Evidencia: ${relevant.flatMap((name) => inferred.get(name)?.evidence ?? []).slice(0, 5).join(", ") || "override proof.config"}.`,
    });
  }
  if (conditional.length > 0) {
    findings.push({
      severity: "LOW",
      message:
        `${conditional.length} variable(s) ausentes solo aparecen en rutas condicionales/con fallback; ` +
        `no bloquean esta corrida: ${conditional.slice(0, 5).join(", ")}${conditional.length > 5 ? ` (+${conditional.length - 5} más)` : ""}.`,
    });
  }
  if (unrelated.length > 0) {
    findings.push({
      severity: "LOW",
      message:
        `${unrelated.length} variable(s) de .env.example están ausentes pero no aparecen en la superficie ` +
        "config/runtime/workload verificada; se omite la lista para evitar ruido.",
    });
  }
  return findings;
}

function insideProject(cwd: string, path: string): boolean {
  const absolute = resolve(cwd, path);
  const rel = relative(cwd, absolute);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function checkProofDirIgnored(cwd: string): DoctorFinding[] {
  const repository = spawnSync("git", ["rev-parse", "--is-inside-work-tree"], {
    cwd,
    encoding: "utf-8",
    windowsHide: true,
  });
  if (repository.status !== 0) return [];
  // Peor caso primero: evidencia YA versionada — un bundle en la historia de
  // Git no es un problema estético, es evidencia local publicada como código.
  const tracked = spawnSync("git", ["ls-files", "--", ".proof"], {
    cwd,
    encoding: "utf-8",
    windowsHide: true,
  });
  const trackedFiles =
    tracked.status === 0
      ? tracked.stdout
          .split("\n")
          .map((line) => line.trim())
          .filter(Boolean)
      : [];
  if (trackedFiles.length > 0) {
    return [
      {
        severity: "HIGH",
        message:
          `Hay evidencia de .proof/ versionada en Git (${trackedFiles.length} archivo(s), ej. ${trackedFiles[0]}). ` +
          "Sacala del índice con `git rm -r --cached .proof`, corré `proof init` para agregar .proof/ a " +
          ".gitignore y revisá el historial antes de publicar.",
      },
    ];
  }
  if (!existsSync(join(cwd, ".proof"))) return [];
  const ignored = spawnSync("git", ["check-ignore", "-q", ".proof/probe"], {
    cwd,
    encoding: "utf-8",
    windowsHide: true,
  });
  if (ignored.status === 0) return [];
  return [
    {
      severity: "LOW",
      message:
        ".proof/ no está ignorado por Git; contiene evidencia local y snapshots que no deben versionarse. " +
        "Corré `proof init` (agrega .proof/ a .gitignore) o agregalo a mano.",
    },
  ];
}

function resolvedDockerfile(
  cwd: string,
  service: ProjectConfig["services"][string],
): string | undefined {
  const candidates = service.dockerfile === undefined
    ? [join(service.path, "Dockerfile"), "Dockerfile"]
    : [service.dockerfile];
  return candidates
    .map((candidate) => resolve(cwd, candidate))
    .find((candidate) => insideProject(cwd, candidate) && existsSync(candidate));
}

function serviceUsesPrisma(
  cwd: string,
  service: ProjectConfig["services"][string],
): boolean {
  const candidates = service.prismaSchema === undefined
    ? [join(service.path, "prisma", "schema.prisma"), join(service.path, "prisma", "schema"), "prisma/schema.prisma", "prisma/schema"]
    : [service.prismaSchema];
  return candidates.some((candidate) => isPrismaSchemaTarget(resolve(cwd, candidate)));
}

function checkImageRuntime(
  cwd: string,
  config?: ProjectConfig,
): DoctorFinding[] {
  if (config === undefined) return [];
  const findings: DoctorFinding[] = [];
  for (const [name, service] of Object.entries(config.services)) {
    const dockerfile = resolvedDockerfile(cwd, service);
    if (dockerfile === undefined) continue;
    let dockerfileContents: string;
    try {
      dockerfileContents = readFileSync(dockerfile, "utf-8");
    } catch {
      continue;
    }
    for (const finding of preflightImageRuntime({
      dockerfileContents,
      usesPrisma: serviceUsesPrisma(cwd, service),
    })) {
      findings.push({
        severity: finding.severity,
        message: `Servicio "${name}": ${finding.message} Evidencia: ${finding.evidence.join(", ")}.`,
      });
    }
  }
  return findings;
}

function checkAuthFixtures(
  cwd: string,
  config?: ProjectConfig,
): DoctorFinding[] {
  if (config === undefined || config.fixtures?.beforeAll !== undefined) return [];
  const spec = findOpenApiSpec(cwd);
  if (spec === undefined) return [];
  const authOperations = countAuthOperations(spec.document);
  return authOperations === 0
    ? []
    : [
        {
          severity: "MEDIUM",
          message:
            `${authOperations} operación(es) OpenAPI requieren autenticación pero no se declaró fixtures.beforeAll; ` +
            "el workload puede quedarse fuera de los flujos de negocio protegidos. " +
            "Sin registro público, sembrá la identidad con fixtures.bootstrapSql y obtené el token vía login HTTP en fixtures.beforeAll.",
        },
      ];
}

function serviceFindings(cwd: string, config: ProjectConfig): DoctorFinding[] {
  const findings: DoctorFinding[] = [];
  const entries = Object.entries(config.services);
  if (entries.length === 0) {
    return [{ severity: "CRITICAL", message: "proof.config.ts no declara ningún servicio." }];
  }
  if (entries.length > 1) {
    findings.push({
      severity: "LOW",
      message: "Hay varios servicios; release verify debe ejecutarse con --service <nombre>.",
    });
  }
  for (const [name, service] of entries) {
    if (!insideProject(cwd, service.path)) {
      findings.push({
        severity: "CRITICAL",
        message: `services.${name}.path sale de la raíz del repositorio: ${service.path}`,
      });
      continue;
    }
    findings.push(...dockerfileFindings(cwd, name, service));
    findings.push(...prismaFindings(cwd, name, service));
  }
  return findings;
}

function dockerfileFindings(
  cwd: string,
  name: string,
  service: ProjectConfig["services"][string],
): DoctorFinding[] {
  if (service.dockerfile !== undefined) {
    if (!insideProject(cwd, service.dockerfile) || !existsSync(resolve(cwd, service.dockerfile))) {
      return [
        {
          severity: "HIGH",
          message: `Servicio "${name}": services.${name}.dockerfile no existe: ${service.dockerfile}`,
        },
      ];
    }
    return [];
  }
  const serviceRoot = resolve(cwd, service.path);
  if (existsSync(join(serviceRoot, "Dockerfile")) || existsSync(join(cwd, "Dockerfile"))) {
    return [];
  }
  const candidates = dockerfileCandidates(cwd, service.path);
  return [
    {
      severity: "HIGH",
      message:
        `Servicio "${name}": falta Dockerfile en ${service.path} y en la raíz.` +
        (candidates.length === 0
          ? ""
          : ` Encontré ${candidates.join(", ")}; si corresponde, declaralo en services.${name}.dockerfile.`),
    },
  ];
}

/** Dockerfiles con nombre custom cerca del servicio, para sugerirlos. */
function dockerfileCandidates(cwd: string, servicePath: string): string[] {
  const searchDirectories =
    servicePath === "." ? [".", "docker"] : [servicePath, `${servicePath}/docker`, "docker"];
  const found: string[] = [];
  for (const directory of searchDirectories) {
    const absolute = resolve(cwd, directory);
    if (!existsSync(absolute)) continue;
    let entries: string[];
    try {
      entries = readdirSync(absolute);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (/^dockerfile([._-].+)?$/i.test(entry) || /\.dockerfile$/i.test(entry)) {
        found.push(directory === "." ? entry : `${directory}/${entry}`);
      }
    }
  }
  return [...new Set(found)].sort();
}

function prismaFindings(
  cwd: string,
  name: string,
  service: ProjectConfig["services"][string],
): DoctorFinding[] {
  const candidates =
    service.prismaSchema !== undefined
      ? [service.prismaSchema]
      : service.path === "."
        ? ["prisma/schema.prisma", "prisma/schema"]
        : [
            `${service.path}/prisma/schema.prisma`,
            `${service.path}/prisma/schema`,
            "prisma/schema.prisma",
            "prisma/schema",
          ];
  const resolved = candidates.some(
    (candidate) => insideProject(cwd, candidate) && isPrismaSchemaTarget(resolve(cwd, candidate)),
  );
  if (resolved) return [];
  return [
    {
      severity: "HIGH",
      message: `Servicio "${name}": no se encontró schema Prisma en ${candidates.join(" ni ")} (acepta schema.prisma o carpeta multi-archivo).`,
    },
  ];
}

async function checkProject(cwd: string): Promise<DoctorFinding[]> {
  try {
    const config = await loadConfig(cwd);
    const findings = serviceFindings(cwd, config);
    if (!Object.values(config.data).some((source) => source.kind === "postgres")) {
      findings.push({
        severity: "HIGH",
        message: "No se declaró una fuente PostgreSQL; release verify de Fase 1 no puede ejecutarse.",
      });
    }
    if (config.workload === undefined) {
      findings.push({
        severity: "HIGH",
        message: "No se declaró workload; release verify siempre será INCONCLUSIVE.",
      });
    } else if (!commandAvailable(config.workload.command)) {
      findings.push({
        severity: "HIGH",
        message: `El comando del workload "${config.workload.command}" no está disponible en PATH.`,
      });
    }
    if (
      config.fixtures?.beforeAll !== undefined &&
      !commandAvailable(config.fixtures.beforeAll.command)
    ) {
      findings.push({
        severity: "HIGH",
        message: `El comando de fixtures.beforeAll "${config.fixtures.beforeAll.command}" no está disponible en PATH.`,
      });
    }
    if (config.fixtures?.bootstrapSql !== undefined) {
      const bootstrapPath = config.fixtures.bootstrapSql;
      if (!insideProject(cwd, bootstrapPath) || !existsSync(resolve(cwd, bootstrapPath))) {
        findings.push({
          severity: "HIGH",
          message: `fixtures.bootstrapSql apunta a un archivo inexistente: ${bootstrapPath}. Sin bootstrap la identidad inicial no existe y la corrida fallará en la preparación.`,
        });
      }
    }
    if (config.coverage === undefined) {
      findings.push({
        severity: "MEDIUM",
        message: "No se declaró coverage.requiredRoutes; Proof no emitirá VERIFIED con cobertura desconocida.",
      });
    }
    for (const approval of config.approvals) {
      if (approval.expiresAt !== undefined && Date.parse(approval.expiresAt) <= Date.now()) {
        findings.push({
          severity: "MEDIUM",
          message: `Approval expirada para ${approval.assertionId}: ${approval.expiresAt}.`,
        });
      }
    }
    return findings;
  } catch (error) {
    return [
      {
        severity: "CRITICAL",
        message: error instanceof Error ? error.message : String(error),
      },
    ];
  }
}

const GIB = 1024 ** 3;

/**
 * Una corrida de verify construye dos imágenes de app más un migrador y
 * levanta Postgres: sin espacio, Docker falla a mitad de corrida con
 * errores confusos. statfs mide el disco del repo — aproximación honesta:
 * en Docker Desktop las imágenes pueden vivir en el disco de la VM.
 */
function checkDiskSpace(cwd: string): DoctorFinding[] {
  let freeBytes: number;
  try {
    const stats = statfsSync(cwd);
    freeBytes = stats.bavail * stats.bsize;
  } catch {
    return [];
  }
  const freeGib = freeBytes / GIB;
  if (freeGib >= 8) return [];
  const message =
    `Quedan ${freeGib.toFixed(1)} GiB libres en el disco del repositorio; ` +
    `una corrida de release verify construye 2 imágenes de app + 1 migrador. ` +
    `Liberá espacio o corré \`docker system prune\` para eliminar imágenes huérfanas.`;
  return [{ severity: freeGib < 2 ? "HIGH" : "MEDIUM", message }];
}

/**
 * Los clones shallow (CI checkouts con depth acotado) no contienen el commit
 * base desplegado: release verify fallaría recién al armar el worktree.
 */
function checkGitHistory(cwd: string): DoctorFinding[] {
  const result = spawnSync("git", ["rev-parse", "--is-shallow-repository"], {
    cwd,
    encoding: "utf-8",
    timeout: 15_000,
    windowsHide: true,
  });
  // Fuera de un repo git lo reportan init/verify con su propio mensaje.
  if (result.status !== 0 || result.stdout.trim() !== "true") return [];
  return [
    {
      severity: "HIGH",
      message:
        "El historial Git es superficial (shallow); release verify necesita los commits base y head completos. Corré `git fetch --unshallow`.",
    },
  ];
}

/**
 * Nombres de archivo bajo control de versiones que casi siempre contienen
 * credenciales. Puro y exportado para testearlo sin un repo git real.
 */
export function trackedSecretCandidates(paths: string[]): string[] {
  return paths.filter((path) => {
    const name = path.split("/").pop() ?? path;
    if (/^\.env(\.[^/]+)?$/.test(name)) {
      return !/\.(example|sample|template|dist|test)$/.test(name);
    }
    return /\.(pem|p12|pfx)$/i.test(name) || /^id_(rsa|dsa|ecdsa|ed25519)$/.test(name);
  });
}

function checkTrackedSecrets(cwd: string): DoctorFinding[] {
  const result = spawnSync("git", ["ls-files"], {
    cwd,
    encoding: "utf-8",
    timeout: 15_000,
    windowsHide: true,
  });
  if (result.status !== 0) return [];
  const suspicious = trackedSecretCandidates(
    result.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean),
  );
  if (suspicious.length === 0) return [];
  const shown = suspicious.slice(0, 5).join(", ");
  const extra = suspicious.length > 5 ? ` y ${suspicious.length - 5} más` : "";
  return [
    {
      severity: "HIGH",
      message:
        `Posibles credenciales versionadas en Git: ${shown}${extra}. ` +
        `Sacalas del índice con \`git rm --cached <archivo>\`, agregalas a .gitignore y rotá los secretos expuestos.`,
    },
  ];
}

function portInUse(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    const settle = (value: boolean) => {
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(750);
    socket.once("connect", () => settle(true));
    socket.once("timeout", () => settle(false));
    socket.once("error", () => settle(false));
  });
}

/**
 * release verify publica solo puertos efímeros, así que un puerto declarado
 * ocupado no rompe la corrida — pero un workload que apunte al puerto fijo
 * puede golpear la instancia local en vez de la de Proof y contaminar la
 * evidencia. Por eso es LOW y no HIGH.
 */
async function checkServicePorts(cwd: string): Promise<DoctorFinding[]> {
  let config: ProjectConfig;
  try {
    config = await loadConfig(cwd);
  } catch {
    // Sin config cargable no hay puertos declarados; checkProject ya avisó.
    return [];
  }
  const findings: DoctorFinding[] = [];
  for (const [name, service] of Object.entries(config.services)) {
    if (service.port === undefined) continue;
    if (await portInUse(service.port)) {
      findings.push({
        severity: "LOW",
        message:
          `Servicio "${name}": el puerto ${service.port} ya está en uso en 127.0.0.1. ` +
          `release verify publica puertos efímeros y no choca, pero un workload apuntado al puerto fijo ` +
          `puede golpear esa instancia en vez de la de Proof; detenela antes de verificar.`,
      });
    }
  }
  return findings;
}

function parseEnvKeys(contents: string): Set<string> {
  const keys = new Set<string>();
  for (const line of contents.split("\n")) {
    const match = /^\s*([A-Z0-9_]+)\s*=/.exec(line);
    if (match?.[1]) keys.add(match[1]);
  }
  return keys;
}

function printHuman(findings: DoctorFinding[]): void {
  if (findings.length === 0) {
    process.stdout.write(`${symbols.ok} ${paint.green("No se detectaron problemas de entorno.")}\n`);
    return;
  }
  for (const finding of findings) {
    process.stdout.write(`${severityLabel(finding.severity)} - ${finding.message}\n`);
  }
}
