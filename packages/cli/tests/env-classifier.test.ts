import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { classifyEnvKeys } from "../src/commands/env-classifier.js";

const roots: string[] = [];

function repo(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "cloudproof-env-classifier-"));
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

describe("classifyEnvKeys", () => {
  it("separa required (sin guardia, con archivo:línea), conditional y unreferenced", () => {
    const root = repo({
      "src/db.ts": 'export const url = process.env.DATABASE_URL;\n',
      "src/arca.ts": 'const key = process.env.ARCA_API_KEY ?? "";\n',
      "src/wa.ts": "if (!process.env.WHATSAPP_TOKEN) {\n  throw new Error();\n}\n",
    });

    const classes = classifyEnvKeys(
      root,
      new Set(["DATABASE_URL", "ARCA_API_KEY", "WHATSAPP_TOKEN", "DOCUMENTED_ONLY"]),
    );

    expect(classes.get("DATABASE_URL")).toMatchObject({
      usage: "required",
      evidence: ["src/db.ts:1"],
    });
    expect(classes.get("ARCA_API_KEY")?.usage).toBe("conditional");
    expect(classes.get("WHATSAPP_TOKEN")?.usage).toBe("conditional");
    expect(classes.get("DOCUMENTED_ONLY")).toMatchObject({ usage: "unreferenced", evidence: [] });
  });

  it("una sola lectura sin guardia vuelve la variable required aunque haya otras guardadas", () => {
    const root = repo({
      "src/a.ts": 'const a = process.env.SMTP_HOST || "localhost";\n',
      "src/b.ts": "export const b = process.env.SMTP_HOST;\n",
    });

    const classes = classifyEnvKeys(root, new Set(["SMTP_HOST"]));
    expect(classes.get("SMTP_HOST")).toMatchObject({
      usage: "required",
      evidence: ["src/b.ts:1"],
    });
  });

  it("reconoce wrappers (env.X de t3-env) y el acceso por corchetes", () => {
    const root = repo({
      "src/wrapped.ts": 'import { env } from "~/env";\nexport const x = env.NEXTAUTH_SECRET;\n',
      "src/bracket.ts": 'const y = process.env["STRIPE_KEY"];\n',
    });

    const classes = classifyEnvKeys(root, new Set(["NEXTAUTH_SECRET", "STRIPE_KEY"]));
    expect(classes.get("NEXTAUTH_SECRET")?.usage).toBe("required");
    expect(classes.get("STRIPE_KEY")?.usage).toBe("required");
  });

  it("no cuenta lecturas dentro de código generado", () => {
    const root = repo({
      "src/generated/prisma/runtime.js": "const url = process.env.HIDDEN_VAR;\n",
    });

    const classes = classifyEnvKeys(root, new Set(["HIDDEN_VAR"]));
    expect(classes.get("HIDDEN_VAR")?.usage).toBe("unreferenced");
  });
});
