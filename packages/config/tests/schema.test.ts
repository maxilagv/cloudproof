import { describe, expect, it } from "vitest";
import { ProjectConfigSchema } from "../dist/index.js";

const base = {
  services: { api: { kind: "node", path: "." } },
  data: { postgres: { kind: "postgres", version: 16 } },
  release: { strategy: "migration-first", rollback: "application" },
};

describe("ProjectConfigSchema", () => {
  it("aplica defaults aditivos a configs existentes", () => {
    expect(ProjectConfigSchema.parse(base)).toMatchObject({
      flows: [],
      policies: [],
      approvals: [],
    });
  });

  it("valida el universo de rutas y rechaza approvals ambiguas", () => {
    expect(
      ProjectConfigSchema.safeParse({
        ...base,
        coverage: { requiredRoutes: ["payments"] },
      }).success,
    ).toBe(false);
    const duplicate = ProjectConfigSchema.safeParse({
      ...base,
      approvals: [
        { assertionId: "postgres.sql-effects", reason: "one" },
        { assertionId: "postgres.sql-effects", reason: "two" },
      ],
    });
    expect(duplicate.success).toBe(false);
    if (!duplicate.success) {
      expect(duplicate.error.issues[0]?.message).toContain("duplicada");
    }
  });
});
