import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import type { CommandRunner } from "./command-runner.js";
import { ExecutorError } from "./errors.js";

/**
 * Checkout de SHAs específicos vía `git worktree` (comparte objetos con el
 * repo original, no clona). Los worktrees se cachean por SHA en un
 * directorio temporal y se REUSAN entre corridas — el criterio de "cero
 * residuos" de la Subfase 1.A aplica a contenedores, no a worktrees, que
 * funcionan como capa de cache (tesis 16.4: caché content-addressed).
 * pruneAll() los limpia cuando se quiere liberar disco.
 *
 * Los worktrees viven SIEMPRE fuera del repo del usuario (en tmpdir), en
 * parte para no ensuciar su árbol y en parte porque montar rutas de
 * OneDrive/red dentro de Docker es frágil — tmpdir local no lo es.
 */
export class WorktreeManager {
  private readonly created = new Set<string>();
  private readonly baseDir: string;

  constructor(
    private readonly runner: CommandRunner,
    private readonly repoRoot: string,
    baseDir?: string,
  ) {
    // El mismo SHA puede existir en repos distintos (por ejemplo, commits con
    // árbol/metadatos idénticos). Separar el cache por repo evita reutilizar
    // un worktree válido pero perteneciente a otro proyecto.
    const repoKey = createHash("sha256").update(resolve(repoRoot)).digest("hex").slice(0, 16);
    this.baseDir = baseDir ?? join(tmpdir(), "cloudproof-worktrees", repoKey);
  }

  /** Devuelve un directorio con el repo checkouteado exactamente en `sha`. */
  async ensure(sha: string): Promise<string> {
    const fullSha = await this.resolveCommit(sha);
    const dir = join(this.baseDir, fullSha.slice(0, 12));

    if (existsSync(dir)) {
      const head = await this.runner.run("git", ["-C", dir, "rev-parse", "HEAD"]);
      const status = await this.runner.run("git", [
        "-C",
        dir,
        "status",
        "--porcelain=v1",
        "--untracked-files=all",
      ]);
      if (
        head.exitCode === 0 &&
        head.stdout.trim() === fullSha &&
        status.exitCode === 0 &&
        status.stdout.trim() === ""
      ) {
        return dir;
      }
      // Directorio residual roto, sucio o de otro repo: descartarlo y
      // recrearlo. HEAD por sí solo no demuestra que el contenido conserve
      // el commit; un workload previo pudo modificar o agregar archivos.
      await this.runner.run("git", ["-C", this.repoRoot, "worktree", "remove", "--force", dir]);
      if (existsSync(dir)) {
        rmSync(dir, { recursive: true, force: true });
      }
      await this.runner.run("git", ["-C", this.repoRoot, "worktree", "prune"]);
    }

    mkdirSync(this.baseDir, { recursive: true });
    const add = await this.runner.run("git", [
      "-C",
      this.repoRoot,
      "worktree",
      "add",
      "--detach",
      dir,
      fullSha,
    ]);
    if (add.exitCode !== 0) {
      throw new ExecutorError(`git worktree add falló para ${sha}`, [
        add.stderr.trim().slice(-2000),
      ]);
    }
    this.created.add(dir);
    return dir;
  }

  /** Elimina todos los worktrees creados por esta instancia. */
  async pruneAll(): Promise<void> {
    for (const dir of this.created) {
      await this.runner.run("git", ["-C", this.repoRoot, "worktree", "remove", "--force", dir]);
      if (existsSync(dir)) {
        rmSync(dir, { recursive: true, force: true });
      }
    }
    this.created.clear();
    await this.runner.run("git", ["-C", this.repoRoot, "worktree", "prune"]);
  }

  /** Snapshot inmutable del árbol de trabajo de este repo (ver función suelta). */
  async snapshotWorkingTree(): Promise<WorkingTreeSnapshot> {
    return snapshotWorkingTree(this.runner, this.repoRoot);
  }

  private async resolveCommit(sha: string): Promise<string> {
    // Evita option injection y revisiones patologicas antes de pasarlas a git.
    // Se conservan los operadores de revision utiles (^, ~, @{...}, :), pero
    // nunca se acepta un argumento que pueda empezar como flag.
    if (
      sha.length < 1 ||
      sha.length > 256 ||
      sha.startsWith("-") ||
      !/^[A-Za-z0-9._/@{}~^:+-]+$/.test(sha)
    ) {
      throw new ExecutorError(`Referencia git invalida o insegura: "${sha}".`);
    }
    const result = await this.runner.run("git", [
      "-C",
      this.repoRoot,
      "rev-parse",
      "--verify",
      `${sha}^{commit}`,
    ]);
    if (result.exitCode !== 0) {
      throw new ExecutorError(`SHA inválido o inexistente en ${this.repoRoot}: ${sha}`, [
        result.stderr.trim().slice(-500),
      ]);
    }
    const fullSha = result.stdout.trim();
    if (!/^[0-9a-f]{40,64}$/i.test(fullSha)) {
      throw new ExecutorError(`git devolvió un object id inválido para ${sha}.`);
    }
    return fullSha;
  }
}

// --------------------------------------------------- snapshot del árbol vivo

export interface WorkingTreeSnapshot {
  /** Commit git REAL (objeto en la object database) con el contenido exacto del árbol. */
  sha: string;
  /** Tree del snapshot: content-addressed — un commit posterior con el mismo contenido comparte este id. */
  tree: string;
  /** HEAD del repo al momento del snapshot (padre del commit sintético). */
  parent: string;
  /** Archivos que difieren de HEAD según `git status`; vacío = el snapshot ES HEAD. */
  dirtyFiles: string[];
}

/**
 * Identidad y fechas FIJAS: mismo contenido ⇒ mismo commit id ⇒ el cache de
 * worktrees por SHA se reutiliza entre corridas consecutivas sin commit.
 */
const SNAPSHOT_ENV = {
  GIT_AUTHOR_NAME: "CloudProof",
  GIT_AUTHOR_EMAIL: "snapshot@cloudproof.dev",
  GIT_COMMITTER_NAME: "CloudProof",
  GIT_COMMITTER_EMAIL: "snapshot@cloudproof.dev",
  GIT_AUTHOR_DATE: "2005-04-07T22:13:13Z",
  GIT_COMMITTER_DATE: "2005-04-07T22:13:13Z",
};

/**
 * Congela el árbol de trabajo (incluidos archivos sin trackear que no estén
 * en .gitignore) en un commit git inmutable SIN tocar HEAD, el index del
 * usuario ni disparar hooks: index temporal vía GIT_INDEX_FILE + read-tree,
 * add -A, write-tree y commit-tree (plumbing puro).
 *
 * Esto resuelve "no puede verificar cambios sin commit" (informe Lubrisur
 * 2026-07) SIN degradar la postura de inmutabilidad: la evidencia queda
 * atada a un object id content-addressed que cualquiera puede auditar; el
 * bundle resultante sirve para iterar en desarrollo, y un gate de
 * merge/deploy sigue exigiendo verificar el commit publicado.
 */
export async function snapshotWorkingTree(
  runner: CommandRunner,
  repoRoot: string,
): Promise<WorkingTreeSnapshot> {
  const git = async (args: string[], env?: Record<string, string>) => {
    const result = await runner.run("git", ["-C", repoRoot, ...args], {
      ...(env === undefined ? {} : { env }),
    });
    if (result.exitCode !== 0) {
      throw new ExecutorError(`git ${args[0]} falló al preparar el snapshot del árbol de trabajo.`, [
        result.stderr.trim().slice(-2000),
      ]);
    }
    return result.stdout;
  };
  const objectId = (value: string, label: string): string => {
    const id = value.trim();
    if (!/^[0-9a-f]{40,64}$/i.test(id)) {
      throw new ExecutorError(`git devolvió un ${label} inválido para el snapshot: "${id}".`);
    }
    return id;
  };

  const parent = objectId(await git(["rev-parse", "--verify", "HEAD^{commit}"]), "commit id");
  const status = await git(["status", "--porcelain=v1", "--untracked-files=all"]);
  const dirtyFiles = status
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 3)
    .map((line) => {
      const path = line.slice(3);
      // Renames se reportan como "old -> new"; interesa el destino vivo.
      const arrow = path.lastIndexOf(" -> ");
      return (arrow < 0 ? path : path.slice(arrow + 4)).replace(/^"|"$/g, "");
    })
    .sort();

  if (dirtyFiles.length === 0) {
    const tree = objectId(await git(["rev-parse", "HEAD^{tree}"]), "tree id");
    return { sha: parent, tree, parent, dirtyFiles };
  }

  const indexDirectory = mkdtempSync(join(tmpdir(), "cloudproof-snapshot-"));
  const indexEnv = { GIT_INDEX_FILE: join(indexDirectory, "index") };
  try {
    await git(["read-tree", "HEAD"], indexEnv);
    await git(["add", "-A", "--", "."], indexEnv);
    const tree = objectId(await git(["write-tree"], indexEnv), "tree id");
    const sha = objectId(
      await git(
        [
          "commit-tree",
          tree,
          "-p",
          parent,
          "-m",
          "cloudproof: working-tree snapshot (cambios sin commit)",
        ],
        { ...indexEnv, ...SNAPSHOT_ENV },
      ),
      "commit id",
    );
    return { sha, tree, parent, dirtyFiles };
  } finally {
    rmSync(indexDirectory, { recursive: true, force: true });
  }
}
