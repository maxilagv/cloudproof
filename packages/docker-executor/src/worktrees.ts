import { createHash } from "node:crypto";
import { existsSync, mkdirSync, rmSync } from "node:fs";
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
    this.baseDir = baseDir ?? join(tmpdir(), "proof-worktrees", repoKey);
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
