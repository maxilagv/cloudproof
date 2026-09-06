import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  bundleVerifyExitCode,
  runBundleInspect,
  runBundleKeygen,
  runBundleSign,
  runBundleVerify,
} from "../src/commands/bundle.js";

const roots: string[] = [];

function workspace(): string {
  const root = mkdtempSync(join(tmpdir(), "cloudproof-bundle-"));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const V1_BUNDLE = {
  version: "1",
  subject: { baseSha: "a".repeat(40), headSha: "b".repeat(40) },
  conclusion: "UNSAFE",
  assertions: [
    {
      id: "postgres.old-app-new-schema.post-payments",
      result: "fail",
      state: "A0_S1",
      evidence: ["HTTP 500 (baseline 201)."],
    },
  ],
  coverage: { routesObserved: 1, routesDetected: 1 },
  provenance: { runner: "test-run", artifacts: [] },
  nextActions: [
    {
      kind: "fix-failure",
      assertionId: "postgres.old-app-new-schema.post-payments",
      instruction: "Fix the candidate migration.",
    },
  ],
};

function writeBundle(root: string): string {
  const path = join(root, "release-verify-test.json");
  writeFileSync(path, JSON.stringify(V1_BUNDLE, null, 2), "utf-8");
  return path;
}

const silent = { writeOutput: () => {} };

describe("cloudproof bundle — keygen/sign/verify (gate 3, informe 2026-07-18)", () => {
  it("roundtrip completo: keygen → sign → verify concluye TRUSTED con exit 0", () => {
    const root = workspace();
    const bundlePath = writeBundle(root);

    const keys = runBundleKeygen({ cwd: root, ...silent });
    expect(keys.created).toBe(true);
    expect(keys.keyId).toMatch(/^sha256:[a-f0-9]{64}$/);

    const signed = runBundleSign(bundlePath, { cwd: root, ...silent });
    expect(signed.keyId).toBe(keys.keyId);
    expect(signed.payloadDigest).toMatch(/^sha256:[a-f0-9]{64}$/);

    const report = runBundleVerify(bundlePath, { cwd: root, ...silent });
    expect(report).toMatchObject({
      payloadMatches: true,
      digestMatches: true,
      signatureVerified: true,
      verdict: "trusted",
      conclusion: "UNSAFE",
    });
    expect(bundleVerifyExitCode(report)).toBe(0);
  });

  it("modificar el bundle después de la firma lo vuelve INVALID", () => {
    const root = workspace();
    const bundlePath = writeBundle(root);
    runBundleKeygen({ cwd: root, ...silent });
    runBundleSign(bundlePath, { cwd: root, ...silent });

    const tampered = JSON.parse(readFileSync(bundlePath, "utf-8")) as typeof V1_BUNDLE;
    tampered.conclusion = "VERIFIED";
    tampered.assertions = [];
    tampered.nextActions = [];
    writeFileSync(bundlePath, JSON.stringify(tampered, null, 2), "utf-8");

    const report = runBundleVerify(bundlePath, { cwd: root, ...silent });
    expect(report.verdict).toBe("invalid");
    expect(report.payloadMatches).toBe(false);
    expect(bundleVerifyExitCode(report)).toBe(1);
    expect(report.problems.join("\n")).toContain("modificado después de la firma");
  });

  it("sin clave pública la integridad se demuestra pero la confianza no (exit 1)", () => {
    const root = workspace();
    const bundlePath = writeBundle(root);
    runBundleKeygen({ cwd: root, ...silent });
    runBundleSign(bundlePath, { cwd: root, ...silent });
    // Simula un consumidor sin la clave: borra el directorio de claves.
    rmSync(join(root, ".cloudproof", "keys"), { recursive: true, force: true });

    const report = runBundleVerify(bundlePath, { cwd: root, ...silent });
    expect(report.verdict).toBe("integrity-only");
    expect(report.signatureVerified).toBe(false);
    expect(bundleVerifyExitCode(report)).toBe(1);
    expect(report.problems.join("\n")).toContain("nunca confianza");
  });

  it("una clave pública ajena no verifica la firma", () => {
    const root = workspace();
    const other = workspace();
    const bundlePath = writeBundle(root);
    runBundleKeygen({ cwd: root, ...silent });
    runBundleSign(bundlePath, { cwd: root, ...silent });
    const foreign = runBundleKeygen({ cwd: other, ...silent });

    const report = runBundleVerify(bundlePath, {
      cwd: root,
      key: foreign.publicKeyPath,
      ...silent,
    });
    expect(report.verdict).toBe("integrity-only");
    expect(report.problems.join("\n")).toContain("Ninguna firma corresponde");
  });

  it("keygen no pisa una clave existente sin --force", () => {
    const root = workspace();
    const first = runBundleKeygen({ cwd: root, ...silent });
    const second = runBundleKeygen({ cwd: root, ...silent });
    expect(second.created).toBe(false);
    expect(second.keyId).toBe(first.keyId);

    const regenerated = runBundleKeygen({ cwd: root, force: true, ...silent });
    expect(regenerated.created).toBe(true);
    expect(regenerated.keyId).not.toBe(first.keyId);
  });

  it("inspect resume veredicto, matriz y presencia del attestation", () => {
    const root = workspace();
    const bundlePath = writeBundle(root);
    let output = "";
    runBundleInspect(bundlePath, { cwd: root, writeOutput: (text) => (output += text) });

    expect(output).toContain("Bundle v1");
    expect(output).toContain("UNSAFE");
    expect(output).toContain("Matriz de ejecución:");
    expect(output).toMatch(/A0_S1\s+FAIL/);
    expect(output).toContain("sin attestation");

    runBundleKeygen({ cwd: root, ...silent });
    runBundleSign(bundlePath, { cwd: root, ...silent });
    output = "";
    runBundleInspect(bundlePath, { cwd: root, writeOutput: (text) => (output += text) });
    expect(output).toContain("attestation presente");
  });
});
