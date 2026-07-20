#!/usr/bin/env node
import { buildProgram, CLI_VERSION } from "./program.js";
import { paint, symbols, welcome } from "./ui.js";

/**
 * Entry point del binario `proof`. `proof` sin argumentos muestra la
 * bienvenida (banner + comandos + próximos pasos) en vez del error seco
 * de "missing command" — primera experiencia de la tesis 6.3.
 */

if (process.argv.slice(2).length === 0) {
  process.stdout.write(welcome(CLI_VERSION));
  process.exit(0);
}

buildProgram()
  .parseAsync(process.argv)
  .catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${symbols.fail} ${paint.red(message)}\n`);
    process.exitCode = 1;
  });
