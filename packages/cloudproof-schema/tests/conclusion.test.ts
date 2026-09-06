import { describe, expect, it } from "vitest";
import { deriveConclusion } from "../dist/index.js";

const completeCoverage = {
  routesObserved: 1,
  routesDetected: 1,
  routesRequired: 1,
  source: "declared" as const,
  complete: true,
};

describe("deriveConclusion", () => {
  it("prioriza un fallo obligatorio no aprobado", () => {
    expect(
      deriveConclusion([{ result: "fail", mandatory: true }], {
        ...completeCoverage,
        complete: false,
      }),
    ).toBe("UNSAFE");
  });

  it("una approval explícita elimina solo ese bloqueo", () => {
    expect(
      deriveConclusion(
        [
          {
            result: "fail",
            mandatory: true,
            approval: { reason: "Cambio coordinado" },
          },
        ],
        completeCoverage,
      ),
    ).toBe("VERIFIED");
  });

  it("cobertura desconocida, incompleta o assertion omitida nunca verifica", () => {
    expect(
      deriveConclusion([{ result: "pass" }], {
        ...completeCoverage,
        source: "unknown",
      }),
    ).toBe("INCONCLUSIVE");
    expect(
      deriveConclusion([{ result: "pass" }], {
        ...completeCoverage,
        complete: false,
      }),
    ).toBe("INCONCLUSIVE");
    expect(
      deriveConclusion([{ result: "pass" }, { result: "skipped" }], completeCoverage),
    ).toBe("INCONCLUSIVE");
  });

  it("mantiene compatibilidad con coverage v1 legacy cuando hay evidencia", () => {
    expect(
      deriveConclusion([{ result: "pass" }], {
        routesObserved: 1,
        routesDetected: 1,
      }),
    ).toBe("VERIFIED");
  });
});
