# @proof/docker-executor

Ejecutor Docker real: construye A0/A1 desde worktrees confinados, levanta
Postgres S0/S1, aplica migraciones Prisma, ejecuta apps, captura efectos SQL y
limpia todos los recursos mediante labels por corrida.

## Aislamiento

La red del workload es interna por default. Un sidecar fijo y limitado conecta
un unico puerto con `127.0.0.1`; el codigo candidato no obtiene egress. Todos
los contenedores tienen limites de memoria, CPU y PIDs y
`no-new-privileges`. En `internal`/`fork`, app y migrador usan `cap-drop ALL`;
Postgres parte de `cap-drop ALL` y recupera solo las capabilities necesarias
para inicializar su volumen efimero. El sidecar fijo siempre elimina todas.

## Perfiles de ejecucion

`ComposeExecutor` resuelve `trusted < internal < fork` desde override o
`PROOF_EXECUTION_PROFILE`. `PROOF_EXECUTION_PROFILE_LOCKED` impide downgrades.

- `trusted`: compatibilidad local; root filesystem escribible por default.
- `internal`: root filesystem read-only por default, configurable para una app
  legacy; entorno heredado reducido y build args sensibles rechazados.
- `fork`: exige runner efimero, egress bloqueado, build con `--network=none`,
  root filesystem read-only, imagen con `USER` no-root y rechaza env/build args
  sensibles. Ninguna opcion puede relajar estos controles.

Los valores de entorno de la app viajan por un archivo temporal modo 0600, no
por argv, y se elimina al crear el contenedor.

Un workload es codigo arbitrario, no orquestacion. Usa
`new SpawnRunner({ executionProfile, role: "workload" })`. `fork` falla cerrado
en host: requiere un worker sin credenciales ni acceso al socket Docker.
`internal` solo admite workload host con `PROOF_EPHEMERAL_RUNNER=1` y
`PROOF_SECRETLESS_RUNNER=1`. En perfiles no confiables, omitir `role` se trata
como workload; infraestructura Docker/git debe declarar `role: "orchestrator"`.
