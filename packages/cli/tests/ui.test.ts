import { describe, expect, it } from "vitest";
import { banner, welcome, conclusionBadge, severityLabel, paint } from "../dist/ui.js";
import { buildProgram, CLI_VERSION } from "../dist/program.js";

/**
 * Bajo vitest stdout no es un TTY: la regla dura de ui.ts es que en ese
 * caso la salida sea texto plano byte-idéntico (sin códigos ANSI), para
 * que pipes, CI y los asserts de los tests e2e no vean escapes.
 */
const ESC = "\u001b";

describe("ui — sin TTY todo es texto plano", () => {
  it("banner y welcome no contienen códigos ANSI y sí la versión y los comandos", () => {
    const output = welcome(CLI_VERSION);
    expect(output).not.toContain(ESC);
    expect(output).toContain(`v${CLI_VERSION}`);
    for (const command of [
      "init",
      "doctor",
      "release verify",
      "reproduce",
      "cleanup",
      "bundle sign|verify",
      "check",
      "mcp serve",
    ]) {
      expect(output).toContain(command);
    }
    expect(banner(CLI_VERSION)).not.toContain(ESC);
  });

  it("badges y severidades degradan a texto plano", () => {
    expect(conclusionBadge("VERIFIED")).toBe("VERIFIED");
    expect(conclusionBadge("UNSAFE")).toBe("UNSAFE");
    expect(severityLabel("CRITICAL")).toBe("CRITICAL ");
    expect(paint.red("x")).toBe("x");
  });
});

describe("programa — interpretación de comandos", () => {
  it("registra exactamente los comandos de Fase 1-2 (D-016)", () => {
    const program = buildProgram();
    expect(program.commands.map((command) => command.name()).sort()).toEqual(
      ["bundle", "check", "cleanup", "doctor", "init", "mcp", "release", "reproduce"].sort(),
    );
  });

  it("un comando con typo sugiere el más parecido en vez de fallar seco", async () => {
    const program = buildProgram();
    let stderr = "";
    program.exitOverride();
    program.configureOutput({
      writeErr: (text) => {
        stderr += text;
      },
    });

    await expect(program.parseAsync(["node", "cloudproof", "relese"])).rejects.toThrow();
    expect(stderr).toContain("release");
  });

  it("--version responde la versión real del paquete", async () => {
    const program = buildProgram();
    let stdout = "";
    program.exitOverride();
    program.configureOutput({
      writeOut: (text) => {
        stdout += text;
      },
    });

    await expect(program.parseAsync(["node", "cloudproof", "--version"])).rejects.toThrow(); // exitOverride
    expect(stdout).toContain(CLI_VERSION);
  });
});
