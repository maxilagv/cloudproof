import { existsSync, readFileSync, readdirSync, statfsSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { createConnection } from "node:net";
import { spawnSync } from "node:child_process";
import semver from "semver";
import { loadConfig, type ProjectConfig } from "@proof/config";
import { isPrismaSchemaTarget } from "@proof/docker-executor";
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

export async function runDoctor(options: DoctorOptions = {}): Promise<DoctorFinding[]> {
  const cwd = resolve(options.cwd ?? process.cwd());
  const findings: DoctorFinding[] = [
    ...checkNodeVersion(cwd),
    ...checkEnvDrift(cwd),
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

function checkEnvDrift(cwd: string): DoctorFinding[] {
  const examplePath = join(cwd, ".env.example");
  const envPath = join(cwd, ".env");
  if (!existsSync(examplePath)) return [];
  const declaredKeys = parseEnvKeys(readFileSync(examplePath, "utf-8"));
  const fileKeys = existsSync(envPath)
    ? parseEnvKeys(readFileSync(envPath, "utf-8"))
    : new Set<string>();
  const missing = [...declaredKeys].filter(
    (key) => !fileKeys.has(key) && process.env[key] === undefined,
  );
  return missing.length === 0
    ? []
    : [
        {
          severity: "MEDIUM",
          message: `${missing.length} variable(s) requeridas no están en .env ni en el proceso: ${missing.join(", ")}`,
        },
      ];
}

function insideProject(cwd: string, path: string): boolean {
  const absolute = resolve(cwd, path);
  const rel = relative(cwd, absolute);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
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
