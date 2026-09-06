import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { ComposeExecutor } from "../dist/index.js";
import { FakeRunner, compose, type Responder } from "./fake-runner.js";

/**
 * Onboarding a Docker (informe Bs As Neumáticos 2026-07): el candidato
 * agrega el Dockerfile que el commit base desplegado no tiene. Con
 * dockerfileFromSha la RECETA sale del worktree del candidato y las FUENTES
 * del worktree del commit que se construye.
 */

const BASE_SHA = "a".repeat(40);
const HEAD_SHA = "b".repeat(40);

let tmp: string;
let worktreesDir: string;

function seedWorktree(sha: string, files: Record<string, string>): string {
  const dir = join(worktreesDir, sha.slice(0, 12));
  mkdirSync(dir, { recursive: true });
  for (const [relPath, contents] of Object.entries(files)) {
    const absPath = join(dir, relPath);
    mkdirSync(dirname(absPath), { recursive: true });
    writeFileSync(absPath, contents, "utf-8");
  }
  return dir;
}

/** Como gitCachedWorktree, pero honesto con DOS SHAs distintos. */
function gitTwoWorktrees(): Responder {
  return (command, args) => {
    if (command !== "git") return undefined;
    const line = args.join(" ");
    const target = args.find((arg) => arg.endsWith("^{commit}"));
    if (line.includes("rev-parse") && target !== undefined) {
      return { stdout: `${target.slice(0, -"^{commit}".length)}\n` };
    }
    if (line.endsWith("rev-parse HEAD")) {
      const dir = args[args.indexOf("-C") + 1] ?? "";
      return {
        stdout: `${dir.includes(BASE_SHA.slice(0, 12)) ? BASE_SHA : HEAD_SHA}\n`,
      };
    }
    return undefined;
  };
}

function inspectMissResponder(): Responder {
  return (command, args) => {
    if (
      command === "docker" &&
      args[0] === "image" &&
      args[1] === "inspect" &&
      String(args[2] ?? "").startsWith("cloudproof-app:")
    ) {
      return { exitCode: 1, stderr: "No such image" };
    }
    return undefined;
  };
}

function makeExecutor(runner: FakeRunner): ComposeExecutor {
  return new ComposeExecutor({
    runner,
    repoRoot: tmp,
    worktreesDir,
    runId: "test",
    pollIntervalMs: 1,
    readinessTimeoutMs: 500,
    httpProbe: async () => true,
    blockEgress: false,
  });
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "cloudproof-df-head-"));
  worktreesDir = join(tmp, "wt");
  mkdirSync(worktreesDir, { recursive: true });
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("buildImage con dockerfileFromSha", () => {
  it("usa la receta del candidato y las fuentes del commit base", async () => {
    const baseDir = seedWorktree(BASE_SHA, { "package.json": "{}\n" });
    const headDir = seedWorktree(HEAD_SHA, {
      Dockerfile: "FROM scratch\n",
      "package.json": "{}\n",
    });
    const runner = new FakeRunner(compose(gitTwoWorktrees(), inspectMissResponder()));

    await makeExecutor(runner).buildImage({
      sha: BASE_SHA,
      servicePath: ".",
      dockerfileFromSha: HEAD_SHA,
    });

    const build = runner.calls.find(
      (call) => call.command === "docker" && call.args[0] === "build",
    );
    // -f apunta al Dockerfile del worktree del CANDIDATO…
    expect(build?.args).toContain(join(headDir, "Dockerfile"));
    // …y el contexto (último argumento) es el worktree del commit BASE.
    expect(build?.args.at(-1)).toBe(baseDir);
  });

  it("sin dockerfileFromSha el error enseña la salida legítima (dockerfileFrom: head)", async () => {
    seedWorktree(BASE_SHA, { "package.json": "{}\n" });
    const runner = new FakeRunner(compose(gitTwoWorktrees(), inspectMissResponder()));

    await expect(
      makeExecutor(runner).buildImage({ sha: BASE_SHA, servicePath: "." }),
    ).rejects.toThrow(/dockerfileFrom/);
  });

  it("con dockerfileFromSha y receta ausente TAMBIÉN en el candidato, falla sin sugerirse a sí mismo", async () => {
    seedWorktree(BASE_SHA, { "package.json": "{}\n" });
    seedWorktree(HEAD_SHA, { "package.json": "{}\n" });
    const runner = new FakeRunner(compose(gitTwoWorktrees(), inspectMissResponder()));

    const failure = makeExecutor(runner).buildImage({
      sha: BASE_SHA,
      servicePath: ".",
      dockerfileFromSha: HEAD_SHA,
    });
    await expect(failure).rejects.toThrow(/No se encontró Dockerfile/);
    await expect(failure).rejects.not.toThrow(/dockerfileFrom: "head"/);
  });
});
