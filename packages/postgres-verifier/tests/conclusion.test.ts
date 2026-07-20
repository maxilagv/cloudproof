import { describe, it, expect } from "vitest";
import { finalConclusion, routeAssertions } from "../dist/index.js";
import type { ReplayResult } from "@proof/http-recorder";

const coverage = (routes: number) => ({ routesObserved: routes, routesDetected: routes });

describe("finalConclusion", () => {
  it("baseline roto → INCONCLUSIVE aunque no haya otros fallos", () => {
    expect(
      finalConclusion([{ id: "workload.baseline", result: "fail" }], coverage(3), ["POST"]),
    ).toBe("INCONCLUSIVE");
  });

  it("baseline roto → INCONCLUSIVE incluso con fallos de replay (nada es atribuible)", () => {
    expect(
      finalConclusion(
        [
          { id: "workload.baseline", result: "fail" },
          { id: "postgres.old-app-new-schema.post-payments", result: "fail" },
        ],
        coverage(3),
        ["POST"],
      ),
    ).toBe("INCONCLUSIVE");
  });

  it("fallo de ruta con baseline sano → UNSAFE", () => {
    expect(
      finalConclusion(
        [
          { id: "workload.baseline", result: "pass" },
          { id: "postgres.old-app-new-schema.post-payments", result: "fail" },
        ],
        coverage(2),
        ["POST", "GET"],
      ),
    ).toBe("UNSAFE");
  });

  it("todo pasa con escrituras observadas → VERIFIED", () => {
    expect(
      finalConclusion(
        [
          { id: "workload.baseline", result: "pass" },
          { id: "postgres.old-app-new-schema.post-payments", result: "pass" },
          { id: "proof.execution-complete", result: "pass" },
        ],
        coverage(2),
        ["POST", "GET"],
      ),
    ).toBe("VERIFIED");
  });

  it("todo pasa pero solo lecturas → INCONCLUSIVE (criterio 19.4: sin workload de escritura)", () => {
    expect(
      finalConclusion(
        [
          { id: "workload.baseline", result: "pass" },
          { id: "postgres.old-app-new-schema.get-payments", result: "pass" },
          { id: "proof.execution-complete", result: "pass" },
        ],
        coverage(1),
        ["GET", "GET"],
      ),
    ).toBe("INCONCLUSIVE");
  });

  it("UNSAFE por lecturas NO se degrada aunque no haya escrituras", () => {
    expect(
      finalConclusion(
        [
          { id: "workload.baseline", result: "pass" },
          { id: "postgres.old-app-new-schema.get-payments", result: "fail" },
        ],
        coverage(1),
        ["GET"],
      ),
    ).toBe("UNSAFE");
  });

  it("cobertura cero → INCONCLUSIVE", () => {
    expect(finalConclusion([], coverage(0), [])).toBe("INCONCLUSIVE");
  });
});

describe("routeAssertions", () => {
  const exchangeFor = (method: string, path: string, baselineStatus: number) => ({
    request: { method, path, headers: {} },
    baselineResponse: { status: baselineStatus },
  });

  it("agrega por ruta con el formato de la demo canónica (failed N/M + SQLSTATE)", () => {
    const results: ReplayResult[] = [0, 1, 2].map(() => ({
      exchange: exchangeFor("POST", "/payments", 201),
      candidateResponse: {
        status: 500,
        sqlErrors: ['SQLSTATE 23502: null value in column "currency"'],
      },
      matches: false,
    }));

    const assertions = routeAssertions(results);

    expect(assertions).toHaveLength(1);
    const assertion = assertions[0]!;
    expect(assertion.id).toBe("postgres.old-app-new-schema.post-payments-07e6553df2bf");
    expect(assertion.result).toBe("fail");
    expect(assertion.evidence[0]).toBe("A0 sobre S1: POST /payments failed 3/3.");
    expect(assertion.evidence.join("\n")).toContain("SQLSTATE 23502");
    expect(assertion.reproduction).toBe(
      `proof reproduce ${assertion.id}`,
    );
  });

  it("rutas que pasan producen assertions pass sin reproduction", () => {
    const results: ReplayResult[] = [
      {
        exchange: exchangeFor("GET", "/payments", 200),
        candidateResponse: { status: 200 },
        matches: true,
      },
    ];

    const assertions = routeAssertions(results);

    expect(assertions).toHaveLength(1);
    expect(assertions[0]!.result).toBe("pass");
    expect(assertions[0]!.reproduction).toBeUndefined();
  });

  it("mismo status sin SQLSTATE agrega la aclaración de body distinto", () => {
    const results: ReplayResult[] = [
      {
        exchange: exchangeFor("GET", "/payments", 200),
        candidateResponse: { status: 200 },
        matches: false,
      },
    ];

    const evidence = routeAssertions(results)[0]!.evidence.join("\n");
    expect(evidence).toContain("failed 1/1");
    expect(evidence).toContain("difiere del baseline");
  });
});
