import { z } from "zod";

/**
 * Ver tesis, sección 5.1 y 19.1 (alcance MVP): solo Node.js/TS, PostgreSQL,
 * Prisma y Docker Compose están soportados en Fase 1-2. No agregar otros
 * services/data adapters acá sin pasar antes por la regla de disciplina
 * de scope (D-016).
 */

export const ServiceKindSchema = z.enum(["nextjs", "node"]);

/**
 * El perfil efectivo se resuelve antes de cargar configuracion del checkout.
 * Este enum es el contrato comun para CLI y ejecutores.
 */
export const ExecutionProfileSchema = z.enum(["trusted", "internal", "fork"]);

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;
const WINDOWS_ABSOLUTE_PATH = /^(?:[A-Za-z]:[\\/]|[\\/]{2})/;
const ENVIRONMENT_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const CONFIGURATION_KEY = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

const ConfigurationKeySchema = z
  .string()
  .regex(CONFIGURATION_KEY, "Nombre de configuración inválido.")
  .refine(
    (value) => !["__proto__", "constructor", "prototype"].includes(value.toLowerCase()),
    "Nombre de configuración reservado.",
  );

/** Ruta confinable a un checkout. Se acepta "." y el prefijo "./". */
export const RepoRelativePathSchema = z
  .string()
  .trim()
  .min(1)
  .max(1_024)
  .refine(
    (value) =>
      !CONTROL_CHARACTERS.test(value) &&
      !value.startsWith("/") &&
      !WINDOWS_ABSOLUTE_PATH.test(value) &&
      !value.replace(/\\/g, "/").split("/").includes(".."),
    "Debe ser una ruta relativa al repo, sin '..' ni caracteres de control.",
  );

export const EnvironmentNameSchema = z
  .string()
  .min(1)
  .max(256)
  .regex(ENVIRONMENT_NAME, "Nombre de variable de entorno invalido.");

const EnvironmentValueSchema = z
  .string()
  .max(65_536)
  .refine((value) => !value.includes("\u0000"), "El valor no puede contener NUL.");

export const ServiceSchema = z.object({
  kind: ServiceKindSchema,
  path: RepoRelativePathSchema,
  port: z.number().int().positive().max(65535).optional(),
  /**
   * Ruta al schema Prisma relativa a la raíz del repo (no a `path`). Acepta
   * un archivo `schema.prisma` o una carpeta de schemas multi-archivo
   * (`prisma/schema/`). Default: `<path>/prisma/schema.prisma` con fallback
   * a `prisma/schema.prisma` y a las variantes de carpeta.
   */
  prismaSchema: RepoRelativePathSchema.optional(),
  /**
   * Ruta al Dockerfile relativa a la raíz del repo, para repos que usan un
   * nombre o ubicación no convencional (ej. "docker/Dockerfile.web").
   * Default: `<path>/Dockerfile` con fallback al `Dockerfile` de la raíz.
   */
  dockerfile: RepoRelativePathSchema.optional(),
  /**
   * De qué commit sale el CONTENIDO del Dockerfile (informe Bs As
   * Neumáticos 2026-07). Default "commit": cada lado se construye con el
   * Dockerfile de su propio commit — inmutabilidad estricta. "head" cubre el
   * onboarding real: el candidato AGREGA el Dockerfile y el commit base
   * desplegado no lo tiene; ambos lados se construyen con el Dockerfile del
   * candidato (contenido inmutable, tomado del headSha verificado) mientras
   * las fuentes siguen saliendo del worktree de cada lado. El Bundle registra
   * esa procedencia en la evidencia de BUILD_A0.
   */
  dockerfileFrom: z.enum(["commit", "head"]).optional(),
  /**
   * Contexto de build relativo a la raíz del repo. Default: inferido — la
   * carpeta del Dockerfile, salvo que sus COPY/ADD referencien archivos que
   * solo existen en la raíz (patrón Turborepo: `docker build -f
   * apps/web/Dockerfile .`), en cuyo caso el contexto es la raíz.
   */
  buildContext: RepoRelativePathSchema.optional(),
  /**
   * --build-arg para la imagen (ej. { SELF_HOSTED: "true" }). `cloudproof init`
   * los adopta automáticamente del docker-compose del repo cuando ese
   * compose construye el mismo Dockerfile.
   */
  buildArgs: z.record(EnvironmentNameSchema, EnvironmentValueSchema).optional(),
  /**
   * Variables de entorno de RUNTIME para el contenedor de la app (el
   * equivalente al env_file del docker-compose del repo). DATABASE_URL y
   * PORT los fija CloudProof y no pueden sobrescribirse desde acá.
   */
  env: z.record(EnvironmentNameSchema, EnvironmentValueSchema).optional(),
  /**
   * Tiempo máximo (ms) para que la app acepte HTTP tras arrancar. Default
   * 60000; subilo para apps con bootstraps pesados (ej. entrypoints que
   * post-procesan el build antes de escuchar).
   */
  readinessTimeoutMs: z.number().int().positive().max(600_000).optional(),
}).strict().superRefine((service, context) => {
  if (Object.keys(service.buildArgs ?? {}).length > 256) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["buildArgs"], message: "Máximo 256 build args." });
  }
  if (Object.keys(service.env ?? {}).length > 256) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["env"], message: "Máximo 256 variables de runtime." });
  }
});

export const DataKindSchema = z.enum(["postgres", "redis"]);

export const DataSourceSchema = z.object({
  kind: DataKindSchema,
  version: z.number().int().positive().max(1_000).optional(),
  /**
   * Génesis alternativa de S0 (informe Lubrisur 2026-07, 2ª ronda): un .sql
   * del repo con el dump de la base DESPLEGADA — schema + contenido de la
   * tabla `_prisma_migrations` — para repos cuya historia de migraciones no
   * se reconstruye desde cero (migraciones editadas después de aplicadas,
   * `db push`, `migrate resolve`). CloudProof aplica este dump al seed S0
   * ANTES de `migrate deploy`; Prisma entonces aplica solo las migraciones
   * que producción aún no registró — la MISMA transición que ejecutará el
   * deploy real. Generarlo:
   *   pg_dump "$DATABASE_URL" --schema-only --no-owner --no-privileges
   *   pg_dump "$DATABASE_URL" --data-only --table=_prisma_migrations --no-owner --no-privileges
   * Sin `_prisma_migrations` el archivo se rechaza antes de gastar Docker.
   * El digest sha256 queda en la evidencia del Bundle: la corrida declara
   * explícitamente que S0 nació de un baseline y no de un replay completo.
   */
  schemaBaseline: RepoRelativePathSchema.optional(),
}).strict().superRefine((data, context) => {
  if (data.kind !== "postgres" && data.schemaBaseline !== undefined) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["schemaBaseline"],
      message: "schemaBaseline solo aplica a data sources con kind \"postgres\".",
    });
  }
});

export const ReleaseStrategySchema = z.enum(["migration-first"]);
export const RollbackStrategySchema = z.enum(["application"]);

export const ReleaseConfigSchema = z.object({
  strategy: ReleaseStrategySchema,
  rollback: RollbackStrategySchema,
}).strict();

/**
 * "Tests existentes como workload" (tesis 19.1): el comando que corre la
 * suite del usuario contra la app base durante release verify. CloudProof le
 * inyecta CLOUDPROOF_BASE_URL con la URL del proxy de captura — la suite debe
 * usar esa URL como base. Comando + args explícitos (sin shell) para ser
 * portable entre Windows y POSIX sin quoting frágil.
 */
export const WorkloadConfigSchema = z.object({
  command: z
    .string()
    .trim()
    .min(1)
    .max(1_024)
    .refine(
      (value) => !CONTROL_CHARACTERS.test(value),
      "El comando no puede contener caracteres de control.",
    ),
  args: z
    .array(
      z
        .string()
        .max(16_384)
        .refine((value) => !value.includes("\u0000"), "Un argumento no puede contener NUL."),
    )
    .max(512)
    .default([]),
  timeoutMs: z.number().int().positive().max(3_600_000).optional(),
}).strict();

/**
 * Fixtures HTTP (informe 2026-07-18, gate 2): preparación de identidad y
 * datos ANTES del workload, siempre a través de CLOUDPROOF_BASE_URL — el mismo
 * proxy de captura. Sus exchanges quedan grabados como prefijo replayable,
 * así cada celda de la matriz recrea la misma identidad/datos al hacer
 * replay. `beforeAll` puede exportar variables (p.ej. un token) escribiendo
 * líneas KEY=VALUE en el archivo apuntado por CLOUDPROOF_FIXTURE_ENV; el workload
 * las recibe en su entorno. No recibe DATABASE_URL: mutar por fuera de la
 * superficie HTTP observada rompería la atribución del replay.
 *
 * No existe `afterAll` a propósito: los entornos de CloudProof son efímeros y el
 * executor los destruye; la limpieza es responsabilidad del plano de
 * ejecución, no del workload.
 */
export const FixturesConfigSchema = z
  .object({
    beforeAll: WorkloadConfigSchema.optional(),
    /**
     * Bootstrap SQL de identidad/datos de referencia (informe Bs As
     * Neumáticos 2026-07: apps con rutas autenticadas y SIN signup público
     * no tenían forma legítima de crear el primer usuario). Es un archivo
     * .sql del repo que CloudProof aplica UNA vez por corrida, dentro del
     * contenedor Postgres, después de `migrate deploy` del commit base y
     * ANTES de arrancar cualquier app: forma parte de la preparación del
     * entorno (como una migración), no del workload — la regla "las
     * escrituras del workload son HTTP observables" queda intacta. Todas
     * las celdas de la matriz lo heredan por clonación del seed S0, y su
     * digest sha256 queda en la evidencia del Bundle. Patrón típico: crear
     * el usuario semilla acá (hash bcrypt literal) y obtener el token vía
     * fixtures.beforeAll con el login HTTP real.
     */
    bootstrapSql: RepoRelativePathSchema.optional(),
  })
  .strict();

export const CoverageConfigSchema = z.object({
  requiredRoutes: z
    .array(z.string().max(2_048).regex(/^(GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS)\s+\//i))
    .min(1)
    .max(2_000),
  /**
   * Lecturas idempotentes capturadas después de la última escritura. CloudProof
   * las ejecuta exactamente una vez con A0 después de escrituras de A1.
   * Si se omite, intenta derivarlas del tail del workload y falla cerrado si
   * no existe ninguna.
   */
  rollbackProbeRoutes: z
    .array(z.string().regex(/^(GET|HEAD|OPTIONS)\s+\//i))
    .min(1)
    .max(100)
    .optional(),
}).strict();

/**
 * Override explícito de la clasificación de variables de entorno que
 * `cloudproof doctor` infiere del código (required = la app la asume presente;
 * optional = módulo condicional, ej. ARCA o WhatsApp). El repo sabe más que
 * cualquier heurística: lo declarado acá gana siempre sobre lo inferido.
 */
export const EnvClassificationSchema = z
  .object({
    required: z.array(EnvironmentNameSchema).max(256).optional(),
    optional: z.array(EnvironmentNameSchema).max(256).optional(),
  })
  .strict();

export const ApprovalConfigSchema = z.object({
  assertionId: z.string().trim().min(1).max(256),
  reason: z.string().trim().min(1).max(2_048),
  expiresAt: z.string().datetime().optional(),
}).strict();

/**
 * Los nombres de política referencian implementaciones registradas en
 * @cloudproof/policy-engine (ver packages/policy-engine/src/policies).
 */
export const ProjectConfigSchema = z
  .object({
    services: z.record(ConfigurationKeySchema, ServiceSchema),
    data: z.record(ConfigurationKeySchema, DataSourceSchema),
    flows: z.array(z.string().min(1).max(2_048)).max(1_000).default([]),
    release: ReleaseConfigSchema,
    policies: z.array(z.string().min(1).max(256)).max(100).default([]),
    workload: WorkloadConfigSchema.optional(),
    fixtures: FixturesConfigSchema.optional(),
    coverage: CoverageConfigSchema.optional(),
    env: EnvClassificationSchema.optional(),
    approvals: z.array(ApprovalConfigSchema).max(100).default([]),
  })
  .strict()
  .superRefine((config, context) => {
    if (Object.keys(config.services).length < 1 || Object.keys(config.services).length > 100) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["services"],
        message: "Se requiere entre 1 y 100 servicios.",
      });
    }
    if (Object.keys(config.data).length > 100) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["data"],
        message: "Máximo 100 data sources.",
      });
    }
    const seen = new Set<string>();
    config.approvals.forEach((approval, index) => {
      if (seen.has(approval.assertionId)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["approvals", index, "assertionId"],
          message: `Approval duplicada para ${approval.assertionId}.`,
        });
      }
      seen.add(approval.assertionId);
    });
  });

export type ServiceConfig = z.infer<typeof ServiceSchema>;
export type ExecutionProfile = z.infer<typeof ExecutionProfileSchema>;
export type DataSourceConfig = z.infer<typeof DataSourceSchema>;
export type ReleaseConfig = z.infer<typeof ReleaseConfigSchema>;
export type WorkloadConfig = z.infer<typeof WorkloadConfigSchema>;
export type FixturesConfig = z.infer<typeof FixturesConfigSchema>;
export type CoverageConfig = z.infer<typeof CoverageConfigSchema>;
export type EnvClassificationConfig = z.infer<typeof EnvClassificationSchema>;
export type ApprovalConfig = z.infer<typeof ApprovalConfigSchema>;
export type ProjectConfig = z.infer<typeof ProjectConfigSchema>;
