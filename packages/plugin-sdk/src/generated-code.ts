import { readFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";

/**
 * Reconocimiento de código GENERADO (gate 1.F, informe Lubrisur 2026-07):
 * el cliente Prisma generado con `output` custom copia `schema.prisma` y un
 * `package.json` dentro del árbol fuente (ej. `src/generated/prisma`), y sin
 * esta capa los detectores lo confundían con un segundo servicio ejecutable.
 *
 * La clasificación es por EVIDENCIA, nunca por adivinanza, y siempre produce
 * una razón legible para que `cloudproof init` pueda mostrarla:
 *
 *  1. La ruta está dentro del `output` declarado por un `generator` del
 *     propio schema Prisma del repo (la fuente de verdad más fuerte).
 *  2. La ruta contiene un segmento que por convención universal es salida
 *     de generadores (`generated`, `__generated__`, `.generated`, `.prisma`).
 *
 * Nada de esto depende de que el repo tenga el directorio en .gitignore:
 * en proyectos reales el cliente generado suele estar versionado.
 */

const GENERATED_SEGMENTS = new Set(["generated", "__generated__", ".generated", ".prisma"]);

export interface GeneratedPathVerdict {
  generated: boolean;
  /** Evidencia legible; presente solo cuando generated=true. */
  reason?: string;
}

/** Primer segmento de `relativePath` que marca salida de generador, si existe. */
export function generatedSegmentOf(relativePath: string): string | undefined {
  return relativePath
    .replace(/\\/g, "/")
    .split("/")
    .find((segment) => GENERATED_SEGMENTS.has(segment.toLowerCase()));
}

/** ¿`childRelative` es igual o desciende de `parentRelative`? (rutas repo-relativas). */
export function isWithinPath(parentRelative: string, childRelative: string): boolean {
  const parent = parentRelative.replace(/\\/g, "/").replace(/\/+$/, "");
  const child = childRelative.replace(/\\/g, "/").replace(/\/+$/, "");
  return child === parent || child.startsWith(`${parent}/`);
}

/**
 * Directorios `output` declarados por los bloques `generator` de un schema
 * Prisma, resueltos a rutas repo-relativas. `output = env(...)` no es
 * resoluble estáticamente y se ignora; un output fuera del repo tampoco
 * excluye nada (no hay ruta repo-relativa que clasificar).
 */
export function prismaGeneratorOutputs(
  projectRoot: string,
  schemaFileAbsolute: string,
): string[] {
  let contents: string;
  try {
    contents = readFileSync(schemaFileAbsolute, "utf-8");
  } catch {
    return [];
  }
  const outputs: string[] = [];
  for (const block of contents.matchAll(/generator\s+\w+\s*\{([^}]*)\}/g)) {
    const body = block[1] ?? "";
    const output =
      /output\s*=\s*"([^"]+)"/.exec(body)?.[1] ?? /output\s*=\s*'([^']+)'/.exec(body)?.[1];
    if (output === undefined) continue;
    const absolute = isAbsolute(output)
      ? output
      : resolve(dirname(schemaFileAbsolute), output);
    const repoRelative = relative(projectRoot, absolute).replace(/\\/g, "/");
    if (repoRelative === "" || repoRelative.startsWith("..")) continue;
    outputs.push(repoRelative);
  }
  return [...new Set(outputs)].sort();
}

/**
 * Veredicto para una ruta repo-relativa. `generatorOutputs` son los outputs
 * ya resueltos por `prismaGeneratorOutputs` sobre los schemas del repo.
 */
export function classifyGeneratedPath(
  relativePath: string,
  generatorOutputs: readonly string[] = [],
): GeneratedPathVerdict {
  const output = generatorOutputs.find((candidate) => isWithinPath(candidate, relativePath));
  if (output !== undefined) {
    return {
      generated: true,
      reason: `output del generator Prisma declarado en el schema (${output})`,
    };
  }
  const segment = generatedSegmentOf(relativePath);
  if (segment !== undefined) {
    return {
      generated: true,
      reason: `segmento de ruta "${segment}" reservado para código generado`,
    };
  }
  return { generated: false };
}
