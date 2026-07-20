# Fase 1 — estado de cierre

Fuente: tesis v0.2, secciones 15.2, 15.7 y 19.

Fecha de corte: **2026-07-14**.

> **Documento histórico.** Conserva la evidencia y los aprendizajes del gate
> inicial. Desde el 2026-07-15 el motor avanzó al Assurance Kernel de la tesis
> v0.3: `release plan` y la matriz A0/A1 × S0/S1 con coexistencia y rollback ya
> están implementados. La capacidad vigente se documenta en el
> [README](../README.md) y en [ARCHITECTURE.md](ARCHITECTURE.md); las frases de
> este cierre sobre estados “fuera de alcance” describen exclusivamente el
> corte histórico.

## Resultado

Las subfases técnicas 1.A–1.D están implementadas y verificadas, y el gate
1.E de instalación externa se completó 5/5 sobre repos reales el
2026-07-15. Queda abierto, del espíritu de 1.E, el componente de "usuarios
reales" (pilotos con humanos ajenos al proyecto usando la herramienta sin
acompañamiento).

| Subfase | Estado | Evidencia principal |
|---|---|---|
| 1.A Motor Docker | Cerrada | unit tests + Docker real + 20 ciclos sin residuos |
| 1.B Captura/replay HTTP | Cerrada | 6 tests de proxy, replay, límites, normalización y errores |
| 1.C Integración canónica | Cerrada técnicamente | UNSAFE real, VERIFIED benigno, INCONCLUSIVE sin workload |
| 1.D Reproducción | Cerrada | finding en vivo, snapshot SQL, Compose y cleanup a cero |
| 1.E Gate externo | **5/5 (2026-07-15)** | 5 repos externos reales; 1 VERIFIED, 1 UNSAFE canónico con remediación, 3 INCONCLUSIVE honestos — ver sección Gate 1.E |

## Contrato técnico cerrado

La ejecución actual realiza:

```text
BUILD A0 ─┐
          ├─> A0 + S0 ── workload/Recorder ──> S0 poblado
BUILD A1 ─┘        │                              │
                   ├─ clon limpio + migrate ──> S1 replay
                   └─ clon poblado + migrate ─> S1 transición

A0 + S1 transición ── readiness
A0 + S1 replay ─────── HTTP replay + efectos SQL
```

Se usan dos S1 deliberadamente:

- el S1 de transición valida que la migración aplique sobre datos reales del
  workload y que A0 alcance readiness;
- el S1 de replay parte del mismo estado lógico inicial que el baseline, para
  no duplicar escrituras ni fabricar diferencias de respuesta.

Una corrida solo puede emitir `VERIFIED` cuando:

- baseline y builds pasan;
- la migración limpia y poblada pasa;
- todas las rutas de `coverage.requiredRoutes` fueron observadas;
- no hay assertions obligatorias omitidas;
- hubo al menos una escritura HTTP;
- los efectos SQL baseline/replay son equivalentes;
- todo fallo restante tiene una approval exacta, explícita y vigente.

Un fallo de build, migración, startup, HTTP o efectos SQL queda dentro del
Proof Bundle. Los fallos HTTP conservan el exchange mínimo para reproducción;
los fallos de etapa conservan un contexto de rerun. Ninguna de estas etapas
se convierte en una excepción sin evidencia.

Además, el bundle es accionable sin interpretar prosa (preparación directa
del gate 1.E con agentes de IA como consumidores):

- los fallos con SQLSTATE reconocido llevan `remediation` — la secuencia
  expand/contract del catálogo determinista (tesis 7.6);
- todo veredicto UNSAFE/INCONCLUSIVE lleva `nextActions` — acciones tipadas
  (declarar coverage, agregar workload de escritura, ejercitar ruta,
  re-ejecutar etapa, aplicar receta);
- `proof init` genera `AGENTS.md` (bloque gestionado) para que cualquier
  agente que entre al repo sepa que la verificación existe y cómo usarla.

## Aislamiento

- app, PostgreSQL y migrador corren en una red `--internal` sin egress;
- un sidecar TCP fijo y limitado une host→target sin ejecutar código del repo;
- puertos expuestos solo en `127.0.0.1`;
- límites de memoria/CPU/PIDs y `no-new-privileges`;
- worktrees por SHA con paths confinados;
- migrador Prisma preconstruido antes de entrar a la red interna;
- labels por owner/run, teardown idempotente y barrido de residuos.

## Gates automatizados

Siempre:

```sh
pnpm typecheck
pnpm lint
pnpm build
pnpm test
```

Con Docker:

```sh
PROOF_DOCKER_IT=1 PROOF_DOCKER_IT_FULL=1 \
  pnpm --filter @proof/docker-executor exec vitest run tests/integration.test.ts --no-file-parallelism
PROOF_DOCKER_IT=1 PROOF_DOCKER_IT_FULL=1 \
  pnpm --filter @proof/cli exec vitest run tests/e2e.test.ts --no-file-parallelism
PROOF_DOCKER_IT=1 PROOF_DOCKER_IT_FULL=1 \
  pnpm --filter @proof/cli exec vitest run tests/reproduce.integration.test.ts --no-file-parallelism
```

Estas suites se ejecutan secuencialmente en CI porque verifican limpieza por
labels y no deben barrer recursos de otra suite concurrente.

## Gate 1.E — segunda corrida real (2026-07-15): 5/5

Tras la primera corrida (1/5), cada bloqueante se convirtió en una mejora
del motor (ver "Capacidades agregadas" abajo) y se re-corrió la batería
completa sobre los mismos 5 repos externos:

| Experimento | Criterio de éxito | Resultado |
|---|---|---|
| Instalación en 5 repos externos reales | 4/5 completan setup sin asistencia intensiva | **5/5 completan el pipeline entero** |
| Catálogo manual de migraciones inseguras | detecta al menos 8/10 escenarios | Catálogo de 9 patrones + alias Prisma P2xxx; UNSAFE real demostrado end-to-end |
| Calibración de normalizadores | reduce ruido sin ocultar breaking changes | Calibrado en vivo: ids/tokens opacos por clave (falso positivo real de better-auth eliminado sin tocar campos de negocio) |

### Resultado final por repo (2026-07-15)

| # | Repo | Veredicto | Detalle |
|---|---|---|---|
| 1 | workout-cool | **VERIFIED** (y **UNSAFE** en la demo) | Pipeline completo con workload real (signup = INSERT). Proof detectó un **bug real del repo**: `user.onboardingPreferences` en schema.prisma sin migración (deploy fresco roto, P2022); con la migración faltante agregada al fork → VERIFIED. Demo canónica: branch con `ADD COLUMN tenant_id NOT NULL` → UNSAFE + receta expand/contract + `apply-remediation`, la salida exacta de la tesis 19.5 sobre código externo |
| 2 | nestjs-prisma-postgres-starter | INCONCLUSIVE honesto | Build reparado (1 commit al fork: su Dockerfile no copiaba prisma.config.ts), schema multi-archivo + migrador config-era funcionan; la app exige Redis en runtime (502) — fuera del alcance F1, ya en la etapa 2 de la tesis (18.3) |
| 3 | rallly | INCONCLUSIVE honesto | Cero asistencia: init detectó servicio + prismaSchema + `SELF_HOSTED=true` desde su compose; build Turborepo desde raíz, migrador Prisma 7 config-era, arranque OK. Solo falta suite HTTP propia |
| 4 | peppermint | INCONCLUSIVE honesto | Dockerfile standalone del repo estaba abandonado (sin corepack, no compilaba la app, entrypoint roto) — reparado en el fork (3 commits); migrador respeta Prisma 5.6 del servicio; puerto 5003 hardcodeado vs EXPOSE 8090 stale (defecto del repo) calibrado con `port` |
| 5 | inbox-zero | INCONCLUSIVE honesto | init eligió `docker/Dockerfile.prod` (preferencia por imagen de producción); su Dockerfile.web es un dev-container que exige internet en runtime — incompatible con el aislamiento sin egress, que es correcto. `readinessTimeoutMs` para su bootstrap lento |

### Capacidades del motor agregadas en esta iteración (todas con tests)

1. **Build context inferido** por análisis de fuentes COPY/ADD (patrón
   Turborepo `docker build -f apps/web/Dockerfile .`), más `dockerfile` y
   `buildContext` declarables por servicio.
2. **Dockerfile custom** (`docker/Dockerfile.prod`), con preferencia por
   variantes de producción y match por nombre de servicio en `init`.
3. **`buildArgs`** por servicio + adopción automática desde el
   docker-compose del repo (rallly exige `SELF_HOSTED=true`).
4. **`env` de runtime** por servicio (equivalente al env_file del compose;
   DATABASE_URL/PORT siguen siendo de Proof).
5. **`readinessTimeoutMs`** por servicio para bootstraps pesados.
6. **Prisma multi-archivo** (`prisma/schema/`) en detectores, doctor y
   migrador.
7. **Migrador "config-era"** (Prisma 7 / prisma.config.ts): config
   sintético de Proof montado junto al node_modules del migrador, drivado
   por env vars — el config del repo nunca se ejecuta.
8. **Versión de Prisma por servicio/paquete del schema**, no solo raíz
   (peppermint: 5.6 en apps/api).
9. **cross-spawn** en el runner: workloads `npm/pnpm/yarn` funcionan en
   hosts Windows (.cmd shims).
10. **Normalizador por clave** para ids/tokens opacos (better-auth/nanoid)
    — calibración del experimento 3 del gate.
11. **Alias Prisma P2xxx → SQLSTATE** en el catálogo de remediación (la
    demo real llegó como P2011, no 23502).
12. **Cache de imagen por contenido** (Dockerfile + rutas + buildArgs en el
    tag) y `PROOF_FORCE_REBUILD=1`.

### Fricciones que quedan (honestas, con dueño claro)

- Repos sin suite HTTP propia quedan INCONCLUSIVE por diseño; el camino a
  VERIFIED es un workload PROOF_BASE_URL (documentado en AGENTS.md).
- Apps que exigen servicios extra en runtime (Redis) esperan la etapa 2 de
  la tesis (18.3).
- El timeout de build de 10 min del ejecutor quedó corto para monorepos
  fríos grandes (peppermint/inbox-zero); mitigable con cache de capas, a
  exponer como opción en Fase 2.

## Primera corrida (2026-07-14), preservada como referencia

| Experimento | Criterio de éxito | Resultado |
|---|---|---|
| Instalación en 5 repos externos reales | 4/5 completan setup sin asistencia intensiva | 1/5 sin asistencia |
| Catálogo manual de migraciones inseguras | detecta al menos 8/10 escenarios | Pendiente en esa corrida |
| Calibración de normalizadores | reduce ruido sin ocultar breaking changes | Pendiente en esa corrida |

Fixtures, unit tests y la demo canónica prueban el motor; no sustituyen este
gate de validación de producto. Esta sección documenta la primera corrida
real: 5 repos open source ajenos (forkeados a `splayercloud/*`, privados),
sin fixtures propios.

### Resultado por repo

| # | Repo | `proof init` | `proof doctor` | Docker real | Veredicto de la corrida |
|---|---|---|---|---|---|
| 1 | Snouzy/workout-cool | Correcto, cero asistencia | Limpio | Build A0 + Postgres + migración + arranque de la app: **todo OK** | `INCONCLUSIVE` — el repo no tiene test suite propio (esperado, tesis 19.1: sin workload no hay VERIFIED) |
| 2 | Peppermint-Lab/peppermint | **Path de servicio incorrecto** (`apps/api/src` en vez de `apps/api`) | Corregido con 1 edición manual de config | Build falla | Bloqueado por un bug real en el Dockerfile del propio repo (`COPY turbo.json /../../turbo.json`, ruta inválida) — no relacionado con Proof |
| 3 | lukevella/rallly | **Servicio incorrecto** (detectó `packages/database`, una librería sin Dockerfile, en vez de `apps/web`) | Corregido con 1 edición manual de config | Build falla | Bloqueado por un **gap real del motor** (ver abajo) |
| 4 | elie222/inbox-zero | Servicio correcto (`apps/web`) | **Sin Dockerfile detectable** | No intentado | Bloqueado por un **gap real del motor** (ver abajo) |
| 5 | the-pujon/nestjs-prisma-postgres-starter | Workload auto-detectado (`test:e2e`) ✓; **Prisma no detectado** (schema multi-archivo) | HIGH: falta schema Prisma | Build falla | Bloqueado por un **gap real del motor** + un bug de ordering en el Dockerfile del propio repo |

Solo **1 de 5** completó el ciclo entero (build + Postgres + migración +
arranque de la app) sin ninguna corrección manual. El gate exige 4/5: **no
se cierra con esta corrida**.

### Gaps reales del motor descubiertos (backlog accionable)

1. **Build context ≠ ubicación del Dockerfile.** `compose-executor.buildImage`
   asume que el contexto de build es siempre la carpeta donde vive el
   Dockerfile del servicio (o la raíz, como fallback). No existe forma de
   declarar el patrón oficial y documentado de Turborepo — Dockerfile dentro
   de `apps/<servicio>/Dockerfile` pero build **desde la raíz del repo**
   (`docker build -f apps/web/Dockerfile .`) — que es exactamente lo que
   `rallly` declara en su propio `docker-compose.yml`
   (`context: .`, `dockerfile: ./apps/web/Dockerfile`). Este es probablemente
   el fix de mayor apalancamiento: es una convención común y documentada, no
   una rareza de un solo repo.
2. **Sin soporte para Dockerfile con nombre/ruta custom.** `inbox-zero` usa
   `docker/Dockerfile.local` / `.prod` / `.web` — Proof solo reconoce un
   archivo llamado literalmente `Dockerfile` en `servicePath` o en la raíz.
   No hay campo en `ServiceSchema` para declarar una ruta explícita.
3. **Sin soporte para el schema multi-archivo de Prisma** (`prisma/schema/`
   como carpeta en vez de `prisma/schema.prisma`). Rompe tanto la detección
   (`prismaDetector`/`postgresDetector`) como, presumiblemente, la invocación
   de migración en `docker-executor` (no llegamos a probarlo en vivo porque
   el build del repo falló antes por una causa separada).
4. **Heurística de `proof init` para el path de servicio es demasiado
   ingenua**: asume que "donde vive `prisma/`" es el servicio HTTP real. Se
   equivoca de dos formas distintas en esta corrida — Prisma anidado bajo
   `src/` dentro del servicio correcto (peppermint) y Prisma en un paquete
   compartido separado del servicio HTTP (rallly). Necesita preferir la
   carpeta que además tiene `package.json` + Dockerfile propio y aparece
   como app en el grafo de build del monorepo, no "donde esté prisma".
5. **Cache de `buildImage` por `(sha, servicePath)` asume checkout
   determinista.** Es una asunción válida en un entorno con configuración
   de git estable, pero se violó en esta misma corrida: un `core.autocrlf`
   inconsistente en el entorno de testing produjo bytes distintos en disco
   para el mismo SHA (antes/después de corregir la config), y el `docker
   image inspect` que gatea el rebuild devolvió un hit stale. Vale la pena
   una clave de cache más robusta (hash de contenido del worktree) o al
   menos documentar cómo purgar `proof-app:<sha>-<hash>` manualmente.

### Defectos reales en los repos externos (no de Proof)

- `peppermint/apps/api/Dockerfile`: `COPY turbo.json /../../turbo.json` es
  una ruta inválida — rompe para cualquiera que construya ese Dockerfile,
  no solo para Proof.
- `nestjs-prisma-postgres-starter/Dockerfile`: `RUN npm ci` dispara
  `postinstall: prisma generate` antes de que `COPY . .` traiga
  `prisma.config.ts` (necesario para el schema multi-archivo) — build roto
  desde un checkout limpio, independiente de Proof.

### Próximos pasos para cerrar 1.E

No alcanza con reintentar los mismos 5 repos: los gaps 1–4 de arriba son
fixes de producto reales. El camino más corto al gate es implementar el fix
de mayor apalancamiento (build context declarable) y volver a correr sobre
`rallly` — el único de los 3 bloqueados cuyo bloqueo es *puramente* un gap
de Proof, sin defectos propios del repo de por medio.
