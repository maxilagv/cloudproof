import { describe, expect, it } from "vitest";
import type { CommandRunner } from "@cloudproof/docker-executor";
import { cleanupExitCode, renderCleanupReport, runCleanup } from "../src/commands/cleanup.js";

/** Runner mínimo: responde a los listados de residues.ts y registra rm. */
function fakeRunner(
  containers: string,
  networks: string,
): { runner: CommandRunner; lines: string[] } {
  const lines: string[] = [];
  return {
    lines,
    runner: {
      async run(command, args) {
        const line = [command, ...args].join(" ");
        lines.push(line);
        if (line.includes("ps -a")) return { stdout: containers, stderr: "", exitCode: 0 };
        if (line.includes("network ls")) return { stdout: networks, stderr: "", exitCode: 0 };
        return { stdout: "", stderr: "", exitCode: 0 };
      },
    },
  };
}

describe("cloudproof cleanup", () => {
  it("--dry-run lista los residuos sin eliminarlos y sale con 0", async () => {
    const { runner, lines } = fakeRunner("aaa\tcloudproof-pg-s0-x\tx\n", "bbb\tcloudproof-net-x\tx\n");
    let output = "";
    const report = await runCleanup({
      dryRun: true,
      runner,
      writeOutput: (text) => (output += text),
    });

    expect(report.removed).toBe(false);
    expect(cleanupExitCode(report)).toBe(0);
    expect(lines.some((line) => line.includes("rm -f") || line.includes("network rm"))).toBe(
      false,
    );
    expect(output).toContain("cloudproof-pg-s0-x");
    expect(output).toContain("--dry-run: no se eliminó nada.");
  });

  it("elimina y emite JSON estable bajo --json", async () => {
    const { runner } = fakeRunner("aaa\tcloudproof-pg-s0-x\tx\n", "");
    let output = "";
    const report = await runCleanup({
      json: true,
      runner,
      writeOutput: (text) => (output += text),
    });

    expect(cleanupExitCode(report)).toBe(0);
    const parsed = JSON.parse(output) as { version: string; removed: boolean; containers: unknown[] };
    expect(parsed.version).toBe("1");
    expect(parsed.removed).toBe(true);
    expect(parsed.containers).toEqual([{ id: "aaa", name: "cloudproof-pg-s0-x", runId: "x" }]);
  });

  it("renderCleanupReport comunica el caso sin residuos", () => {
    const output = renderCleanupReport({
      containers: [],
      networks: [],
      removed: true,
      failures: [],
    });
    expect(output).toContain("Sin residuos de CloudProof");
  });

  it("un fallo de eliminación produce exit code 1", () => {
    expect(
      cleanupExitCode({
        containers: [],
        networks: [],
        removed: true,
        failures: ["contenedor x: busy"],
      }),
    ).toBe(1);
  });
});
