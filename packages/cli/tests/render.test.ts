import { describe, it, expect } from "vitest";
import { renderHumanReport } from "../dist/commands/release-verify.js";
import type { Assertion, ProofBundle } from "@proof/schema";

function stripRemediation(assertion: Assertion): Assertion {
  const copy = { ...assertion };
  delete copy.remediation;
  return copy;
}

const unsafeBundle: ProofBundle = {
  version: "1",
  subject: { baseSha: "a".repeat(40), headSha: "b".repeat(40) },
  conclusion: "UNSAFE",
  assertions: [
    { id: "workload.baseline", result: "pass", evidence: [] },
    {
      id: "postgres.old-app-new-schema.post-payments",
      result: "fail",
      state: "A0_S1",
      evidence: [
        "POST /payments failed 3/3.",
        "HTTP 500 (baseline 201).",
        'SQLSTATE 23502: null value in column "currency" of relation "payments" violates not-null constraint',
      ],
      reproduction: "proof reproduce postgres.old-app-new-schema.post-payments",
      remediation: {
        pattern: "postgres.not-null-column-old-app-writes",
        strategy: "expand-contract",
        summary: 'The deployed application cannot write column "currency".',
        steps: [
          { order: 1, phase: "expand", title: "Add nullable column", detail: "..." },
          { order: 2, phase: "deploy", title: "Deploy dual-write app", detail: "..." },
          { order: 3, phase: "backfill", title: "Backfill", detail: "..." },
          { order: 4, phase: "contract", title: "Add NOT NULL in later release", detail: "..." },
        ],
        triggeredBy: ["SQLSTATE 23502"],
      },
    },
  ],
  coverage: { routesObserved: 2, routesDetected: 2 },
  provenance: { runner: "test-run", artifacts: [] },
  nextActions: [
    {
      kind: "apply-remediation",
      assertionId: "postgres.old-app-new-schema.post-payments",
      instruction: "Apply the remediation steps and re-run proof release verify.",
    },
  ],
};

describe("renderHumanReport — demo canónica (tesis 19.5)", () => {
  it("UNSAFE con remediation del catálogo reproduce la demo completa", () => {
    const report = renderHumanReport(
      unsafeBundle,
      [
        {
          policyId: "no-destructive-migrations",
          message: "La migración candidata rompe la aplicación actualmente desplegada.",
          relatedAssertionIds: ["postgres.old-app-new-schema.post-payments"],
        },
      ],
      ".proof/release-verify-test-run.json",
    );

    expect(report).toContain("Tests normales: PASS");
    expect(report).toContain("Migration: APPLIED");
    expect(report).toContain("RELEASE PROOF: UNSAFE");
    expect(report).toContain("Old application cannot write to migrated schema.");
    expect(report).toContain("POST /payments failed 3/3.");
    expect(report).toContain("SQLSTATE 23502");
    expect(report).toContain("Recommended:");
    expect(report).toContain("1. Add nullable column");
    expect(report).toContain("4. Add NOT NULL in later release");
    expect(report).toContain("Reproduce: proof reproduce postgres.old-app-new-schema.post-payments");
    expect(report).toContain("[policy] no-destructive-migrations");
  });

  it("UNSAFE sin receta de catálogo no inventa una recomendación", () => {
    const bundle: ProofBundle = {
      ...unsafeBundle,
      assertions: unsafeBundle.assertions.map((assertion) =>
        assertion.result === "fail"
          ? { ...stripRemediation(assertion), evidence: ["HTTP 500 (baseline 201)."] }
          : assertion,
      ),
      nextActions: [],
    };

    const report = renderHumanReport(bundle, [], "x.json");

    expect(report).toContain("RELEASE PROOF: UNSAFE");
    expect(report).not.toContain("Recommended:");
  });

  it("INCONCLUSIVE sin workload explica qué falta y lista las nextActions", () => {
    const bundle: ProofBundle = {
      ...unsafeBundle,
      conclusion: "INCONCLUSIVE",
      assertions: [],
      coverage: { routesObserved: 0, routesDetected: 0 },
      nextActions: [
        {
          kind: "add-workload",
          configPath: "workload",
          instruction:
            "Declare a workload in proof.config.ts that drives the service through PROOF_BASE_URL.",
        },
        {
          kind: "declare-coverage",
          configPath: "coverage.requiredRoutes",
          instruction: "Declare the mandatory route universe in proof.config.ts.",
        },
      ],
    };

    const report = renderHumanReport(bundle, [], "x.json");

    expect(report).toContain("RELEASE PROOF: INCONCLUSIVE");
    expect(report).toContain("No write workload observed");
    expect(report).toContain("Next:");
    expect(report).toContain("1. Declare a workload in proof.config.ts");
    expect(report).toContain("2. Declare the mandatory route universe");
    expect(report).not.toContain("Recommended:");
    expect(report).not.toContain("Tests normales");
  });

  it("baseline roto → INCONCLUSIVE con la evidencia del workload, sin culpar a la migración", () => {
    const bundle: ProofBundle = {
      ...unsafeBundle,
      conclusion: "INCONCLUSIVE",
      assertions: [
        {
          id: "workload.baseline",
          result: "fail",
          evidence: ["El workload baseline salió con código 1 sobre A0+S0."],
        },
      ],
      nextActions: [
        {
          kind: "fix-baseline",
          assertionId: "workload.baseline",
          instruction: "Fix the suite or the base app first.",
        },
      ],
    };

    const report = renderHumanReport(bundle, [], "x.json");

    expect(report).toContain("Tests normales: FAIL");
    expect(report).toContain("nothing can be attributed to the migration");
    expect(report).toContain("salió con código 1");
    expect(report).toContain("Next:");
    expect(report).toContain("1. Fix the suite or the base app first.");
  });

  it("fingerprint roto se muestra antes que la coverage incompleta", () => {
    const bundle: ProofBundle = {
      ...unsafeBundle,
      conclusion: "INCONCLUSIVE",
      assertions: [
        {
          id: "postgres.baseline.schema-stable",
          result: "skipped",
          mandatory: true,
          state: "A0_S0",
          evidence: [
            "No se pudo fingerprintar pg_catalog en ambos puntos de corte.",
            'ERROR: operator is not unique: text || "char"',
          ],
        },
      ],
      coverage: {
        routesObserved: 0,
        routesDetected: 1,
        routesRequired: 1,
        source: "declared",
        complete: false,
      },
      nextActions: [
        {
          kind: "rerun-stage",
          assertionId: "postgres.baseline.schema-stable",
          instruction: 'Fix operator is not unique: text || "char" and re-run.',
        },
      ],
    };

    const report = renderHumanReport(bundle, [], "x.json");

    expect(report).toContain("Schema fingerprint failed at postgres.baseline.schema-stable");
    expect(report).toContain('operator is not unique: text || "char"');
    expect(report).not.toContain("Required route coverage is incomplete");
  });

  it("distingue coverage declarada de una ruta realmente modificada sin tráfico", () => {
    const bundle: ProofBundle = {
      ...unsafeBundle,
      conclusion: "INCONCLUSIVE",
      assertions: [
        {
          id: "coverage.changed-route.post-api-catalogo-inline",
          result: "skipped",
          mandatory: true,
          state: "A0_S0",
          evidence: ["La ruta modificada POST /api/catalogo/inline no recibió tráfico HTTP."],
        },
      ],
      coverage: {
        routesObserved: 2,
        routesDetected: 2,
        routesRequired: 2,
        source: "declared",
        complete: false,
        changedRoutesDetected: 1,
        changedRoutesObserved: 0,
        changedRoutesMissing: ["POST /api/catalogo/inline"],
        changeSource: "diff-inferred",
      },
    };

    const report = renderHumanReport(bundle, [], "x.json");

    expect(report).toContain("Change coverage is incomplete");
    expect(report).toContain("Changed route without traffic: POST /api/catalogo/inline");
    expect(report).toContain("cannot claim that the modified feature works");
    expect(report).not.toContain("Required route coverage is incomplete");
  });

  it("imprime la matriz celda por celda desde los states del Bundle", () => {
    const report = renderHumanReport(unsafeBundle, [], "x.json");

    expect(report).toContain("Matriz de ejecución:");
    // La celda que falló muestra FAIL; las no ejercidas no se inventan.
    expect(report).toMatch(/A0_S1\s+FAIL/);
    expect(report).toMatch(/BUILD_A0\s+sin evidencia/);
    // Aparecen los 10 estados del contrato, siempre en el mismo orden.
    expect(report.indexOf("BUILD_A0")).toBeLessThan(report.indexOf("SQL_EFFECTS"));
  });

  it("la matriz no se imprime cuando ninguna assertion declara state", () => {
    const bundle: ProofBundle = {
      ...unsafeBundle,
      assertions: [{ id: "workload.baseline", result: "pass", evidence: [] }],
    };
    expect(renderHumanReport(bundle, [], "x.json")).not.toContain("Matriz de ejecución:");
  });

  it("muestra un cambio aprobado sin renderizarlo como fallo bloqueante ni recomendar receta", () => {
    const bundle: ProofBundle = {
      ...unsafeBundle,
      conclusion: "VERIFIED",
      assertions: unsafeBundle.assertions.map((assertion) =>
        assertion.result === "fail"
          ? {
              ...stripRemediation(assertion),
              approval: { reason: "Cambio coordinado con consumidores" },
            }
          : assertion,
      ),
      nextActions: [],
    };

    const report = renderHumanReport(bundle, [], "x.json");

    expect(report).toContain("RELEASE PROOF: VERIFIED");
    expect(report).toContain("APPROVED CHANGE: postgres.old-app-new-schema.post-payments");
    expect(report).toContain("Cambio coordinado con consumidores");
    expect(report).not.toContain("Old application cannot write");
    expect(report).not.toContain("Recommended:");
  });
});
