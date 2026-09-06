import { ProjectConfigSchema, type ProjectConfig, type ServiceConfig, type DataSourceConfig } from "./schema.js";

/**
 * Ver tesis, sección 5.1 — ejemplo canónico de cloudproof.config.ts:
 *
 *   export default defineProject({
 *     services: { web: nextjs("./apps/web"), api: node("./apps/api") },
 *     data: { postgres: postgres({ version: 18 }), redis: redis() },
 *     flows: ["checkout", "authentication"],
 *     release: { strategy: "migration-first", rollback: "application" },
 *     policies: ["no-destructive-migrations", "critical-flows-pass"]
 *   });
 */
export function defineProject(input: ProjectConfig): ProjectConfig {
  return ProjectConfigSchema.parse(input);
}

type ServiceOptions = Pick<ServiceConfig, "port" | "prismaSchema">;

export function nextjs(path: string, options: ServiceOptions = {}): ServiceConfig {
  return {
    kind: "nextjs",
    path,
    ...(options.port === undefined ? {} : { port: options.port }),
    ...(options.prismaSchema === undefined ? {} : { prismaSchema: options.prismaSchema }),
  };
}

export function node(path: string, options: ServiceOptions = {}): ServiceConfig {
  return {
    kind: "node",
    path,
    ...(options.port === undefined ? {} : { port: options.port }),
    ...(options.prismaSchema === undefined ? {} : { prismaSchema: options.prismaSchema }),
  };
}

export function postgres(opts: { version?: number } = {}): DataSourceConfig {
  return { kind: "postgres", version: opts.version };
}

export function redis(): DataSourceConfig {
  return { kind: "redis" };
}
