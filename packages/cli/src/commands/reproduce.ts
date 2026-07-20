import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { loadConfig, type ProjectConfig } from "@proof/config";
import {
  ComposeExecutor,
  SpawnRunner,
  type ComposeExecutorOptions,
  type CommandRunner,
  type RunningContainer,
} from "@proof/docker-executor";
import {
  Recorder,
  Replayer,
  type RecordedExchange,
  type ReplayResult,
} from "@proof/http-recorder";
import { verifyRelease } from "@proof/postgres-verifier";
import { ProofBundleSchema, type ProofBundle, type Assertion } from "@proof/schema";

/**
 * Ver tesis, sección 6.1 ("Reproducción: todo fallo serio ofrece un
 * comando") y 19.3 paso 10. Cada finding nuevo conserva su estado y el
 * exchange mínimo dentro del bundle. Los findings de A0 + S1 reconstruyen
 * la imagen base contra Postgres migrado hasta subject.headSha; los fallos
 * de etapa vuelven a ejecutar el proof y extraen la misma assertion.
 */
export interface ReproduceOptions {
  json?: boolean;
  cwd?: string;
  /** Bundle explícito para desambiguar ids repetidos entre corridas. */
  bundle?: string;
  /** Elimina los recursos de una reproducción anterior del mismo id. */
  cleanup?: boolean;
}

export interface LocatedAssertion {
  assertion: Assertion;
  subject: ProofBundle["subject"];
  bundlePath: string;
}

export type ReproductionExecutor = Pick<
  ComposeExecutor,
  | "runId"
  | "buildImage"
  | "startEphemeralPostgres"
  | "startApp"
  | "imageDigest"
  | "captureSqlEffects"
  | "captureSchemaFingerprint"
  | "teardown"
  | "exportPostgres"
  | "disposeRun"
>;

export interface ReproductionExecutorOptions {
  repoRoot: string;
  runId?: string;
  postgresImage?: string;
}

export interface ReproduceDependencies {
  createExecutor(options: ReproductionExecutorOptions): ReproductionExecutor;
  loadProjectConfig(cwd: string): Promise<ProjectConfig>;
  verifyRunDisposed(runId: string): Promise<void>;
  commandRunner: CommandRunner;
  writeOutput(text: string): void;
  now(): string;
}

export interface LiveReproductionResult {
  kind: "started";
  assertion: Assertion;
  subject: ProofBundle["subject"];
  bundlePath: string;
  servicePath: string;
  runId: string;
  appUrl: string;
  postgresUrl: string;
  postgresInternalUrl: string;
  composePath: string;
  sqlSnapshotPath: string;
  replay?: ReplayResult;
  cleanupCommand: string;
}

export interface RerunReproductionResult {
  kind: "rerun";
  assertion: Assertion;
  conclusion: ProofBundle["conclusion"];
  runId: string;
}

export interface CleanupResult {
  kind: "cleaned";
  assertionId: string;
  runId: string;
}

export type ReproduceResult = LiveReproductionResult | RerunReproductionResult | CleanupResult;

interface ReproductionManifest {
  version: "1";
  assertionId: string;
  runId: string;
  status: "starting" | "ready";
  createdAt: string;
  subject: ProofBundle["subject"];
  bundlePath: string;
  servicePath: string;
  serviceName?: string;
  composePath?: string;
  sqlSnapshotPath?: string;
  postgres?: {
    id: string;
    internalUrl: string;
    hostUrl: string;
  };
  app?: {
    id: string;
    url: string;
  };
}

const SAFE_RUN_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;

export class AssertionNotFoundError extends Error {
  constructor(id: string) {
    super(`No se encontró la assertion "${id}" en ningún Proof Bundle guardado en .proof/.`);
    this.name = "AssertionNotFoundError";
  }
}

export class AssertionAmbiguousError extends Error {
  constructor(id: string, bundlePaths: string[]) {
    super(
      `La assertion "${id}" aparece en más de un Proof Bundle:\n` +
        bundlePaths.map((path) => `  ${path}`).join("\n") +
        `\nElegí el bundle exacto con --bundle <ruta>.`,
    );
    this.name = "AssertionAmbiguousError";
  }
}

export class ReproductionContextError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReproductionContextError";
  }
}

export class ReproductionStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReproductionStateError";
  }
}

const defaultDependencies: ReproduceDependencies = {
  createExecutor(options) {
    const executorOptions: ComposeExecutorOptions = { repoRoot: options.repoRoot };
    if (options.runId !== undefined) {
      executorOptions.runId = options.runId;
    }
    if (options.postgresImage !== undefined) {
      executorOptions.postgresImage = options.postgresImage;
    }
    return new ComposeExecutor(executorOptions);
  },
  loadProjectConfig: loadConfig,
  commandRunner: new SpawnRunner(),
  async verifyRunDisposed(runId) {
    const runner = new SpawnRunner();
    const containers = await runner.run("docker", [
      "ps",
      "-aq",
      "--filter",
      `label=dev.proof.run=${runId}`,
    ]);
    const networks = await runner.run("docker", [
      "network",
      "ls",
      "-q",
      "--filter",
      `label=dev.proof.run=${runId}`,
    ]);
    if (containers.exitCode !== 0 || networks.exitCode !== 0) {
      throw new ReproductionStateError(
        `Docker no pudo confirmar la limpieza de la corrida ${runId}: ` +
          [containers.stderr, networks.stderr].filter(Boolean).join(" ").slice(-1000),
      );
    }
    if (containers.stdout.trim() !== "" || networks.stdout.trim() !== "") {
      throw new ReproductionStateError(
        `La limpieza de la corrida ${runId} dejó recursos etiquetados; ` +
          "el manifiesto se conservó para reintentar.",
      );
    }
  },
  writeOutput(text) {
    process.stdout.write(text);
  },
  now() {
    return new Date().toISOString();
  },
};

function bundlePaths(cwd: string, explicitBundle?: string): string[] {
  if (explicitBundle !== undefined) {
    return [resolve(cwd, explicitBundle)];
  }

  const proofDir = join(cwd, ".proof");
  if (!existsSync(proofDir)) {
    return [];
  }
  return readdirSync(proofDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => join(proofDir, entry.name))
    .sort();
}

function assertionMatches(
  assertionId: string,
  cwd: string,
  explicitBundle?: string,
): LocatedAssertion[] {
  const matches: LocatedAssertion[] = [];
  for (const bundlePath of bundlePaths(cwd, explicitBundle)) {
    if (!existsSync(bundlePath)) {
      continue;
    }
    const bundle: ProofBundle = ProofBundleSchema.parse(
      JSON.parse(readFileSync(bundlePath, "utf-8")),
    );
    const assertion = bundle.assertions.find((candidate) => candidate.id === assertionId);
    if (assertion !== undefined) {
      matches.push({ assertion, subject: bundle.subject, bundlePath });
    }
  }
  return matches;
}

/** Lectura usada por MCP, con la misma desambiguación estricta que la CLI. */
export function findAssertion(
  assertionId: string,
  cwd: string = process.cwd(),
  explicitBundle?: string,
): Assertion {
  return findAssertionContext(assertionId, cwd, explicitBundle).assertion;
}

export function findAssertionContext(
  assertionId: string,
  cwd: string = process.cwd(),
  explicitBundle?: string,
): LocatedAssertion {
  const matches = assertionMatches(assertionId, resolve(cwd), explicitBundle);
  if (matches.length === 0) {
    throw new AssertionNotFoundError(assertionId);
  }
  if (matches.length > 1) {
    throw new AssertionAmbiguousError(
      assertionId,
      matches.map((match) => match.bundlePath),
    );
  }
  return matches[0] as LocatedAssertion;
}

export function reproductionManifestPath(assertionId: string, cwd: string = process.cwd()): string {
  const digest = createHash("sha256").update(assertionId).digest("hex").slice(0, 20);
  return join(resolve(cwd), ".proof", "reproductions", digest + ".json");
}

function reproductionArtifactPaths(assertionId: string, cwd: string): {
  sql: string;
  compose: string;
} {
  const manifest = reproductionManifestPath(assertionId, cwd);
  const stem = manifest.slice(0, -".json".length);
  return { sql: `${stem}.sql`, compose: `${stem}.compose.yml` };
}

function composeManifest(input: {
  projectName: string;
  imageTag: string;
  postgresImage: string;
  sqlFileName: string;
  appPort: number;
}): string {
  const proxyScript =
    'const net=require("node:net");' +
    'const proxy=(listen,host,port)=>net.createServer((incoming)=>{' +
    'const outgoing=net.connect(port,host);incoming.pipe(outgoing);outgoing.pipe(incoming);' +
    'const close=()=>{incoming.destroy();outgoing.destroy()};' +
    'incoming.on("error",close);outgoing.on("error",close);' +
    '}).listen(listen,"0.0.0.0");' +
    `proxy(${input.appPort},"app",${input.appPort});proxy(5432,"postgres",5432);`;
  return [
    `name: ${input.projectName}`,
    "services:",
    "  postgres:",
    `    image: ${JSON.stringify(input.postgresImage)}`,
    "    environment:",
    "      POSTGRES_USER: proof",
    "      POSTGRES_PASSWORD: proof",
    "      POSTGRES_DB: proof",
    "    healthcheck:",
    // SELECT 1 por TCP y no pg_isready: el postmaster temporal de initdb
    // responde pg_isready por socket Unix pero NO escucha TCP; solo el
    // definitivo lo hace (misma semántica que waitPostgresTcpReady).
    "      test: [\"CMD-SHELL\", \"PGPASSWORD=proof psql -X -h 127.0.0.1 -U proof -d proof -c 'SELECT 1'\"]",
    "      interval: 1s",
    "      timeout: 3s",
    "      retries: 30",
    "    volumes:",
    `      - ${JSON.stringify(`./${input.sqlFileName}:/docker-entrypoint-initdb.d/proof.sql:ro`)}`,
    "    networks: [proof_internal]",
    "    mem_limit: 1g",
    "    cpus: 1.0",
    "    pids_limit: 256",
    "    security_opt: [no-new-privileges:true]",
    "  app:",
    `    image: ${JSON.stringify(input.imageTag)}`,
    "    environment:",
    "      DATABASE_URL: postgresql://proof:proof@postgres:5432/proof",
    `      PORT: ${JSON.stringify(String(input.appPort))}`,
    "    depends_on:",
    "      postgres:",
    "        condition: service_healthy",
    "    networks: [proof_internal]",
    "    mem_limit: 1g",
    "    cpus: 1.0",
    "    pids_limit: 256",
    "    security_opt: [no-new-privileges:true]",
    "  proxy:",
    "    image: node:20-alpine",
    "    user: node",
    `    command: ${JSON.stringify(["node", "-e", proxyScript])}`,
    "    depends_on:",
    "      app:",
    "        condition: service_started",
    "    ports:",
    `      - ${JSON.stringify(`127.0.0.1::${input.appPort}`)}`,
    '      - "127.0.0.1::5432"',
    "    networks: [proof_internal, proof_access]",
    "    mem_limit: 128m",
    "    cpus: 0.25",
    "    pids_limit: 64",
    "    security_opt: [no-new-privileges:true]",
    "networks:",
    "  proof_internal:",
    "    internal: true",
    "  proof_access:",
    "",
  ].join("\n");
}

function writeInitialManifest(path: string, manifest: ReproductionManifest): void {
  mkdirSync(dirname(path), { recursive: true });
  try {
    writeFileSync(path, JSON.stringify(manifest, null, 2) + "\n", {
      encoding: "utf-8",
      flag: "wx",
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new ReproductionStateError(
        `Ya existe una reproducción registrada para "${manifest.assertionId}". ` +
          `Limpiála primero con ${cleanupCommand(manifest.assertionId)}.`,
      );
    }
    throw error;
  }
}

function updateManifest(path: string, manifest: ReproductionManifest): void {
  const temporaryPath = path + "." + process.pid + ".tmp";
  writeFileSync(temporaryPath, JSON.stringify(manifest, null, 2) + "\n", "utf-8");
  renameSync(temporaryPath, path);
}

function removeManifest(path: string): void {
  if (existsSync(path)) {
    unlinkSync(path);
  }
}

function readManifest(path: string, assertionId: string): ReproductionManifest {
  if (!existsSync(path)) {
    throw new ReproductionStateError(
      `No hay una reproducción registrada para "${assertionId}". No hay recursos dirigidos para limpiar.`,
    );
  }
  const value = JSON.parse(readFileSync(path, "utf-8")) as Partial<ReproductionManifest>;
  if (
    value.version !== "1" ||
    value.assertionId !== assertionId ||
    typeof value.runId !== "string" ||
    !SAFE_RUN_ID_RE.test(value.runId) ||
    (value.status !== "starting" && value.status !== "ready")
  ) {
    throw new ReproductionStateError(
      `El manifiesto de reproducción ${path} es inválido; no se adivinó qué recursos eliminar.`,
    );
  }
  return value as ReproductionManifest;
}

function cleanupCommand(assertionId: string): string {
  return `proof reproduce ${JSON.stringify(assertionId)} --cleanup`;
}

interface SelectedService {
  name: string;
  path: string;
  port?: number;
  prismaSchema?: string;
  dockerfile?: string;
  buildContext?: string;
  buildArgs?: Record<string, string>;
  env?: Record<string, string>;
}

function optionalServiceFields(service: {
  port?: number | undefined;
  prismaSchema?: string | undefined;
  dockerfile?: string | undefined;
  buildContext?: string | undefined;
  buildArgs?: Record<string, string> | undefined;
  env?: Record<string, string> | undefined;
}): Pick<
  SelectedService,
  "port" | "prismaSchema" | "dockerfile" | "buildContext" | "buildArgs" | "env"
> {
  return {
    ...(service.port === undefined ? {} : { port: service.port }),
    ...(service.prismaSchema === undefined ? {} : { prismaSchema: service.prismaSchema }),
    ...(service.dockerfile === undefined ? {} : { dockerfile: service.dockerfile }),
    ...(service.buildContext === undefined ? {} : { buildContext: service.buildContext }),
    ...(service.buildArgs === undefined ? {} : { buildArgs: service.buildArgs }),
    ...(service.env === undefined ? {} : { env: service.env }),
  };
}

function selectedService(config: ProjectConfig, subject: ProofBundle["subject"]): SelectedService {
  if (subject.service !== undefined) {
    const configured = Object.hasOwn(config.services, subject.service.name)
      ? config.services[subject.service.name]
      : undefined;
    if (configured === undefined) {
      throw new ReproductionContextError(
        `El bundle identifica el servicio "${subject.service.name}", pero ya no existe en proof.config.ts.`,
      );
    }
    if (configured.path !== subject.service.path) {
      throw new ReproductionContextError(
        `El servicio "${subject.service.name}" cambió de path desde el bundle ` +
          `(${subject.service.path} → ${configured.path}); no se reconstruyó un contexto ambiguo.`,
      );
    }
    return {
      name: subject.service.name,
      path: subject.service.path,
      ...optionalServiceFields(configured),
    };
  }

  const services = Object.entries(config.services);
  if (services.length !== 1) {
    throw new ReproductionContextError(
      services.length === 0
        ? "proof.config.ts no declara ningún servicio; no se puede reconstruir la imagen A0."
        : "proof.config.ts declara más de un servicio, pero el Proof Bundle actual no identifica cuál produjo la assertion. Pasá a un bundle/schema que preserve ese dato antes de reproducir; no se eligió un servicio arbitrariamente.",
    );
  }
  const selected = services[0];
  if (selected === undefined) {
    throw new ReproductionContextError(
      "proof.config.ts no declara ningún servicio; no se puede reconstruir la imagen A0.",
    );
  }
  const [name, service] = selected;
  return {
    name,
    path: service.path,
    ...optionalServiceFields(service),
  };
}

function postgresImage(config: ProjectConfig): string {
  const postgres = Object.values(config.data).find((source) => source.kind === "postgres");
  if (postgres === undefined) {
    throw new ReproductionContextError(
      "proof.config.ts no declara PostgreSQL; no se eligió una base implícita para reproducir.",
    );
  }
  return postgres.version === undefined ? "postgres:16-alpine" : `postgres:${postgres.version}-alpine`;
}

function requiredConnectionUrl(
  value: string | undefined,
  resourceDescription: string,
): string {
  if (value === undefined || value === "") {
    throw new ReproductionContextError(
      `${resourceDescription} no expuso la URL requerida para una sesión de debug alcanzable.`,
    );
  }
  return value;
}

function printStarted(result: LiveReproductionResult, write: (text: string) => void): void {
  write(`${result.assertion.id} — ${result.assertion.result}\n`);
  for (const line of result.assertion.evidence) {
    write(`  ${line}\n`);
  }
  write("\nReproducción en vivo lista (A0 + S1):\n");
  write(`  App: ${result.appUrl}\n`);
  write(`  Postgres (host): ${result.postgresUrl}\n`);
  write(`  Postgres (red Docker): ${result.postgresInternalUrl}\n`);
  write(`  Run ID: ${result.runId}\n`);
  write(`  Bundle: ${result.bundlePath}\n`);
  write(`  Compose: ${result.composePath}\n`);
  write(`  Snapshot SQL: ${result.sqlSnapshotPath}\n`);
  if (result.replay !== undefined) {
    write(
      `  Exchange reejecutado: HTTP ${result.replay.candidateResponse.status} — ${
        result.replay.matches ? "MATCH" : "MISMATCH reproducido"
      }\n`,
    );
  }
  write(`\nCuando termines: ${result.cleanupCommand}\n`);
}

async function cleanupReproduction(
  assertionId: string,
  cwd: string,
  options: ReproduceOptions,
  dependencies: ReproduceDependencies,
): Promise<CleanupResult> {
  const path = reproductionManifestPath(assertionId, cwd);
  const manifest = readManifest(path, assertionId);
  const executor = dependencies.createExecutor({ repoRoot: cwd, runId: manifest.runId });
  await executor.disposeRun();
  await dependencies.verifyRunDisposed(manifest.runId);
  removeManifest(path);

  const result: CleanupResult = { kind: "cleaned", assertionId, runId: manifest.runId };
  if (options.json === true) {
    dependencies.writeOutput(JSON.stringify(result, null, 2) + "\n");
  } else {
    dependencies.writeOutput(
      `Limpieza completada para "${assertionId}" (run ${manifest.runId}): ` +
        "contenedores y red de esa reproducción fueron eliminados.\n",
    );
  }
  return result;
}

function pgSpec(
  sha: string,
  label: "S0" | "S1",
  service: SelectedService,
  cloneFromContainerId?: string,
) {
  return {
    label,
    migrationsUpToSha: sha,
    servicePath: service.path,
    ...(service.prismaSchema === undefined ? {} : { prismaSchema: service.prismaSchema }),
    ...(cloneFromContainerId === undefined ? {} : { cloneFromContainerId }),
  };
}

function appEnvironment(databaseUrl: string, service: SelectedService): Record<string, string> {
  return {
    ...(service.env ?? {}),
    DATABASE_URL: databaseUrl,
    ...(service.port === undefined ? {} : { PORT: String(service.port) }),
  };
}

async function prepareReplayState(
  executor: ReproductionExecutor,
  service: SelectedService,
  config: ProjectConfig,
  subject: ProofBundle["subject"],
  cwd: string,
  commandRunner: CommandRunner,
  requireWorkload: boolean,
): Promise<{ imageTag: string; s0: RunningContainer; replayS1: RunningContainer }> {
  const imageTag = await executor.buildImage({
    sha: subject.baseSha,
    servicePath: service.path,
    ...(service.dockerfile === undefined ? {} : { dockerfile: service.dockerfile }),
    ...(service.buildContext === undefined ? {} : { buildContext: service.buildContext }),
    ...(service.buildArgs === undefined ? {} : { buildArgs: service.buildArgs }),
  });
  const s0 = await executor.startEphemeralPostgres(pgSpec(subject.baseSha, "S0", service));
  // Clone before executing the workload.  The proof compares the baseline and
  // replay from equivalent starting data; cloning afterwards would duplicate
  // all writes when the recorded workload is replayed.
  const replayS1 = await executor.startEphemeralPostgres(
    pgSpec(subject.headSha, "S1", service, s0.id),
  );
  if (config.workload === undefined) {
    if (requireWorkload) {
      throw new ReproductionContextError(
        "El finding requiere reconstruir los datos del baseline, pero proof.config.ts ya no declara workload.",
      );
    }
    return { imageTag, s0, replayS1 };
  }

  const baselineApp = await executor.startApp(
    imageTag,
    appEnvironment(requiredConnectionUrl(s0.connectionUrl, "Postgres S0"), service),
  );
  const recorder = new Recorder({
    targetUrl: requiredConnectionUrl(baselineApp.connectionUrl, "La app A0+S0"),
  });
  try {
    const proxyUrl = await recorder.start();
    const result = await commandRunner.run(config.workload.command, config.workload.args, {
      cwd,
      env: { PROOF_BASE_URL: proxyUrl },
      timeoutMs: config.workload.timeoutMs ?? 600_000,
    });
    recorder.stop();
    if (result.exitCode !== 0) {
      throw new ReproductionContextError(
        `El workload baseline ya no pasa (exit ${result.exitCode}); no se puede reconstruir S0 fielmente.\n${result.stderr.slice(-1000)}`,
      );
    }
  } finally {
    try {
      recorder.stop();
    } catch {
      // Ya detenido o error original en curso.
    }
    await executor.teardown(baselineApp.id).catch(() => undefined);
  }
  return { imageTag, s0, replayS1 };
}

async function rerunProofFinding(
  assertionId: string,
  located: LocatedAssertion,
  config: ProjectConfig,
  service: SelectedService,
  cwd: string,
  executor: ReproductionExecutor,
  dependencies: ReproduceDependencies,
  json: boolean,
): Promise<RerunReproductionResult> {
  const bundle = await verifyRelease(
    {
      baseSha: located.subject.baseSha,
      headSha: located.subject.headSha,
      serviceName: service.name,
      servicePath: service.path,
      ...(service.port === undefined ? {} : { servicePort: service.port }),
      ...(service.prismaSchema === undefined ? {} : { prismaSchema: service.prismaSchema }),
      runner: executor.runId,
      cwd,
      ...(config.workload === undefined ? {} : { workload: config.workload }),
      ...(config.workload?.timeoutMs === undefined
        ? {}
        : { workloadTimeoutMs: config.workload.timeoutMs }),
      ...(config.coverage === undefined
        ? {}
        : { requiredRoutes: config.coverage.requiredRoutes }),
      approvals: config.approvals.map((approval) => ({
        assertionId: approval.assertionId,
        reason: approval.reason,
        ...(approval.expiresAt === undefined ? {} : { expiresAt: approval.expiresAt }),
      })),
    },
    executor,
    dependencies.commandRunner,
  );
  const assertion = bundle.assertions.find((candidate) => candidate.id === assertionId);
  if (assertion === undefined) {
    throw new ReproductionStateError(
      `La nueva corrida no volvió a producir "${assertionId}"; conclusión actual: ${bundle.conclusion}.`,
    );
  }
  const result: RerunReproductionResult = {
    kind: "rerun",
    assertion,
    conclusion: bundle.conclusion,
    runId: executor.runId,
  };
  dependencies.writeOutput(
    json
      ? JSON.stringify(result, null, 2) + "\n"
      : [
          `Reproducción ejecutada: ${assertion.id} — ${assertion.result}`,
          `Conclusión: ${bundle.conclusion}`,
          ...assertion.evidence.map((line) => `  ${line}`),
          "",
        ].join("\n"),
  );
  return result;
}

export async function runReproduce(
  assertionId: string,
  options: ReproduceOptions = {},
  overrides: Partial<ReproduceDependencies> = {},
): Promise<ReproduceResult> {
  const dependencies: ReproduceDependencies = { ...defaultDependencies, ...overrides };
  const cwd = resolve(options.cwd ?? process.cwd());

  if (options.cleanup === true) {
    return cleanupReproduction(assertionId, cwd, options, dependencies);
  }

  const located = findAssertionContext(assertionId, cwd, options.bundle);
  const config = await dependencies.loadProjectConfig(cwd);
  const service = selectedService(config, located.subject);
  const configuredPostgresImage = postgresImage(config);
  const executor = dependencies.createExecutor({
    repoRoot: cwd,
    postgresImage: configuredPostgresImage,
  });

  if (located.assertion.reproductionContext?.kind === "rerun-proof") {
    try {
      return await rerunProofFinding(
        assertionId,
        located,
        config,
        service,
        cwd,
        executor,
        dependencies,
        options.json === true,
      );
    } finally {
      await executor.disposeRun().catch(() => undefined);
    }
  }

  const path = reproductionManifestPath(assertionId, cwd);
  const artifactPaths = reproductionArtifactPaths(assertionId, cwd);
  const manifest: ReproductionManifest = {
    version: "1",
    assertionId,
    runId: executor.runId,
    status: "starting",
    createdAt: dependencies.now(),
    subject: located.subject,
    bundlePath: located.bundlePath,
    servicePath: service.path,
    serviceName: service.name,
    composePath: artifactPaths.compose,
    sqlSnapshotPath: artifactPaths.sql,
  };
  writeInitialManifest(path, manifest);

  try {
    const requiresPopulatedS0 = located.assertion.reproductionContext?.kind === "live-state";
    const prepared = await prepareReplayState(
      executor,
      service,
      config,
      located.subject,
      cwd,
      dependencies.commandRunner,
      requiresPopulatedS0,
    );
    const imageTag = prepared.imageTag;
    const postgres = prepared.replayS1;
    const postgresInternalUrl = requiredConnectionUrl(
      postgres.connectionUrl,
      "Postgres S1",
    );
    const postgresUrl = requiredConnectionUrl(
      postgres.hostConnectionUrl,
      "Postgres S1",
    );
    manifest.postgres = {
      id: postgres.id,
      internalUrl: postgresInternalUrl,
      hostUrl: postgresUrl,
    };
    updateManifest(path, manifest);

    await executor.exportPostgres(postgres.id, artifactPaths.sql);

    const app = await executor.startApp(
      imageTag,
      appEnvironment(postgresInternalUrl, service),
    );
    const appUrl = requiredConnectionUrl(app.connectionUrl, "La app A0");
    const appPort = app.containerPort;
    if (appPort === undefined) {
      throw new ReproductionContextError("La app A0 no informó su puerto interno para Compose.");
    }
    writeFileSync(
      artifactPaths.compose,
      composeManifest({
        projectName: `proof-reproduction-${basename(artifactPaths.compose, ".compose.yml")}`,
        imageTag,
        postgresImage: configuredPostgresImage,
        sqlFileName: basename(artifactPaths.sql),
        appPort,
      }),
      "utf-8",
    );

    let replay: ReplayResult | undefined;
    const exchange = located.assertion.reproductionContext?.exchange;
    if (exchange !== undefined) {
      const replayExchange: RecordedExchange = {
        request: {
          method: exchange.request.method,
          path: exchange.request.path,
          headers: exchange.request.headers,
          ...(exchange.request.body === undefined ? {} : { body: exchange.request.body }),
        },
        baselineResponse: {
          status: exchange.baselineResponse.status,
          ...(exchange.baselineResponse.body === undefined
            ? {}
            : { body: exchange.baselineResponse.body }),
          ...(exchange.baselineResponse.sqlErrors === undefined
            ? {}
            : { sqlErrors: exchange.baselineResponse.sqlErrors }),
        },
      };
      replay = (await new Replayer().replay([replayExchange], appUrl))[0];
    }

    await executor.teardown(prepared.s0.id);
    manifest.app = { id: app.id, url: appUrl };
    manifest.status = "ready";
    updateManifest(path, manifest);

    const result: LiveReproductionResult = {
      kind: "started",
      assertion: located.assertion,
      subject: located.subject,
      bundlePath: located.bundlePath,
      servicePath: service.path,
      runId: executor.runId,
      appUrl,
      postgresUrl,
      postgresInternalUrl,
      composePath: artifactPaths.compose,
      sqlSnapshotPath: artifactPaths.sql,
      ...(replay === undefined ? {} : { replay }),
      cleanupCommand: cleanupCommand(assertionId),
    };

    if (options.json === true) {
      dependencies.writeOutput(JSON.stringify(result, null, 2) + "\n");
    } else {
      printStarted(result, dependencies.writeOutput);
    }
    return result;
  } catch (startupError) {
    try {
      await executor.disposeRun();
      await dependencies.verifyRunDisposed(executor.runId);
      removeManifest(path);
      if (existsSync(artifactPaths.compose)) unlinkSync(artifactPaths.compose);
      if (existsSync(artifactPaths.sql)) unlinkSync(artifactPaths.sql);
    } catch (cleanupError) {
      throw new AggregateError(
        [startupError, cleanupError],
        `Falló la reproducción y también su limpieza automática. ` +
          `El manifiesto ${path} se conservó para reintentar ${cleanupCommand(assertionId)}.`,
      );
    }
    throw startupError;
  }
}
