import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Detector, DetectionResult } from "@cloudproof/plugin-sdk";

export const githubActionsDetector: Detector = {
  id: "github-actions",
  async detect(projectRoot: string): Promise<DetectionResult> {
    const workflowsDir = join(projectRoot, ".github", "workflows");
    const evidence = existsSync(workflowsDir) ? [".github/workflows/"] : [];
    return { detected: evidence.length > 0, kind: "github-actions", evidence };
  },
};
