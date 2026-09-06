import type { CloudProofBundle } from "@cloudproof/schema";
import { describe, expect, it } from "vitest";
import { evaluatePolicies, getPolicy, UnknownPolicyError } from "../dist/index.js";

function bundle(approved: boolean): CloudProofBundle {
  return {
    version: "1",
    subject: { baseSha: "base", headSha: "head" },
    conclusion: approved ? "VERIFIED" : "UNSAFE",
    assertions: [
      {
        id: "postgres.sql-effects",
        result: "fail",
        evidence: ["delta distinto"],
        ...(approved ? { approval: { reason: "cambio coordinado" } } : {}),
      },
    ],
    coverage: { routesObserved: 1, routesDetected: 1 },
    provenance: { runner: "unit", artifacts: [] },
    nextActions: [],
  };
}

describe("policy registry", () => {
  it("no-destructive-migrations bloquea solo fallos no aprobados", () => {
    expect(evaluatePolicies(["no-destructive-migrations"], bundle(false))).toHaveLength(1);
    expect(evaluatePolicies(["no-destructive-migrations"], bundle(true))).toEqual([]);
  });

  it("no registra policies futuras como si estuvieran disponibles", () => {
    expect(() => getPolicy("critical-flows-pass")).toThrow(UnknownPolicyError);
  });
});
