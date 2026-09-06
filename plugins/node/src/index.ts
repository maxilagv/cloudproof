import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Detector, DetectionResult } from "@cloudproof/plugin-sdk";

export const nodeDetector: Detector = {
  id: "node",
  async detect(projectRoot: string): Promise<DetectionResult> {
    const evidence: string[] = [];
    const packageJsonPath = join(projectRoot, "package.json");
    const tsconfigPath = join(projectRoot, "tsconfig.json");

    if (existsSync(packageJsonPath)) evidence.push("package.json");
    if (existsSync(tsconfigPath)) evidence.push("tsconfig.json");

    return {
      detected: evidence.length > 0,
      kind: "node",
      evidence,
    };
  },
};

export default nodeDetector;
