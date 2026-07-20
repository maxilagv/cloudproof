# @proof/schema

Contrato Zod del **Proof Bundle**, el recibo estructurado que producen y
consumen Proof, la CLI, MCP y las integraciones de CI.

## Compatibilidad

- `ProofBundleV1Schema` conserva el contrato histórico y acepta Bundles v1
  anteriores, incluido el default `nextActions: []`.
- `ProofBundleV2Schema` es el contrato estricto para productores nuevos.
- `ProofBundleSchema` es el lector compatible: acepta v1 o v2.
- `ProofBundle`, `Assertion` y `Provenance` son uniones compatibles para los
  consumidores actuales; un productor nuevo debe elegir explícitamente
  `ProofBundleV1` o `ProofBundleV2`.

La lista compartida de estados ya contiene la matriz completa: `A0_S0`,
`A1_S0`, migración, `A0_S1`, coexistencia A0/A1 sobre S1, `A1_S1`, rollback
de A0 después de escrituras de A1, builds y efectos SQL.

## Qué agrega v2

- procedencia atribuible del runner, identidad, repositorio y commits;
- digests de herramienta, configuración, imágenes, plugins y evidencia;
- referencias de evidencia content-addressed, nunca blobs o logs inline;
- reproducción por referencia redactada (v2 no incrusta requests ni headers);
- clasificación, política y contadores de redacción, más retención;
- `issuedAt`/`expiresAt` y `getProofBundleFreshness()`;
- matriz de release explícita y relacionada con assertions/evidencia;
- approvals con actor, alcance, vencimiento, ticket y attestation;
- envelopes DSSE o firmas detached estructuralmente validadas.

V2 usa objetos estrictos, límites de cardinalidad/tamaño y validaciones entre
campos. Por ejemplo: un Bundle `VERIFIED` no puede tener matriz parcial,
redacción fallida, cobertura desconocida ni un estado obligatorio sin pasar.

## Attestations: límite de confianza

El schema **no afirma autenticidad criptográfica**. Valida la estructura y que
todas las attestations declaren el mismo payload digest. El payload se obtiene
con `createProofBundleV2AttestationPayload()`: JSON canónico determinista del
Bundle sin `integrity` ni `attestations`. Un consumidor debe:

1. calcular el hash indicado por `integrity.payloadDigest` sobre los bytes
   UTF-8 de ese payload;
2. comparar con `attestationPayloadDigestMatches()`;
3. verificar cada firma/certificado contra su propia política de confianza,
   revocación e identidad.

Parsear una attestation no verifica su firma ni confía en su `keyId`.

Un Bundle v2 exige al menos una attestation estructural. Los productores
locales sin signer configurado deben seguir emitiendo v1; nunca deben fabricar
una firma para satisfacer el schema. La migración del productor a v2 ocurre
cuando exista identidad verificable (OIDC de CI, servicio de firma o clave
local gobernada) y el consumidor aplique su trust policy.

## Reglas del contrato

- `conclusion` solo admite `VERIFIED | UNSAFE | INCONCLUSIVE`.
- La evidencia textual es un resumen corto; la evidencia real se referencia
  por digest.
- Los cambios incompatibles requieren una nueva versión interna del Bundle y
  una entrada en `CHANGELOG.md`.
