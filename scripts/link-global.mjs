// Deja el binario `cloudproof` disponible en el PATH global via `npm link`,
// ejecutado desde packages/cli. Multiplataforma (Windows crea los shims
// cloudproof.cmd/cloudproof.ps1; POSIX un symlink). Los workspace:* ya quedaron
// materializados por `pnpm install`, así que el paquete linkeado resuelve
// sus dependencias contra el árbol real del repo.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const cliDir = join(repoRoot, "packages", "cli");

const result = spawnSync("npm", ["link"], {
  cwd: cliDir,
  stdio: "inherit",
  shell: process.platform === "win32",
});

if (result.status !== 0) {
  console.error("\nnpm link falló. Alternativa manual: cd packages/cli && npm link");
  process.exit(result.status ?? 1);
}

console.log("\n√ `cloudproof` quedó disponible globalmente. Probalo con: cloudproof");
