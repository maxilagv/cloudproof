/**
 * Ver tesis, sección 19.3 (flujo técnico), pasos 1-7: resolver SHAs,
 * construir imagen base y candidata, levantar Postgres efímero,
 * aplicar migraciones, arrancar la app base contra el schema migrado.
 */

export interface BuildSpec {
  /** SHA de la app "vieja" (A0) o "candidata" (A1). */
  sha: string;
  /** Ruta al servicio dentro del repo, ej. "./apps/api". */
  servicePath: string;
  /**
   * Ruta worktree-relativa a un Dockerfile con nombre/ubicación custom
   * (ej. "docker/Dockerfile.web"). Default: `<servicePath>/Dockerfile`
   * con fallback al `Dockerfile` de la raíz.
   */
  dockerfile?: string;
  /**
   * SHA cuyo worktree provee el CONTENIDO del Dockerfile cuando difiere de
   * `sha` (caso onboarding: el candidato agrega el Dockerfile y el commit
   * base no lo tiene). Las fuentes del build siguen saliendo del worktree
   * de `sha`; solo la receta viene del otro commit — inmutable igual,
   * porque ese SHA también es content-addressed.
   */
  dockerfileFromSha?: string;
  /**
   * Contexto de build worktree-relativo. Default: inferido analizando los
   * COPY/ADD del Dockerfile (patrón Turborepo: contexto en la raíz).
   */
  buildContext?: string;
  /** --build-arg del docker build, ej. { SELF_HOSTED: "true" }. */
  buildArgs?: Record<string, string>;
}

export interface EphemeralPostgresSpec {
  /** "S0" (baseline) o "S1" (con la migración candidata aplicada). */
  label: "S0" | "S1";
  migrationsUpToSha: string;
  /** Servicio que contiene prisma/schema.prisma en monorepos. */
  servicePath?: string;
  /** Ruta explícita al schema Prisma, relativa al worktree. */
  prismaSchema?: string;
  /** Si existe, S1 se restaura desde este Postgres antes de migrar. */
  cloneFromContainerId?: string;
  /**
   * Ruta HOST-absoluta a un .sql de bootstrap (identidad/datos de
   * referencia) que se aplica dentro del contenedor, con ON_ERROR_STOP,
   * inmediatamente después de las migraciones. Solo aplica en bases NO
   * clonadas: los clones ya lo heredan del origen. Es preparación de
   * entorno (como una migración), no workload.
   */
  bootstrapSql?: string;
  /**
   * Ruta HOST-absoluta al dump SQL de la base desplegada (schema +
   * `_prisma_migrations`) que se aplica ANTES de `migrate deploy` como
   * génesis del seed (informe Lubrisur 2026-07, 2ª ronda: historias de
   * migraciones irreplayables desde cero). Solo aplica en bases NO
   * clonadas: los clones lo heredan del origen.
   */
  schemaBaselineSql?: string;
}

export interface SqlEffectCounters {
  table: string;
  inserted: number;
  updated: number;
  deleted: number;
}

export interface SqlEffectSnapshot {
  tables: SqlEffectCounters[];
}

export interface DatabaseSchemaFingerprint {
  /** Digest canónico de tablas, columnas, defaults, constraints, índices, views y triggers. */
  digest: `sha256:${string}`;
}

/**
 * Asimetría deliberada de connectionUrl según quién consume el recurso:
 *  - Postgres efímero: URL de red interna de Docker (postgresql://...@<nombre>:5432/...),
 *    porque la consume la APP contenedorizada en la misma red (verify.ts la
 *    pasa como DATABASE_URL). hostConnectionUrl expone además la URL
 *    127.0.0.1:<puerto> para herramientas del host (debug, cloudproof reproduce).
 *  - App: URL http://127.0.0.1:<puerto>, porque la consume el Replayer que
 *    corre en el host.
 */
export interface RunningContainer {
  id: string;
  serviceName: string;
  connectionUrl?: string;
  /** Solo para Postgres efímero: la misma base, alcanzable desde el host. */
  hostConnectionUrl?: string;
  /** Puerto TCP dentro del contenedor, cuando aplica. */
  containerPort?: number;
}

/**
 * Sonda o reintento registrado por el ejecutor. Cota dura de 500 entradas
 * por corrida; el detail se redacta y trunca antes de almacenarse. Se
 * expone en el Bundle (provenance.executorAttempts) para que un fallo
 * transitorio reintentado deje rastro en la evidencia.
 */
export interface ExecutorAttempt {
  phase: "postgres-readiness" | "sql-read-retry";
  /** Contenedor o recurso objetivo (nombre de servicio o id). */
  target: string;
  /** Número de intento/sonda (1-based) dentro de la fase. */
  attempt: number;
  outcome: string;
  detail: string;
}

export interface DockerExecutor {
  buildImage(spec: BuildSpec): Promise<string>;
  startEphemeralPostgres(spec: EphemeralPostgresSpec): Promise<RunningContainer>;
  startApp(imageTag: string, env: Record<string, string>): Promise<RunningContainer>;
  imageDigest(imageTag: string): Promise<string>;
  captureSqlEffects(containerId: string): Promise<SqlEffectSnapshot>;
  captureSchemaFingerprint(containerId: string): Promise<DatabaseSchemaFingerprint>;
  exportPostgres(containerId: string, destinationPath: string): Promise<void>;
  teardown(containerId: string): Promise<void>;
  /** Sondas/reintentos de la corrida; opcional para ejecutores de test. */
  attemptLog?(): readonly ExecutorAttempt[];
}
