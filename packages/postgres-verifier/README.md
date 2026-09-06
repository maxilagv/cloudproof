# @cloudproof/postgres-verifier

Núcleo de evidencia estática y dinámica para releases PostgreSQL + Prisma.

## Fast path

`planRelease` inspecciona un rango Git con presupuesto acotado. Clasifica
migraciones, schema Prisma, SQL, build, dependencias, runtime y CI; detecta
patrones de riesgo y devuelve `PLAN_ONLY_NOT_VERIFIED` con el nivel de
aseguramiento y `nextCommand` requeridos. Nunca emite `VERIFIED`.

## Matriz dinámica

`verifyRelease` deriva su ledger obligatorio de `src/matrix.ts` y ejecuta:

- builds A0/A1;
- baseline `A0+S0` y migración de estados limpios/poblados;
- `A1+S0`, `A0+S1` y `A1+S1`;
- coexistencia A0/A1 sobre S1 en órdenes A0-first y A1-first;
- rollback de A0 después de un prefijo de escrituras de A1;
- efectos SQL en cortes de startup y workload.

Se usan clones frescos del mismo seed para que las comparaciones no dupliquen
escrituras ni mezclen estados iniciales distintos.

## Semántica de conclusión

- `UNSAFE`: existe un fallo obligatorio no aprobado.
- `INCONCLUSIVE`: baseline roto, cobertura desconocida/incompleta, estado
  obligatorio omitido, ausencia de escrituras o efectos no atribuibles.
- `VERIFIED`: toda obligación ejecutada y toda coverage declarada satisfecha.

Cada fallo reconocido conserva contexto de reproducción, puede adjuntar una
remediation determinista y genera `nextActions` tipadas.
