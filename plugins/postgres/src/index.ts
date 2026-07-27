import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { generatedSegmentOf, type Detector, type DetectionResult } from "@proof/plugin-sdk";

export const postgresDetector: Detector = {
  id: "postgres",
  async detect(projectRoot: string): Promise<DetectionResult> {
    const evidence: string[] = [];
    for (const composeName of ["compose.yml", "compose.yaml", "docker-compose.yml", "docker-compose.yaml"]) {
      const composePath = join(projectRoot, composeName);
      if (existsSync(composePath)) {
        const contents = readFileSync(composePath, "utf-8");
        if (/\bpostgres(:|\/)/i.test(contents)) {
          evidence.push(`${composeName} referencia una imagen postgres`);
        }
      }
    }

    for (const envName of [".env", ".env.example"]) {
      const envPath = join(projectRoot, envName);
      if (existsSync(envPath) && /postgres(ql)?:\/\//i.test(readFileSync(envPath, "utf-8"))) {
        evidence.push(`${envName} contiene un DATABASE_URL de postgres`);
      }
    }

    const prismaSchemas: string[] = [];
    const collectPrismaFiles = (directory: string, depth: number): void => {
      if (depth < 0) return;
      let entries;
      try {
        entries = readdirSync(directory, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const child = join(directory, entry.name);
        if (entry.isDirectory()) collectPrismaFiles(child, depth - 1);
        else if (entry.name.endsWith(".prisma")) prismaSchemas.push(child);
      }
    };
    const findSchemas = (directory: string, depth: number): void => {
      if (depth > 5) return;
      for (const entry of requireDirectories(directory)) {
        if (["node_modules", ".git", "dist", ".next", ".turbo"].includes(entry)) continue;
        // Los outputs de generadores (ej. el cliente Prisma en src/generated)
        // copian schema.prisma; no son evidencia del schema fuente del repo.
        if (generatedSegmentOf(entry) !== undefined) continue;
        const child = join(directory, entry);
        if (entry === "prisma") {
          const schema = join(child, "schema.prisma");
          if (existsSync(schema)) prismaSchemas.push(schema);
          // Layout multi-archivo: prisma/schema/**/*.prisma.
          else collectPrismaFiles(join(child, "schema"), 2);
        } else {
          findSchemas(child, depth + 1);
        }
      }
    };
    findSchemas(projectRoot, 0);
    if (prismaSchemas.some((path) => /provider\s*=\s*["']postgresql["']/i.test(readFileSync(path, "utf-8")))) {
      evidence.push("Prisma declara provider postgresql");
    }

    return { detected: evidence.length > 0, kind: "postgres", evidence };
  },
};

function requireDirectories(path: string): string[] {
  return readdirSync(path, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
}

export default postgresDetector;
