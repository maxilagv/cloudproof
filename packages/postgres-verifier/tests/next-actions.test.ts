import { describe, expect, it } from "vitest";
import { deriveNextActions } from "../dist/index.js";
import type { Assertion, Coverage, Remediation } from "@cloudproof/schema";

const declaredCoverage: Coverage = {
  routesObserved: 2,
  routesDetected: 2,
  routesRequired: 2,
  source: "declared",
  complete: true,
};

const unknownCoverage: Coverage = {
  routesObserved: 1,
  routesDetected: 0,
  routesRequired: 0,
  source: "unknown",
  complete: false,
};

const context = {
  workloadDeclared: true,
  observedExchanges: 3,
  observedWrites: true,
  missingRoutes: [] as string[],
};

const remediation: Remediation = {
  pattern: "postgres.not-null-column-old-app-writes",
  strategy: "expand-contract",
  summary: "resumen",
  steps: [{ order: 1, phase: "expand", title: "Add nullable column", detail: "detalle" }],
  triggeredBy: ["SQLSTATE 23502"],
};

describe("deriveNextActions — invariantes", () => {
  it("VERIFIED → cero acciones", () => {
    expect(deriveNextActions([], declaredCoverage, "VERIFIED", context)).toEqual([]);
  });

  it("UNSAFE con receta → apply-remediation con assertionId, comando y prohibición de auto-approval", () => {
    const assertions: Assertion[] = [
      {
        id: "postgres.old-app-new-schema.post-payments",
        result: "fail",
        evidence: ["POST /payments failed 3/3."],
        reproduction: "cloudproof reproduce postgres.old-app-new-schema.post-payments",
        remediation,
      },
    ];

    const actions = deriveNextActions(assertions, declaredCoverage, "UNSAFE", context);

    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({
      kind: "apply-remediation",
      assertionId: "postgres.old-app-new-schema.post-payments",
      command: "cloudproof reproduce postgres.old-app-new-schema.post-payments",
    });
    expect(actions[0]?.instruction).toContain("postgres.not-null-column-old-app-writes");
    expect(actions[0]?.instruction).toContain("approvals are a human decision");
  });

  it("UNSAFE sin receta de catálogo → fix-failure con la evidencia principal", () => {
    const actions = deriveNextActions(
      [
        {
          id: "postgres.sql-effects",
          result: "fail",
          evidence: ["Los efectos SQL del replay difieren del baseline."],
        },
      ],
      declaredCoverage,
      "UNSAFE",
      context,
    );

    expect(actions).toHaveLength(1);
    expect(actions[0]?.kind).toBe("fix-failure");
    expect(actions[0]?.instruction).toContain("difieren del baseline");
  });

  it("UNSAFE ignora fallos aprobados y el baseline al derivar acciones", () => {
    const actions = deriveNextActions(
      [
        {
          id: "postgres.sql-effects",
          result: "fail",
          evidence: ["x"],
          approval: { reason: "coordinado" },
        },
        { id: "postgres.old-app-new-schema.post-payments", result: "fail", evidence: ["y"] },
      ],
      declaredCoverage,
      "UNSAFE",
      context,
    );

    expect(actions.map((action) => action.assertionId)).toEqual([
      "postgres.old-app-new-schema.post-payments",
    ]);
  });

  it("baseline roto → una única acción fix-baseline (nada más es atribuible)", () => {
    const actions = deriveNextActions(
      [
        {
          id: "workload.baseline",
          result: "fail",
          evidence: ["El workload baseline salió con código 1 sobre A0+S0."],
        },
        { id: "coverage.routes-declared", result: "skipped", evidence: ["sin universo"] },
      ],
      unknownCoverage,
      "INCONCLUSIVE",
      context,
    );

    expect(actions).toHaveLength(1);
    expect(actions[0]?.kind).toBe("fix-baseline");
    expect(actions[0]?.instruction).toContain("salió con código 1");
  });

  it("prerequisito de infraestructura sin evidencia → solo rerun-stage", () => {
    const actions = deriveNextActions(
      [{ id: "build.base", result: "skipped", evidence: ["docker build falló"] }],
      unknownCoverage,
      "INCONCLUSIVE",
      { ...context, workloadDeclared: false, observedExchanges: 0, observedWrites: false },
    );

    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({ kind: "rerun-stage", assertionId: "build.base" });
  });

  it("fingerprint roto gana prioridad sobre coverage incompleta y conserva la causa", () => {
    const actions = deriveNextActions(
      [
        {
          id: "postgres.baseline.schema-stable",
          result: "skipped",
          mandatory: true,
          evidence: [
            "No se pudo fingerprintar pg_catalog en ambos puntos de corte.",
            "Falló fingerprint de schema PostgreSQL.",
            'ERROR: operator is not unique: text || "char"',
          ],
        },
        {
          id: "coverage.route.post-orders",
          result: "skipped",
          evidence: ["POST /orders no fue ejercitada"],
        },
      ],
      { ...declaredCoverage, complete: false },
      "INCONCLUSIVE",
      { ...context, missingRoutes: ["POST /orders"] },
    );

    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({
      kind: "rerun-stage",
      assertionId: "postgres.baseline.schema-stable",
    });
    expect(actions[0]?.instruction).toContain('operator is not unique: text || "char"');
  });

  it("cobertura desconocida + ruta faltante + sin escrituras → acciones específicas acumuladas", () => {
    const actions = deriveNextActions(
      [
        {
          id: "coverage.route.post-payments",
          result: "skipped",
          evidence: ["La ruta obligatoria POST /payments no fue ejercitada por el workload."],
        },
      ],
      { ...declaredCoverage, complete: false },
      "INCONCLUSIVE",
      { ...context, observedWrites: false, missingRoutes: ["POST /payments"] },
    );

    const kinds = actions.map((action) => action.kind);
    expect(kinds).toContain("exercise-route");
    expect(kinds).toContain("add-write-workload");
    expect(actions.find((action) => action.kind === "exercise-route")).toMatchObject({
      subject: "POST /payments",
    });
    expect(
      actions.find((action) => action.kind === "exercise-route")?.instruction,
    ).toContain("CLOUDPROOF_BASE_URL");
  });

  it("sin workload declarado → add-workload apuntando al configPath", () => {
    const actions = deriveNextActions(
      [],
      unknownCoverage,
      "INCONCLUSIVE",
      { workloadDeclared: false, observedExchanges: 0, observedWrites: false, missingRoutes: [] },
    );

    const workloadAction = actions.find((action) => action.kind === "add-workload");
    expect(workloadAction).toMatchObject({ configPath: "workload" });
    expect(actions.find((action) => action.kind === "declare-coverage")).toMatchObject({
      configPath: "coverage.requiredRoutes",
    });
  });

  it("workload declarado pero sin tráfico grabado → señalar CLOUDPROOF_BASE_URL", () => {
    const actions = deriveNextActions(
      [],
      declaredCoverage,
      "INCONCLUSIVE",
      { workloadDeclared: true, observedExchanges: 0, observedWrites: false, missingRoutes: [] },
    );

    const workloadAction = actions.find((action) => action.kind === "add-workload");
    expect(workloadAction?.instruction).toContain("CLOUDPROOF_BASE_URL");
  });

  it("sql-effects omitida por falta de escrituras no duplica rerun-stage (la cubre add-write-workload)", () => {
    const actions = deriveNextActions(
      [
        {
          id: "postgres.sql-effects",
          result: "skipped",
          evidence: ["El workload baseline no produjo inserts, updates ni deletes observables en PostgreSQL."],
        },
      ],
      declaredCoverage,
      "INCONCLUSIVE",
      { ...context, observedWrites: false },
    );

    expect(actions.map((action) => action.kind)).toEqual(["add-write-workload"]);
  });

  it("INCONCLUSIVE nunca queda sin acciones (fallo aprobado que cortó la ejecución)", () => {
    const actions = deriveNextActions(
      [
        {
          id: "postgres.migration-candidate",
          result: "fail",
          evidence: ["migration rejected"],
          approval: { reason: "aceptado temporalmente" },
        },
      ],
      declaredCoverage,
      "INCONCLUSIVE",
      context,
    );

    expect(actions.length).toBeGreaterThan(0);
    expect(actions[0]?.kind).toBe("rerun-stage");
  });
});
