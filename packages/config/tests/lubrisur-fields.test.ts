import { describe, expect, it } from "vitest";
import { ProjectConfigSchema } from "../src/schema.js";

const BASE_CONFIG = {
  services: { api: { kind: "node", path: "." } },
  data: { postgres: { kind: "postgres", version: 16 } },
  flows: [],
  release: { strategy: "migration-first", rollback: "application" },
  policies: [],
  approvals: [],
};

describe("data.<n>.schemaBaseline (informe Lubrisur 2026-07, 2ª ronda)", () => {
  it("acepta una ruta repo-relativa en data sources postgres", () => {
    const valid = ProjectConfigSchema.safeParse({
      ...BASE_CONFIG,
      data: {
        postgres: { kind: "postgres", version: 16, schemaBaseline: "cloudproof.baseline.sql" },
      },
    });
    expect(valid.success).toBe(true);
  });

  it("rechaza traversal y rutas absolutas", () => {
    for (const path of ["../fuera.sql", "/etc/baseline.sql", "C:\\baseline.sql"]) {
      expect(
        ProjectConfigSchema.safeParse({
          ...BASE_CONFIG,
          data: { postgres: { kind: "postgres", schemaBaseline: path } },
        }).success,
      ).toBe(false);
    }
  });

  it("rechaza schemaBaseline en data sources que no son postgres", () => {
    const invalid = ProjectConfigSchema.safeParse({
      ...BASE_CONFIG,
      data: {
        postgres: { kind: "postgres" },
        cache: { kind: "redis", schemaBaseline: "cloudproof.baseline.sql" },
      },
    });
    expect(invalid.success).toBe(false);
  });
});
