# Changelog — @cloudproof/schema

## 0.0.1 (continuación — coverage del cambio y snapshots de desarrollo)

- `CoverageSchema` incorpora métricas aditivas de rutas/métodos derivados del
  diff (`changedRoutesDetected`, `changedRoutesObserved`,
  `changedRoutesMissing`, `changeSource`). Un hueco del cambio impide
  `VERIFIED` aunque el universo declarado esté completo.
- Provenance v1 puede declarar el origen del candidato y marcar un commit
  sintético de worktree como `developmentOnly`, sin confundirlo con un commit
  publicado apto para gates de merge/deploy.

## CloudProof Bundle v2 (adición compatible de lectura)

- `CloudProofBundleSchema` lee v1 y v2; se exponen schemas y tipos explícitos para
  cada versión.
- V2 incorpora provenance verificable por digest, identidad del runner,
  repositorio/commits, perfil de ejecución y ventana temporal completa.
- Evidencia content-addressed con clasificación, disposición de redacción y
  límites estrictos; política, contadores y retención a nivel Bundle.
- Matriz completa con `A1_S0`, `COEXIST_A0_A1_S1`, `A1_S1` y
  `ROLLBACK_A0_AFTER_A1_WRITES`.
- `issuedAt`/`expiresAt` y helper puro para derivar `fresh | expired`.
- Approvals trazables a identidad, alcance y attestation.
- Attestations DSSE/detached con contrato de payload canónico. El paquete solo
  valida estructura y coherencia de digests; no realiza ni afirma verificación
  criptográfica.
- Reglas cross-field impiden `VERIFIED` con matriz parcial, cobertura
  insuficiente, redacción fallida o assertions obligatorias sin respaldo.

## 0.0.1 (continuación — salida accionable para agentes)

- Extensión aditiva del Bundle v1 (los bundles previos siguen validando):
  - `AssertionSchema.remediation` (opcional): receta determinista
    expand/contract (`RemediationSchema`) con `pattern`, `strategy`,
    `steps[{order, phase, title, detail}]` y `triggeredBy` (tesis 7.6).
  - `CloudProofBundleSchema.nextActions` (default `[]`): acciones tipadas
    (`NextActionSchema`) que hacen accionable todo veredicto no VERIFIED.

## 0.0.1

- Scaffold inicial. `CloudProofBundleSchema` versión `"1"` (campo interno, no el version del paquete npm) según tesis sección 7.3.
- Cierre técnico de Fase 1: extensiones aditivas para servicio, estado de
  ejecución, approvals, contexto de reproducción, cobertura honesta y
  provenance de entorno. Los Bundles v1 anteriores siguen siendo válidos.
- `deriveConclusion()` ya no permite `VERIFIED` con cobertura desconocida o
  assertions obligatorias omitidas; un fallo aprobado queda visible sin
  bloquear y un fallo reproducible prevalece sobre cobertura parcial.
