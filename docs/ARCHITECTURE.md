# Arquitectura actual — Assurance Kernel

Este documento describe el código ejecutable al 2026-07-16. La tesis v0.3
define la dirección de producto: CloudProof es un Evidence Plane independiente del
agente, del humano y de CI; el motor inicial sigue siendo Node.js/Next.js,
PostgreSQL y Prisma.

## Dos niveles de evidencia

```text
CHANGE / RELEASE CLAIM
        |
        +--> cloudproof release plan
        |      git diff + config + static triage
        |      PLAN_ONLY_NOT_VERIFIED + nextCommand
        |
        +--> cloudproof release verify
               Docker builds + Postgres + HTTP recorder + policies
               VERIFIED | UNSAFE | INCONCLUSIVE
                           |
                           v
                    CloudProof Bundle v1
```

El plan es deliberadamente barato y nunca autoriza un release. Clasifica el
diff, detecta superficies de riesgo y elige la matriz que debe ejecutarse. El
verify produce hechos de runtime y falla cerrado ante cobertura, escrituras o
estados obligatorios ausentes.

## Flujo del verify

```text
cloudproof.config.(ts|json)
        |
        v
@cloudproof/config ---------- perfil trusted | internal | fork
        |
        v
@cloudproof/postgres-verifier
        +--> @cloudproof/docker-executor -- builds, clones, migraciones, aislamiento
        +--> @cloudproof/http-recorder ---- baseline, captura y replay
        +--> efectos SQL ------------- insert/update/delete por tabla
        +--> @cloudproof/policy-engine ---- policies y approvals exactas
        |
        v
@cloudproof/schema ---------- CloudProof Bundle v1
        +--> @cloudproof/cli -- reporte, persistencia y reproducción
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

La lista completa sigue siendo el contrato fail-closed para cambios de
schema/SQL, riesgo alto o triage incompleto. Para un diff exclusivamente de
aplicación con schema diff cero, el plan selecciona el ledger enfocado
`BUILD_A0 + BUILD_A1 + A0_S0 + A1_S0 + SQL_EFFECTS`; las demás celdas se
registran como no requeridas, no como evidencia omitida. La decisión y su
ruleset forman parte de provenance/cache.

Coverage tiene dos universos simultáneos: las rutas declaradas por el proyecto
y cada método+ruta inferido de entrypoints HTTP modificados. Ambos deben quedar
cubiertos para `VERIFIED`; esto evita que un workload completo respecto de una
lista obsoleta certifique un feature cambiado que nunca recibió tráfico.

## Fronteras de confianza

- Los inputs de release son dos snapshots Git exactos; los paths se confinan
  al checkout correspondiente.
- App, PostgreSQL y migrador corren en redes internas sin egress.
- El host accede mediante un sidecar TCP fijo; el código del repo no controla
  ese puente.
- El workload recibe `CLOUDPROOF_BASE_URL`, no credenciales de la base. La escritura
  debe ser atribuible al contrato HTTP observado.
- `trusted` conserva config TypeScript y workload local. `internal`/`fork`
  exigen config JSON data-only y aplican restricciones adicionales.
- Un perfil endurecido reduce superficie, pero el Bundle v1 local no es una
  atestación firmada ni CloudProof afirma aislar código hostil por completo.
- Los bundles limitan y redactan evidencia; no deben contener logs ilimitados
  ni secretos.
- Las approvals son exactas por assertion, visibles y opcionalmente expiran.

## Contrato de salida para agentes

- `conclusion` es un enum, no una recomendación del LLM.
- `assertions[].remediation` proviene de un catálogo determinista disparado
  por SQLSTATE/Prisma code y estado ejecutado.
- `nextActions[]` describe de forma tipada qué evidencia falta o qué debe
  corregirse.
- `cloudproof init` instala en `AGENTS.md` la disciplina
  `plan → verify → remediate → re-verify`.
- `release plan` nunca puede producir `VERIFIED`; `INCONCLUSIVE` nunca se
  transforma en verde por policy.

## Bootstrap de identidad (fixtures.bootstrapSql)

Apps con rutas autenticadas y sin registro público no pueden crear su primer
usuario por HTTP (informe Bs As Neumáticos 2026-07). `fixtures.bootstrapSql`
declara un `.sql` del repo que el executor aplica UNA vez por corrida, dentro
del contenedor Postgres, después de `migrate deploy` del commit base y antes
de arrancar cualquier app. Es preparación de entorno — análoga a una
migración — así que la invariante "las escrituras del workload son HTTP
observables" queda intacta: el bootstrap ocurre antes de que exista tráfico
observado, todas las celdas lo heredan por clonación del seed S0, y su digest
sha256 queda en `provenance.artifacts` y en la assertion `postgres.bootstrap`.
El patrón completo: sembrar el usuario (hash literal) en el SQL y obtener el
token con el login HTTP real vía `fixtures.beforeAll`.

Para el onboarding a Docker (el candidato agrega el Dockerfile que el commit
base desplegado no tiene), `services.<n>.dockerfileFrom: "head"` construye
ambos lados con la receta del candidato manteniendo las fuentes de cada
commit; la procedencia queda en la evidencia de `BUILD_A0`.

## Capacidades todavía ausentes

- Bundle v2, content-addressed evidence, freshness y atestación firmada;
- GitHub Check Run, dashboard y control plane;
- servicios stateful adicionales y captura de tráfico de producción.

`docs/PHASE_1.md` conserva el cierre histórico del slice inicial y no debe
usarse como descripción de la matriz actual.
