/**
 * Ver tesis, sección 7.5 ("Normalizadores por campo y protocolo") y 19.4
 * ("No bloquea por UUIDs o timestamps inestables calibrados"). Sin esto,
 * cualquier campo no-determinista (UUID generado, timestamp, nonce)
 * produce un falso positivo en cada comparación baseline vs. candidate.
 *
 * Este archivo es deliberadamente el único con lógica "real" del paquete
 * en este scaffold: es pura, sin I/O, y su contrato es completamente
 * conocido de antemano — no hay ambigüedad de diseño que resolver más
 * adelante, a diferencia del resto (executor, recorder), que sí depende
 * de decisiones de implementación todavía abiertas.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z?$/;
/**
 * Claves cuyo VALOR es un identificador opaco generado por el servidor
 * (ids de better-auth/nanoid/cuid, tokens de sesión). Calibración del gate
 * 1.E: sin esto, cualquier endpoint que devuelva un id/token no-UUID
 * produce un falso positivo por corrida. Acotado por clave (id/…Id/
 * token/…Token) Y por forma del valor (opaco, sin espacios, ≥8 chars —
 * string u numérico) para no ocultar breaking changes en campos de
 * negocio.
 *
 * V-1 (auditoría adversarial 2026-07-20): la rama numérica no aplicaba
 * ningún umbral de forma — cualquier número bajo una clave volátil se
 * borraba, sin importar su magnitud. Eso incluye referencias relacionales
 * de negocio de baja cardinalidad (`customerId: 7`), que en Postgres/Prisma
 * son enteros autoincrement igual que los ids técnicos. Un IDOR o un join
 * roto que devuelve el `customerId` de otra fila (7 → 9) normalizaba a
 * "<volatile-id>" en ambos lados y comparaba como igual — sin que
 * `captureSqlEffects` lo viera tampoco, porque una LECTURA incorrecta no
 * cambia ningún contador de escritura. Exigir el mismo umbral de ≥8 dígitos
 * que ya regía para strings cierra ese camino: preferimos que un id
 * autoincrement chico deje de normalizarse (ruido, potencial UNSAFE/flake)
 * antes que arriesgar un VERIFIED falso — la asimetría de costos entre
 * ambos errores nunca se invierte.
 */
const VOLATILE_KEY_RE = /(^id$|^_id$|Id$|^token$|Token$)/;
const OPAQUE_VALUE_RE = /^[A-Za-z0-9_-]{8,}$/;
const OPAQUE_NUMBER_RE = /^\d{8,}$/;

function isOpaqueNumber(value: number): boolean {
  return Number.isSafeInteger(value) && OPAQUE_NUMBER_RE.test(String(Math.abs(value)));
}

/** Recibe el valor y, cuando existe, la clave del campo que lo contiene. */
export type FieldNormalizer = (value: unknown, key?: string) => unknown;

export const defaultNormalizers: FieldNormalizer[] = [
  (value) => (typeof value === "string" && UUID_RE.test(value) ? "<uuid>" : value),
  (value) =>
    typeof value === "string" && ISO_TIMESTAMP_RE.test(value) ? "<timestamp>" : value,
  (value, key) =>
    key !== undefined &&
    VOLATILE_KEY_RE.test(key) &&
    ((typeof value === "string" && OPAQUE_VALUE_RE.test(value)) ||
      (typeof value === "number" && isOpaqueNumber(value)))
      ? "<volatile-id>"
      : value,
];

export function normalizeValue(
  value: unknown,
  normalizers: FieldNormalizer[] = defaultNormalizers,
  key?: string,
): unknown {
  return normalizers.reduce((acc, normalize) => normalize(acc, key), value);
}

/**
 * Normaliza recursivamente un cuerpo de respuesta (objeto/array/primitivo)
 * para poder comparar baseline vs. candidate sin ruido de campos volátiles.
 */
export function normalizeBody(
  body: unknown,
  normalizers: FieldNormalizer[] = defaultNormalizers,
  key?: string,
): unknown {
  if (Array.isArray(body)) {
    return body.map((item) => normalizeBody(item, normalizers, key));
  }
  if (body !== null && typeof body === "object") {
    return Object.fromEntries(
      Object.entries(body as Record<string, unknown>).map(([childKey, value]) => [
        childKey,
        normalizeBody(value, normalizers, childKey),
      ]),
    );
  }
  return normalizeValue(body, normalizers, key);
}
