# @proof/cli

Interfaz determinista del Assurance Kernel. Proof expone evidencia para
agentes, humanos y CI; no contiene un agente conversacional.

| Comando | Comportamiento |
|---|---|
| `proof init` | detecta Node/Postgres/Prisma/Actions y genera config plano |
| `proof doctor` | valida runtime, Docker, config, paths, workload, cobertura y approvals |
| `proof release plan` | clasifica el diff estáticamente y devuelve `PLAN_ONLY_NOT_VERIFIED` + `nextCommand` |
| `proof release verify` | ejecuta el proof y persiste el bundle en `.proof/` |
| `proof reproduce <id>` | reconstruye el finding o reejecuta su etapa |
| `proof mcp serve` | expone verify/evidencia por stdio |

`release verify --json` emite un envelope versionado con bundle, violaciones y
ruta persistida. En monorepos se exige `--service` cuando hay más de uno.
La matriz vigente incluye A0/A1 × S0/S1, dos schedules de coexistencia, efectos
SQL y rollback de A0 después de escrituras de A1.

`doctor` termina con código 1 cuando existe al menos un finding `HIGH` o
`CRITICAL`; findings `MEDIUM/LOW` permanecen diagnósticos no bloqueantes.

## Reproducción

Para un finding HTTP se reconstruyen A0 y un S1 que parte del mismo estado
lógico del baseline, se exporta un snapshot SQL, se escribe un Compose y se
reejecuta el exchange exacto. La app queda disponible para debug hasta:

```sh
proof reproduce <id> --cleanup
```

Los fallos de etapa (`BUILD_A1`, migración, startup o efectos SQL) vuelven a
ejecutar el proof y devuelven la assertion actual. IDs repetidos requieren
`--bundle`; CLI y MCP rechazan elegir uno arbitrariamente.

`proof check` pertenece a Fase 2: la publicación real de GitHub Check Run no
está implementada y falla explícitamente.
