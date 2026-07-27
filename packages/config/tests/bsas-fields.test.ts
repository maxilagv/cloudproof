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

describe("fixtures.bootstrapSql (informe Bs As Neumáticos)", () => {
  it("acepta una ruta repo-relativa y rechaza traversal/absolutas", () => {
    const valid = ProjectConfigSchema.safeParse({
      ...BASE_CONFIG,
      fixtures: { bootstrapSql: "proof.seed.sql" },
    });
    expect(valid.success).toBe(true);

    for (const path of ["../fuera.sql", "/etc/seed.sql", "C:\\seed.sql"]) {
      expect(
        ProjectConfigSchema.safeParse({
          ...BASE_CONFIG,
          fixtures: { bootstrapSql: path },
        }).success,
      ).toBe(false);
    }
  });
});

describe("services.<n>.dockerfileFrom", () => {
  it("acepta commit/head y rechaza cualquier otro valor", () => {
    for (const value of ["commit", "head"]) {
      expect(
        ProjectConfigSchema.safeParse({
          ...BASE_CONFIG,
          services: { api: { kind: "node", path: ".", dockerfileFrom: value } },
        }).success,
      ).toBe(true);
    }
    expect(
      ProjectConfigSchema.safeParse({
        ...BASE_CONFIG,
        services: { api: { kind: "node", path: ".", dockerfileFrom: "base" } },
      }).success,
    ).toBe(false);
  });
});
