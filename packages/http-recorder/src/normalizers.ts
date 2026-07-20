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
 * token/…Token) Y por forma del valor (opaco, sin espacios, ≥8 chars, o
 * numérico) para no ocultar breaking changes en campos de negocio.
 */
const VOLATILE_KEY_RE = /(^id$|^_id$|Id$|^token$|Token$)/;
const OPAQUE_VALUE_RE = /^[A-Za-z0-9_-]{8,}$/;

/** Recibe el valor y, cuando existe, la clave del campo que lo contiene. */
export type FieldNormalizer = (value: unknown, key?: string) => unknown;

export const defaultNormalizers: FieldNormalizer[] = [
  (value) => (typeof value === "string" && UUID_RE.test(value) ? "<uuid>" : value),
  (value) =>
    typeof value === "string" && ISO_TIMESTAMP_RE.test(value) ? "<timestamp>" : value,
  (value, key) =>
    key !== undefined &&
    VOLATILE_KEY_RE.test(key) &&
    ((typeof value === "string" && OPAQUE_VALUE_RE.test(value)) || typeof value === "number")
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
