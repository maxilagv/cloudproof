const REDACTED = "[REDACTED]";

/** Defense-in-depth para evidencia operacional antes de salir del ejecutor. */
export function redactDiagnosticText(input: string): string {
  return input
    .replace(
      /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z ]+ )?PRIVATE KEY-----/g,
      REDACTED,
    )
    .replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, REDACTED)
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, REDACTED)
    .replace(
      /\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,}|AKIA[A-Z0-9]{16})\b/g,
      REDACTED,
    )
    .replace(
      /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?):\/\/[^\s:/?#]+:[^\s@/?#]+@/gi,
      REDACTED,
    )
    .replace(
      /\b(?:authorization|cookie|credential|password|passwd|private[_-]?key|secret|session|token|api[_-]?key|client[_-]?secret)\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi,
      REDACTED,
    )
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, REDACTED);
}

/**
 * Error con evidencia adjunta. Se redacta en la frontera para que stderr,
 * logs y SQLSTATE no filtren credenciales al CloudProof Bundle ni a la consola.
 */
export class ExecutorError extends Error {
  readonly evidence: string[];

  constructor(message: string, evidence: string[] = []) {
    const sanitizedEvidence = evidence.map(redactDiagnosticText);
    const sanitizedMessage = redactDiagnosticText(message);
    super(
      sanitizedEvidence.length > 0
        ? `${sanitizedMessage}\n${sanitizedEvidence.map((line) => `  ${line}`).join("\n")}`
        : sanitizedMessage,
    );
    this.name = "ExecutorError";
    this.evidence = sanitizedEvidence;
  }
}
