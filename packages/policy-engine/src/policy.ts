import type { ProofBundle } from "@proof/schema";

export interface PolicyViolation {
  policyId: string;
  message: string;
  relatedAssertionIds: string[];
}

export interface Policy {
  id: string;
  description: string;
  /** Evaluación pura y determinista sobre un Proof Bundle ya generado. Ninguna policy hace I/O ni llama a un modelo. */
  evaluate(bundle: ProofBundle): PolicyViolation[];
}
