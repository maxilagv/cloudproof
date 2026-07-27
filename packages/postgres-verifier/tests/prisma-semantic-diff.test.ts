import { describe, expect, it } from "vitest";
import { parsePrismaModels, prismaSemanticFindings } from "../dist/index.js";

/**
 * Informe Bs As Neumáticos (2026-07): `Payment.amount` fue marcado como
 * PRISMA_REQUIRED_FIELD_ADDED cuando solo se re-alineó el espaciado de la
 * línea. Estos tests fijan el contrato: los findings salen de comparar
 * modelos y campos PARSEADOS, nunca líneas.
 */

const BASE = [
  "model Payment {",
  "  id        String  @id @default(cuid())",
  "  amount    Decimal",
  "  reference String? @map(\"ref\")",
  "  createdAt DateTime @default(now())",
  "  @@unique([reference, createdAt])",
  "}",
].join("\n");

describe("prismaSemanticFindings — falsos positivos eliminados", () => {
  it("re-alinear el espaciado de un campo existente NO es un campo nuevo (caso Payment.amount)", () => {
    const head = BASE.replace("  amount    Decimal", "  amount            Decimal");
    expect(prismaSemanticFindings(BASE, head)).toEqual([]);
  });

  it("reordenar atributos o reformatear @@unique tampoco genera findings", () => {
    const head = [
      "model Payment {",
      "  id        String  @default(cuid()) @id",
      "  amount Decimal",
      "  reference String? @map(\"ref\")",
      "  createdAt DateTime @default(now())",
      "  @@unique([reference,createdAt])",
      "}",
    ].join("\n");
    const findings = prismaSemanticFindings(BASE, head);
    // El @@unique reformateado no debe contar como nuevo; el reordenar
    // atributos de `id` tampoco toca requiredness ni unicidad.
    expect(findings.filter((f) => f.code === "PRISMA_UNIQUE_ADDED")).toEqual([]);
    expect(findings.filter((f) => f.code === "PRISMA_REQUIRED_FIELD_ADDED")).toEqual([]);
  });

  it("mover un campo de lugar dentro del modelo no genera findings", () => {
    const head = [
      "model Payment {",
      "  amount    Decimal",
      "  id        String  @id @default(cuid())",
      "  createdAt DateTime @default(now())",
      "  reference String? @map(\"ref\")",
      "  @@unique([reference, createdAt])",
      "}",
    ].join("\n");
    expect(prismaSemanticFindings(BASE, head)).toEqual([]);
  });
});

describe("prismaSemanticFindings — riesgos reales detectados", () => {
  it("un campo requerido genuinamente NUEVO en un modelo existente sigue siendo HIGH", () => {
    const head = BASE.replace(
      "  amount    Decimal",
      "  amount    Decimal\n  currency  String",
    );
    const findings = prismaSemanticFindings(BASE, head);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      code: "PRISMA_REQUIRED_FIELD_ADDED",
      risk: "high",
    });
    expect(findings[0]?.raw).toContain("currency");
  });

  it("un campo nuevo con @default, opcional, o en un modelo NUEVO no genera riesgo A0", () => {
    const withDefault = BASE.replace(
      "  amount    Decimal",
      "  amount    Decimal\n  currency  String @default(\"ARS\")",
    );
    const optional = BASE.replace(
      "  amount    Decimal",
      "  amount    Decimal\n  note      String?",
    );
    const newModel = `${BASE}\n\nmodel Refund {\n  id     String @id\n  amount Decimal\n}`;
    expect(prismaSemanticFindings(BASE, withDefault)).toEqual([]);
    expect(prismaSemanticFindings(BASE, optional)).toEqual([]);
    expect(prismaSemanticFindings(BASE, newModel)).toEqual([]);
  });

  it("volver requerido un campo que era opcional se reporta como su propia clase de riesgo", () => {
    const head = BASE.replace(
      "  reference String? @map(\"ref\")",
      "  reference String @map(\"ref\")",
    );
    const findings = prismaSemanticFindings(BASE, head);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ code: "PRISMA_FIELD_MADE_REQUIRED", risk: "high" });
  });

  it("la unicidad solo cuenta cuando es semánticamente nueva (@unique de campo y @@unique de bloque)", () => {
    const fieldUnique = BASE.replace(
      "  reference String? @map(\"ref\")",
      "  reference String? @unique @map(\"ref\")",
    );
    const blockUnique = BASE.replace(
      "  @@unique([reference, createdAt])",
      "  @@unique([reference, createdAt])\n  @@unique([amount, createdAt])",
    );
    expect(prismaSemanticFindings(BASE, fieldUnique).map((f) => f.code)).toEqual([
      "PRISMA_UNIQUE_ADDED",
    ]);
    expect(prismaSemanticFindings(BASE, blockUnique).map((f) => f.code)).toEqual([
      "PRISMA_UNIQUE_ADDED",
    ]);
  });
});

describe("parsePrismaModels", () => {
  it("parsea campos con tipo, opcionalidad, lista y atributos normalizados", () => {
    const models = parsePrismaModels(BASE);
    const payment = models.get("Payment");
    expect(payment?.fields.get("amount")).toMatchObject({
      type: "Decimal",
      optional: false,
      list: false,
    });
    expect(payment?.fields.get("reference")).toMatchObject({ optional: true });
    expect([...(payment?.blockAttributes.keys() ?? [])]).toEqual(["@@unique([reference,createdAt])"]);
  });
});
