# Arquitectura actual — Assurance Kernel

Este documento describe el código ejecutable al 2026-07-16. La tesis v0.3
define la dirección de producto: Proof es un Evidence Plane independiente del
agente, del humano y de CI; el motor inicial sigue siendo Node.js/Next.js,
PostgreSQL y Prisma.

## Dos niveles de evidencia

```text
CHANGE / RELEASE CLAIM
        |
        +--> proof release plan
        |      git diff + config + static triage
        |      PLAN_ONLY_NOT_VERIFIED + nextCommand
        |
        +--> proof release verify
               Docker builds + Postgres + HTTP recorder + policies
               VERIFIED | UNSAFE | INCONCLUSIVE
                           |
                           v
                    Proof Bundle v1
```

El plan es deliberadamente barato y nunca autoriza un release. Clasifica el
diff, detecta superficies de riesgo y elige la matriz que debe ejecutarse. El
verify produce hechos de runtime y falla cerrado ante cobertura, escrituras o
estados obligatorios ausentes.

## Flujo del verify

```text
proof.config.(ts|json)
        |
        v
@proof/config ---------- perfil trusted | internal | fork
        |
        v
@proof/postgres-verifier
        +--> @proof/docker-executor -- builds, clones, migraciones, aislamiento
        +--> @proof/http-recorder ---- baseline, captura y replay
        +--> efectos SQL ------------- insert/update/delete por tabla
        +--> @proof/policy-engine ---- policies y approvals exactas
        |
        v
@proof/schema ---------- Proof Bundle v1
        +--> @proof/cli -- reporte, persistencia y reproducción
        +--> MCP stdio -- objetos tipados sin salida lateral
```

## Matriz ejecutada

La lista en `packages/postgres-verifier/src/matrix.ts` es el contrato
ejecutable del ledger obligatorio.

| Estado | Propósito |
|---|---|
| `BUILD_A0` | Construir la versión desplegada |
| `BUILD_A1` | Construir el candidato |
| `A0_S0` | Establecer baseline y S0 poblado atribuibles |
| `MIGRATE_S0_TO_S1` | Migrar clones limpios y poblados |
| `A1_S0` | Validar el candidato antes de la migración |
| `A0_S1` | Validar la aplicación desplegada después de la migración |
| `COEXIST_A0_A1_S1` | Ejecutar schedules A0-first y A1-first sobre S1 compartidos frescos |
| `A1_S1` | Validar el estado final del candidato |
| `ROLLBACK_A0_AFTER_A1_WRITES` | Arrancar y consultar A0 después de escrituras de A1 |
| `SQL_EFFECTS` | Comparar efectos observables durante startup y workloads |

## Fronteras de confianza

- Los inputs de release son dos snapshots Git exactos; los paths se confinan
  al checkout correspondiente.
- App, PostgreSQL y migrador corren en redes internas sin egress.
- El host accede mediante un sidecar TCP fijo; el código del repo no controla
  ese puente.
- El workload recibe `PROOF_BASE_URL`, no credenciales de la base. La escritura
  debe ser atribuible al contrato HTTP observado.
- `trusted` conserva config TypeScript y workload local. `internal`/`fork`
  exigen config JSON data-only y aplican restricciones adicionales.
- Un perfil endurecido reduce superficie, pero el Bundle v1 local no es una
  atestación firmada ni Proof afirma aislar código hostil por completo.
- Los bundles limitan y redactan evidencia; no deben contener logs ilimitados
  ni secretos.
- Las approvals son exactas por assertion, visibles y opcionalmente expiran.

## Contrato de salida para agentes

- `conclusion` es un enum, no una recomendación del LLM.
- `assertions[].remediation` proviene de un catálogo determinista disparado
  por SQLSTATE/Prisma code y estado ejecutado.
- `nextActions[]` describe de forma tipada qué evidencia falta o qué debe
  corregirse.
- `proof init` instala en `AGENTS.md` la disciplina
  `plan → verify → remediate → re-verify`.
- `release plan` nunca puede producir `VERIFIED`; `INCONCLUSIVE` nunca se
  transforma en verde por policy.

## Capacidades todavía ausentes

- Bundle v2, content-addressed evidence, freshness y atestación firmada;
- fixture/bootstrap privilegiado y reproducible para apps sin setup HTTP;
- flujo de evidencia local para árbol sucio con semántica distinta a release;
- GitHub Check Run, dashboard y control plane;
- servicios stateful adicionales y captura de tráfico de producción.

`docs/PHASE_1.md` conserva el cierre histórico del slice inicial y no debe
usarse como descripción de la matriz actual.
