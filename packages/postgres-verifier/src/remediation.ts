import type { Assertion, ExecutionState, Remediation, RemediationStep } from "@cloudproof/schema";

/**
 * Catálogo determinista de recetas expand/contract (tesis 7.6 y demo
 * canónica 19.5). Una receta se dispara EXCLUSIVAMENTE por evidencia
 * reproducible: un SQLSTATE observado en un estado de ejecución concreto.
 * No hay heurísticas ni inferencia generativa (D-005/D-015); si el catálogo
 * no reconoce el fallo, la assertion simplemente no lleva remediation.
 *
 * Los títulos de los pasos son cortos y en inglés porque son la salida de la
 * demo canónica ("Add nullable column", ...); el detail lleva tabla/columna
 * concretas cuando la evidencia las expone.
 */

const SQLSTATE_PATTERN = /SQLSTATE\s*:?\s*([0-9A-Z]{5})/i;
const PRISMA_CODE_PATTERN = /\b(P\d{4})\b/i;
const COLUMN_PATTERN = /column "([^"]+)"/i;
const RELATION_PATTERN = /(?:relation|table) "([^"]+)"/i;

/**
 * Las apps que acceden a Postgres vía Prisma Client reportan códigos P2xxx
 * en vez del SQLSTATE crudo (gate 1.E: el 23502 de workout-cool llegó como
 * P2011). Mismo fallo de fondo → misma receta del catálogo.
 */
const PRISMA_CODE_ALIASES: Record<string, string> = {
  P2011: "23502", // null constraint violation
  P2002: "23505", // unique constraint failed
  P2003: "23503", // foreign key constraint failed
  // P2004 no se convierte: Prisma lo usa para constraints diversas y sin
  // metadata no demuestra que sea un CHECK/23514.
  P2000: "22001", // value too long for column type
  P2022: "42703", // column does not exist
  P2021: "42P01", // table does not exist
};

interface EvidenceContext {
  /** Línea exacta de evidencia que disparó la receta. */
  line: string;
  column: string | undefined;
  table: string | undefined;
}

/** "columna currency de payments" / "the column" según qué expuso el error. */
function describeColumn(context: EvidenceContext): string {
  if (context.column !== undefined && context.table !== undefined) {
    return `column "${context.column}" of "${context.table}"`;
  }
  if (context.column !== undefined) return `column "${context.column}"`;
  return "the affected column";
}

function describeTable(context: EvidenceContext): string {
  return context.table !== undefined ? `table "${context.table}"` : "the affected table";
}

function steps(
  ...definitions: Array<[RemediationStep["phase"], string, string]>
): RemediationStep[] {
  return definitions.map(([phase, title, detail], index) => ({
    order: index + 1,
    phase,
    title,
    detail,
  }));
}

type RecipeBuilder = (context: EvidenceContext) => Omit<Remediation, "triggeredBy">;

/**
 * Estado de ejecución agrupado por significado:
 *  - "replay": la app desplegada (A0) falló contra el schema migrado (A0_S1).
 *  - "migration": la migración candidata falló sobre datos reales
 *    (MIGRATE_S0_TO_S1) — fallo data-dependent.
 */
type FailureStage =
  | "old-app-new-schema"
  | "new-app-old-schema"
  | "candidate-final"
  | "coexistence"
  | "rollback"
  | "migration";

const CATALOG = new Map<`${FailureStage}:${string}`, RecipeBuilder>([
  [
    // not_null_violation durante el replay: A0 no escribe la columna nueva.
    "old-app-new-schema:23502",
    (context) => ({
      pattern: "postgres.not-null-column-old-app-writes",
      strategy: "expand-contract",
      summary:
        `The deployed application cannot write to the migrated schema: ` +
        `${describeColumn(context)} is NOT NULL and the deployed version does not provide it.`,
      steps: steps(
        [
          "expand",
          "Add nullable column",
          `Recreate ${describeColumn(context)} as NULLable (or with a database DEFAULT) so writes from the deployed version keep succeeding.`,
        ],
        [
          "deploy",
          "Deploy dual-write app",
          `Ship the application version that always writes ${describeColumn(context)} while the old version may still be running.`,
        ],
        [
          "backfill",
          "Backfill",
          `Backfill ${describeColumn(context)} for existing rows once dual-write is fully deployed.`,
        ],
        [
          "contract",
          "Add NOT NULL in later release",
          `Enforce NOT NULL on ${describeColumn(context)} in a follow-up migration, after no deployed version can write NULL.`,
        ],
      ),
    }),
  ],
  [
    // not_null_violation durante la migración: SET NOT NULL sobre filas con NULL.
    "migration:23502",
    (context) => ({
      pattern: "postgres.set-not-null-over-existing-nulls",
      strategy: "safe-sequence",
      summary:
        `The candidate migration cannot apply to real data: it enforces NOT NULL on ` +
        `${describeColumn(context)} while existing rows contain NULL.`,
      steps: steps(
        [
          "backfill",
          "Backfill existing rows",
          `Populate ${describeColumn(context)} for existing rows (UPDATE ... WHERE ${context.column !== undefined ? `"${context.column}"` : "<column>"} IS NULL) in its own migration, before any constraint change.`,
        ],
        [
          "contract",
          "Add NOT NULL after backfill",
          `Apply SET NOT NULL in a later migration, once the backfill is verified against production-shaped data.`,
        ],
      ),
    }),
  ],
  [
    // undefined_column durante el replay: se eliminó/renombró una columna en uso.
    "old-app-new-schema:42703",
    (context) => ({
      pattern: "postgres.dropped-column-still-used",
      strategy: "expand-contract",
      summary:
        `The deployed application still reads or writes ${describeColumn(context)}, ` +
        `which the candidate migration drops or renames.`,
      steps: steps(
        [
          "expand",
          "Keep the column during the transition",
          `Do not drop or rename ${describeColumn(context)} in the same release; if renaming, add the new column alongside the old one.`,
        ],
        [
          "deploy",
          "Deploy the app that no longer uses it",
          `Ship the application version that stopped referencing ${describeColumn(context)} (dual-read/dual-write if renaming).`,
        ],
        [
          "contract",
          "Drop the column in a later release",
          `Remove ${describeColumn(context)} in a follow-up migration, after no deployed version references it.`,
        ],
      ),
    }),
  ],
  [
    // undefined_table durante el replay: se eliminó/renombró una tabla en uso.
    "old-app-new-schema:42P01",
    (context) => ({
      pattern: "postgres.dropped-table-still-used",
      strategy: "expand-contract",
      summary:
        `The deployed application still uses ${describeTable(context)}, ` +
        `which the candidate migration drops or renames.`,
      steps: steps(
        [
          "expand",
          "Keep the table during the transition",
          `Do not drop or rename ${describeTable(context)} in the same release; if renaming, create the new table (or a compatibility view) alongside it.`,
        ],
        [
          "deploy",
          "Deploy the app that no longer uses it",
          `Ship the application version that stopped referencing ${describeTable(context)}.`,
        ],
        [
          "contract",
          "Drop the table in a later release",
          `Remove ${describeTable(context)} in a follow-up migration, after no deployed version references it.`,
        ],
      ),
    }),
  ],
  [
    // unique_violation durante la migración: índice único sobre datos con duplicados.
    "migration:23505",
    (context) => ({
      pattern: "postgres.unique-over-duplicates",
      strategy: "safe-sequence",
      summary:
        `The candidate migration cannot apply to real data: a new unique constraint on ` +
        `${describeTable(context)} conflicts with existing duplicate rows.`,
      steps: steps(
        [
          "backfill",
          "Deduplicate existing rows",
          `Remove or merge the duplicate rows in ${describeTable(context)} in its own migration or script, before creating the constraint.`,
        ],
        [
          "contract",
          "Create the unique constraint after dedup",
          `Add the unique constraint/index in a later migration, once the deduplication is verified.`,
        ],
      ),
    }),
  ],
  [
    // unique_violation durante el replay: el patrón de escritura de A0 viola la unicidad nueva.
    "old-app-new-schema:23505",
    (context) => ({
      pattern: "postgres.unique-breaks-old-writes",
      strategy: "expand-contract",
      summary:
        `The deployed application's writes violate a unique constraint the candidate migration adds on ` +
        `${describeTable(context)}.`,
      steps: steps(
        [
          "deploy",
          "Deploy conflict-aware app first",
          `Ship the application version whose writes respect the new uniqueness (e.g. upsert/ON CONFLICT) before adding the constraint.`,
        ],
        [
          "contract",
          "Add the unique constraint in a later release",
          `Create the unique constraint/index in a follow-up migration, after no deployed version can produce duplicates.`,
        ],
      ),
    }),
  ],
  [
    // string_data_right_truncation: se achicó una columna que A0 sigue llenando.
    "old-app-new-schema:22001",
    (context) => ({
      pattern: "postgres.column-shrunk-under-old-writes",
      strategy: "expand-contract",
      summary:
        `The deployed application writes values longer than the new size of ${describeColumn(context)}.`,
      steps: steps(
        [
          "expand",
          "Restore the previous column size",
          `Keep ${describeColumn(context)} at its previous size during the transition; do not shrink it in this release.`,
        ],
        [
          "deploy",
          "Deploy the app that writes shorter values",
          `Ship the application version that enforces the new length before changing the column type.`,
        ],
        [
          "contract",
          "Shrink the column in a later release",
          `Reduce the size of ${describeColumn(context)} in a follow-up migration, after validating existing data fits.`,
        ],
      ),
    }),
  ],
  [
    // foreign_key_violation durante el replay: una FK nueva rompe las escrituras de A0.
    "old-app-new-schema:23503",
    (context) => ({
      pattern: "postgres.foreign-key-breaks-old-writes",
      strategy: "expand-contract",
      summary:
        `The deployed application's writes violate a foreign key the candidate migration adds on ` +
        `${describeTable(context)}.`,
      steps: steps(
        [
          "deploy",
          "Deploy the compatible writer first",
          `Ship the application version that always writes referentially valid rows before creating the foreign key; NOT VALID still checks every new insert/update.`,
        ],
        [
          "expand",
          "Add the foreign key as NOT VALID",
          `After the old writer is gone, add the foreign key on ${describeTable(context)} as NOT VALID to avoid scanning historical rows during creation.`,
        ],
        [
          "backfill",
          "Repair orphan rows",
          `Backfill or delete rows that violate the new reference, once dual-write is deployed.`,
        ],
        [
          "contract",
          "VALIDATE CONSTRAINT in a later release",
          `Run VALIDATE CONSTRAINT in a follow-up migration, after the repair is verified.`,
        ],
      ),
    }),
  ],
  [
    // check_violation durante el replay: un CHECK nuevo rompe las escrituras de A0.
    "old-app-new-schema:23514",
    (context) => ({
      pattern: "postgres.check-breaks-old-writes",
      strategy: "expand-contract",
      summary:
        `The deployed application's writes violate a CHECK constraint the candidate migration adds on ` +
        `${describeTable(context)}.`,
      steps: steps(
        [
          "deploy",
          "Deploy the compatible writer first",
          `Ship the application version whose writes satisfy the new condition before creating the CHECK; NOT VALID still checks every new insert/update.`,
        ],
        [
          "expand",
          "Add the CHECK as NOT VALID",
          `After the old writer is gone, add the CHECK on ${describeTable(context)} as NOT VALID to defer the scan of historical rows.`,
        ],
        [
          "contract",
          "VALIDATE CONSTRAINT in a later release",
          `Run VALIDATE CONSTRAINT in a follow-up migration, after existing data is repaired and verified.`,
        ],
      ),
    }),
  ],
]);

function stageFor(state: ExecutionState | undefined): FailureStage | undefined {
  if (state === "A0_S1") return "old-app-new-schema";
  if (state === "A1_S0") return "new-app-old-schema";
  if (state === "A1_S1") return "candidate-final";
  if (state === "COEXIST_A0_A1_S1") return "coexistence";
  if (state === "ROLLBACK_A0_AFTER_A1_WRITES") return "rollback";
  if (state === "MIGRATE_S0_TO_S1") return "migration";
  return undefined;
}

/**
 * Devuelve la receta determinista para una assertion fallida, o undefined si
 * el catálogo no reconoce la evidencia. Las assertions aprobadas no llevan
 * receta: la approval registra que el cambio es intencional.
 */
export function remediationFor(
  assertion: Pick<Assertion, "result" | "state" | "evidence" | "approval">,
): Remediation | undefined {
  if (assertion.result !== "fail" || assertion.approval !== undefined) return undefined;
  const stage = stageFor(assertion.state);
  if (stage === undefined) return undefined;

  for (const line of assertion.evidence) {
    const raw =
      SQLSTATE_PATTERN.exec(line)?.[1]?.toUpperCase() ??
      PRISMA_CODE_PATTERN.exec(line)?.[1]?.toUpperCase();
    if (raw === undefined) continue;
    const sqlstate = PRISMA_CODE_ALIASES[raw] ?? raw;
    const build = CATALOG.get(`${stage}:${sqlstate}`);
    if (build === undefined) continue;
    const context: EvidenceContext = {
      line,
      column: COLUMN_PATTERN.exec(line)?.[1],
      table: RELATION_PATTERN.exec(line)?.[1],
    };
    return { ...build(context), triggeredBy: [line] };
  }
  return undefined;
}

/** Adjunta la receta del catálogo a una assertion fallida que no tenga una. */
export function withRemediation(assertion: Assertion): Assertion {
  if (assertion.remediation !== undefined) return assertion;
  const remediation = remediationFor(assertion);
  return remediation === undefined ? assertion : { ...assertion, remediation };
}
