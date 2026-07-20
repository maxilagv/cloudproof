import { describe, expect, it } from "vitest";
import { remediationFor, withRemediation } from "../dist/index.js";
import type { Assertion, ExecutionState } from "@proof/schema";

const NOT_NULL_LINE =
  'SQLSTATE 23502: null value in column "currency" of relation "payments" violates not-null constraint';

describe("remediationFor — catálogo determinista (tesis 7.6)", () => {
  it("23502 en replay → la receta expand/contract de la demo canónica, con columna y tabla concretas", () => {
    const remediation = remediationFor({
      result: "fail",
      state: "A0_S1",
      evidence: ["POST /payments failed 18/18.", NOT_NULL_LINE],
    });

    expect(remediation?.pattern).toBe("postgres.not-null-column-old-app-writes");
    expect(remediation?.strategy).toBe("expand-contract");
    expect(remediation?.steps.map((step) => step.title)).toEqual([
      "Add nullable column",
      "Deploy dual-write app",
      "Backfill",
      "Add NOT NULL in later release",
    ]);
    expect(remediation?.steps.map((step) => step.phase)).toEqual([
      "expand",
      "deploy",
      "backfill",
      "contract",
    ]);
    expect(remediation?.summary).toContain('"currency"');
    expect(remediation?.steps[0]?.detail).toContain('"currency"');
    expect(remediation?.steps[0]?.detail).toContain('"payments"');
    expect(remediation?.triggeredBy).toEqual([NOT_NULL_LINE]);
  });

  it("23502 durante la migración → backfill antes del constraint (fallo data-dependent), no receta de app", () => {
    const remediation = remediationFor({
      result: "fail",
      state: "MIGRATE_S0_TO_S1",
      evidence: [NOT_NULL_LINE],
    });

    expect(remediation?.pattern).toBe("postgres.set-not-null-over-existing-nulls");
    expect(remediation?.strategy).toBe("safe-sequence");
    expect(remediation?.steps[0]?.phase).toBe("backfill");
    expect(remediation?.steps.at(-1)?.title).toBe("Add NOT NULL after backfill");
  });

  it("42703 en replay → conservar la columna durante la transición", () => {
    const remediation = remediationFor({
      result: "fail",
      state: "A0_S1",
      evidence: ['SQLSTATE 42703: column "legacy_status" of relation "orders" does not exist'],
    });

    expect(remediation?.pattern).toBe("postgres.dropped-column-still-used");
    expect(remediation?.steps[0]?.title).toBe("Keep the column during the transition");
    expect(remediation?.steps[0]?.detail).toContain('"legacy_status"');
  });

  it("reconoce el resto del catálogo Fase 1 por SQLSTATE y estado", () => {
    const cases: Array<[ExecutionState, string, string]> = [
      ["A0_S1", "SQLSTATE 42P01: relation \"legacy_orders\" does not exist", "postgres.dropped-table-still-used"],
      ["MIGRATE_S0_TO_S1", "SQLSTATE 23505: could not create unique index", "postgres.unique-over-duplicates"],
      ["A0_S1", "SQLSTATE 23505: duplicate key value violates unique constraint", "postgres.unique-breaks-old-writes"],
      ["A0_S1", "SQLSTATE 23503: violates foreign key constraint", "postgres.foreign-key-breaks-old-writes"],
      ["A0_S1", "SQLSTATE 23514: violates check constraint", "postgres.check-breaks-old-writes"],
      ["A0_S1", "SQLSTATE 22001: value too long for type character varying(3)", "postgres.column-shrunk-under-old-writes"],
    ];
    for (const [state, line, pattern] of cases) {
      expect(remediationFor({ result: "fail", state, evidence: [line] })?.pattern).toBe(pattern);
    }
  });

  it("sin SQLSTATE reconocible, con approval, en pass o en estado no mapeado → sin receta", () => {
    expect(
      remediationFor({ result: "fail", state: "A0_S1", evidence: ["HTTP 500 (baseline 201)."] }),
    ).toBeUndefined();
    expect(
      remediationFor({
        result: "fail",
        state: "A0_S1",
        evidence: [NOT_NULL_LINE],
        approval: { reason: "cambio coordinado" },
      }),
    ).toBeUndefined();
    expect(
      remediationFor({ result: "pass", state: "A0_S1", evidence: [] }),
    ).toBeUndefined();
    expect(
      remediationFor({ result: "fail", state: "SQL_EFFECTS", evidence: [NOT_NULL_LINE] }),
    ).toBeUndefined();
    expect(
      remediationFor({ result: "fail", state: "A0_S1", evidence: ["SQLSTATE 99999: unknown"] }),
    ).toBeUndefined();
  });

  it("withRemediation adjunta la receta a fallos y deja intactas las demás assertions", () => {
    const fail: Assertion = {
      id: "postgres.old-app-new-schema.post-payments",
      result: "fail",
      state: "A0_S1",
      evidence: [NOT_NULL_LINE],
    };
    const pass: Assertion = { id: "build.base", result: "pass", evidence: [] };

    expect(withRemediation(fail).remediation?.pattern).toBe(
      "postgres.not-null-column-old-app-writes",
    );
    expect(withRemediation(pass)).toBe(pass);
  });
});
