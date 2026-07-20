<div align="center">

# 🛡️ Proof

### El Evidence Plane determinista para releases de software

**Ningún agente, humano o pipeline de CI puede fabricarse a sí mismo el permiso para declarar un release confiable.**

[![Licencia](https://img.shields.io/badge/licencia-propietaria%20(uso%20restringido)-critical.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-20%2B-339933?logo=node.js&logoColor=white)](package.json)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.7-3178C6?logo=typescript&logoColor=white)](tsconfig.base.json)
[![PostgreSQL](https://img.shields.io/badge/PostgreSQL-16-4169E1?logo=postgresql&logoColor=white)](plugins/postgres)
[![Prisma](https://img.shields.io/badge/Prisma-supported-2D3748?logo=prisma&logoColor=white)](plugins/prisma)
[![Estado](https://img.shields.io/badge/estado-desarrollo%20activo-orange.svg)](#estado-actual)

[Instalación](#-instalación) · [Cómo funciona](#-el-contrato-para-agentes) · [Comandos](#-comandos) · [Roadmap multi-stack](#-roadmap-el-camino-a-estándar-multi-stack) · [Límites](#-límites-deliberados)

</div>

---

## 🧭 ¿Qué es Proof?

Proof es una capa de **evidencia**, no de tests. No reemplaza tu suite, no programa por vos y no contiene un LLM. Su única función es responder, con datos reproducibles, una pregunta que ningún test suite responde por sí sola:

> **¿Esta aplicación va a seguir funcionando durante la transición real de versión y esquema — no solo después de ella?**

El primer motor de Proof está afinado para el caso más peligroso y más común en producción: **Node.js / Next.js + PostgreSQL con migraciones Prisma**, atravesando un despliegue real donde código viejo y código nuevo conviven, escriben y leen sobre la misma base de datos.

> 📅 **Estado al 2026-07-18:** el fast path estático y la matriz completa A0/A1 × S0/S1, coexistencia y rollback están implementados. El readiness de Postgres usa `SELECT 1` por TCP con doble confirmación sobre el mismo postmaster, y los reintentos de lecturas transitorias quedan registrados en el Bundle (`executorAttempts`). El Bundle local (v1) ya puede firmarse y verificarse (`proof bundle keygen/sign/verify`: Ed25519 sobre payload canónico RFC 8785, encoding DSSE PAE, attestation separado). `proof check` todavía no publica un GitHub Check Run.
>
> 📄 La tesis v0.3 está en [`output/pdf/`](output/pdf/) *(no versionada — ver [🔒 Qué no se sube al repo](#-qué-no-se-sube-al-repositorio))*.

---

## ✅ Qué hace bien Proof, en detalle

### 1. Separa "clasificar el riesgo" de "demostrarlo"

```sh
# L0/L1 — clasifica el diff sin Docker ni workload real
proof release plan --base-sha <deployed-sha> --head-sha <candidate-sha>

# L2 — ejecuta la evidencia dinámica de transición
proof release verify --base-sha <deployed-sha> --head-sha <candidate-sha>
```

`release plan` corre con presupuesto acotado e inspecciona Git, configuración, historial de migraciones, Prisma, SQL, build, dependencias, runtime y CI. Su veredicto **siempre** es `PLAN_ONLY_NOT_VERIFIED`: elige el siguiente nivel de evidencia necesario, pero jamás se hace pasar por una demostración de seguridad. Es una decisión de diseño deliberada: el análisis estático no puede — y no debería — declararse a sí mismo suficiente.

### 2. Construye la matriz de transición completa, no un smoke test

`release verify` levanta contenedores reales para A0 (versión desplegada) y A1 (versión candidata) y ejecuta, en orden:

| # | Obligación | Qué demuestra |
|---|---|---|
| 1 | `A0 + S0` | Baseline atribuible: la app vieja funciona con el esquema viejo, con workload HTTP real |
| 2 | `S0 → S1` | La migración corre limpio tanto sobre estado vacío como poblado |
| 3 | `A1 + S0` / `A0 + S1` | Compatibilidad cruzada en ambas direcciones — el punto ciego más común en incidentes reales |
| 4 | `A0 + A1 + S1` | Coexistencia bajo dos schedules: A0-first y A1-first (orden de despliegue importa) |
| 5 | `A1 + S1` | Estado final del candidato, ya migrado |
| 6 | Rollback | A0 vuelve a correr sobre S1 *después* de escrituras producidas por A1 |
| 7 | Comparación | Respuestas HTTP normalizadas y efectos SQL observables, celda por celda |

El resultado final es siempre uno de tres: **`VERIFIED`**, **`UNSAFE`** o **`INCONCLUSIVE`** — nunca un color verde ambiguo. Cada veredicto viene acompañado de coverage, provenance, assertions individuales, `remediation` determinista y `nextActions` tipadas y accionables. `INCONCLUSIVE` está diseñado para **no** poder confundirse con "seguro": una aprobación final sigue siendo, siempre, una decisión humana.

### 3. Genera su propio workload cuando el repo no tiene uno

Si el repositorio no declara un script e2e, `proof init` busca un spec OpenAPI 3.x (`openapi.json`/`.yaml` en `docs/`, `api/`, `openapi/` y variantes) y sintetiza `proof.workload.mjs`: lecturas primero, escrituras después, y una repetición final de lecturas — exactamente el *tail* read-only que el rollback necesita observar para ser evaluado. Los cuerpos de request salen de los schemas del spec en orden de prioridad `example > default > enum > tipo`, con datos únicos por corrida vía placeholder `{{RUN}}`. Las rutas cubiertas se declaran de forma determinista en `coverage.requiredRoutes` y `coverage.rollbackProbeRoutes`.

Todo hueco de cobertura — operaciones con auth, cuerpos no-JSON, parámetros sintéticos — se reporta explícitamente como *gap* en la salida de `proof init`. Nunca se rellena con datos mágicos. El script generado es un punto de partida editable, no una caja negra.

### 4. Fixtures deterministas para identidad y estado previo

```ts
fixtures: {
  beforeAll: { command: "node", args: ["scripts/proof-fixtures.mjs"] },
},
```

- Corre **antes** del workload, contra el mismo `PROOF_BASE_URL` (el proxy de captura de Proof), así que sus intercambios HTTP quedan grabados como **prefijo replayable**: cada celda de la matriz recrea la misma identidad y los mismos datos al hacer replay, sin acceso privilegiado a la base de datos.
- Puede entregarle variables al workload (por ejemplo, un token) escribiendo líneas `KEY=VALUE` en el archivo apuntado por `PROOF_FIXTURE_ENV`. El Bundle final solo conserva los **nombres** de esas variables, nunca los valores — los secretos no viajan al artefacto de evidencia.
- Si el fixture falla, el veredicto es honestamente `INCONCLUSIVE`, con la assertion `workload.fixtures` y una `nextAction` accionable. El workload ni siquiera se ejecuta.
- No existe `afterAll` a propósito: los entornos son efímeros y el executor los destruye siempre.

### 5. Bundles firmados, no solo logs

`proof bundle keygen/sign/verify/inspect` firma el payload canónico (RFC 8785) con Ed25519, usando encoding DSSE PAE y un attestation separado del payload. Sin clave pública configurada, Proof reporta **integridad** (el bundle no fue alterado) — nunca **confianza** (que el firmante sea quien decís que es). Esa distinción es explícita en el diseño, no un detalle de implementación.

### 6. `proof doctor`: falla rápido y con motivo

Valida runtime, Docker, espacio en disco, historial de Git, secretos versionados por error, configuración, workload, coverage y approvals declaradas. Devuelve código de salida `1` en cuanto encuentra un problema `HIGH` o `CRITICAL` — pensado para bloquear CI antes de gastar tiempo en levantar contenedores.

### 7. Perfiles endurecidos para código no confiable

Para repos que no controlás por completo, existen los perfiles `internal` y `fork`, que consumen configuración JSON *data-only* (sin ejecución de código arbitrario en la config) y endurecen la ejecución. **No son una garantía completa frente a código hostil** — son una mitigación deliberadamente honesta sobre sus propios límites.

---

## 📦 Instalación

Requisitos: **Node.js 20+**, **Git** y **Docker** con el daemon activo.

```sh
git clone https://github.com/splayercloud/proof
cd proof
corepack enable
pnpm run setup
```

En un repositorio objetivo:

```sh
proof init      # detecta stack, genera config + instrucciones para agentes
proof doctor    # valida el entorno antes de gastar tiempo de Docker
proof release plan --base-sha <deployed-sha> --head-sha <candidate-sha>
```

`proof init` respeta `.gitignore`, detecta servicios construibles, distingue Node.js de Next.js, y genera `proof.config.ts`, `proof.config.json` y un bloque gestionado dentro de `AGENTS.md`.

### Configuración mínima

```ts
export default {
  services: {
    api: { kind: "nextjs", path: ".", port: 3000 },
  },
  data: {
    postgres: { kind: "postgres", version: 16 },
  },
  flows: [],
  release: { strategy: "migration-first", rollback: "application" },
  policies: ["no-destructive-migrations"],
  workload: {
    command: "pnpm",
    args: ["run", "test:e2e"],
    timeoutMs: 600000,
  },
  coverage: {
    requiredRoutes: ["POST /payments", "GET /payments"],
    rollbackProbeRoutes: ["GET /payments"],
  },
  approvals: [],
};
```

Cada servicio también admite `dockerfile`, `buildContext`, `buildArgs`, `env`, `prismaSchema` y `readinessTimeoutMs`. En monorepos con varios servicios, `--service <nombre>` es obligatorio.

El workload recibe `PROOF_BASE_URL` y debe conducir la aplicación por HTTP. **Nunca recibe `DATABASE_URL`**: el recorder necesita poder atribuir cada escritura a una ruta HTTP concreta, y el workload no debe poder mutar la base por fuera de la superficie observada.

> ⚠️ **Límite conocido:** la autenticación *stateless* (JWT firmado con el secreto declarado en `services.<n>.env`) replayea correctamente. Las sesiones con token aleatorio persistido en base todavía pueden divergir en el replay y no están soportadas hoy.

---

## 🖥️ Comandos

| Comando | Estado actual |
|---|---|
| `proof init` | Detecta stack/servicios, genera configuración + instrucciones para agentes; sin e2e propio, genera un workload desde OpenAPI con coverage real |
| `proof doctor` | Valida runtime, Docker, disco, historial Git, secretos versionados, config, workload, coverage y approvals |
| `proof release plan` | Fast path estático; planifica y **nunca** emite `VERIFIED` |
| `proof release verify` | Ejecuta la matriz completa, coexistencia y rollback; imprime celda por celda y genera el Proof Bundle |
| `proof reproduce <id>` | Reconstruye un exchange puntual o vuelve a ejecutar una etapa completa |
| `proof cleanup` | Elimina contenedores/redes residuales de Proof (`--dry-run` lista sin tocar nada) |
| `proof bundle keygen/sign/verify/inspect` | Firma Ed25519 del payload canónico y su verificación |
| `proof mcp serve` | Expone `plan`/`verify`/`reproduce` por MCP stdio, para que un agente los invoque directamente |
| `proof check` | Stub explícito — la publicación de un GitHub Check Run todavía no está implementada |

Los bundles se guardan en `.proof/` (excluido del repo — ver `.gitignore`).

---

## 🗺️ Roadmap: el camino a estándar multi-stack

El motor actual de Proof está deliberadamente acotado a **TypeScript/Next.js + PostgreSQL + Prisma** porque probar la matriz de transición a fondo en un solo stack, antes de generalizar, es lo que hace que la evidencia sea confiable en primer lugar. Esa decisión es temporal, no arquitectónica: el core (`docker-executor`, `http-recorder`, `policy-engine`, `postgres-verifier`, `proof-schema`) ya está separado del detector de stack vía `@proof/plugin-sdk`, y cada integración de lenguaje/framework/base de datos vive como plugin independiente (`plugins/node`, `plugins/postgres`, `plugins/prisma`, `plugins/github-actions`).

La intención declarada del proyecto es que Proof se convierta en el **estándar del Evidence Plane para cualquier stack backend con estado**, no solo para el ecosistema Node.js:

| Stack | Estado |
|---|---|
| ![TypeScript](https://img.shields.io/badge/-TypeScript%2FNext.js-3178C6?logo=typescript&logoColor=white) + ![PostgreSQL](https://img.shields.io/badge/-PostgreSQL-4169E1?logo=postgresql&logoColor=white) + ![Prisma](https://img.shields.io/badge/-Prisma-2D3748?logo=prisma&logoColor=white) | ✅ Motor implementado y en uso |
| ![Python](https://img.shields.io/badge/-Python-3776AB?logo=python&logoColor=white) (Django / FastAPI / SQLAlchemy) | 🔜 Planificado |
| ![C](https://img.shields.io/badge/-C%2FC%2B%2B%2FC%23-A8B9CC?logo=c&logoColor=white) (familia C) | 🔜 Planificado |
| ![Java](https://img.shields.io/badge/-Java%20%2F%20Spring%20Boot-6DB33F?logo=spring&logoColor=white) | 🔜 Planificado |

Cada nuevo stack implica, como mínimo: un detector de servicio (`plugin-sdk`), un adaptador de base de datos/migraciones equivalente a `postgres-verifier`, y validación de que el modelo de matriz A0/A1 × S0/S1 sigue siendo la pregunta correcta para ese ecosistema — no una traducción mecánica del caso Node.js.

---

## 🚫 Límites deliberados

Proof no intenta adivinar invariantes de negocio. *"Dos períodos no pueden abrirse simultáneamente"* o *"el ciclo de sueldos debe devolver 422"* son tests que el agente o el equipo tienen que escribir; Proof los convierte en workload y los reejecuta a través de la transición completa.

Tampoco reemplaza un linter completo de migraciones como Atlas. El fast path consume y clasifica evidencia estática; lo que diferencia a Proof es unir esa evidencia con evidencia **dinámica** de qué versiones, datos, flujos y escrituras se ejecutaron realmente.

Hoy `release verify` necesita dos snapshots de Git: el SHA desplegado y el candidato. Inferir "la cadena sin la última migración" responde una pregunta local distinta y no demuestra cuál aplicación está efectivamente desplegada. Un flujo para árboles sucios puede agregarse como nivel de desarrollo, pero nunca puede fingir provenance de release.

---

## 🔒 Qué no se sube al repositorio

Este repositorio versiona código, configuración y documentación técnica — **no** documentos generados, binarios ni material derivado. El `.gitignore` excluye explícitamente:

- `output/` y `tmp/` — PDFs, renders y artefactos generados (p. ej. la tesis del proyecto)
- `*.pdf`, `*.docx`, `*.pptx`, `*.xlsx` y binarios de oficina en cualquier ubicación fuera de `docs/`
- `.proof/` — bundles de evidencia generados en ejecuciones locales
- `.env`, `.env.*`, `*.pem`, `*.key`, `*.p12`, `*.pfx` — secretos y credenciales
- `.turbo/`, `.turbo-evaluation/`, `dist/`, `coverage/` — caches y builds reproducibles

Si necesitás compartir un documento del proyecto, subilo a un almacenamiento externo (Drive, storage del equipo) y enlazalo desde `docs/`, en vez de commitearlo.

---

## 🛠️ Desarrollo

```sh
pnpm typecheck
pnpm lint
pnpm build
pnpm test
```

- Arquitectura actual: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)
- Pruebas con Docker real: [`docs/PHASE_1.md`](docs/PHASE_1.md)
- Cómo contribuir: [`CONTRIBUTING.md`](CONTRIBUTING.md)

---

## 📄 Licencia

Proof **no** es software libre ni de código abierto. Se distribuye bajo la
**Proof Restricted Use License**, una licencia propietaria que autoriza
usar Proof como producto terminado (CLI, servidor MCP) pero **prohíbe**:
modificarlo, redistribuirlo, ofrecerlo como servicio a terceros, crear
obras derivadas, o usar su código/documentación para construir un
producto competidor. El código es visible por transparencia y auditoría,
no por ser reutilizable.

Ver el texto completo en [LICENSE](LICENSE). Para licenciamiento comercial
ampliado, contactar a través de los canales del repositorio.

<div align="center">

*Proof no te dice que confíes. Te da la evidencia para decidir.*

</div>
