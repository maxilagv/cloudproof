/**
 * Informe Lubrisur 2026-07 (2ª ronda): la corrida quedó INCONCLUSIVE porque
 * la historia de migraciones del commit BASE no se puede reconstruir sobre
 * una base vacía (`20260531162000_fase2_operaciones` re-creaba una columna
 * que la migración inicial ya había creado). El fallo llegaba como un
 * `postgres.baseline-schema` genérico ("Address the cause") y el agente
 * tenía que deducir solo que (a) la migración culpable era histórica y
 * (b) el candidato no tenía nada que ver.
 *
 * Este módulo clasifica ese modo de fallo a partir de la evidencia textual
 * de `prisma migrate deploy` — determinista, sin heurísticas generativas
 * (D-005/D-015): si los marcadores de Prisma no están, no clasifica y el
 * flujo cae al fallo genérico de siempre.
 *
 * La atribución es ESTRUCTURAL, no inferida: el seed S0 se construye
 * exclusivamente con las migraciones del commit base, así que un fallo al
 * levantarlo nunca puede ser causado por el candidato.
 */

/** Códigos de `prisma migrate` que señalan una historia no aplicable. */
const PRISMA_MIGRATE_CODES = /\bP30(?:06|09|11|18)\b/;
const APPLYING_MIGRATION = /Applying migration `([^`]+)`/;
const MIGRATION_NAME = /Migration name:\s*(\S+)/;
const DATABASE_ERROR_CODE = /Database error code:\s*([0-9A-Z]{5})/i;
const DATABASE_ERROR_LINE = /^\s*ERROR:\s*(.+)$/m;
/** Nombre de carpeta de migración Prisma: timestamp de 14 dígitos + slug. */
const MIGRATION_FOLDER = /\b(\d{14}_[A-Za-z0-9_]+)\b/;

export interface MigrationApplyFailure {
  /** Carpeta de la migración que no aplica, ej. "20260531162000_fase2_operaciones". */
  migrationName?: string;
  /** SQLSTATE reportado por Postgres, ej. "42701" (duplicate_column). */
  databaseErrorCode?: string;
  /** Línea "ERROR: ..." exacta de Postgres, ya redactada aguas arriba. */
  databaseError?: string;
  /** Código de prisma migrate observado (P3006/P3009/P3011/P3018), si hubo. */
  prismaCode?: string;
}

/**
 * Clasifica la evidencia de un fallo al construir el seed S0 como "historia
 * de migraciones irreplayable". Devuelve undefined si la evidencia no
 * contiene marcadores de `prisma migrate` — un timeout de Docker o un
 * fallo de red NO deben disfrazarse de problema de migraciones.
 */
export function classifyMigrationApplyFailure(
  evidence: readonly string[],
): MigrationApplyFailure | undefined {
  const text = evidence.join("\n");
  const prismaCode = PRISMA_MIGRATE_CODES.exec(text)?.[0];
  const applying = APPLYING_MIGRATION.exec(text)?.[1];
  const named = MIGRATION_NAME.exec(text)?.[1];
  const errorLine = DATABASE_ERROR_LINE.exec(text)?.[1]?.trim();

  // Señal mínima: un código P30xx de migrate, o el par "migración nombrada +
  // ERROR de Postgres" que produce el propio migrate deploy.
  const migrationMarker = named ?? applying;
  if (prismaCode === undefined && (migrationMarker === undefined || errorLine === undefined)) {
    return undefined;
  }

  const failure: MigrationApplyFailure = {};
  const migrationName = migrationMarker ?? MIGRATION_FOLDER.exec(text)?.[1];
  if (migrationName !== undefined) failure.migrationName = migrationName;
  const code = DATABASE_ERROR_CODE.exec(text)?.[1];
  if (code !== undefined) failure.databaseErrorCode = code.toUpperCase();
  if (errorLine !== undefined) failure.databaseError = `ERROR: ${errorLine}`;
  if (prismaCode !== undefined) failure.prismaCode = prismaCode;
  return failure;
}
