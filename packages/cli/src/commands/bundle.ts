import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign as cryptoSign,
  verify as cryptoVerify,
  type KeyObject,
} from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { z } from "zod";
import {
  createProofBundleSigningPayload,
  parseProofBundleJson,
  type ProofBundle,
} from "@proof/schema";
import { conclusionBadge, paint, symbols } from "../ui.js";
import { renderMatrixCells } from "./release-verify.js";

/**
 * Gate 3 del informe 2026-07-18: cerrar el círculo de confianza del Bundle.
 * El schema V2 ya definía hash canónico y attestations DSSE; lo que faltaba
 * era el pipeline que firma DE VERDAD y los comandos para verificar. Este
 * módulo firma el payload canónico (V1: bundle completo; V2: contrato
 * RFC 8785 sin integrity/attestations) con Ed25519 sobre el encoding
 * PAE de DSSE, en un archivo `<bundle>.attestation.json` separado.
 *
 * Honestidad del veredicto: `verify` sin clave pública puede demostrar
 * integridad estructural (el bundle no fue tocado desde la firma) pero
 * JAMÁS confianza — sale con código 1 y lo dice. La política de qué claves
 * son confiables es del consumidor, no de Proof.
 */

const KEYS_DIRECTORY = join(".proof", "keys");
const PRIVATE_KEY_FILE = "proof-signing.key";
const PUBLIC_KEY_FILE = "proof-signing.pub";
const SIGNING_ALGORITHM = "ed25519";

const AttestationFileSchema = z
  .object({
    version: z.literal("1"),
    kind: z.literal("dsse"),
    payloadType: z.enum([
      "application/vnd.proof.bundle.v1+json",
      "application/vnd.proof.bundle.v2+json",
    ]),
    payload: z.string().min(4),
    payloadDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    signatures: z
      .array(
        z
          .object({
            keyid: z.string().regex(/^sha256:[a-f0-9]{64}$/),
            algorithm: z.literal(SIGNING_ALGORITHM),
            sig: z.string().min(16),
          })
          .strict(),
      )
      .min(1)
      .max(20),
    signedAt: z.string().datetime({ offset: true }),
  })
  .strict();

export type BundleAttestation = z.infer<typeof AttestationFileSchema>;

/** DSSE v1 Pre-Authentication Encoding: lo que realmente se firma. */
function preAuthenticationEncoding(payloadType: string, payload: Buffer): Buffer {
  return Buffer.concat([
    Buffer.from(`DSSEv1 ${Buffer.byteLength(payloadType)} ${payloadType} ${payload.length} `),
    payload,
  ]);
}

/** Identidad estable de una clave: sha256 del SPKI DER de la pública. */
function keyIdOf(publicKey: KeyObject): string {
  const der = publicKey.export({ type: "spki", format: "der" });
  return `sha256:${createHash("sha256").update(der).digest("hex")}`;
}

function sha256Digest(payload: Buffer): string {
  return `sha256:${createHash("sha256").update(payload).digest("hex")}`;
}

function defaultWrite(text: string): void {
  process.stdout.write(text);
}

// ---------------------------------------------------------------- keygen

export interface BundleKeygenOptions {
  cwd?: string;
  json?: boolean;
  force?: boolean;
  writeOutput?: (text: string) => void;
}

export interface BundleKeygenResult {
  privateKeyPath: string;
  publicKeyPath: string;
  keyId: string;
  created: boolean;
}

export function runBundleKeygen(options: BundleKeygenOptions = {}): BundleKeygenResult {
  const cwd = resolve(options.cwd ?? process.cwd());
  const directory = join(cwd, KEYS_DIRECTORY);
  const privateKeyPath = join(directory, PRIVATE_KEY_FILE);
  const publicKeyPath = join(directory, PUBLIC_KEY_FILE);
  const writeOutput = options.writeOutput ?? defaultWrite;

  if (existsSync(privateKeyPath) && options.force !== true) {
    const keyId = keyIdOf(createPublicKey(readFileSync(publicKeyPath, "utf-8")));
    const result: BundleKeygenResult = { privateKeyPath, publicKeyPath, keyId, created: false };
    writeOutput(
      options.json
        ? JSON.stringify({ version: "1", ...result }, null, 2) + "\n"
        : `${symbols.warn} ${paint.yellow("Ya existe una clave de firma;")} usá --force para regenerarla.\n` +
            `  ${symbols.dot} ${privateKeyPath}\n  ${symbols.dot} keyid ${keyId}\n`,
    );
    return result;
  }

  const { privateKey, publicKey } = generateKeyPairSync(SIGNING_ALGORITHM);
  mkdirSync(directory, { recursive: true });
  writeFileSync(privateKeyPath, privateKey.export({ type: "pkcs8", format: "pem" }), {
    encoding: "utf-8",
    mode: 0o600,
  });
  writeFileSync(publicKeyPath, publicKey.export({ type: "spki", format: "pem" }), "utf-8");
  const keyId = keyIdOf(publicKey);
  const result: BundleKeygenResult = { privateKeyPath, publicKeyPath, keyId, created: true };
  writeOutput(
    options.json
      ? JSON.stringify({ version: "1", ...result }, null, 2) + "\n"
      : [
          `${symbols.ok} ${paint.green("Par de claves Ed25519 generado.")}`,
          `  ${symbols.dot} privada  ${privateKeyPath} ${paint.dim("(0600; no la subas al repo)")}`,
          `  ${symbols.dot} pública  ${publicKeyPath}`,
          `  ${symbols.dot} keyid    ${keyId}`,
          "",
        ].join("\n"),
  );
  return result;
}

// ------------------------------------------------------------------ sign

export interface BundleSignOptions {
  cwd?: string;
  json?: boolean;
  /** Ruta a la clave privada PEM; default .proof/keys/proof-signing.key. */
  key?: string;
  writeOutput?: (text: string) => void;
}

export interface BundleSignResult {
  bundlePath: string;
  attestationPath: string;
  keyId: string;
  payloadDigest: string;
}

export function runBundleSign(
  bundlePath: string,
  options: BundleSignOptions = {},
): BundleSignResult {
  const cwd = resolve(options.cwd ?? process.cwd());
  const absoluteBundlePath = resolve(cwd, bundlePath);
  const privateKeyPath = resolve(cwd, options.key ?? join(KEYS_DIRECTORY, PRIVATE_KEY_FILE));
  if (!existsSync(privateKeyPath)) {
    throw new Error(
      `No existe la clave privada ${privateKeyPath}. Generala con \`proof bundle keygen\` o pasá --key <ruta>.`,
    );
  }
  const privateKey = createPrivateKey(readFileSync(privateKeyPath, "utf-8"));
  if (privateKey.asymmetricKeyType !== SIGNING_ALGORITHM) {
    throw new Error(`La clave de firma debe ser ${SIGNING_ALGORITHM}; es ${privateKey.asymmetricKeyType}.`);
  }
  const publicKey = createPublicKey(privateKey);

  const bundle = parseProofBundleJson(readFileSync(absoluteBundlePath, "utf-8"));
  const { payloadType, payload } = createProofBundleSigningPayload(bundle);
  const payloadBytes = Buffer.from(payload, "utf-8");
  const pae = preAuthenticationEncoding(payloadType, payloadBytes);
  const signature = cryptoSign(null, pae, privateKey);
  // Autochequeo inmediato: una firma que no verifica no se escribe.
  if (!cryptoVerify(null, pae, publicKey, signature)) {
    throw new Error("La firma generada no verificó contra su propia clave pública.");
  }

  const keyId = keyIdOf(publicKey);
  const attestation: BundleAttestation = {
    version: "1",
    kind: "dsse",
    payloadType,
    payload: payloadBytes.toString("base64"),
    payloadDigest: sha256Digest(payloadBytes) as BundleAttestation["payloadDigest"],
    signatures: [{ keyid: keyId, algorithm: SIGNING_ALGORITHM, sig: signature.toString("base64") }],
    signedAt: new Date().toISOString(),
  };
  const attestationPath = `${absoluteBundlePath}.attestation.json`;
  writeFileSync(attestationPath, JSON.stringify(attestation, null, 2) + "\n", "utf-8");

  const result: BundleSignResult = {
    bundlePath: absoluteBundlePath,
    attestationPath,
    keyId,
    payloadDigest: attestation.payloadDigest,
  };
  const writeOutput = options.writeOutput ?? defaultWrite;
  writeOutput(
    options.json
      ? JSON.stringify({ version: "1", ...result }, null, 2) + "\n"
      : [
          `${symbols.ok} ${paint.green(`Bundle v${bundle.version} firmado (${SIGNING_ALGORITHM}, DSSE PAE).`)}`,
          `  ${symbols.dot} attestation ${attestationPath}`,
          `  ${symbols.dot} digest      ${result.payloadDigest}`,
          `  ${symbols.dot} keyid       ${keyId}`,
          "",
        ].join("\n"),
  );
  return result;
}

// ---------------------------------------------------------------- verify

export interface BundleVerifyOptions {
  cwd?: string;
  json?: boolean;
  /** Ruta a la clave pública PEM; default .proof/keys/proof-signing.pub si existe. */
  key?: string;
  /** Ruta al attestation; default <bundle>.attestation.json. */
  attestation?: string;
  writeOutput?: (text: string) => void;
}

export interface BundleVerifyReport {
  bundlePath: string;
  attestationPath: string;
  bundleVersion?: string;
  conclusion?: string;
  payloadMatches: boolean;
  digestMatches: boolean;
  signatureVerified: boolean;
  /** trusted: integridad + firma con la clave provista. integrity-only: sin clave. */
  verdict: "trusted" | "integrity-only" | "invalid";
  problems: string[];
}

export function bundleVerifyExitCode(report: BundleVerifyReport): 0 | 1 {
  return report.verdict === "trusted" ? 0 : 1;
}

export function runBundleVerify(
  bundlePath: string,
  options: BundleVerifyOptions = {},
): BundleVerifyReport {
  const cwd = resolve(options.cwd ?? process.cwd());
  const absoluteBundlePath = resolve(cwd, bundlePath);
  const attestationPath = resolve(
    cwd,
    options.attestation ?? `${absoluteBundlePath}.attestation.json`,
  );
  const problems: string[] = [];
  let payloadMatches = false;
  let digestMatches = false;
  let signatureVerified = false;
  let bundle: ProofBundle | undefined;
  let attestation: BundleAttestation | undefined;

  try {
    bundle = parseProofBundleJson(readFileSync(absoluteBundlePath, "utf-8"));
  } catch (error) {
    problems.push(
      `El bundle no valida contra el schema: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`,
    );
  }
  try {
    attestation = AttestationFileSchema.parse(
      JSON.parse(readFileSync(attestationPath, "utf-8")) as unknown,
    );
  } catch (error) {
    problems.push(
      existsSync(attestationPath)
        ? `El attestation no es válido: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`
        : `No existe ${attestationPath}; firmá el bundle con \`proof bundle sign\`.`,
    );
  }

  if (bundle !== undefined && attestation !== undefined) {
    const { payloadType, payload } = createProofBundleSigningPayload(bundle);
    const payloadBytes = Buffer.from(payload, "utf-8");
    const attested = Buffer.from(attestation.payload, "base64");
    payloadMatches =
      attestation.payloadType === payloadType && attested.equals(payloadBytes);
    if (!payloadMatches) {
      problems.push(
        "El payload firmado NO coincide byte a byte con el bundle actual: el bundle fue modificado después de la firma (o el attestation corresponde a otro bundle).",
      );
    }
    digestMatches = attestation.payloadDigest === sha256Digest(attested);
    if (!digestMatches) {
      problems.push("El digest declarado no corresponde al payload del attestation.");
    }

    const publicKeyPath =
      options.key !== undefined
        ? resolve(cwd, options.key)
        : join(cwd, KEYS_DIRECTORY, PUBLIC_KEY_FILE);
    if (!existsSync(publicKeyPath)) {
      problems.push(
        options.key !== undefined
          ? `No existe la clave pública ${publicKeyPath}.`
          : "Sin clave pública (--key) solo puede demostrarse integridad, nunca confianza.",
      );
    } else if (payloadMatches && digestMatches) {
      try {
        const publicKey = createPublicKey(readFileSync(publicKeyPath, "utf-8"));
        const expectedKeyId = keyIdOf(publicKey);
        const pae = preAuthenticationEncoding(attestation.payloadType, attested);
        const matching = attestation.signatures.filter(
          (signature) => signature.keyid === expectedKeyId,
        );
        if (matching.length === 0) {
          problems.push(
            `Ninguna firma corresponde a la clave provista (keyid esperado ${expectedKeyId}).`,
          );
        } else {
          signatureVerified = matching.some((signature) =>
            cryptoVerify(null, pae, publicKey, Buffer.from(signature.sig, "base64")),
          );
          if (!signatureVerified) {
            problems.push("La firma Ed25519 no verificó contra la clave pública provista.");
          }
        }
      } catch (error) {
        problems.push(
          `No se pudo usar la clave pública: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }

  const verdict: BundleVerifyReport["verdict"] = signatureVerified
    ? "trusted"
    : payloadMatches && digestMatches
      ? "integrity-only"
      : "invalid";
  const report: BundleVerifyReport = {
    bundlePath: absoluteBundlePath,
    attestationPath,
    ...(bundle === undefined ? {} : { bundleVersion: bundle.version, conclusion: bundle.conclusion }),
    payloadMatches,
    digestMatches,
    signatureVerified,
    verdict,
    problems,
  };

  const writeOutput = options.writeOutput ?? defaultWrite;
  writeOutput(
    options.json
      ? JSON.stringify({ version: "1", ...report }, null, 2) + "\n"
      : renderVerifyReport(report),
  );
  return report;
}

function checkLine(ok: boolean, label: string): string {
  return `  ${ok ? symbols.ok : symbols.fail} ${label}`;
}

function renderVerifyReport(report: BundleVerifyReport): string {
  const lines: string[] = [];
  if (report.conclusion !== undefined) {
    lines.push(
      `Bundle v${report.bundleVersion}: ${conclusionBadge(report.conclusion)} ${paint.dim(report.bundlePath)}`,
    );
  }
  lines.push(
    checkLine(report.payloadMatches, "payload canónico coincide byte a byte con el bundle"),
    checkLine(report.digestMatches, "digest sha256 del payload"),
    checkLine(report.signatureVerified, "firma Ed25519 verificada con la clave provista"),
  );
  for (const problem of report.problems) {
    lines.push(`  ${symbols.warn} ${paint.yellow(problem)}`);
  }
  lines.push(
    report.verdict === "trusted"
      ? `${symbols.ok} ${paint.green("TRUSTED: integridad y firma verificadas.")} ${paint.dim("La política de qué claves aceptar sigue siendo del consumidor.")}`
      : report.verdict === "integrity-only"
        ? `${symbols.warn} ${paint.yellow("INTEGRITY-ONLY: el bundle no fue modificado desde la firma, pero la firma no se verificó con una clave confiable.")}`
        : `${symbols.fail} ${paint.red("INVALID: la evidencia no es confiable.")}`,
    "",
  );
  return lines.join("\n");
}

// --------------------------------------------------------------- inspect

export interface BundleInspectOptions {
  cwd?: string;
  json?: boolean;
  writeOutput?: (text: string) => void;
}

export function runBundleInspect(
  bundlePath: string,
  options: BundleInspectOptions = {},
): ProofBundle {
  const cwd = resolve(options.cwd ?? process.cwd());
  const absoluteBundlePath = resolve(cwd, bundlePath);
  const bundle = parseProofBundleJson(readFileSync(absoluteBundlePath, "utf-8"));
  const attestationPath = `${absoluteBundlePath}.attestation.json`;
  const hasAttestation = existsSync(attestationPath);
  const writeOutput = options.writeOutput ?? defaultWrite;

  if (options.json) {
    writeOutput(
      JSON.stringify(
        {
          version: "1",
          bundlePath: absoluteBundlePath,
          bundleVersion: bundle.version,
          conclusion: bundle.conclusion,
          subject: bundle.subject,
          coverage: bundle.coverage,
          assertions: bundle.assertions.length,
          nextActions: bundle.nextActions.length,
          attestationPresent: hasAttestation,
        },
        null,
        2,
      ) + "\n",
    );
    return bundle;
  }

  const lines: string[] = [
    `Bundle v${bundle.version}: ${conclusionBadge(bundle.conclusion)}`,
    `  ${symbols.dot} base ${bundle.subject.baseSha.slice(0, 12)} ${symbols.arrow} head ${bundle.subject.headSha.slice(0, 12)}`,
  ];
  if (bundle.subject.service !== undefined) {
    lines.push(`  ${symbols.dot} servicio ${bundle.subject.service.name} (${bundle.subject.service.path})`);
  }
  lines.push(
    `  ${symbols.dot} coverage ${bundle.coverage.routesObserved} observada(s) / ${bundle.coverage.routesRequired ?? 0} requerida(s) (${bundle.coverage.source ?? "legacy"})`,
    `  ${symbols.dot} ${bundle.assertions.length} assertion(s), ${bundle.nextActions.length} nextAction(s)`,
  );
  const attempts =
    "executorAttempts" in bundle.provenance ? (bundle.provenance.executorAttempts?.length ?? 0) : 0;
  if (attempts > 0) {
    lines.push(`  ${symbols.dot} ${attempts} sonda(s)/reintento(s) del ejecutor registrados`);
  }
  lines.push(
    hasAttestation
      ? `  ${symbols.dot} attestation presente ${paint.dim(`(verificala con proof bundle verify)`)}`
      : `  ${symbols.dot} ${paint.dim("sin attestation — firmá con proof bundle sign")}`,
  );
  const matrixCells = renderMatrixCells(
    bundle.assertions,
    bundle.provenance.artifacts.find((artifact) => artifact.startsWith("matrix=")),
  );
  if (matrixCells.length > 0) {
    lines.push("", paint.bold("Matriz de ejecución:"), ...matrixCells);
  }
  lines.push("");
  writeOutput(lines.join("\n"));
  return bundle;
}
