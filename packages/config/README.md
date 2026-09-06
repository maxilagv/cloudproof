# @cloudproof/config

Schema Zod y helpers de configuracion para CloudProof.

## Uso

```ts
import { defineProject, nextjs, postgres } from "@cloudproof/config";

export default defineProject({
  services: { web: nextjs("./apps/web") },
  data: { postgres: postgres({ version: 18 }) },
  flows: ["checkout"],
  release: { strategy: "migration-first", rollback: "application" },
  policies: ["no-destructive-migrations"],
  workload: { command: "pnpm", args: ["run", "test:e2e"] },
  coverage: { requiredRoutes: ["POST /payments"] },
  approvals: [],
});
```

El workload usa comando y argumentos separados, nunca shell. Las rutas deben
ser relativas al repo y no pueden atravesar con `..`.

## Frontera de confianza

El orden de aislamiento es `trusted < internal < fork`.

- `trusted` conserva `cloudproof.config.ts` via jiti por compatibilidad y tambien
  acepta `cloudproof.config.json`.
- `internal` y `fork` solo aceptan `cloudproof.config.json`: importar TypeScript
  ejecutaria codigo del checkout antes de crear el sandbox.
- `CLOUDPROOF_EXECUTION_PROFILE` selecciona el perfil; un override tipado tiene
  prioridad.
- `CLOUDPROOF_EXECUTION_PROFILE_LOCKED` fija el piso de seguridad de CI. Un override
  puede endurecerlo, nunca bajarlo.

El JSON se limita a 1 MiB y se valida con el mismo `ProjectConfigSchema`.
