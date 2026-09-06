import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createWorktreeSnapshot } from "../dist/worktree-snapshot.js";
import { runReleasePlan } from "../dist/commands/release-plan.js";

const repositories: string[] = [];

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8" }).trim();
}

function repository(): string {
  const cwd = mkdtempSync(join(tmpdir(), "cloudproof-worktree-test-"));
  repositories.push(cwd);
  git(cwd, ["init", "-q"]);
  git(cwd, ["config", "user.name", "CloudProof Tests"]);
  git(cwd, ["config", "user.email", "cloudproof-tests@example.com"]);
  writeFileSync(join(cwd, "tracked.txt"), "base\n", "utf-8");
  git(cwd, ["add", "."]);
  git(cwd, ["commit", "-q", "-m", "base"]);
  return cwd;
}

afterEach(() => {
  for (const cwd of repositories.splice(0)) rmSync(cwd, { recursive: true, force: true });
});

describe("createWorktreeSnapshot", () => {
  it("captures visible tracked and untracked content without touching branch or index", async () => {
    const cwd = repository();
    const parent = git(cwd, ["rev-parse", "HEAD"]);
    writeFileSync(join(cwd, "tracked.txt"), "staged\n", "utf-8");
    git(cwd, ["add", "tracked.txt"]);
    writeFileSync(join(cwd, "tracked.txt"), "visible\n", "utf-8");
    writeFileSync(join(cwd, "untracked.txt"), "new\n", "utf-8");
    const statusBefore = git(cwd, ["status", "--porcelain=v1", "--untracked-files=all"]);
    const indexBefore = git(cwd, ["diff", "--cached"]);

    const first = await createWorktreeSnapshot(cwd);
    const second = await createWorktreeSnapshot(cwd);

    expect(first).toMatchObject({
      parentSha: parent,
      dirty: true,
      source: "synthetic-worktree-commit",
    });
    expect(first.headSha).toBe(second.headSha);
    expect(first.headSha).not.toBe(parent);
    expect(git(cwd, ["show", `${first.headSha}:tracked.txt`])).toBe("visible");
    expect(git(cwd, ["show", `${first.headSha}:untracked.txt`])).toBe("new");
    expect(git(cwd, ["rev-parse", "HEAD"])).toBe(parent);
    expect(git(cwd, ["status", "--porcelain=v1", "--untracked-files=all"])).toBe(statusBefore);
    expect(git(cwd, ["diff", "--cached"])).toBe(indexBefore);
  });

  it("reuses HEAD for a clean worktree", async () => {
    const cwd = repository();
    const head = git(cwd, ["rev-parse", "HEAD"]);
    expect(await createWorktreeSnapshot(cwd)).toEqual({
      headSha: head,
      parentSha: head,
      dirty: false,
      source: "clean-worktree",
    });
  });

  it("keeps --worktree in the plan-to-verify handoff so provenance is not downgraded", async () => {
    const cwd = repository();
    const baseSha = git(cwd, ["rev-parse", "HEAD"]);
    writeFileSync(join(cwd, "tracked.txt"), "candidate\n", "utf-8");
    writeFileSync(
      join(cwd, "cloudproof.config.ts"),
      `export default {
  services: { api: { kind: "node", path: "." } },
  data: { postgres: { kind: "postgres" } },
  release: { strategy: "migration-first", rollback: "application" },
};\n`,
      "utf-8",
    );

    const plan = await runReleasePlan({
      cwd,
      baseSha,
      worktree: true,
      writeOutput() {},
    });

    expect(plan.subject.headSha).not.toBe(baseSha);
    expect(plan.nextCommand.args).toContain("--worktree");
    expect(plan.nextCommand.args).not.toContain("--head-sha");
    expect(plan.nextCommand.reason).toContain("snapshot de desarrollo inmutable");
  });
});
