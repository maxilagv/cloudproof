import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  classifyGeneratedPath,
  generatedSegmentOf,
  isWithinPath,
  prismaGeneratorOutputs,
} from "../src/generated-code.js";

const roots: string[] = [];

function repo(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "cloudproof-generated-code-"));
  roots.push(root);
  for (const [relativePath, contents] of Object.entries(files)) {
    const absolutePath = join(root, relativePath);
    mkdirSync(dirname(absolutePath), { recursive: true });
    writeFileSync(absolutePath, contents, "utf-8");
  }
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("generatedSegmentOf / isWithinPath", () => {
  it("reconoce los segmentos convencionales de código generado", () => {
    expect(generatedSegmentOf("src/generated/prisma")).toBe("generated");
    expect(generatedSegmentOf("app/__generated__/graphql")).toBe("__generated__");
    expect(generatedSegmentOf("node/.prisma/client")).toBe(".prisma");
    expect(generatedSegmentOf("apps/api/src")).toBeUndefined();
    // "generation" o "degenerated" no son marcadores: el match es por segmento exacto.
    expect(generatedSegmentOf("src/generation/prisma")).toBeUndefined();
  });

  it("isWithinPath compara por límites de segmento, no por prefijo de string", () => {
    expect(isWithinPath("src/generated", "src/generated/prisma")).toBe(true);
    expect(isWithinPath("src/generated", "src/generated")).toBe(true);
    expect(isWithinPath("src/gen", "src/generated")).toBe(false);
  });
});

describe("prismaGeneratorOutputs", () => {
  it("resuelve output relativo al directorio del schema (caso Lubrisur)", () => {
    const root = repo({
      "prisma/schema.prisma": [
        'generator client {',
        '  provider = "prisma-client-js"',
        '  output   = "../src/generated/prisma"',
        '}',
        'datasource db {',
        '  provider = "postgresql"',
        '  url      = env("DATABASE_URL")',
        '}',
      ].join("\n"),
    });

    expect(prismaGeneratorOutputs(root, join(root, "prisma/schema.prisma"))).toEqual([
      "src/generated/prisma",
    ]);
  });

  it("ignora outputs env(...) o fuera del repo y no falla sin bloque generator", () => {
    const root = repo({
      "prisma/schema.prisma": [
        'generator client {',
        '  provider = "prisma-client-js"',
        '  output   = env("PRISMA_OUTPUT")',
        '}',
        'generator docs {',
        '  provider = "prisma-docs-generator"',
        '  output   = "../../fuera-del-repo"',
        '}',
      ].join("\n"),
      "solo-datasource/prisma/schema.prisma": 'datasource db { provider = "postgresql" }',
    });

    expect(prismaGeneratorOutputs(root, join(root, "prisma/schema.prisma"))).toEqual([]);
    expect(
      prismaGeneratorOutputs(root, join(root, "solo-datasource/prisma/schema.prisma")),
    ).toEqual([]);
  });
});

describe("classifyGeneratedPath", () => {
  it("prioriza la evidencia del generator y cae al marcador de segmento", () => {
    const byOutput = classifyGeneratedPath("client_gen/prisma", ["client_gen"]);
    expect(byOutput.generated).toBe(true);
    expect(byOutput.reason).toContain("generator Prisma");

    const bySegment = classifyGeneratedPath("src/generated/prisma", []);
    expect(bySegment.generated).toBe(true);
    expect(bySegment.reason).toContain('"generated"');

    expect(classifyGeneratedPath("apps/api", ["client_gen"])).toEqual({ generated: false });
  });
});
