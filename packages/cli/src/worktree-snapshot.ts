import { SpawnRunner, snapshotWorkingTree } from "@cloudproof/docker-executor";

export interface WorktreeSnapshot {
  headSha: string;
  parentSha: string;
  dirty: boolean;
  source: "clean-worktree" | "synthetic-worktree-commit";
}

/** CLI adapter around the executor's plumbing-only immutable snapshot. */
export async function createWorktreeSnapshot(cwd: string): Promise<WorktreeSnapshot> {
  const snapshot = await snapshotWorkingTree(
    new SpawnRunner({ executionProfile: "trusted", role: "orchestrator" }),
    cwd,
  );
  return {
    headSha: snapshot.sha,
    parentSha: snapshot.parent,
    dirty: snapshot.dirtyFiles.length > 0,
    source:
      snapshot.dirtyFiles.length === 0 ? "clean-worktree" : "synthetic-worktree-commit",
  };
}
