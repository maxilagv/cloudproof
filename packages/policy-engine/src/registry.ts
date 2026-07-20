import type { Policy, PolicyViolation } from "./policy.js";
import type { ProofBundle } from "@proof/schema";
import { noDestructiveMigrations } from "./policies/no-destructive-migrations.js";

// Solo se registran policies ejecutables. El módulo futuro de critical flows
// sigue exportado para desarrollo, pero un config no puede activarlo por error.
const BUILTIN_POLICIES: Policy[] = [noDestructiveMigrations];

export class UnknownPolicyError extends Error {
  constructor(policyId: string) {
    super(`Policy desconocida: "${policyId}". Policies registradas: ${BUILTIN_POLICIES.map((p) => p.id).join(", ")}`);
    this.name = "UnknownPolicyError";
  }
}

export function getPolicy(id: string): Policy {
  const policy = BUILTIN_POLICIES.find((p) => p.id === id);
  if (!policy) throw new UnknownPolicyError(id);
  return policy;
}

/** Evalúa una lista de policy ids (tal como aparecen en proof.config.ts) contra un Proof Bundle. */
export function evaluatePolicies(policyIds: string[], bundle: ProofBundle): PolicyViolation[] {
  return policyIds.flatMap((id) => getPolicy(id).evaluate(bundle));
}
