import { describe, expect, it } from "vitest";
import { CloudProofBundleSchema, RemediationSchema, NextActionSchema } from "../dist/index.js";

/**
 * remediation y nextActions son adiciones COMPATIBLES dentro de la versión
 * "1" del CloudProof Bundle: un bundle previo (sin esos campos) debe seguir
 * validando sin migración, y el parseo debe defaultear nextActions a [].
 */
const legacyBundle = {
  version: "1",
  subject: { baseSha: "a".repeat(40), headSha: "b".repeat(40) },
  conclusion: "UNSAFE",
  assertions: [
    {
      id: "postgres.old-app-new-schema.post-payments",
      result: "fail",
      evidence: ["POST /payments failed 18/18", "SQLSTATE 23502"],
      reproduction: "cloudproof reproduce postgres.old-app-new-schema.post-payments",
    },
  ],
  coverage: { routesObserved: 18, routesDetected: 24 },
  provenance: { runner: "run-1", artifacts: ["sha256:x"] },
};

describe("CloudProof Bundle v1 — compatibilidad de adiciones", () => {
  it("un bundle previo sin remediation/nextActions valida y defaultea nextActions a []", () => {
    const parsed = CloudProofBundleSchema.parse(legacyBundle);
    expect(parsed.nextActions).toEqual([]);
    expect(parsed.assertions[0]?.remediation).toBeUndefined();
  });

  it("un bundle nuevo con remediation y nextActions valida completo", () => {
    const parsed = CloudProofBundleSchema.parse({
      ...legacyBundle,
      assertions: [
        {
          ...legacyBundle.assertions[0],
          remediation: {
            pattern: "postgres.not-null-column-old-app-writes",
            strategy: "expand-contract",
            summary: "A0 no puede escribir la columna nueva.",
            steps: [
              { order: 1, phase: "expand", title: "Add nullable column", detail: "..." },
              { order: 2, phase: "contract", title: "Add NOT NULL in later release", detail: "..." },
            ],
            triggeredBy: ["SQLSTATE 23502"],
          },
        },
      ],
      nextActions: [
        {
          kind: "apply-remediation",
          assertionId: "postgres.old-app-new-schema.post-payments",
          instruction: "Aplicar la receta y re-verificar.",
        },
      ],
    });

    expect(parsed.assertions[0]?.remediation?.steps).toHaveLength(2);
    expect(parsed.nextActions[0]?.kind).toBe("apply-remediation");
  });

  it("una receta es una secuencia corta: rechaza más de 8 pasos y triggeredBy vacío", () => {
    const step = (order: number) => ({
      order,
      phase: "expand" as const,
      title: `paso ${order}`,
      detail: "...",
    });
    expect(
      RemediationSchema.safeParse({
        pattern: "x",
        strategy: "expand-contract",
        summary: "s",
        steps: Array.from({ length: 9 }, (_, index) => step(index + 1)),
        triggeredBy: ["e"],
      }).success,
    ).toBe(false);
    expect(
      RemediationSchema.safeParse({
        pattern: "x",
        strategy: "expand-contract",
        summary: "s",
        steps: [step(1)],
        triggeredBy: [],
      }).success,
    ).toBe(false);
  });

  it("nextAction exige kind del enum e instruction no vacía", () => {
    expect(
      NextActionSchema.safeParse({ kind: "hacer-magia", instruction: "x" }).success,
    ).toBe(false);
    expect(NextActionSchema.safeParse({ kind: "fix-baseline", instruction: "" }).success).toBe(
      false,
    );
    expect(
      NextActionSchema.safeParse({ kind: "fix-baseline", instruction: "arreglar la suite" })
        .success,
    ).toBe(true);
  });
});
