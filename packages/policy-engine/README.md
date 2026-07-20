# @proof/policy-engine

Evaluación determinista de invariantes (tesis, sección 11 "Policy engine: evaluación determinista de invariantes"). Ninguna policy hace I/O ni llama a un LLM — solo lee el `ProofBundle` ya generado por `@proof/postgres-verifier`.

## Policies incluidas

| id | Estado | Alcance |
|---|---|---|
| `no-destructive-migrations` | Implementada | MVP (Fase 1) |
| `critical-flows-pass` | No registrada; módulo futuro que falla explícitamente | Fase 3+ (requiere Critical Flows as Code) |

No agregar policies nuevas sin que primero exista el mecanismo que produce la evidencia que esa policy necesita evaluar (ver `postgres-verifier/README.md`, mismo principio: no fabricar evidencia).
