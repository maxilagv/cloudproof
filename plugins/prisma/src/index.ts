import { existsSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import type { Detector, DetectionResult } from "@proof/plugin-sdk";

/** ¿La carpeta contiene al menos un .prisma (hasta 2 niveles)? */
function containsPrismaFiles(directory: string, depth = 2): boolean {
  if (depth < 0) return false;
  let entries;
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch {
    return false;
  }
  return entries.some((entry) =>
    entry.isDirectory()
      ? containsPrismaFiles(join(directory, entry.name), depth - 1)
      : entry.name.endsWith(".prisma"),
  );
}

export const prismaDetector: Detector = {
  id: "prisma",
  async detect(projectRoot: string): Promise<DetectionResult> {
    const evidence: string[] = [];
    const ignored = new Set(["node_modules", ".git", "dist", ".next", ".turbo"]);
    const visit = (directory: string, depth: number): void => {
      if (depth > 5) return;
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        if (!entry.isDirectory() || ignored.has(entry.name)) continue;
        const child = join(directory, entry.name);
        if (entry.name === "prisma") {
          const schemaPath = join(child, "schema.prisma");
          if (existsSync(schemaPath)) {
            evidence.push(relative(projectRoot, schemaPath).replace(/\\/g, "/"));
          }
          // Layout multi-archivo (Prisma 6.7+): prisma/schema/ con *.prisma.
          const schemaFolder = join(child, "schema");
          if (!existsSync(schemaPath) && containsPrismaFiles(schemaFolder)) {
            evidence.push(relative(projectRoot, schemaFolder).replace(/\\/g, "/") + "/");
          }
          const migrationsDir = join(child, "migrations");
          if (existsSync(migrationsDir)) {
            evidence.push(relative(projectRoot, migrationsDir).replace(/\\/g, "/") + "/");
          }
        } else {
          visit(child, depth + 1);
        }
      }
    };
    visit(projectRoot, 0);

    return { detected: evidence.length > 0, kind: "prisma", evidence };
  },
};

export default prismaDetector;
