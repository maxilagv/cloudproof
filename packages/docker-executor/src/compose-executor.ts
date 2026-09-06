import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import type {
  BuildSpec,
  EphemeralPostgresSpec,
  RunningContainer,
  DockerExecutor,
  DatabaseSchemaFingerprint,
  ExecutorAttempt,
  SqlEffectSnapshot,
} from "./types.js";
import { isTransientPostgresError, waitPostgresTcpReady } from "./postgres-readiness.js";
import { OWNER_LABEL, sweepResidues } from "./residues.js";
import {
  SpawnRunner,
  type CommandRunner,
  type CommandResult,
} from "./command-runner.js";
import { WorktreeManager } from "./worktrees.js";
import { ExecutorError, redactDiagnosticText } from "./errors.js";
import {
  assertSafeBuildArgs,
  assertSafeImageReference,
  assertValidEnvironment,
  executionPolicy,
  isEphemeralRunner,
  isSecretlessRunner,
  isSensitiveName,
  looksSensitiveValue,
  resolveExecutionProfile,
  type BuildNetworkMode,
  type ExecutionPolicy,
  type ExecutionProfile,
} from "./execution-profile.js";

/**
 * Implementación real del DockerExecutor sobre la CLI de Docker.
 *
 * Nota sobre el nombre: la clase conserva el nombre ComposeExecutor del
 * scaffold (lo importan @cloudproof/postgres-verifier y @cloudproof/cli; renombrarla
 * generaría churn cruzado mientras la Subfase 1.B avanza en paralelo),
 * pero la implementación actual orquesta contenedores individuales vía
 * `docker build/run/rm` directamente — más preciso para la matriz
 * A0/A1+S0/S1 que un archivo compose. `cloudproof reproduce` genera además un
 * Compose y snapshot local para la sesión interactiva.
 *
 * Decisiones de diseño (documentadas también en el README del paquete):
 *
 *  - Checkout por SHA vía `git worktree` cacheado en tmpdir (no clona,
 *    no ensucia el repo del usuario, evita montar rutas OneDrive en Docker).
 *  - Red bridge interna POR CORRIDA (sin egress, con DNS entre
 *    contenedores). Todos los puertos publicados se atan a 127.0.0.1.
 *  - Migraciones Prisma containerizadas con una imagen de migrador
 *    preconstruida durante la preparación. La ejecución del cloudproof no
 *    descarga dependencias ni depende del toolchain del host.
 *  - Asimetría deliberada de connectionUrl (ver types.ts): el de postgres
 *    es la URL de red interna (la consume la app contenedorizada); el de
 *    una app es la URL host 127.0.0.1 (la consume el Replayer del host).
 *  - Todo contenedor y red llevan labels dev.cloudproof.owner / dev.cloudproof.run:
 *    disposeRun() barre la corrida actual y sweepAll() cualquier residuo
 *    de corridas anteriores, incluso tras un proceso matado a la mitad.
 */

export { OWNER_LABEL };

export interface ComposeExecutorOptions {
  /** Raíz del repo git del usuario. Default: process.cwd(). */
  repoRoot?: string;
  runner?: CommandRunner;
  runId?: string;
  worktreesDir?: string;
  /** Imagen de Postgres para bases efímeras. Default: postgres:16-alpine. */
  postgresImage?: string;
  /** Imagen con node para correr prisma migrate deploy. Default: node:20-bookworm. */
  migrationImage?: string;
  pollIntervalMs?: number;
  readinessTimeoutMs?: number;
  buildTimeoutMs?: number;
  migrateTimeoutMs?: number;
  /** Espera para que PostgreSQL publique stats acumuladas. Default: 1100 ms. */
  statsSettleMs?: number;
  /** Probe de readiness HTTP inyectable (tests). Default: fetch; cualquier respuesta HTTP = listo. */
  httpProbe?: (url: string) => Promise<boolean>;
  /** Red sin ruta de salida para Postgres, migrador y aplicaciones. Default: true. */
  blockEgress?: boolean;
  /** Imagen fija usada por el proxy TCP host→red interna. */
  portProxyImage?: string;
  memoryLimit?: string;
  cpuLimit?: string;
  pidsLimit?: number;
  /** Override tipado; si falta se usa CLOUDPROOF_EXECUTION_PROFILE o trusted. */
  executionProfile?: ExecutionProfile;
  /** Afirmacion explicita del operador; fork la exige. */
  ephemeralRunner?: boolean;
  /** Afirmacion explicita de que el runner no contiene secretos; fork la exige. */
  secretlessRunner?: boolean;
  /** fork fuerza none; trusted/internal pueden elegir. */
  buildNetwork?: BuildNetworkMode;
  /** fork fuerza true; internal default true; trusted default false. */
  readOnlyRootFilesystem?: boolean;
}

const DEFAULTS = {
  postgresImage: "postgres:16-alpine",
  migrationImage: "node:20-bookworm",
  pollIntervalMs: 500,
  readinessTimeoutMs: 60_000,
  buildTimeoutMs: 600_000,
  migrateTimeoutMs: 300_000,
  statsSettleMs: 1_100,
  blockEgress: true,
  portProxyImage: "node:20-alpine",
  memoryLimit: "1g",
  cpuLimit: "1.0",
  pidsLimit: 256,
} as const;

async function defaultHttpProbe(url: string): Promise<boolean> {
  try {
    // Cualquier respuesta HTTP (incluso 404) significa "está escuchando".
    await fetch(url, { signal: AbortSignal.timeout(1500) });
    return true;
  } catch {
    return false;
  }
}

export class ComposeExecutor implements DockerExecutor {
  readonly runId: string;
  readonly executionProfile: ExecutionProfile;

  private readonly runner: CommandRunner;
  private readonly policy: ExecutionPolicy;
  private readonly worktrees: WorktreeManager;
  private readonly postgresImage: string;
  private readonly migrationImage: string;
  private readonly pollIntervalMs: number;
  private readonly readinessTimeoutMs: number;
  private readonly buildTimeoutMs: number;
  private readonly migrateTimeoutMs: number;
  private readonly statsSettleMs: number;
  private readonly httpProbe: (url: string) => Promise<boolean>;
  private readonly blockEgress: boolean;
  private readonly portProxyImage: string;
  private readonly memoryLimit: string;
  private readonly cpuLimit: string;
  private readonly pidsLimit: number;
  private networkCreated = false;
  private accessNetworkCreated = false;
  private appCounter = 0;
  private proxyCounter = 0;
  private readonly portProxies = new Map<string, string>();
  private readonly sensitiveValues = new Set<string>();
  private readonly attempts: ExecutorAttempt[] = [];

  constructor(options: ComposeExecutorOptions = {}) {
    this.executionProfile = resolveExecutionProfile(options.executionProfile);
    this.policy = executionPolicy(this.executionProfile, {
      ...(options.blockEgress === undefined ? {} : { blockEgress: options.blockEgress }),
      ...(options.buildNetwork === undefined ? {} : { buildNetwork: options.buildNetwork }),
      ...(options.readOnlyRootFilesystem === undefined
        ? {}
        : { readOnlyRootFilesystem: options.readOnlyRootFilesystem }),
    });
    if (this.policy.requireEphemeralRunner) {
      const ephemeral = options.ephemeralRunner ?? isEphemeralRunner();
      const secretless = options.secretlessRunner ?? isSecretlessRunner();
      if (!ephemeral || !secretless) {
        throw new ExecutorError(
          "El perfil fork solo puede ejecutarse en un runner efimero y sin secretos. " +
            "El operador debe aislar la maquina y declarar " +
            "CLOUDPROOF_EPHEMERAL_RUNNER=1 y CLOUDPROOF_SECRETLESS_RUNNER=1.",
        );
      }
    }
    this.runner =
      options.runner ??
      new SpawnRunner({ executionProfile: this.executionProfile, role: "orchestrator" });
    this.runId = options.runId ?? randomUUID().slice(0, 8);
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,31}$/.test(this.runId)) {
      throw new ExecutorError(`runId invalido para nombres Docker: "${this.runId}".`);
    }
    this.worktrees = new WorktreeManager(
      this.runner,
      options.repoRoot ?? process.cwd(),
      options.worktreesDir,
    );
    this.postgresImage = options.postgresImage ?? DEFAULTS.postgresImage;
    this.migrationImage = options.migrationImage ?? DEFAULTS.migrationImage;
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULTS.pollIntervalMs;
    this.readinessTimeoutMs = options.readinessTimeoutMs ?? DEFAULTS.readinessTimeoutMs;
    this.buildTimeoutMs = options.buildTimeoutMs ?? DEFAULTS.buildTimeoutMs;
    this.migrateTimeoutMs = options.migrateTimeoutMs ?? DEFAULTS.migrateTimeoutMs;
    this.statsSettleMs = options.statsSettleMs ?? DEFAULTS.statsSettleMs;
    this.httpProbe = options.httpProbe ?? defaultHttpProbe;
    this.blockEgress = this.policy.blockEgress;
    this.portProxyImage = options.portProxyImage ?? DEFAULTS.portProxyImage;
    this.memoryLimit = options.memoryLimit ?? DEFAULTS.memoryLimit;
    this.cpuLimit = options.cpuLimit ?? DEFAULTS.cpuLimit;
    this.pidsLimit = options.pidsLimit ?? DEFAULTS.pidsLimit;
    assertSafeImageReference(this.postgresImage, "postgresImage");
    assertSafeImageReference(this.migrationImage, "migrationImage");
    assertSafeImageReference(this.portProxyImage, "portProxyImage");
    if (!/^\d+(?:\.\d+)?(?:[bkmg])?$/i.test(this.memoryLimit)) {
      throw new ExecutorError(`memoryLimit invalido: "${this.memoryLimit}".`);
    }
    if (!/^\d+(?:\.\d+)?$/.test(this.cpuLimit) || Number(this.cpuLimit) <= 0) {
      throw new ExecutorError(`cpuLimit invalido: "${this.cpuLimit}".`);
    }
    if (!Number.isSafeInteger(this.pidsLimit) || this.pidsLimit < 16 || this.pidsLimit > 32_768) {
      throw new ExecutorError(`pidsLimit invalido: ${this.pidsLimit}.`);
    }
  }

  private runtimeLimits(): string[] {
    return [
      "--memory",
      this.memoryLimit,
      "--cpus",
      this.cpuLimit,
      "--pids-limit",
      String(this.pidsLimit),
      "--security-opt",
      "no-new-privileges:true",
    ];
  }

  private droppedCapabilities(): string[] {
    return this.executionProfile === "trusted" ? [] : ["--cap-drop", "ALL"];
  }

  private readOnlyFilesystem(tmpfs: string[] = ["/tmp:rw,noexec,nosuid,size=64m"]): string[] {
    if (!this.policy.readOnlyRootFilesystem) return [];
    return ["--read-only", ...tmpfs.flatMap((mount) => ["--tmpfs", mount])];
  }

  /** Evita que docker run resuelva tags contra un registry en perfil fork. */
  private pullPolicy(): string[] {
    return this.executionProfile === "fork" ? ["--pull", "never"] : [];
  }

  private worktreePath(worktree: string, requestedPath: string, label: string): string {
    const absolute = resolve(worktree, requestedPath);
    const rel = relative(worktree, absolute);
    if (rel.startsWith("..") || isAbsolute(rel)) {
      throw new ExecutorError(`${label} sale del worktree y fue rechazado: ${requestedPath}`);
    }
    return absolute;
  }

  /**
   * La comprobacion lexica no alcanza frente a symlinks del checkout. Para
   * cualquier archivo/directorio que el host vaya a leer o entregar a Docker,
   * verificamos tambien su destino real antes de usarlo.
   */
  private assertRealPathInWorktree(worktree: string, path: string, label: string): void {
    let realRoot: string;
    let realTarget: string;
    try {
      realRoot = realpathSync(worktree);
      realTarget = realpathSync(path);
    } catch {
      throw new ExecutorError(`${label} no existe o no puede resolverse dentro del worktree.`);
    }
    const rel = relative(realRoot, realTarget);
    if (rel.startsWith("..") || isAbsolute(rel)) {
      throw new ExecutorError(`${label} resuelve fuera del worktree y fue rechazado.`);
    }
  }

  private get runLabel(): string {
    return `dev.cloudproof.run=${this.runId}`;
  }

  private get networkName(): string {
    return `cloudproof-net-${this.runId}`;
  }

  private get accessNetworkName(): string {
    return `cloudproof-access-${this.runId}`;
  }

  // ---------------------------------------------------------------- build

  async buildImage(spec: BuildSpec): Promise<string> {
    const worktree = await this.worktrees.ensure(spec.sha);
    // Onboarding: la RECETA puede venir de otro commit (el candidato agrega
    // el Dockerfile que el base desplegado no tiene); las fuentes siguen
    // saliendo del worktree de spec.sha.
    const dockerfileWorktree =
      spec.dockerfileFromSha === undefined || spec.dockerfileFromSha === spec.sha
        ? worktree
        : await this.worktrees.ensure(spec.dockerfileFromSha);
    const build = this.resolveBuild(worktree, dockerfileWorktree, spec);
    assertSafeBuildArgs(spec.buildArgs ?? {}, this.executionProfile);
    const dockerfileContents = readFileSync(build.dockerfile, "utf8");
    if (this.executionProfile === "fork") {
      assertSafeForkDockerfile(dockerfileContents);
      if (dockerfileHasRemoteAdd(dockerfileContents)) {
        throw new ExecutorError(
          "El perfil fork rechazo ADD remoto en el Dockerfile. " +
            "Vendoriza el artefacto o usa una imagen base previamente aprobada.",
        );
      }
      await this.assertForkBuildImagesCached(dockerfileContents);
    }

    const buildArgs = Object.entries(spec.buildArgs ?? {}).sort(([a], [b]) =>
      a.localeCompare(b),
    );
    const shaSegment = worktree.slice(-12); // el dir del worktree se llama <sha12>
    // La identidad del tag incluye el contenido del Dockerfile y los build
    // args además de las rutas: si algo de eso cambió para el mismo SHA
    // (checkout no determinista, p.ej. una config de git distinta) el tag
    // cambia y no se sirve una imagen stale. CLOUDPROOF_FORCE_REBUILD=1 saltea
    // el cache por tag.
    const identity = createHash("sha256")
      .update(
        JSON.stringify({
          servicePath: spec.servicePath,
          dockerfile: build.dockerfileRel,
          // Solo presente cuando la receta viene de otro commit: así los tags
          // históricos (y sus réplicas en tests) no cambian de identidad.
          ...(spec.dockerfileFromSha === undefined
            ? {}
            : { dockerfileFromSha: spec.dockerfileFromSha }),
          context: build.contextRel,
          buildArgs,
          buildNetwork: this.policy.buildNetwork,
          dockerfileSha256: createHash("sha256")
            .update(dockerfileContents)
            .digest("hex"),
        }),
      )
      .digest("hex")
      .slice(0, 8);
    const tag = `cloudproof-app:${shaSegment}-${identity}`;

    if (process.env["CLOUDPROOF_FORCE_REBUILD"] !== "1") {
      const cached = await this.docker(["image", "inspect", tag]);
      if (cached.exitCode === 0) {
        return tag;
      }
    }

    await this.dockerOk(
      [
        "build",
        "--network",
        this.policy.buildNetwork,
        ...(this.executionProfile === "fork"
          ? [
              "--pull=false",
              "--memory",
              this.memoryLimit,
              "--cpu-period",
              "100000",
              "--cpu-quota",
              String(Math.ceil(Number(this.cpuLimit) * 100_000)),
              "--shm-size",
              "64m",
              "--ulimit",
              "nofile=1024:2048",
            ]
          : []),
        "-t",
        tag,
        "-f",
        build.dockerfile,
        "--label",
        OWNER_LABEL,
        ...buildArgs.flatMap(([key, value]) => ["--build-arg", `${key}=${value}`]),
        build.context,
      ],
      `docker build de ${spec.sha} (${spec.servicePath})`,
      this.buildTimeoutMs,
    );
    return tag;
  }

  private async assertForkBuildImagesCached(dockerfileContents: string): Promise<void> {
    const sources = dockerfileExternalImages(dockerfileContents);
    for (const source of sources) {
      assertSafeImageReference(source, "imagen externa del Dockerfile");
      if (!/@sha256:[a-f0-9]{64}$/i.test(source)) {
        throw new ExecutorError(
          `El perfil fork exige FROM/COPY --from fijado por digest: ${source}.`,
        );
      }
      const cached = await this.docker(["image", "inspect", source]);
      if (cached.exitCode !== 0) {
        throw new ExecutorError(
          `El perfil fork no descargara la imagen externa ${source}. ` +
            "Precargala por digest desde una fase confiable antes de ejecutar CloudProof.",
        );
      }
    }
  }

  /**
   * Resuelve Dockerfile y contexto de build (explícitos o inferidos). La
   * receta se busca en `dockerfileWorktree` (normalmente el mismo worktree;
   * distinto cuando dockerfileFromSha apunta al candidato) y las fuentes en
   * `worktree`.
   */
  private resolveBuild(
    worktree: string,
    dockerfileWorktree: string,
    spec: BuildSpec,
  ): { dockerfile: string; context: string; dockerfileRel: string; contextRel: string } {
    // Salida legítima para el onboarding (informe Bs As Neumáticos): cuando
    // el commit base no contiene el Dockerfile, el error debe enseñar el
    // camino en vez de cerrar la puerta.
    const onboardingHint =
      spec.dockerfileFromSha === undefined
        ? " Si el Dockerfile fue agregado por el candidato (onboarding a Docker), declará " +
          'services.<nombre>.dockerfileFrom: "head" para construir ambos lados con la receta ' +
          "del candidato; el Bundle registrará esa procedencia."
        : "";
    let dockerfile: string;
    if (spec.dockerfile !== undefined) {
      dockerfile = this.worktreePath(dockerfileWorktree, spec.dockerfile, "dockerfile");
      if (!existsSync(dockerfile)) {
        throw new ExecutorError(
          `El commit ${spec.dockerfileFromSha ?? spec.sha} no contiene el Dockerfile declarado ` +
            `en services.<nombre>.dockerfile: ${spec.dockerfile}.${onboardingHint}`,
        );
      }
      this.assertRealPathInWorktree(dockerfileWorktree, dockerfile, "dockerfile");
    } else {
      const serviceRoot = this.worktreePath(dockerfileWorktree, spec.servicePath, "servicePath");
      const serviceDockerfile = join(serviceRoot, "Dockerfile");
      const rootDockerfile = join(dockerfileWorktree, "Dockerfile");
      if (existsSync(serviceDockerfile)) {
        dockerfile = serviceDockerfile;
      } else if (existsSync(rootDockerfile)) {
        dockerfile = rootDockerfile;
      } else {
        throw new ExecutorError(
          `No se encontró Dockerfile ni en ${serviceRoot} ni en la raíz del worktree para el SHA ${spec.dockerfileFromSha ?? spec.sha}. ` +
            `Si el repo usa un nombre/ubicación no convencional (ej. docker/Dockerfile.web), ` +
            `declaralo en services.<nombre>.dockerfile de cloudproof.config.ts.${onboardingHint}`,
        );
      }
      this.assertRealPathInWorktree(dockerfileWorktree, dockerfile, "dockerfile");
    }
    const dockerfileRel = relative(dockerfileWorktree, dockerfile).replace(/\\/g, "/");

    const context =
      spec.buildContext !== undefined
        ? this.worktreePath(worktree, spec.buildContext, "buildContext")
        : this.inferBuildContext(worktree, dockerfile, dockerfileRel);
    this.assertRealPathInWorktree(worktree, context, "buildContext");
    const contextIgnore = join(context, ".dockerignore");
    if (existsSync(contextIgnore)) {
      this.assertRealPathInWorktree(worktree, contextIgnore, "dockerignore");
    }
    const dockerfileIgnore = `${dockerfile}.dockerignore`;
    if (existsSync(dockerfileIgnore)) {
      this.assertRealPathInWorktree(dockerfileWorktree, dockerfileIgnore, "dockerignore");
    }

    return {
      dockerfile,
      context,
      dockerfileRel,
      contextRel: relative(worktree, context).replace(/\\/g, "/") || ".",
    };
  }

  /**
   * Contexto por defecto: la carpeta del Dockerfile. Excepción determinista:
   * si algún COPY/ADD del Dockerfile referencia una fuente que NO existe
   * relativa a esa carpeta pero SÍ existe relativa a la raíz del worktree,
   * el Dockerfile sigue la convención de monorepos (Turborepo la documenta
   * como `docker build -f apps/web/Dockerfile .`) y el contexto es la raíz.
   * La decisión se basa solo en evidencia del filesystem, no en heurísticas
   * de contenido.
   *
   * `dockerfileRel` permite mapear la carpeta de la receta sobre el worktree
   * de FUENTES cuando la receta vive en otro worktree (dockerfileFromSha):
   * el contexto siempre se evalúa contra las fuentes que se van a copiar.
   */
  private inferBuildContext(worktree: string, dockerfile: string, dockerfileRel: string): string {
    const dockerfileDir = join(worktree, dirname(dockerfileRel));
    if (resolve(dockerfileDir) === resolve(worktree)) return worktree;

    for (const source of copySources(readFileSync(dockerfile, "utf-8"))) {
      if (contextSourceExists(dockerfileDir, source)) continue;
      if (contextSourceExists(worktree, source)) return worktree;
      // Fuente ausente en ambos contextos: no decide (p.ej. generada, o un
      // wildcard demasiado dinámico). El build fallará con el error real de
      // Docker si de verdad falta.
    }
    return dockerfileDir;
  }

  async imageDigest(imageTag: string): Promise<string> {
    const inspected = await this.dockerOk(
      ["image", "inspect", "-f", "{{.Id}}", imageTag],
      `digest de imagen ${imageTag}`,
    );
    const digest = inspected.stdout.trim();
    if (!/^sha256:[a-f0-9]{64}$/i.test(digest)) {
      throw new ExecutorError(`Docker devolvió un digest inválido para ${imageTag}: "${digest}".`);
    }
    return digest;
  }

  /**
   * En fork, transforma cualquier tag local de control/app en su content id
   * antes de `docker run`; así un retag concurrente no cambia los bytes que
   * realmente se ejecutan y nunca se consulta un registry.
   */
  private async localImageReference(reference: string, label: string): Promise<string> {
    if (this.executionProfile !== "fork") return reference;
    const inspected = await this.dockerOk(
      ["image", "inspect", "-f", "{{.Id}}", reference],
      `resolución offline de ${label}`,
    );
    const digest = inspected.stdout.trim();
    if (!/^sha256:[a-f0-9]{64}$/i.test(digest)) {
      throw new ExecutorError(`${label} no resolvió a un image id local inmutable.`);
    }
    return digest;
  }

  // ------------------------------------------------------------- postgres

  async startEphemeralPostgres(spec: EphemeralPostgresSpec): Promise<RunningContainer> {
    await this.ensureNetwork();
    const postgresImage = await this.localImageReference(this.postgresImage, "postgresImage");

    const name = `cloudproof-pg-${spec.label.toLowerCase()}-${this.runId}-${randomUUID().slice(0, 4)}`;
    const run = await this.dockerOk(
      [
        "run",
        ...this.pullPolicy(),
        "-d",
        "--name",
        name,
        "--label",
        OWNER_LABEL,
        "--label",
        this.runLabel,
        "--network",
        this.networkName,
        ...this.runtimeLimits(),
        ...this.droppedCapabilities(),
        "--cap-add",
        "CHOWN",
        "--cap-add",
        "DAC_OVERRIDE",
        "--cap-add",
        "FOWNER",
        "--cap-add",
        "SETGID",
        "--cap-add",
        "SETUID",
        ...this.readOnlyFilesystem([
          "/tmp:rw,noexec,nosuid,size=64m",
          "/var/run/postgresql:rw,nosuid,size=16m",
          "/var/lib/postgresql/data:rw,noexec,nosuid,size=768m",
        ]),
        ...(this.blockEgress ? [] : ["-p", "127.0.0.1:0:5432"]),
        "-e",
        "POSTGRES_USER=cloudproof",
        "-e",
        "POSTGRES_PASSWORD=cloudproof",
        "-e",
        "POSTGRES_DB=cloudproof",
        postgresImage,
      ],
      `docker run de Postgres efímero (${spec.label})`,
    );
    const id = run.stdout.trim();

    try {
      await this.waitPostgresReady(id, name);
      const hostPort = await this.publishPort(id, name, 5432);
      if (spec.cloneFromContainerId !== undefined) {
        await this.restorePostgresClone(spec.cloneFromContainerId, id);
      }
      // Schema baseline (informe Lubrisur 2026-07, 2ª ronda): génesis del
      // seed ANTES de migrate deploy — con `_prisma_migrations` restaurada,
      // Prisma aplica solo las migraciones pendientes, como en producción.
      // Solo en bases NO clonadas: los clones lo heredan del origen.
      if (spec.schemaBaselineSql !== undefined && spec.cloneFromContainerId === undefined) {
        await this.applySqlFile(id, spec.schemaBaselineSql, {
          source: "data.schemaBaseline",
          context: `schema baseline (${spec.label}) antes de migrate deploy`,
          // Un dump de schema real puede superar con holgura los 5 MiB del
          // bootstrap de identidad; el límite evita dumps con datos masivos.
          maxBytes: 64 * 1024 * 1024,
        });
      }
      await this.applyMigrations(
        spec.migrationsUpToSha,
        name,
        spec.servicePath,
        spec.prismaSchema,
      );
      // Bootstrap de identidad/datos de referencia: solo en bases NO
      // clonadas — los clones ya lo heredan del origen (S0 seed).
      if (spec.bootstrapSql !== undefined && spec.cloneFromContainerId === undefined) {
        await this.applySqlFile(id, spec.bootstrapSql, {
          source: "fixtures.bootstrapSql",
          context: `bootstrap SQL (${spec.label}) tras migrate deploy`,
          maxBytes: 5 * 1024 * 1024,
        });
      }

      return {
        id,
        serviceName: name,
        connectionUrl: `postgresql://cloudproof:cloudproof@${name}:5432/cloudproof`,
        hostConnectionUrl: `postgresql://cloudproof:cloudproof@127.0.0.1:${hostPort}/cloudproof`,
        containerPort: 5432,
      };
    } catch (error) {
      await this.teardown(id).catch(() => undefined);
      throw error;
    }
  }

  /**
   * Delegado a waitPostgresTcpReady (ver postgres-readiness.ts): SELECT 1
   * por TCP contra la base exacta, dos éxitos consecutivos sobre el mismo
   * postmaster. pg_isready quedó descartado: respondía OK contra el
   * postmaster temporal de initdb y producía fallos intermitentes.
   */
  private async waitPostgresReady(id: string, name: string): Promise<void> {
    await waitPostgresTcpReady(this.runner, id, {
      label: name,
      timeoutMs: this.readinessTimeoutMs,
      pollIntervalMs: this.pollIntervalMs,
      onAttempt: (probe) =>
        this.recordAttempt({
          phase: "postgres-readiness",
          target: name,
          attempt: probe.attempt,
          outcome: probe.outcome,
          detail: probe.detail,
        }),
    });
  }

  /**
   * Aplica un archivo SQL del host dentro del contenedor Postgres con
   * ON_ERROR_STOP (un SQL a medias no es un entorno válido). Dos usos:
   *  - fixtures.bootstrapSql (informe Bs As Neumáticos 2026-07): identidad y
   *    datos de referencia DESPUÉS de `migrate deploy` — preparación de
   *    entorno, la regla "las escrituras del workload son HTTP observables"
   *    no se toca.
   *  - data.schemaBaseline (informe Lubrisur 2026-07, 2ª ronda): dump de la
   *    base desplegada ANTES de `migrate deploy`, génesis del seed para
   *    historias de migraciones irreplayables desde cero.
   */
  private async applySqlFile(
    containerId: string,
    hostPath: string,
    options: { source: string; context: string; maxBytes: number },
  ): Promise<void> {
    let contents: Buffer;
    try {
      contents = readFileSync(hostPath);
    } catch {
      throw new ExecutorError(
        `${options.source} no pudo leerse desde el host: ${hostPath}`,
      );
    }
    if (contents.byteLength === 0 || contents.byteLength > options.maxBytes) {
      throw new ExecutorError(
        `${options.source} debe tener entre 1 byte y ${options.maxBytes} bytes (tiene ${contents.byteLength}).`,
      );
    }
    if (contents.includes(0)) {
      throw new ExecutorError(`${options.source} parece binario; se espera SQL en texto plano.`);
    }
    const containerPath = `/tmp/cloudproof-sql-${randomUUID().slice(0, 8)}.sql`;
    try {
      await this.dockerOk(
        ["cp", hostPath, `${containerId}:${containerPath}`],
        `copia de ${options.source} hacia el contenedor`,
      );
      await this.dockerOk(
        [
          "exec",
          containerId,
          "psql",
          "-v",
          "ON_ERROR_STOP=1",
          "-U",
          "cloudproof",
          "-d",
          "cloudproof",
          "-f",
          containerPath,
        ],
        options.context,
        this.migrateTimeoutMs,
      );
    } finally {
      await this.docker(["exec", containerId, "rm", "-f", containerPath]).catch(() => undefined);
    }
  }

  private async restorePostgresClone(sourceId: string, targetId: string): Promise<void> {
    const temporaryDirectory = mkdtempSync(join(tmpdir(), "cloudproof-pg-clone-"));
    const hostDump = join(temporaryDirectory, "s0.sql");
    const sourceDump = `/tmp/cloudproof-s0-${randomUUID().slice(0, 8)}.sql`;
    const targetDump = `/tmp/cloudproof-s0-${randomUUID().slice(0, 8)}.sql`;
    try {
      // El dump del origen es de solo lectura: puede reintentarse ante un
      // transitorio. El restore sobre el destino NO (mutante): dockerOk.
      await this.dockerOkReadRetry(
        [
          "exec",
          sourceId,
          "pg_dump",
          "-U",
          "cloudproof",
          "-d",
          "cloudproof",
          "--no-owner",
          "--no-privileges",
          "-f",
          sourceDump,
        ],
        `snapshot lógico de S0 (${sourceId})`,
        sourceId,
        this.migrateTimeoutMs,
      );
      await this.dockerOk(
        ["cp", `${sourceId}:${sourceDump}`, hostDump],
        `copia del snapshot S0 al host`,
      );
      await this.dockerOk(
        ["cp", hostDump, `${targetId}:${targetDump}`],
        `copia del snapshot S0 hacia S1`,
      );
      await this.dockerOk(
        [
          "exec",
          targetId,
          "psql",
          "-v",
          "ON_ERROR_STOP=1",
          "-U",
          "cloudproof",
          "-d",
          "cloudproof",
          "-f",
          targetDump,
        ],
        `restore del estado S0 dentro de S1`,
        this.migrateTimeoutMs,
      );
    } finally {
      await this.docker(["exec", sourceId, "rm", "-f", sourceDump]).catch(() => undefined);
      await this.docker(["exec", targetId, "rm", "-f", targetDump]).catch(() => undefined);
      rmSync(temporaryDirectory, { recursive: true, force: true });
    }
  }

  /**
   * Resuelve el target de `--schema`: un archivo `schema.prisma` o una
   * carpeta de schemas multi-archivo (`prisma/schema/` con *.prisma dentro,
   * el layout GA de Prisma 6.7+). El orden de candidatos prioriza el
   * servicio y luego la raíz, archivo antes que carpeta. Las migraciones
   * siguen la convención Prisma: carpeta `migrations` hermana del schema.
   */
  private prismaSchemaPath(
    worktree: string,
    servicePath?: string,
    explicitSchema?: string,
  ): { absolute: string; container: string; migrationsContainer: string } {
    const candidates =
      explicitSchema !== undefined
        ? [explicitSchema]
        : servicePath === undefined || servicePath === "."
          ? [join("prisma", "schema.prisma"), join("prisma", "schema")]
          : [
              join(servicePath, "prisma", "schema.prisma"),
              join(servicePath, "prisma", "schema"),
              join("prisma", "schema.prisma"),
              join("prisma", "schema"),
            ];
    for (const relativePath of candidates) {
      const absolute = this.worktreePath(worktree, relativePath, "prismaSchema");
      if (isPrismaSchemaTarget(absolute)) {
        this.assertRealPathInWorktree(worktree, absolute, "prismaSchema");
        const containerRelative = relativePath.replace(/\\/g, "/");
        // schema.prisma (archivo) y schema/ (carpeta) comparten convención:
        // la carpeta migrations es hermana → se quita el último segmento.
        const schemaDir = containerRelative.split("/").slice(0, -1).join("/");
        return {
          absolute,
          container: `/repo/${containerRelative}`,
          migrationsContainer: `/repo/${schemaDir === "" ? "migrations" : `${schemaDir}/migrations`}`,
        };
      }
    }
    throw new ExecutorError(
      `El commit no contiene un schema Prisma en ${candidates.join(" ni ")}. ` +
        `Configurá services.<nombre>.prismaSchema si vive en otra ruta ` +
        `(acepta un schema.prisma o una carpeta de schemas multi-archivo).`,
    );
  }

  /**
   * ¿El repo usa Prisma "config-era"? Desde Prisma 7, `migrate deploy`
   * exige datasource.url vía archivo de config — y el prisma.config.* del
   * repo no puede ejecutarse dentro del migrador porque importa paquetes de
   * un node_modules que no está montado. CloudProof monta entonces su propio
   * config sintético, drivado por variables de entorno.
   *
   * Señales (cualquiera activa el modo):
   *  - versión de prisma del repo con major >= 7, o "latest" (hoy 7.x);
   *  - un prisma.config.* en la raíz, en el servicio o junto al paquete
   *    que contiene el schema (monorepos como rallly lo ponen ahí).
   */
  private prismaConfigMode(
    version: string,
    worktree: string,
    schemaAbsolute: string,
    servicePath?: string,
  ): boolean {
    const major = /(\d+)/.exec(version)?.[1];
    if (version === "latest" || (major !== undefined && Number(major) >= 7)) return true;

    const roots = [
      worktree,
      ...(servicePath === undefined || servicePath === "." ? [] : [join(worktree, servicePath)]),
      // schema.prisma → prisma/ → paquete; carpeta schema/ → prisma/ → paquete.
      dirname(dirname(schemaAbsolute)),
    ];
    return roots.some((root) =>
      ["prisma.config.ts", "prisma.config.js", "prisma.config.mjs", "prisma.config.cjs"].some(
        (name) => existsSync(join(root, name)),
      ),
    );
  }

  private async applyMigrations(
    sha: string,
    pgHost: string,
    servicePath?: string,
    explicitSchema?: string,
  ): Promise<void> {
    const worktree = await this.worktrees.ensure(sha);
    const schema = this.prismaSchemaPath(worktree, servicePath, explicitSchema);
    const prismaVersion = this.prismaVersionFrom(worktree, servicePath, schema.absolute);
    const migratorImage = await this.ensureMigrationImage(prismaVersion);
    const runnableMigratorImage = await this.localImageReference(
      migratorImage,
      "migrationImage",
    );
    // El workdir del migrador es NEUTRO (no /repo) a propósito: Prisma 6+
    // auto-carga prisma.config.ts desde el cwd, y ese archivo suele importar
    // paquetes del node_modules del repo — que no está montado.
    //
    // Dos modos, decididos por evidencia del repo:
    //  - config-era (el repo tiene prisma.config.*): esas versiones exigen
    //    datasource.url vía config para migrate deploy. Se monta un config
    //    SINTÉTICO de CloudProof junto al node_modules del migrador, drivado por
    //    env vars (CLOUDPROOF_PRISMA_SCHEMA / _MIGRATIONS / DATABASE_URL).
    //  - clásico: --schema explícito, sin config a la vista.
    const configMode = this.prismaConfigMode(
      prismaVersion,
      worktree,
      schema.absolute,
      servicePath,
    );
    const temporaryDirectory = configMode
      ? mkdtempSync(join(tmpdir(), "cloudproof-prisma-config-"))
      : undefined;
    try {
      const modeArgs: string[] = [];
      if (temporaryDirectory !== undefined) {
        const configPath = join(temporaryDirectory, "prisma.config.ts");
        writeFileSync(
          configPath,
          [
            `import { defineConfig } from "prisma/config";`,
            ``,
            `export default defineConfig({`,
            `  schema: process.env["CLOUDPROOF_PRISMA_SCHEMA"],`,
            `  migrations: { path: process.env["CLOUDPROOF_PRISMA_MIGRATIONS"] },`,
            `  datasource: { url: process.env["DATABASE_URL"] },`,
            `});`,
            ``,
          ].join("\n"),
          "utf-8",
        );
        modeArgs.push(
          "-v",
          `${configPath}:/opt/cloudproof-migrator/prisma.config.ts:ro`,
          "-e",
          `CLOUDPROOF_PRISMA_SCHEMA=${schema.container}`,
          "-e",
          `CLOUDPROOF_PRISMA_MIGRATIONS=${schema.migrationsContainer}`,
        );
      }
      await this.dockerOk(
        [
          "run",
          ...this.pullPolicy(),
          "--rm",
          "--label",
          OWNER_LABEL,
          "--label",
          this.runLabel,
          "--network",
          this.networkName,
          "-v",
          `${worktree}:/repo:ro`,
          "-w",
          "/opt/cloudproof-migrator",
          "-e",
          `DATABASE_URL=postgresql://cloudproof:cloudproof@${pgHost}:5432/cloudproof`,
          ...modeArgs,
          ...this.runtimeLimits(),
          ...this.droppedCapabilities(),
          ...this.readOnlyFilesystem(),
          runnableMigratorImage,
          "migrate",
          "deploy",
          ...(configMode ? [] : ["--schema", schema.container]),
        ],
        `prisma migrate deploy (hasta ${sha}) sobre ${pgHost}`,
        this.migrateTimeoutMs,
      );
    } finally {
      if (temporaryDirectory !== undefined) {
        rmSync(temporaryDirectory, { recursive: true, force: true });
      }
    }
  }

  /**
   * Usa la versión de prisma declarada por el repo para que la migración
   * corra con la MISMA versión que usa el usuario. En monorepos la
   * dependencia suele vivir en el package.json del servicio o del paquete
   * que contiene el schema, no en la raíz — se buscan en ese orden
   * (peppermint declara prisma 5 en apps/api; correrle Prisma 7 rompería
   * su schema legacy). Si nada es parseable cae a la última estable.
   */
  private prismaVersionFrom(
    worktree: string,
    servicePath?: string,
    schemaAbsolute?: string,
  ): string {
    const candidates = [
      ...(servicePath === undefined || servicePath === "."
        ? []
        : [join(worktree, servicePath, "package.json")]),
      ...(schemaAbsolute === undefined
        ? []
        : [join(dirname(dirname(schemaAbsolute)), "package.json")]),
      join(worktree, "package.json"),
    ];
    for (const packagePath of candidates) {
      if (!existsSync(packagePath)) continue;
      this.assertRealPathInWorktree(worktree, packagePath, "package.json de Prisma");
      try {
        // El replace tolera el BOM de editores Windows; sin él, un
        // package.json válido caería silenciosamente a prisma "latest".
        const pkg = JSON.parse(readFileSync(packagePath, "utf-8").replace(/^\uFEFF/, "")) as {
          dependencies?: Record<string, string>;
          devDependencies?: Record<string, string>;
        };
        const version = pkg.devDependencies?.["prisma"] ?? pkg.dependencies?.["prisma"];
        if (version !== undefined && /^[0-9A-Za-z^~><=.+\- ]+$/.test(version)) {
          return version;
        }
      } catch {
        // package.json inválido: probar el siguiente candidato.
      }
    }
    return "latest";
  }

  /**
   * Resuelve/instala Prisma durante la preparación de imagen. El contenedor
   * que aplica migraciones corre luego dentro de la red interna, sin egress.
   */
  private async ensureMigrationImage(version: string): Promise<string> {
    const identity = JSON.stringify({ recipe: "v2", base: this.migrationImage, prisma: version });
    const tag = `cloudproof-prisma-migrator:${createHash("sha256").update(identity).digest("hex").slice(0, 16)}`;
    const cached = await this.docker(["image", "inspect", tag]);
    if (cached.exitCode === 0) return tag;
    if (this.executionProfile === "fork") {
      throw new ExecutorError(
        `El perfil fork requiere el migrador ${tag} precargado por una fase confiable; ` +
          "no instalara paquetes desde el checkout no confiable.",
      );
    }

    const context = mkdtempSync(join(tmpdir(), "cloudproof-prisma-image-"));
    try {
      writeFileSync(
        join(context, "package.json"),
        JSON.stringify({ private: true, dependencies: { prisma: version } }, null, 2) + "\n",
        "utf-8",
      );
      writeFileSync(
        join(context, "Dockerfile"),
        [
          `FROM ${this.migrationImage}`,
          "WORKDIR /opt/cloudproof-migrator",
          "COPY package.json ./",
          "RUN npm install --omit=dev --no-audit --no-fund",
          'ENTRYPOINT ["/opt/cloudproof-migrator/node_modules/.bin/prisma"]',
          "",
        ].join("\n"),
        "utf-8",
      );
      await this.dockerOk(
        [
          "build",
          "--network",
          this.policy.buildNetwork,
          "-t",
          tag,
          "--label",
          OWNER_LABEL,
          context,
        ],
        `preparación del migrador Prisma ${version}`,
        this.buildTimeoutMs,
      );
      return tag;
    } finally {
      rmSync(context, { recursive: true, force: true });
    }
  }

  // ------------------------------------------------------------------ app

  async startApp(imageTag: string, env: Record<string, string>): Promise<RunningContainer> {
    await this.ensureNetwork();
    assertSafeImageReference(imageTag, "imageTag");
    assertValidEnvironment(env, this.executionProfile, { allowCloudProofDatabaseUrl: true });
    for (const [name, value] of Object.entries(env)) {
      if (value.length >= 4 && (isSensitiveName(name) || looksSensitiveValue(value))) {
        this.sensitiveValues.add(value);
      }
    }
    const runnableImage = await this.localImageReference(imageTag, "imageTag");
    if (this.executionProfile === "fork") await this.assertImageDeclaresNonRootUser(runnableImage);

    const port = env["PORT"] ?? String(await this.singleExposedPort(runnableImage));
    const numericPort = Number(port);
    if (!Number.isSafeInteger(numericPort) || numericPort < 1 || numericPort > 65_535) {
      throw new ExecutorError(`PORT invalido para ${imageTag}: "${port}".`);
    }
    const name = `cloudproof-app-${this.appCounter++}-${this.runId}`;

    // --env-file evita exponer valores en argv/listados de procesos. El
    // archivo tiene permisos 0600 y se elimina inmediatamente despues de que
    // Docker crea el contenedor (Docker ya copio su contenido al config).
    const envDirectory = mkdtempSync(join(tmpdir(), "cloudproof-app-env-"));
    const envPath = join(envDirectory, "runtime.env");
    writeFileSync(
      envPath,
      Object.entries(env)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, value]) => `${key}=${value}`)
        .join("\n") + "\n",
      { encoding: "utf8", mode: 0o600 },
    );

    const args = [
      "run",
      ...this.pullPolicy(),
      "-d",
      "--name",
      name,
      "--label",
      OWNER_LABEL,
      "--label",
      this.runLabel,
      "--network",
      this.networkName,
      ...this.runtimeLimits(),
      ...this.droppedCapabilities(),
      ...this.readOnlyFilesystem(),
      "--env-file",
      envPath,
      ...(this.blockEgress ? [] : ["-p", `127.0.0.1:0:${numericPort}`]),
    ];
    args.push(runnableImage);

    let run: CommandResult;
    try {
      run = await this.dockerOk(args, `docker run de ${imageTag}`);
    } finally {
      rmSync(envDirectory, { recursive: true, force: true });
    }
    const id = run.stdout.trim();
    try {
      const hostPort = await this.publishPort(id, name, numericPort);
      const url = `http://127.0.0.1:${hostPort}`;
      await this.waitHttpReady(id, name, url);
      return { id, serviceName: name, connectionUrl: url, containerPort: numericPort };
    } catch (error) {
      await this.teardown(id).catch(() => undefined);
      throw error;
    }
  }

  private async assertImageDeclaresNonRootUser(imageTag: string): Promise<void> {
    const inspected = await this.dockerOk(
      ["image", "inspect", "-f", "{{.Config.User}}", imageTag],
      `usuario declarado por ${imageTag}`,
    );
    const user = inspected.stdout.trim().toLowerCase();
    if (user === "" || user === "0" || user === "root" || user.startsWith("0:")) {
      throw new ExecutorError(
        `El perfil fork rechazo ${imageTag}: la imagen debe declarar USER no-root en su Dockerfile.`,
      );
    }
  }

  async captureSqlEffects(containerId: string): Promise<SqlEffectSnapshot> {
    // Los backends de la app publican stats al quedar idle y no más de una
    // vez por segundo. La espera evita una carrera con la respuesta HTTP.
    await this.sleep(this.statsSettleMs);
    // Evita reutilizar un snapshot cacheado en el backend lector.
    await this.dockerOkReadRetry(
      [
        "exec",
        containerId,
        "psql",
        "-v",
        "ON_ERROR_STOP=1",
        "-U",
        "cloudproof",
        "-d",
        "cloudproof",
        "-c",
        "SELECT pg_stat_force_next_flush();",
      ],
      `flush de estadísticas SQL en ${containerId}`,
      containerId,
    );
    const query = await this.dockerOkReadRetry(
      [
        "exec",
        containerId,
        "psql",
        "-A",
        "-t",
        "-F",
        "\t",
        "-U",
        "cloudproof",
        "-d",
        "cloudproof",
        "-c",
        "SELECT schemaname || '.' || relname, n_tup_ins, n_tup_upd, n_tup_del " +
          "FROM pg_stat_user_tables " +
          "WHERE relname <> '_prisma_migrations' ORDER BY schemaname, relname;",
      ],
      `captura de efectos SQL en ${containerId}`,
      containerId,
    );
    const tables = query.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const [table, inserted, updated, deleted] = line.split("\t");
        if (
          table === undefined ||
          inserted === undefined ||
          updated === undefined ||
          deleted === undefined
        ) {
          throw new ExecutorError(`Salida SQL inesperada al capturar efectos: "${line}".`);
        }
        return {
          table,
          inserted: Number.parseInt(inserted, 10),
          updated: Number.parseInt(updated, 10),
          deleted: Number.parseInt(deleted, 10),
        };
      });
    if (
      tables.some(
        (table) =>
          !Number.isFinite(table.inserted) ||
          !Number.isFinite(table.updated) ||
          !Number.isFinite(table.deleted),
      )
    ) {
      throw new ExecutorError("PostgreSQL devolvió contadores de efectos SQL inválidos.");
    }
    return { tables };
  }

  async captureSchemaFingerprint(containerId: string): Promise<DatabaseSchemaFingerprint> {
    // El fingerprint solo contiene metadata canónica; nunca valores de filas.
    // Se toma antes y después de cada startup para detectar entrypoints que
    // auto-migran y convierten silenciosamente A1+S0 en A1+S1.
    const sql = `
WITH user_namespaces AS (
  SELECT oid, nspname
  FROM pg_namespace
  WHERE nspname <> 'information_schema'
    AND nspname NOT LIKE 'pg\\_%' ESCAPE '\\'
), objects AS (
  SELECT 'REL|' || n.nspname || '|' || c.relname || '|' || c.relkind::text || '|' ||
         c.relpersistence::text || '|' || c.relreplident::text AS item
  FROM pg_class c JOIN user_namespaces n ON n.oid = c.relnamespace
  WHERE c.relkind IN ('r','p','v','m','S')
  UNION ALL
  SELECT 'COL|' || n.nspname || '|' || c.relname || '|' || a.attnum || '|' ||
         a.attname || '|' || format_type(a.atttypid, a.atttypmod) || '|' ||
         a.attnotnull || '|' || a.attidentity::text || '|' || a.attgenerated::text || '|' ||
         COALESCE(pg_get_expr(d.adbin, d.adrelid), '')
  FROM pg_attribute a
  JOIN pg_class c ON c.oid = a.attrelid
  JOIN user_namespaces n ON n.oid = c.relnamespace
  LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
  WHERE a.attnum > 0 AND NOT a.attisdropped AND c.relkind IN ('r','p','v','m')
  UNION ALL
  SELECT 'CON|' || n.nspname || '|' || c.relname || '|' || con.conname || '|' ||
         con.contype::text || '|' || con.convalidated || '|' || pg_get_constraintdef(con.oid, true)
  FROM pg_constraint con
  JOIN pg_class c ON c.oid = con.conrelid
  JOIN user_namespaces n ON n.oid = c.relnamespace
  UNION ALL
  SELECT 'IDX|' || n.nspname || '|' || t.relname || '|' || i.relname || '|' ||
         pg_get_indexdef(i.oid)
  FROM pg_index x
  JOIN pg_class i ON i.oid = x.indexrelid
  JOIN pg_class t ON t.oid = x.indrelid
  JOIN user_namespaces n ON n.oid = t.relnamespace
  UNION ALL
  SELECT 'TRG|' || n.nspname || '|' || c.relname || '|' || t.tgname || '|' ||
         pg_get_triggerdef(t.oid, true)
  FROM pg_trigger t
  JOIN pg_class c ON c.oid = t.tgrelid
  JOIN user_namespaces n ON n.oid = c.relnamespace
  WHERE NOT t.tgisinternal
  UNION ALL
  SELECT 'VIEW|' || n.nspname || '|' || c.relname || '|' || pg_get_viewdef(c.oid, true)
  FROM pg_class c JOIN user_namespaces n ON n.oid = c.relnamespace
  WHERE c.relkind IN ('v','m')
  UNION ALL
  SELECT 'ENUM|' || n.nspname || '|' || typ.typname || '|' || e.enumsortorder || '|' || e.enumlabel
  FROM pg_type typ
  JOIN user_namespaces n ON n.oid = typ.typnamespace
  JOIN pg_enum e ON e.enumtypid = typ.oid
)
SELECT 'sha256:' || encode(
  sha256(convert_to(COALESCE(string_agg(item, E'\\n' ORDER BY item), ''), 'UTF8')),
  'hex'
)
FROM objects;`;
    const result = await this.dockerOkReadRetry(
      [
        "exec",
        containerId,
        "psql",
        "-X",
        "-q",
        "-A",
        "-t",
        "-v",
        "ON_ERROR_STOP=1",
        "-U",
        "cloudproof",
        "-d",
        "cloudproof",
        "-c",
        sql,
      ],
      `fingerprint de schema PostgreSQL en ${containerId}`,
      containerId,
    );
    const digest = result.stdout.trim();
    if (!/^sha256:[a-f0-9]{64}$/.test(digest)) {
      throw new ExecutorError(`PostgreSQL devolvió un fingerprint de schema inválido: "${digest}".`);
    }
    return { digest: digest as `sha256:${string}` };
  }

  async exportPostgres(containerId: string, destinationPath: string): Promise<void> {
    mkdirSync(dirname(destinationPath), { recursive: true });
    const containerDump = `/tmp/cloudproof-export-${randomUUID().slice(0, 8)}.sql`;
    try {
      await this.dockerOkReadRetry(
        [
          "exec",
          containerId,
          "pg_dump",
          "-U",
          "cloudproof",
          "-d",
          "cloudproof",
          "--no-owner",
          "--no-privileges",
          "--clean",
          "--if-exists",
          "-f",
          containerDump,
        ],
        `export reproducible de PostgreSQL ${containerId}`,
        containerId,
        this.migrateTimeoutMs,
      );
      await this.dockerOk(
        ["cp", `${containerId}:${containerDump}`, destinationPath],
        `copia del snapshot reproducible a ${destinationPath}`,
      );
    } finally {
      await this.docker(["exec", containerId, "rm", "-f", containerDump]).catch(() => undefined);
    }
  }

  private async singleExposedPort(imageTag: string): Promise<number> {
    const inspect = await this.dockerOk(
      ["image", "inspect", "-f", "{{json .Config.ExposedPorts}}", imageTag],
      `docker image inspect de ${imageTag}`,
    );
    const raw = inspect.stdout.trim();
    const parsed: unknown = raw === "" || raw === "null" ? null : JSON.parse(raw);
    const tcpPorts =
      parsed === null
        ? []
        : Object.keys(parsed as Record<string, unknown>)
            .filter((key) => key.endsWith("/tcp"))
            .map((key) => Number.parseInt(key, 10))
            .filter((value) => Number.isFinite(value));

    const first = tcpPorts[0];
    if (tcpPorts.length === 1 && first !== undefined) {
      return first;
    }
    throw new ExecutorError(
      `No se pudo determinar el puerto de ${imageTag}: la imagen ${
        tcpPorts.length === 0 ? "no declara EXPOSE" : `declara ${tcpPorts.length} puertos TCP`
      }. Pasá el puerto explícitamente vía env.PORT o declará exactamente un EXPOSE en el Dockerfile.`,
    );
  }

  private async waitHttpReady(id: string, name: string, url: string): Promise<void> {
    const deadline = Date.now() + this.readinessTimeoutMs;
    while (Date.now() < deadline) {
      if (await this.httpProbe(url)) return;
      if (!(await this.isRunning(id))) {
        throw new ExecutorError(
          `El contenedor ${name} terminó antes de aceptar conexiones HTTP en ${url}.`,
          await this.logsTail(id),
        );
      }
      await this.sleep(this.pollIntervalMs);
    }
    throw new ExecutorError(
      `${name} no respondió HTTP en ${url} tras ${this.readinessTimeoutMs} ms.`,
      await this.logsTail(id),
    );
  }

  // ------------------------------------------------------------- teardown

  async teardown(containerId: string): Promise<void> {
    const proxyId = this.portProxies.get(containerId);
    this.portProxies.delete(containerId);
    let proxyFailure: CommandResult | undefined;
    if (proxyId !== undefined) {
      const result = await this.docker(["rm", "-f", proxyId]);
      if (result.exitCode !== 0 && !/no such container/i.test(result.stderr)) {
        proxyFailure = result;
      }
    }
    const result = await this.docker(["rm", "-f", containerId]);
    if (result.exitCode !== 0 && !/no such container/i.test(result.stderr)) {
      throw new ExecutorError(`No se pudo eliminar el contenedor ${containerId}.`, [
        result.stderr.trim().slice(-500),
      ]);
    }
    if (proxyFailure !== undefined) {
      throw new ExecutorError(`No se pudo eliminar el proxy de puerto de ${containerId}.`, [
        proxyFailure.stderr.trim().slice(-500),
      ]);
    }
  }

  /** Elimina todos los contenedores y la red de ESTA corrida. Idempotente. */
  async disposeRun(): Promise<void> {
    const list = await this.docker(["ps", "-aq", "--filter", `label=${this.runLabel}`]);
    const ids = list.stdout.split("\n").map((line) => line.trim()).filter(Boolean);
    for (const id of ids) {
      await this.docker(["rm", "-f", id]);
    }
    await this.docker(["network", "rm", this.networkName]);
    await this.docker(["network", "rm", this.accessNetworkName]);
    this.networkCreated = false;
    this.accessNetworkCreated = false;
    this.portProxies.clear();
  }

  /**
   * Barrido global: elimina CUALQUIER contenedor/red creado por cloudproof
   * (label dev.cloudproof.owner), incluso de corridas anteriores muertas a la
   * mitad. Es la garantía de "cero residuos" de la Subfase 1.A.
   */
  static async sweepAll(
    runner: CommandRunner = new SpawnRunner({ role: "orchestrator" }),
  ): Promise<void> {
    await sweepResidues(runner);
  }

  // ------------------------------------------------------------ plumbing

  private async ensureNetwork(): Promise<void> {
    if (this.networkCreated) return;
    const result = await this.docker([
      "network",
      "create",
      ...(this.blockEgress ? ["--internal"] : []),
      "--label",
      OWNER_LABEL,
      "--label",
      this.runLabel,
      this.networkName,
    ]);
    if (result.exitCode !== 0 && !/already exists/i.test(result.stderr)) {
      throw new ExecutorError(`No se pudo crear la red ${this.networkName}.`, [
        result.stderr.trim().slice(-500),
      ]);
    }
    this.networkCreated = true;
  }

  private async ensureAccessNetwork(): Promise<void> {
    if (this.accessNetworkCreated) return;
    const result = await this.docker([
      "network",
      "create",
      "--label",
      OWNER_LABEL,
      "--label",
      this.runLabel,
      this.accessNetworkName,
    ]);
    if (result.exitCode !== 0 && !/already exists/i.test(result.stderr)) {
      throw new ExecutorError(`No se pudo crear la red de acceso ${this.accessNetworkName}.`, [
        result.stderr.trim().slice(-500),
      ]);
    }
    this.accessNetworkCreated = true;
  }

  /**
   * Una red Docker --internal ignora publicaciones -p. Para mantener el
   * workload sin egress y aun así permitir host→app/Postgres, un sidecar
   * fijo (sin código del usuario) se conecta a ambas redes y reenvía un
   * único puerto al target. No es un proxy abierto ni ofrece salida general.
   */
  private async publishPort(
    targetId: string,
    targetName: string,
    targetPort: number,
  ): Promise<number> {
    if (!this.blockEgress) return this.mappedPort(targetId, `${targetPort}/tcp`);

    await this.ensureAccessNetwork();
    const proxyName = `cloudproof-port-${this.proxyCounter++}-${this.runId}`;
    const proxyScript =
      'const net=require("node:net");' +
      'const host=process.env.TARGET_HOST,port=Number(process.env.TARGET_PORT);' +
      'net.createServer((incoming)=>{' +
      'const outgoing=net.connect(port,host);' +
      'incoming.pipe(outgoing);outgoing.pipe(incoming);' +
      'const close=()=>{incoming.destroy();outgoing.destroy()};' +
      'incoming.on("error",close);outgoing.on("error",close);' +
      '}).listen(Number(process.env.LISTEN_PORT),"0.0.0.0");';
    const proxyImage = await this.localImageReference(this.portProxyImage, "portProxyImage");
    const run = await this.dockerOk(
      [
        "run",
        ...this.pullPolicy(),
        "-d",
        "--name",
        proxyName,
        "--label",
        OWNER_LABEL,
        "--label",
        this.runLabel,
        "--network",
        this.accessNetworkName,
        "--memory",
        "128m",
        "--cpus",
        "0.25",
        "--pids-limit",
        "64",
        "--security-opt",
        "no-new-privileges:true",
        "--cap-drop",
        "ALL",
        "--read-only",
        "--tmpfs",
        "/tmp:rw,noexec,nosuid,size=16m",
        "--user",
        "node",
        "-p",
        `127.0.0.1:0:${targetPort}`,
        "-e",
        `TARGET_HOST=${targetName}`,
        "-e",
        `TARGET_PORT=${targetPort}`,
        "-e",
        `LISTEN_PORT=${targetPort}`,
        proxyImage,
        "node",
        "-e",
        proxyScript,
      ],
      `proxy local para ${targetName}:${targetPort}`,
    );
    const proxyId = run.stdout.trim();
    try {
      await this.dockerOk(
        ["network", "connect", this.networkName, proxyId],
        `conexión del proxy ${proxyName} a la red interna`,
      );
      this.portProxies.set(targetId, proxyId);
      return await this.mappedPort(proxyId, `${targetPort}/tcp`);
    } catch (error) {
      await this.docker(["rm", "-f", proxyId]).catch(() => undefined);
      throw error;
    }
  }

  private async mappedPort(containerId: string, portProto: string): Promise<number> {
    const result = await this.dockerOk(
      ["port", containerId, portProto],
      `docker port de ${containerId} (${portProto})`,
    );
    const firstLine = result.stdout.split("\n").map((line) => line.trim()).filter(Boolean)[0];
    const port = Number.parseInt(firstLine?.slice(firstLine.lastIndexOf(":") + 1) ?? "", 10);
    if (!Number.isFinite(port)) {
      throw new ExecutorError(
        `Salida inesperada de docker port para ${containerId} ${portProto}: "${result.stdout.trim()}"`,
      );
    }
    return port;
  }

  private async isRunning(containerId: string): Promise<boolean> {
    const result = await this.docker(["inspect", "-f", "{{.State.Running}}", containerId]);
    return result.exitCode === 0 && result.stdout.trim() === "true";
  }

  private async logsTail(containerId: string): Promise<string[]> {
    const result = await this.docker(["logs", "--tail", "80", containerId]);
    return `${result.stdout}\n${result.stderr}`
      .split("\n")
      .map((line) => this.redactKnownSecrets(line.trim()))
      .filter(Boolean)
      .slice(-20);
  }

  /**
   * Sondas y reintentos registrados durante la corrida, en orden. Es la
   * evidencia que el Bundle expone como provenance.executorAttempts: un
   * fallo transitorio reintentado deja rastro en vez de desaparecer.
   */
  attemptLog(): readonly ExecutorAttempt[] {
    return this.attempts;
  }

  private recordAttempt(entry: ExecutorAttempt): void {
    // Cota dura: nunca crecer sin límite en memoria ni en el Bundle.
    if (this.attempts.length >= 500) return;
    this.attempts.push({
      ...entry,
      detail: this.redactKnownSecrets(entry.detail).slice(0, 500),
    });
  }

  private docker(args: string[], timeoutMs?: number): Promise<CommandResult> {
    return timeoutMs === undefined
      ? this.runner.run("docker", args)
      : this.runner.run("docker", args, { timeoutMs });
  }

  /**
   * Variante de dockerOk EXCLUSIVA para operaciones SQL de solo lectura
   * (sondas, fingerprints, dumps). Reintenta únicamente errores transitorios
   * conocidos de conexión/arranque de Postgres; cualquier error SQL real
   * (constraint, columna inexistente, permiso) se propaga al PRIMER intento:
   * esa evidencia es la razón de ser de CloudProof y jamás se reintenta. Las
   * operaciones que MUTAN estado (migraciones, restore, workload) usan
   * dockerOk directo — reintentar tras una aplicación parcial mentiría.
   */
  private async dockerOkReadRetry(
    args: string[],
    context: string,
    target: string,
    timeoutMs?: number,
    maxAttempts = 3,
  ): Promise<CommandResult> {
    let lastDetail = "";
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      let result: CommandResult;
      try {
        result = await this.docker(args, timeoutMs);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        throw new ExecutorError(`Fallo ${context}.`, [this.redactKnownSecrets(detail)]);
      }
      if (result.exitCode === 0) {
        if (attempt > 1) {
          this.recordAttempt({
            phase: "sql-read-retry",
            target,
            attempt,
            outcome: "ok",
            detail: `${context}: éxito tras ${attempt} intentos.`,
          });
        }
        return result;
      }
      lastDetail = result.stderr.trim().slice(-2000) || result.stdout.trim().slice(-2000);
      if (!isTransientPostgresError(lastDetail)) {
        throw new ExecutorError(`Falló ${context} (exit ${result.exitCode}).`, [
          this.redactKnownSecrets(lastDetail),
        ]);
      }
      this.recordAttempt({
        phase: "sql-read-retry",
        target,
        attempt,
        outcome: "transient",
        detail: lastDetail.slice(-300),
      });
      if (attempt < maxAttempts) await this.sleep(this.pollIntervalMs * attempt);
    }
    throw new ExecutorError(
      `Falló ${context} tras ${maxAttempts} intentos con errores transitorios de Postgres.`,
      [this.redactKnownSecrets(lastDetail)],
    );
  }

  private async dockerOk(
    args: string[],
    context: string,
    timeoutMs?: number,
  ): Promise<CommandResult> {
    let result: CommandResult;
    try {
      result = await this.docker(args, timeoutMs);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new ExecutorError(`Fallo ${context}.`, [this.redactKnownSecrets(detail)]);
    }
    if (result.exitCode !== 0) {
      throw new ExecutorError(`Falló ${context} (exit ${result.exitCode}).`, [
        this.redactKnownSecrets(
          result.stderr.trim().slice(-2000) || result.stdout.trim().slice(-2000),
        ),
      ]);
    }
    return result;
  }

  private redactKnownSecrets(input: string): string {
    let output = redactDiagnosticText(input);
    for (const secret of [...this.sensitiveValues].sort(
      (left, right) => right.length - left.length,
    )) {
      output = output.split(secret).join("[REDACTED]");
    }
    return output;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

/**
 * ¿`path` es un target válido para `prisma --schema`? Un archivo .prisma o
 * una carpeta que contenga al menos un .prisma (multi-archivo, buscando
 * hasta 2 niveles: `prisma/schema/` puede subdividirse por dominio).
 */
export function isPrismaSchemaTarget(path: string, depth = 2): boolean {
  if (!existsSync(path)) return false;
  const entries = (() => {
    try {
      return readdirSync(path, { withFileTypes: true });
    } catch {
      return null;
    }
  })();
  if (entries === null) return path.endsWith(".prisma");
  if (depth <= 0) return false;
  return entries.some((entry) =>
    entry.isDirectory()
      ? isPrismaSchemaTarget(join(path, entry.name), depth - 1)
      : entry.name.endsWith(".prisma"),
  );
}

/**
 * Fuentes de contexto de las instrucciones COPY/ADD de un Dockerfile.
 * Excluye copias entre stages (--from=...) y URLs de ADD, que no salen del
 * contexto de build. Soporta la forma shell y la forma exec (array JSON).
 */
export function copySources(dockerfileContents: string): string[] {
  const sources: string[] = [];
  // Une continuaciones de línea con backslash antes de parsear.
  const logicalLines = dockerfileContents.replace(/\\\r?\n/g, " ").split("\n");
  for (const line of logicalLines) {
    const match = /^\s*(?:COPY|ADD)\s+(.*)$/i.exec(line);
    if (match?.[1] === undefined) continue;
    let rest = match[1].trim();

    // Flags (--from, --chown, --chmod, --link, --exclude, --parents, ...).
    let fromStage = false;
    for (;;) {
      const flag = /^--([a-z-]+)(?:=\S+)?\s+/i.exec(rest);
      if (flag === null) break;
      if (flag[1]?.toLowerCase() === "from") fromStage = true;
      rest = rest.slice(flag[0].length).trimStart();
    }
    if (fromStage || rest === "") continue;

    let tokens: string[];
    if (rest.startsWith("[")) {
      try {
        const parsed: unknown = JSON.parse(rest);
        tokens = Array.isArray(parsed) ? parsed.filter((t): t is string => typeof t === "string") : [];
      } catch {
        continue;
      }
    } else {
      tokens = rest.split(/\s+/);
    }
    // El último token es el destino; el resto son fuentes del contexto.
    for (const source of tokens.slice(0, -1)) {
      if (/^https?:\/\//i.test(source)) continue;
      sources.push(source);
    }
  }
  return sources;
}

/**
 * ¿Existe `source` (posiblemente con wildcards de Docker en el último
 * segmento) relativa a `base`? Wildcards en segmentos intermedios no se
 * resuelven: se responde con la existencia del prefijo estático, para no
 * tomar decisiones sobre patrones que no podemos evaluar con certeza.
 */
export function contextSourceExists(base: string, source: string): boolean {
  const clean = source.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
  if (clean === "" || clean === ".") return true;
  if (!/[*?]/.test(clean)) return existsSync(join(base, clean));

  const segments = clean.split("/");
  const last = segments.pop() ?? "";
  if (segments.some((segment) => /[*?]/.test(segment))) {
    const staticPrefix = segments.slice(
      0,
      segments.findIndex((segment) => /[*?]/.test(segment)),
    );
    return staticPrefix.length === 0 ? true : existsSync(join(base, ...staticPrefix));
  }
  const parent = segments.length === 0 ? base : join(base, ...segments);
  if (!existsSync(parent)) return false;
  const pattern = new RegExp(
    "^" +
      last
        .split("")
        .map((ch) =>
          ch === "*" ? "[^/]*" : ch === "?" ? "[^/]" : ch.replace(/[.+^${}()|[\]\\]/g, "\\$&"),
        )
        .join("") +
      "$",
  );
  try {
    return readdirSync(parent).some((entry) => pattern.test(entry));
  } catch {
    return false;
  }
}

/** Detecta ADD que permitiria a BuildKit obtener contenido fuera del contexto. */
export function dockerfileHasRemoteAdd(dockerfileContents: string): boolean {
  const logicalLines = dockerfileContents.replace(/\\\r?\n/g, " ").split("\n");
  return logicalLines.some((line) => {
    const match = /^\s*ADD\s+(.*)$/i.exec(line);
    if (match?.[1] === undefined) return false;
    const value = match[1];
    return /(?:https?|git|ssh):\/\//i.test(value) || /(?:^|\s)git@[^\s:]+:/i.test(value);
  });
}

/**
 * BuildKit tiene canales fuera de `docker build --network=none` (frontend
 * remoto, cache/secret/ssh mounts y overrides por RUN). Fork los rechaza en
 * lugar de asumir que el flag global los neutraliza.
 */
export function assertSafeForkDockerfile(dockerfileContents: string): void {
  if (/^\s*#\s*syntax\s*=/im.test(dockerfileContents)) {
    throw new ExecutorError(
      "El perfil fork rechaza # syntax=: el frontend BuildKit debe ser el incorporado y confiable.",
    );
  }
  const logicalLines = dockerfileContents.replace(/\\\r?\n/g, " ").split("\n");
  for (const line of logicalLines) {
    if (!/^\s*RUN\b/i.test(line)) continue;
    if (/--mount=[^\s]*(?:type=)?(?:cache|secret|ssh)(?:,|\s|$)/i.test(line)) {
      throw new ExecutorError(
        "El perfil fork rechaza RUN --mount de cache/secret/ssh para impedir canales laterales del builder.",
      );
    }
    if (/--network=(?!none(?:\s|$))\S+/i.test(line)) {
      throw new ExecutorError("El perfil fork solo permite RUN --network=none.");
    }
    if (/--security=|--device=/i.test(line)) {
      throw new ExecutorError(
        "El perfil fork rechaza RUN --security/--device por ampliar privilegios del build.",
      );
    }
  }
}

/**
 * Imagenes externas referenciadas por FROM o COPY --from. Los aliases de
 * stages se excluyen. Una variable en esa posicion se rechaza: CloudProof no puede
 * demostrar offline que valor tomara.
 */
export function dockerfileExternalImages(dockerfileContents: string): string[] {
  const aliases = new Set<string>();
  const external = new Set<string>();
  const logicalLines = dockerfileContents.replace(/\\\r?\n/g, " ").split("\n");

  for (const line of logicalLines) {
    const from = /^\s*FROM\s+(?:(?:--platform=\S+)\s+)?(\S+)(?:\s+AS\s+(\S+))?/i.exec(line);
    if (from?.[1] !== undefined) {
      const source = from[1];
      if (source.includes("$") || source.includes("${")) {
        throw new ExecutorError(
          "El perfil fork rechazo FROM dinamico: no puede probar que la imagen este precargada.",
        );
      }
      if (source.toLowerCase() !== "scratch" && !aliases.has(source.toLowerCase())) {
        external.add(source);
      }
      if (from[2] !== undefined) aliases.add(from[2].toLowerCase());
      continue;
    }

    for (const mount of line.matchAll(/--mount=\S*?from=([^,\s]+)/gi)) {
      const mountedSource = mount[1];
      if (
        mountedSource === undefined ||
        /^\d+$/.test(mountedSource) ||
        aliases.has(mountedSource.toLowerCase())
      ) {
        continue;
      }
      if (mountedSource.includes("$")) {
        throw new ExecutorError(
          "El perfil fork rechazo RUN --mount from dinamico: el origen no es demostrable offline.",
        );
      }
      external.add(mountedSource);
    }

    const copyInstruction = /^\s*(?:COPY|ADD)\s+(.*)$/i.exec(line);
    const copied =
      copyInstruction?.[1] === undefined
        ? null
        : /(?:^|\s)--from=(\S+)/i.exec(copyInstruction[1]);
    const source = copied?.[1];
    if (source === undefined || /^\d+$/.test(source) || aliases.has(source.toLowerCase())) continue;
    if (source.includes("$") || source.includes("${")) {
      throw new ExecutorError(
        "El perfil fork rechazo COPY --from dinamico: el origen no es demostrable offline.",
      );
    }
    external.add(source);
  }
  return [...external].sort();
}
