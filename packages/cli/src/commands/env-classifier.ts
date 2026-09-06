import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { generatedSegmentOf } from "@cloudproof/plugin-sdk";

/**
 * Clasificación de variables de .env.example por EVIDENCIA de uso en el
 * código (informe Lubrisur 2026-07: "no distingue variable documentada de
 * variable obligatoria"). Tres clases, cada una con su evidencia:
 *
 *  - required: al menos una lectura SIN guardia ni fallback (la app la
 *    asume presente); se cita archivo:línea.
 *  - conditional: todas las lecturas están guardadas (`??`, `||`, if(!...),
 *    comparaciones, .optional() de zod) — típico de módulos opcionales como
 *    ARCA o WhatsApp.
 *  - unreferenced: documentada pero ningún archivo la lee.
 *
 * Es un análisis léxico determinista y acotado, no un type-checker: por eso
 * la severidad aguas arriba nunca supera MEDIUM y cloudproof.config puede
 * declarar overrides (env.required / env.optional) cuando el repo sabe más.
 */

export type EnvKeyUsage = "required" | "conditional" | "unreferenced";

export interface EnvKeyClassification {
  key: string;
  usage: EnvKeyUsage;
  /** Hasta 3 citas archivo:línea que sostienen el veredicto. */
  evidence: string[];
}

const SOURCE_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
]);
const IGNORED_DIRECTORIES = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "out",
  ".next",
  ".turbo",
  "coverage",
  ".cloudproof",
]);
const MAX_FILES = 4_000;
const MAX_FILE_BYTES = 1_536 * 1024;
const MAX_EVIDENCE_PER_KEY = 3;

/**
 * Señales de que la lectura tolera ausencia. Se evalúan sobre la línea de la
 * ocurrencia: un fallback (`??`/`||`), una comparación, un typeof/in, un
 * negado en un if, o un .optional() de schema en la misma línea.
 */
const GUARD_SIGNALS = [
  "??",
  "||",
  "===",
  "!==",
  "==",
  "!=",
  "typeof ",
  ".optional(",
  "if (!",
  "if(!",
  " in process.env",
  "hasOwn",
  "hasOwnProperty",
];

function lineIsGuarded(line: string): boolean {
  return GUARD_SIGNALS.some((signal) => line.includes(signal));
}

/** Archivos fuente del repo, orden determinista, con límites de tamaño. */
function sourceFiles(cwd: string): string[] {
  const found: string[] = [];
  const visit = (relativePath: string, depth: number): void => {
    if (depth > 8 || found.length >= MAX_FILES) return;
    const absolute = relativePath === "" ? cwd : join(cwd, relativePath);
    let entries;
    try {
      entries = readdirSync(absolute, { withFileTypes: true }).sort((left, right) =>
        left.name.localeCompare(right.name),
      );
    } catch {
      return;
    }
    for (const entry of entries) {
      if (found.length >= MAX_FILES) return;
      const childRelative = relativePath === "" ? entry.name : `${relativePath}/${entry.name}`;
      if (entry.isDirectory()) {
        if (IGNORED_DIRECTORIES.has(entry.name)) continue;
        // El código generado lee env vars propias de su runtime; no es
        // evidencia de lo que la APLICACIÓN exige.
        if (generatedSegmentOf(entry.name) !== undefined) continue;
        visit(childRelative, depth + 1);
        continue;
      }
      const extension = entry.name.slice(entry.name.lastIndexOf("."));
      if (!SOURCE_EXTENSIONS.has(extension)) continue;
      found.push(childRelative);
    }
  };
  visit("", 0);
  return found;
}

function occurrencePattern(key: string): RegExp {
  // process.env.KEY | process.env["KEY"] | import.meta.env.KEY | env.KEY —
  // el último cubre wrappers tipo t3-env (`import { env } from "~/env"`).
  return new RegExp(
    `\\benv(?:\\.${key}\\b|\\[\\s*["']${key}["']\\s*\\])`,
    "g",
  );
}

export function classifyEnvKeys(
  cwd: string,
  keys: ReadonlySet<string>,
): Map<string, EnvKeyClassification> {
  interface Occurrence {
    location: string;
    guarded: boolean;
  }
  const occurrences = new Map<string, Occurrence[]>([...keys].map((key) => [key, []]));
  if (keys.size === 0) return new Map();

  const patterns = new Map([...keys].map((key) => [key, occurrencePattern(key)]));
  for (const file of sourceFiles(cwd)) {
    const absolute = join(cwd, file);
    try {
      if (statSync(absolute).size > MAX_FILE_BYTES) continue;
    } catch {
      continue;
    }
    let contents: string;
    try {
      contents = readFileSync(absolute, "utf-8");
    } catch {
      continue;
    }
    // Filtro barato antes del análisis por líneas.
    const present = [...keys].filter((key) => contents.includes(key));
    if (present.length === 0) continue;

    const lines = contents.split("\n");
    for (const [index, line] of lines.entries()) {
      for (const key of present) {
        const pattern = patterns.get(key);
        if (pattern === undefined) continue;
        pattern.lastIndex = 0;
        if (!pattern.test(line)) continue;
        occurrences
          .get(key)
          ?.push({ location: `${file}:${index + 1}`, guarded: lineIsGuarded(line) });
      }
    }
  }

  const result = new Map<string, EnvKeyClassification>();
  for (const key of keys) {
    const found = occurrences.get(key) ?? [];
    const unguarded = found.filter((occurrence) => !occurrence.guarded);
    const usage: EnvKeyUsage =
      unguarded.length > 0 ? "required" : found.length > 0 ? "conditional" : "unreferenced";
    // La evidencia sostiene el veredicto: para required se citan las lecturas
    // sin guardia; para conditional, las guardadas.
    const support = usage === "required" ? unguarded : found;
    result.set(key, {
      key,
      usage,
      evidence: support.slice(0, MAX_EVIDENCE_PER_KEY).map((occurrence) => occurrence.location),
    });
  }
  return result;
}
