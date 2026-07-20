import { describe, expect, it } from "vitest";
import { collectResidues, sweepResidues } from "../dist/index.js";
import { FakeRunner, type Responder } from "./fake-runner.js";

/**
 * `proof cleanup` (P0 informe 2026-07-18) se apoya en este módulo: el
 * contrato es listar SOLO recursos con label dev.proof.owner, no eliminar
 * nada bajo dry-run, y que un recurso ya desaparecido no cuente como fallo.
 */

const listing: Responder = (command, args) => {
  if (command !== "docker") return undefined;
  const line = args.join(" ");
  if (line.startsWith("ps -a")) {
    return {
      stdout:
        "aaa111\tproof-pg-s0-run1\trun1\n" +
        "bbb222\tproof-app-0-run2\trun2\n" +
        "ccc333\tproof-legacy\t\n",
    };
  }
  if (line.startsWith("network ls")) {
    return { stdout: "ddd444\tproof-net-run1\trun1\n" };
  }
  return undefined;
};

describe("collectResidues", () => {
  it("lista contenedores y redes con label de Proof, con runId opcional", async () => {
    const runner = new FakeRunner(listing);
    const report = await collectResidues(runner);

    expect(report.containers).toEqual([
      { id: "aaa111", name: "proof-pg-s0-run1", runId: "run1" },
      { id: "bbb222", name: "proof-app-0-run2", runId: "run2" },
      { id: "ccc333", name: "proof-legacy" },
    ]);
    expect(report.networks).toEqual([{ id: "ddd444", name: "proof-net-run1", runId: "run1" }]);
    expect(runner.count("--filter label=dev.proof.owner=proof")).toBe(2);
  });

  it("falla con evidencia si el daemon no responde", async () => {
    const runner = new FakeRunner(() => ({ exitCode: 1, stderr: "cannot connect to daemon" }));
    await expect(collectResidues(runner)).rejects.toThrow(/listar los contenedores/);
  });
});

describe("sweepResidues", () => {
  it("con dryRun lista sin ejecutar ningún rm", async () => {
    const runner = new FakeRunner(listing);
    const report = await sweepResidues(runner, { dryRun: true });

    expect(report.removed).toBe(false);
    expect(report.failures).toEqual([]);
    expect(report.containers).toHaveLength(3);
    expect(runner.count("rm -f")).toBe(0);
    expect(runner.count("network rm")).toBe(0);
  });

  it("elimina contenedores antes que redes y reporta fallos reales", async () => {
    const runner = new FakeRunner((command, args, index) => {
      const base = listing(command, args, index);
      if (base !== undefined) return base;
      const line = args.join(" ");
      if (line === "rm -f bbb222") return { exitCode: 1, stderr: "device or resource busy" };
      if (line === "rm -f ccc333") return { exitCode: 1, stderr: "No such container: ccc333" };
      return undefined;
    });
    const report = await sweepResidues(runner);

    expect(report.removed).toBe(true);
    // El "no such container" no es fallo: alguien lo eliminó entre listado y rm.
    expect(report.failures).toEqual([
      "contenedor proof-app-0-run2: device or resource busy",
    ]);
    expect(runner.count("rm -f")).toBe(3);
    expect(runner.count("network rm ddd444")).toBe(1);
    const lines = runner.lines();
    expect(lines.indexOf("docker network rm ddd444")).toBeGreaterThan(
      lines.indexOf("docker rm -f aaa111"),
    );
  });
});
