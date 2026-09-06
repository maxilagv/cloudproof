import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { URL } from "node:url";
import { z } from "zod";
import { ConclusionSchema } from "./conclusion.js";
import { NextActionSchema } from "./next-action.js";
import { RemediationSchema } from "./remediation.js";

/**
 * CloudProof Bundle is a versioned wire contract. V1 remains readable as-is; V2 is
 * deliberately strict and carries the information needed to decide whether
 * evidence is attributable, sanitized, current and structurally attested.
 *
 * IMPORTANT: parsing an attestation proves only that its envelope is well
 * formed. Authenticity requires a trust policy and cryptographic verification
 * performed by a consumer (see `CLOUDPROOF_BUNDLE_V2_ATTESTATION_PAYLOAD_CONTRACT`).
 */

const SHORT_TEXT_MAX = 2_048;
const LONG_TEXT_MAX = 16_384;
const MAX_ASSERTIONS = 1_000;
const MAX_EVIDENCE_REFS = 2_000;
export const MAX_CLOUDPROOF_BUNDLE_JSON_BYTES = 8 * 1024 * 1024;
export const MAX_CLOUDPROOF_BUNDLE_VALIDITY_MS = 24 * 60 * 60 * 1_000;

const NonEmptyTextSchema = z.string().trim().min(1).max(SHORT_TEXT_MAX);
const LongTextSchema = z.string().trim().min(1).max(LONG_TEXT_MAX);
const IdentifierSchema = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/, "Invalid stable identifier");
const TimestampSchema = z.string().datetime({ offset: true });
const CommitDigestSchema = z
  .string()
  .regex(/^(?:[a-fA-F0-9]{40}|[a-fA-F0-9]{64})$/, "Expected a full Git commit digest");

/** Algorithm-qualified, lower-case content digest. */
export const ContentDigestSchema = z
  .string()
  .regex(
    /^(?:sha256:[a-f0-9]{64}|sha512:[a-f0-9]{128})$/,
    "Expected sha256:<64 lowercase hex> or sha512:<128 lowercase hex>",
  );

export const AssertionResultSchema = z.enum(["pass", "fail", "skipped"]);

export const ExecutionStateSchema = z.enum([
  "BUILD_A0",
  "BUILD_A1",
  "A0_S0",
  "A1_S0",
  "MIGRATE_S0_TO_S1",
  "A0_S1",
  "COEXIST_A0_A1_S1",
  "A1_S1",
  "ROLLBACK_A0_AFTER_A1_WRITES",
  "SQL_EFFECTS",
]);

export const COMPLETE_RELEASE_MATRIX_STATES = ExecutionStateSchema.options;

// ---------------------------------------------------------------------------
// V1: compatibility contract
// ---------------------------------------------------------------------------

export const ApprovalSchema = z.object({
  reason: z.string().min(1),
  expiresAt: z.string().datetime().optional(),
});

const RecordedRequestSchema = z.object({
  method: z.string().min(1),
  path: z.string().min(1),
  headers: z.record(z.string(), z.string()),
  body: z.unknown().optional(),
});

const RecordedResponseSchema = z.object({
  status: z.number().int(),
  body: z.unknown().optional(),
  sqlErrors: z.array(z.string()).optional(),
});

export const ReproductionContextSchema = z.object({
  kind: z.enum(["live-state", "rerun-cloudproof"]),
  state: ExecutionStateSchema,
  exchange: z
    .object({
      request: RecordedRequestSchema,
      baselineResponse: RecordedResponseSchema,
    })
    .optional(),
});

export const AssertionV1Schema = z.object({
  id: z.string().min(1),
  result: AssertionResultSchema,
  /** Default implícito true para conservar Bundles v1 previos. */
  mandatory: z.boolean().optional(),
  evidence: z.array(z.string()).max(20, {
    message: "Evidence debe ser un resumen corto, no un volcado de logs.",
  }),
  reproduction: z.string().optional(),
  state: ExecutionStateSchema.optional(),
  approval: ApprovalSchema.optional(),
  reproductionContext: ReproductionContextSchema.optional(),
  remediation: RemediationSchema.optional(),
});

/** Historical export retained for current producers. */
export const AssertionSchema = AssertionV1Schema;

export const CoverageSchema = z.object({
  routesObserved: z.number().int().nonnegative(),
  routesDetected: z.number().int().nonnegative(),
  routesRequired: z.number().int().nonnegative().optional(),
  source: z.enum(["declared", "unknown", "legacy"]).optional(),
  complete: z.boolean().optional(),
  /** Coverage of HTTP route entrypoints derived from the release diff. */
  changedRoutesDetected: z.number().int().nonnegative().optional(),
  changedRoutesObserved: z.number().int().nonnegative().optional(),
  changedRoutesMissing: z.array(z.string().min(1).max(2_048)).max(2_000).optional(),
  changeSource: z.enum(["diff-inferred", "not-applicable", "unknown"]).optional(),
});

export const CoverageV2Schema = z
  .object({
    routesObserved: z.number().int().nonnegative(),
    routesDetected: z.number().int().nonnegative(),
    routesRequired: z.number().int().nonnegative(),
    source: z.enum(["declared", "unknown", "legacy"]),
    complete: z.boolean(),
    changedRoutesDetected: z.number().int().nonnegative().optional(),
    changedRoutesObserved: z.number().int().nonnegative().optional(),
    changedRoutesMissing: z.array(z.string().min(1).max(2_048)).max(2_000).optional(),
    changeSource: z.enum(["diff-inferred", "not-applicable", "unknown"]).optional(),
  })
  .strict()
  .superRefine((coverage, context) => {
    if (coverage.complete && coverage.routesRequired === 0) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["routesRequired"],
        message: "Complete v2 coverage requires at least one required route",
      });
    }
    if (coverage.complete && coverage.routesObserved < coverage.routesRequired) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["routesObserved"],
        message: "Complete coverage must observe every required route",
      });
    }
    if (coverage.source === "unknown" && coverage.complete) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["source"],
        message: "Unknown coverage cannot be complete",
      });
    }
    if ((coverage.changedRoutesMissing?.length ?? 0) > 0 && coverage.complete) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["changedRoutesMissing"],
        message: "Coverage cannot be complete while a changed HTTP route is unobserved",
      });
    }
  });

/**
 * Sonda o reintento registrado por el ejecutor durante la corrida. Los
 * reintentos de errores transitorios de Postgres dejan rastro en la
 * evidencia en vez de desaparecer (P0 del informe 2026-07-18); un error
 * SQL real nunca genera reintentos, así que su ausencia también informa.
 */
export const ExecutorAttemptSchema = z.object({
  phase: z.enum(["postgres-readiness", "sql-read-retry"]),
  target: z.string().min(1),
  attempt: z.number().int().positive(),
  outcome: z.string().min(1),
  detail: z.string().max(500),
});

export const ProvenanceV1Schema = z.object({
  runner: z.string(),
  artifacts: z.array(z.string()),
  createdAt: z.string().datetime().optional(),
  environment: z
    .object({
      node: z.string(),
      platform: z.string(),
      arch: z.string(),
    })
    .optional(),
  /** Ausente cuando la corrida no registró sondas ni reintentos. */
  executorAttempts: z.array(ExecutorAttemptSchema).max(500).optional(),
  candidate: z
    .object({
      source: z.enum(["commit", "clean-worktree", "synthetic-worktree-commit"]),
      parentSha: z.string().min(1).optional(),
      /** Synthetic worktree receipts are iteration evidence, not merge/deploy authorization. */
      developmentOnly: z.boolean(),
    })
    .optional(),
});

/** Historical export retained for current producers. */
export const ProvenanceSchema = ProvenanceV1Schema;

export const CloudProofBundleV1Schema = z.object({
  version: z.literal("1"),
  subject: z.object({
    baseSha: z.string(),
    headSha: z.string(),
    service: z
      .object({
        name: z.string().min(1),
        path: z.string().min(1),
      })
      .optional(),
  }),
  conclusion: ConclusionSchema,
  assertions: z.array(AssertionV1Schema),
  coverage: CoverageSchema,
  provenance: ProvenanceV1Schema,
  nextActions: z.array(NextActionSchema).max(50).default([]),
});

// ---------------------------------------------------------------------------
// V2: attributable, privacy-safe and attestable evidence
// ---------------------------------------------------------------------------

export const DataClassificationSchema = z.enum([
  "public",
  "internal",
  "confidential",
  "restricted",
]);

export const RedactionDispositionSchema = z.enum([
  "not-required",
  "redacted",
  "blocked",
]);

export const EvidenceReferenceV2Schema = z
  .object({
    id: IdentifierSchema,
    kind: z.enum([
      "build-log",
      "runtime-log",
      "http-transcript",
      "sql-effects",
      "database-snapshot",
      "migration",
      "config",
      "source",
      "report",
      "other",
    ]),
    digest: ContentDigestSchema,
    /** Locator only; evidence bytes never belong inline in the Bundle. */
    uri: z
      .string()
      .min(3)
      .max(2_048)
      .regex(
        /^(?:https|s3|gs|az|oci|cloudproof|urn):/,
        "Evidence URI must use an approved non-executable scheme",
      ),
    mediaType: z.string().min(1).max(256),
    sizeBytes: z.number().int().nonnegative().max(2 ** 53 - 1),
    createdAt: TimestampSchema,
    classification: DataClassificationSchema,
    redaction: z
      .object({
        disposition: RedactionDispositionSchema,
        policyId: IdentifierSchema,
        /** Digest of source bytes before redaction, never the source bytes. */
        sourceDigest: ContentDigestSchema.optional(),
        reason: NonEmptyTextSchema.optional(),
      })
      .strict(),
  })
  .strict()
  .superRefine((value, context) => {
    try {
      const locator = new URL(value.uri);
      if (locator.username !== "" || locator.password !== "" || locator.search !== "" || locator.hash !== "") {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["uri"],
          message: "Evidence locators cannot contain credentials, query strings or fragments",
        });
      }
    } catch {
      // URNs and provider locators are validated syntactically by the scheme
      // allowlist above; they need not implement hierarchical URL semantics.
    }
    if (
      value.redaction.disposition !== "not-required" &&
      value.redaction.sourceDigest === undefined
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["redaction", "sourceDigest"],
        message: "Redacted or blocked evidence must retain the digest of its source",
      });
    }
    if (value.redaction.disposition === "blocked" && value.sizeBytes !== 0) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["sizeBytes"],
        message: "Blocked evidence is metadata-only and must have sizeBytes=0",
      });
    }
  });

export const PrivacyV2Schema = z
  .object({
    classification: DataClassificationSchema,
    policy: z
      .object({
        id: IdentifierSchema,
        version: z.string().min(1).max(128),
        digest: ContentDigestSchema,
        mode: z.enum(["allowlist", "denylist"]),
      })
      .strict(),
    redaction: z
      .object({
        status: z.enum(["applied", "not-required", "failed"]),
        appliedAt: TimestampSchema,
        artifactsInspected: z.number().int().nonnegative().max(MAX_EVIDENCE_REFS),
        artifactsRedacted: z.number().int().nonnegative().max(MAX_EVIDENCE_REFS),
        headersRemoved: z.number().int().nonnegative().max(1_000_000),
        queryValuesMasked: z.number().int().nonnegative().max(1_000_000),
        bodyFieldsMasked: z.number().int().nonnegative().max(1_000_000),
        logTokensMasked: z.number().int().nonnegative().max(10_000_000),
        failureReason: NonEmptyTextSchema.optional(),
      })
      .strict(),
    retention: z
      .object({
        policyId: IdentifierSchema,
        deleteAfter: TimestampSchema,
      })
      .strict(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.redaction.status === "failed" && value.redaction.failureReason === undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["redaction", "failureReason"],
        message: "A failed redaction pass requires a bounded failure reason",
      });
    }
    if (value.redaction.status !== "failed" && value.redaction.failureReason !== undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["redaction", "failureReason"],
        message: "failureReason is only valid when redaction status is failed",
      });
    }
  if (value.redaction.artifactsRedacted > value.redaction.artifactsInspected) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["redaction", "artifactsRedacted"],
      message: "Redacted artifact count cannot exceed inspected artifact count",
    });
  }
  if (value.redaction.status === "not-required" && value.redaction.artifactsRedacted !== 0) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["redaction", "artifactsRedacted"],
      message: "A not-required redaction pass cannot report redacted artifacts",
    });
  }
  });

export const RunnerIdentityV2Schema = z
  .object({
    type: z.enum(["oidc-workload", "service", "user", "local-process"]),
    issuer: z.string().min(1).max(2_048),
    subject: z.string().min(1).max(2_048),
    audiences: z.array(z.string().min(1).max(512)).max(20).default([]),
    claimsDigest: ContentDigestSchema.optional(),
  })
  .strict();

const ArtifactDigestV2Schema = z
  .object({
    name: z.string().min(1).max(256),
    version: z.string().min(1).max(128).optional(),
    digest: ContentDigestSchema,
  })
  .strict();

export const ProvenanceV2Schema = z
  .object({
    /** Stable run id retained as a string for compatibility with v1 consumers. */
    runner: IdentifierSchema,
    /** Digest summaries retained for compatibility; `evidence` is authoritative. */
    artifacts: z.array(ContentDigestSchema).max(MAX_EVIDENCE_REFS),
    createdAt: TimestampSchema,
    runnerIdentity: RunnerIdentityV2Schema,
    repository: z
      .object({
        uri: z.string().min(1).max(2_048),
        baseCommit: CommitDigestSchema,
        headCommit: CommitDigestSchema,
        dirty: z.boolean(),
      })
      .strict(),
    tool: ArtifactDigestV2Schema,
    config: z
      .object({
        source: z.enum(["trusted-base", "verified-json", "generated", "none"]),
        digest: ContentDigestSchema,
      })
      .strict(),
    images: z
      .array(
        z
          .object({
            role: z.enum(["base-app", "candidate-app", "database", "helper"]),
            reference: z.string().min(1).max(2_048),
            digest: ContentDigestSchema,
          })
          .strict(),
      )
      .min(1)
      .max(100),
    plugins: z.array(ArtifactDigestV2Schema).max(100).default([]),
    execution: z
      .object({
        profile: z.enum(["trusted", "internal", "fork"]),
        startedAt: TimestampSchema,
        finishedAt: TimestampSchema,
        isolation: z.enum(["host", "container", "microvm", "remote-sandbox"]),
        network: z.enum(["none", "internal-only", "egress-allowlist", "unrestricted"]),
      })
      .strict(),
    environment: z
      .object({
        os: z.string().min(1).max(128),
        arch: z.string().min(1).max(128),
        runtime: z.string().min(1).max(256),
      })
      .strict(),
  })
  .strict();

export const ApprovalV2Schema = z
  .object({
    id: IdentifierSchema,
    decision: z.enum(["approve", "waive"]),
    reason: NonEmptyTextSchema,
    actor: RunnerIdentityV2Schema,
    scope: z
      .object({
        assertionIds: z.array(IdentifierSchema).min(1).max(100),
        states: z.array(ExecutionStateSchema).max(COMPLETE_RELEASE_MATRIX_STATES.length).default([]),
      })
      .strict(),
    issuedAt: TimestampSchema,
    expiresAt: TimestampSchema,
    ticketUri: z.string().min(1).max(2_048).optional(),
    /** Approval must be covered by one of this Bundle's attestations. */
    attestationId: IdentifierSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (Date.parse(value.expiresAt) <= Date.parse(value.issuedAt)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["expiresAt"],
        message: "Approval expiration must be later than issuance",
      });
    }
    if (new Set(value.scope.assertionIds).size !== value.scope.assertionIds.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["scope", "assertionIds"],
        message: "Approval assertion scope contains duplicates",
      });
    }
  });

const ApprovalLinkV2Schema = z
  .object({
    id: IdentifierSchema,
    /** Human-readable duplicate checked against the top-level approval. */
    reason: NonEmptyTextSchema,
  })
  .strict();

/**
 * V2 never embeds raw HTTP bodies or headers. Reproduction material is an
 * evidence reference that has already passed the Bundle redaction policy.
 * `exchange?: never` keeps the shape safely consumable by legacy readers.
 */
export const ReproductionContextV2Schema = z
  .object({
    kind: z.enum(["live-state", "rerun-cloudproof"]),
    state: ExecutionStateSchema,
    evidenceRef: IdentifierSchema,
    exchange: z.never().optional(),
  })
  .strict();

export const AssertionV2Schema = z
  .object({
    id: IdentifierSchema,
    result: AssertionResultSchema,
    mandatory: z.boolean().default(true),
    state: ExecutionStateSchema,
    summary: NonEmptyTextSchema,
    evidence: z.array(NonEmptyTextSchema).max(20),
    evidenceRefs: z.array(IdentifierSchema).min(1).max(50),
    reproduction: LongTextSchema.optional(),
    reproductionContext: ReproductionContextV2Schema.optional(),
    remediation: RemediationSchema.optional(),
    /** Compatibility view; canonical approval data lives at bundle.approvals. */
    approval: ApprovalLinkV2Schema.optional(),
  })
  .strict()
  .superRefine((assertion, context) => {
    if (assertion.result === "pass" && assertion.approval !== undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["approval"],
        message: "Passing assertions cannot carry a waiver/approval link",
      });
    }
  });

export const ReleaseMatrixEntryV2Schema = z
  .object({
    state: ExecutionStateSchema,
    required: z.boolean(),
    result: AssertionResultSchema,
    assertionIds: z.array(IdentifierSchema).max(MAX_ASSERTIONS),
    evidenceRefs: z.array(IdentifierSchema).max(100),
    startedAt: TimestampSchema.optional(),
    finishedAt: TimestampSchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.startedAt !== undefined &&
      value.finishedAt !== undefined &&
      Date.parse(value.finishedAt) < Date.parse(value.startedAt)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["finishedAt"],
        message: "Matrix state cannot finish before it starts",
      });
    }
    if (value.required && value.assertionIds.length === 0) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["assertionIds"],
        message: "A required matrix state must be backed by at least one assertion",
      });
    }
  });

export const ReleaseMatrixV2Schema = z
  .object({
    completeness: z.enum(["complete", "partial"]),
    entries: z
      .array(ReleaseMatrixEntryV2Schema)
      .min(1)
      .max(COMPLETE_RELEASE_MATRIX_STATES.length),
  })
  .strict()
  .superRefine((value, context) => {
    const states = value.entries.map((entry) => entry.state);
    if (new Set(states).size !== states.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["entries"],
        message: "Release matrix states must be unique",
      });
    }
    if (
      value.completeness === "complete" &&
      COMPLETE_RELEASE_MATRIX_STATES.some((state) => !states.includes(state))
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["entries"],
        message: "A complete matrix must contain every CloudProof v2 execution state",
      });
    }
    if (value.completeness === "complete" && value.entries.some((entry) => !entry.required)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["entries"],
        message: "Every state in a complete matrix must be required",
      });
    }
  });

const SignatureV2Schema = z
  .object({
    keyId: z.string().min(1).max(1_024),
    algorithm: z
      .string()
      .min(2)
      .max(64)
      .regex(/^[a-z0-9][a-z0-9._+-]*$/, "Use a stable lower-case algorithm identifier"),
    signature: z
      .string()
      .min(16)
      .max(16_384)
      .regex(/^[A-Za-z0-9+/_=-]+$/, "Expected a base64/base64url signature"),
    certificateChain: z.array(LongTextSchema).max(10).optional(),
  })
  .strict();

/** Exact DSSE signature field names for wire interoperability. */
const DsseSignatureV2Schema = z
  .object({
    keyid: z.string().min(1).max(1_024),
    sig: z
      .string()
      .min(16)
      .max(16_384)
      .regex(/^[A-Za-z0-9+/_=-]+$/, "Expected a base64/base64url signature"),
  })
  .strict();

const AttestationBaseShape = {
  id: IdentifierSchema,
  predicateType: z.literal("https://cloudproof.dev/attestations/release/v2"),
  payloadDigest: ContentDigestSchema,
  issuedAt: TimestampSchema,
};

export const DsseAttestationV2Schema = z
  .object({
    ...AttestationBaseShape,
    kind: z.literal("dsse"),
    /** The nested object is an exact DSSE envelope. */
    envelope: z
      .object({
        payloadType: z.literal("application/vnd.cloudproof.bundle.v2+json"),
        payload: z
          .string()
          .min(4)
          .max(2_800_000)
          .regex(
            /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/,
            "DSSE payload must be canonical padded base64",
          ),
        signatures: z.array(DsseSignatureV2Schema).min(1).max(20),
      })
      .strict(),
  })
  .strict();

export const DetachedAttestationV2Schema = z
  .object({
    ...AttestationBaseShape,
    kind: z.literal("detached"),
    statementType: z.literal("application/vnd.cloudproof.bundle.v2+json"),
    signatureInput: z.literal("canonical-payload"),
    signatures: z.array(SignatureV2Schema).min(1).max(20),
  })
  .strict();

export const AttestationV2Schema = z.discriminatedUnion("kind", [
  DsseAttestationV2Schema,
  DetachedAttestationV2Schema,
]);

export const CLOUDPROOF_BUNDLE_V2_ATTESTATION_PAYLOAD_CONTRACT =
  "cloudproof-bundle/v2-rfc8785-jcs-v1; exclude=integrity,attestations; digest=algorithm-prefixed" as const;
export const CLOUDPROOF_BUNDLE_V2_PREDICATE_TYPE =
  "https://cloudproof.dev/attestations/release/v2" as const;
export const CLOUDPROOF_BUNDLE_V2_DSSE_PAYLOAD_TYPE =
  "application/vnd.cloudproof.bundle.v2+json" as const;

const IntegrityV2Schema = z
  .object({
    canonicalization: z.literal(CLOUDPROOF_BUNDLE_V2_ATTESTATION_PAYLOAD_CONTRACT),
    payloadDigest: ContentDigestSchema,
  })
  .strict();

const CloudProofBundleV2ObjectSchema = z
  .object({
    version: z.literal("2"),
    subject: z
      .object({
        repository: z.string().min(1).max(2_048),
        baseSha: CommitDigestSchema,
        headSha: CommitDigestSchema,
        service: z
          .object({
            name: z.string().min(1).max(256),
            path: z.string().min(1).max(2_048),
          })
          .strict()
          .optional(),
        releaseId: IdentifierSchema.optional(),
      })
      .strict(),
    conclusion: ConclusionSchema,
    issuedAt: TimestampSchema,
    expiresAt: TimestampSchema,
    assertions: z.array(AssertionV2Schema).min(1).max(MAX_ASSERTIONS),
    coverage: CoverageV2Schema,
    matrix: ReleaseMatrixV2Schema,
    provenance: ProvenanceV2Schema,
    evidence: z.array(EvidenceReferenceV2Schema).min(1).max(MAX_EVIDENCE_REFS),
    privacy: PrivacyV2Schema,
    approvals: z.array(ApprovalV2Schema).max(100).default([]),
    integrity: IntegrityV2Schema,
    attestations: z.array(AttestationV2Schema).min(1).max(20),
    nextActions: z.array(NextActionSchema).max(50).default([]),
  })
  .strict();

const classificationRank: Record<z.infer<typeof DataClassificationSchema>, number> = {
  public: 0,
  internal: 1,
  confidential: 2,
  restricted: 3,
};

function narrativeContainsSensitiveValue(value: unknown): boolean {
  if (typeof value === "string") {
    return (
      /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----/.test(value) ||
      /\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/i.test(value) ||
      /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/.test(value) ||
      /\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,}|AKIA[A-Z0-9]{16})\b/.test(value) ||
      /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?):\/\/[^\s:/?#]+:[^\s@/?#]+@/i.test(value) ||
      /\b(?:authorization|cookie|credential|password|passwd|private[_-]?key|secret|session|token|api[_-]?key|client[_-]?secret)\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/i.test(value) ||
      /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i.test(value)
    );
  }
  if (Array.isArray(value)) return value.some(narrativeContainsSensitiveValue);
  if (value !== null && typeof value === "object") {
    return Object.values(value as Record<string, unknown>).some(narrativeContainsSensitiveValue);
  }
  return false;
}

export const CloudProofBundleV2Schema = CloudProofBundleV2ObjectSchema.superRefine((bundle, context) => {
  const issuedAt = Date.parse(bundle.issuedAt);
  const expiresAt = Date.parse(bundle.expiresAt);
  const startedAt = Date.parse(bundle.provenance.execution.startedAt);
  const finishedAt = Date.parse(bundle.provenance.execution.finishedAt);

  if (Buffer.byteLength(JSON.stringify(bundle), "utf8") > MAX_CLOUDPROOF_BUNDLE_JSON_BYTES) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: [],
      message: `Serialized CloudProof Bundle exceeds ${MAX_CLOUDPROOF_BUNDLE_JSON_BYTES} bytes`,
    });
  }

  if (
    narrativeContainsSensitiveValue(bundle.assertions) ||
    narrativeContainsSensitiveValue(bundle.approvals) ||
    narrativeContainsSensitiveValue(bundle.nextActions)
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["privacy"],
      message: "Inline narrative contains an unredacted secret/PII pattern",
    });
  }

  if (expiresAt <= issuedAt) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["expiresAt"],
      message: "Bundle expiration must be later than issuance",
    });
  }
  if (expiresAt - issuedAt > MAX_CLOUDPROOF_BUNDLE_VALIDITY_MS) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["expiresAt"],
      message: "Bundle validity cannot exceed 24 hours",
    });
  }
  if (finishedAt < startedAt) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["provenance", "execution", "finishedAt"],
      message: "Execution cannot finish before it starts",
    });
  }
  if (issuedAt < finishedAt) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["issuedAt"],
      message: "Bundle cannot be issued before execution finishes",
    });
  }
  const provenanceCreatedAt = Date.parse(bundle.provenance.createdAt);
  if (provenanceCreatedAt < finishedAt || provenanceCreatedAt > issuedAt) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["provenance", "createdAt"],
      message: "Provenance must be finalized after execution and no later than issuance",
    });
  }
  const redactionAppliedAt = Date.parse(bundle.privacy.redaction.appliedAt);
  if (redactionAppliedAt < startedAt || redactionAppliedAt > issuedAt) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["privacy", "redaction", "appliedAt"],
      message: "The redaction pass must occur during evidence production and before issuance",
    });
  }
  if (Date.parse(bundle.privacy.retention.deleteAfter) < expiresAt) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["privacy", "retention", "deleteAfter"],
      message: "Evidence retention cannot end before bundle validity",
    });
  }

  if (
    bundle.subject.repository !== bundle.provenance.repository.uri ||
    bundle.subject.baseSha.toLowerCase() !== bundle.provenance.repository.baseCommit.toLowerCase() ||
    bundle.subject.headSha.toLowerCase() !== bundle.provenance.repository.headCommit.toLowerCase()
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["provenance", "repository"],
      message: "Provenance repository and commits must exactly identify the subject",
    });
  }

  const evidenceIds = bundle.evidence.map((item) => item.id);
  const evidenceIdSet = new Set(evidenceIds);
  if (evidenceIdSet.size !== evidenceIds.length) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["evidence"],
      message: "Evidence ids must be unique",
    });
  }
  const maxEvidenceClassification = bundle.evidence.reduce(
    (maximum, item) => Math.max(maximum, classificationRank[item.classification]),
    0,
  );
  if (classificationRank[bundle.privacy.classification] < maxEvidenceClassification) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["privacy", "classification"],
      message: "Bundle classification cannot be lower than referenced evidence",
    });
  }
  if (bundle.privacy.redaction.artifactsInspected !== bundle.evidence.length) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["privacy", "redaction", "artifactsInspected"],
      message: "Every evidence reference must be covered by the redaction pass",
    });
  }
  const redactedEvidenceCount = bundle.evidence.filter(
    (item) => item.redaction.disposition === "redacted",
  ).length;
  if (bundle.privacy.redaction.artifactsRedacted !== redactedEvidenceCount) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["privacy", "redaction", "artifactsRedacted"],
      message: "Redaction summary must match evidence-level dispositions",
    });
  }
  const provenanceArtifactSet = new Set(bundle.provenance.artifacts);
  for (const [index, item] of bundle.evidence.entries()) {
    const evidenceCreatedAt = Date.parse(item.createdAt);
    if (evidenceCreatedAt < startedAt || evidenceCreatedAt > issuedAt) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["evidence", index, "createdAt"],
        message: "Evidence references must be created during the attested run",
      });
    }
    if (item.redaction.policyId !== bundle.privacy.policy.id) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["evidence", index, "redaction", "policyId"],
        message: "Evidence redaction must use the Bundle privacy policy",
      });
    }
    if (!provenanceArtifactSet.has(item.digest)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["evidence", index, "digest"],
        message: "Every evidence digest must be bound into provenance.artifacts",
      });
    }
  }

  const assertionIds = bundle.assertions.map((assertion) => assertion.id);
  const assertionIdSet = new Set(assertionIds);
  if (assertionIdSet.size !== assertionIds.length) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["assertions"],
      message: "Assertion ids must be unique",
    });
  }
  for (const [index, assertion] of bundle.assertions.entries()) {
    for (const reference of assertion.evidenceRefs) {
      if (!evidenceIdSet.has(reference)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["assertions", index, "evidenceRefs"],
          message: `Unknown evidence reference: ${reference}`,
        });
      }
    }
    if (
      assertion.reproductionContext !== undefined &&
      !assertion.evidenceRefs.includes(assertion.reproductionContext.evidenceRef)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["assertions", index, "reproductionContext", "evidenceRef"],
        message: "Reproduction evidence must also be bound into assertion.evidenceRefs",
      });
    }
    const usableEvidence = assertion.evidenceRefs.some((reference) => {
      const item = bundle.evidence.find((candidate) => candidate.id === reference);
      return (
        item !== undefined &&
        item.redaction.disposition !== "blocked" &&
        item.sizeBytes > 0
      );
    });
    if (assertion.mandatory && assertion.result === "pass" && !usableEvidence) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["assertions", index, "evidenceRefs"],
        message: "A passing mandatory assertion needs retrievable, non-blocked evidence",
      });
    }
  }

  let canonicalPayload: string | undefined;
  let computedPayloadDigest: string | undefined;
  try {
    canonicalPayload = createCloudProofBundleV2AttestationPayload(bundle);
    computedPayloadDigest = digestForContract(canonicalPayload, bundle.integrity.payloadDigest);
  } catch (error) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["integrity"],
      message: error instanceof Error ? error.message : "Canonical payload could not be produced",
    });
  }
  if (
    computedPayloadDigest !== undefined &&
    computedPayloadDigest !== bundle.integrity.payloadDigest
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["integrity", "payloadDigest"],
      message: "Integrity digest does not match the canonical Bundle payload",
    });
  }

  const assertionMatrixReferences = new Map<string, number>();
  for (const [index, entry] of bundle.matrix.entries.entries()) {
    const entryAssertions = entry.assertionIds
      .map((assertionId) => bundle.assertions.find((candidate) => candidate.id === assertionId))
      .filter((assertion): assertion is AssertionV2 => assertion !== undefined);
    for (const assertionId of entry.assertionIds) {
      assertionMatrixReferences.set(
        assertionId,
        (assertionMatrixReferences.get(assertionId) ?? 0) + 1,
      );
      const assertion = bundle.assertions.find((candidate) => candidate.id === assertionId);
      if (assertion === undefined) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["matrix", "entries", index, "assertionIds"],
          message: `Unknown assertion: ${assertionId}`,
        });
      } else if (assertion.state !== entry.state) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["matrix", "entries", index, "assertionIds"],
          message: `Assertion ${assertionId} belongs to ${assertion.state}, not ${entry.state}`,
        });
      }
    }
    if (entryAssertions.length === entry.assertionIds.length) {
      const aggregateResult = entryAssertions.some(
        (assertion) => assertion.result === "fail" && assertion.approval === undefined,
      )
        ? "fail"
        : entryAssertions.some(
              (assertion) => assertion.result === "skipped" && assertion.approval === undefined,
            )
          ? "skipped"
          : "pass";
      if (entry.result !== aggregateResult) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["matrix", "entries", index, "result"],
          message: `Matrix result must equal the aggregate assertion result (${aggregateResult})`,
        });
      }
    }
    if (entry.required && !entryAssertions.some((assertion) => assertion.mandatory)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["matrix", "entries", index, "assertionIds"],
        message: "A required state needs at least one mandatory assertion",
      });
    }
    const assertionEvidence = new Set(
      entryAssertions.flatMap((assertion) => assertion.evidenceRefs),
    );
    const entryEvidence = new Set(entry.evidenceRefs);
    if (
      assertionEvidence.size !== entryEvidence.size ||
      [...assertionEvidence].some((reference) => !entryEvidence.has(reference))
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["matrix", "entries", index, "evidenceRefs"],
        message: "Matrix evidence must exactly equal evidence from its linked assertions",
      });
    }
    for (const reference of entry.evidenceRefs) {
      if (!evidenceIdSet.has(reference)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["matrix", "entries", index, "evidenceRefs"],
          message: `Unknown evidence reference: ${reference}`,
        });
      }
    }
    if (entry.required && (entry.startedAt === undefined || entry.finishedAt === undefined)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["matrix", "entries", index],
        message: "Required states need bounded start and finish timestamps",
      });
    }
    if (
      (entry.startedAt !== undefined && Date.parse(entry.startedAt) < startedAt) ||
      (entry.finishedAt !== undefined && Date.parse(entry.finishedAt) > finishedAt)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["matrix", "entries", index],
        message: "Matrix state timestamps must fall inside the execution window",
      });
    }
  }
  for (const [index, assertion] of bundle.assertions.entries()) {
    if ((assertionMatrixReferences.get(assertion.id) ?? 0) !== 1) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["assertions", index, "id"],
        message: "Every assertion must belong to exactly one matrix state",
      });
    }
  }

  const attestationIds = bundle.attestations.map((attestation) => attestation.id);
  const attestationIdSet = new Set(attestationIds);
  if (attestationIdSet.size !== attestationIds.length) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["attestations"],
      message: "Attestation ids must be unique",
    });
  }
  for (const [index, attestation] of bundle.attestations.entries()) {
    if (attestation.payloadDigest !== bundle.integrity.payloadDigest) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["attestations", index, "payloadDigest"],
        message: "Attestation does not cover the Bundle's declared canonical payload digest",
      });
    }
    const signatureKeys =
      attestation.kind === "dsse"
        ? attestation.envelope.signatures.map((signature) => `dsse\u0000${signature.keyid}`)
        : attestation.signatures.map(
            (signature) => `${signature.algorithm}\u0000${signature.keyId}`,
          );
    if (new Set(signatureKeys).size !== signatureKeys.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["attestations", index, "signatures"],
        message: "An attestation cannot repeat the same algorithm/keyId signature",
      });
    }
    const attestedAt = Date.parse(attestation.issuedAt);
    if (attestedAt < issuedAt || attestedAt > expiresAt) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["attestations", index, "issuedAt"],
        message: "Attestation issuance must fall within the Bundle validity window",
      });
    }
    if (attestation.kind === "dsse") {
      let decoded: string | undefined;
      try {
        const bytes = Buffer.from(attestation.envelope.payload, "base64");
        if (bytes.toString("base64") === attestation.envelope.payload) {
          decoded = bytes.toString("utf8");
        }
      } catch {
        decoded = undefined;
      }
      if (canonicalPayload !== undefined && decoded !== canonicalPayload) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["attestations", index, "envelope", "payload"],
          message: "DSSE payload must equal the canonical Bundle payload byte-for-byte",
        });
      }
    }
  }

  const approvalIds = bundle.approvals.map((approval) => approval.id);
  const approvalById = new Map(bundle.approvals.map((approval) => [approval.id, approval]));
  if (new Set(approvalIds).size !== approvalIds.length) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["approvals"],
      message: "Approval ids must be unique",
    });
  }
  for (const [index, approval] of bundle.approvals.entries()) {
    if (!attestationIdSet.has(approval.attestationId)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["approvals", index, "attestationId"],
        message: `Unknown attestation: ${approval.attestationId}`,
      });
    }
    if (Date.parse(approval.issuedAt) > issuedAt) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["approvals", index, "issuedAt"],
        message: "An approval embedded in a Bundle cannot be issued after the Bundle",
      });
    }
    if (Date.parse(approval.expiresAt) < expiresAt) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["approvals", index, "expiresAt"],
        message: "Approval expiration cannot precede Bundle expiration",
      });
    }
    for (const assertionId of approval.scope.assertionIds) {
      if (!assertionIdSet.has(assertionId)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["approvals", index, "scope", "assertionIds"],
          message: `Unknown assertion: ${assertionId}`,
        });
      }
    }
  }
  for (const [index, assertion] of bundle.assertions.entries()) {
    if (assertion.approval === undefined) continue;
    const approval = approvalById.get(assertion.approval.id);
    if (
      approval === undefined ||
      approval.reason !== assertion.approval.reason ||
      !approval.scope.assertionIds.includes(assertion.id)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["assertions", index, "approval"],
        message: "Assertion approval must resolve to an in-scope, matching top-level approval",
      });
    }
  }

  if (bundle.conclusion === "VERIFIED") {
    if (bundle.provenance.repository.dirty) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["provenance", "repository", "dirty"],
        message: "VERIFIED requires an immutable, clean repository subject",
      });
    }
    const imageRoles = new Set(bundle.provenance.images.map((image) => image.role));
    for (const role of ["base-app", "candidate-app", "database"] as const) {
      if (!imageRoles.has(role)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["provenance", "images"],
          message: `VERIFIED requires an image digest for ${role}`,
        });
      }
    }
    const execution = bundle.provenance.execution;
    if (
      execution.profile === "fork" &&
      (execution.isolation === "host" || execution.network === "unrestricted")
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["provenance", "execution"],
        message: "A fork run cannot be VERIFIED with host isolation or unrestricted network",
      });
    }
    if (execution.profile === "internal" && execution.network === "unrestricted") {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["provenance", "execution", "network"],
        message: "An internal run cannot be VERIFIED with unrestricted network",
      });
    }
    if (bundle.matrix.completeness !== "complete") {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["matrix", "completeness"],
        message: "VERIFIED requires a complete release matrix",
      });
    }
    if (bundle.matrix.entries.some((entry) => entry.required && entry.result !== "pass")) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["matrix", "entries"],
        message: "VERIFIED requires every required matrix state to pass",
      });
    }
    if (
      bundle.assertions.some(
        (assertion) =>
          assertion.mandatory && assertion.result !== "pass" && assertion.approval === undefined,
      )
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["assertions"],
        message: "VERIFIED requires mandatory assertions to pass or carry a traceable approval",
      });
    }
    if (
      bundle.coverage.routesObserved === 0 ||
      bundle.coverage.complete === false ||
      bundle.coverage.source === "unknown"
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["coverage"],
        message: "VERIFIED requires non-trivial, known and complete coverage",
      });
    }
    if (bundle.privacy.redaction.status === "failed") {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["privacy", "redaction", "status"],
        message: "VERIFIED is forbidden when privacy redaction failed",
      });
    }
    if (bundle.nextActions.length !== 0) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["nextActions"],
        message: "A VERIFIED Bundle cannot carry unresolved next actions",
      });
    }
  } else if (bundle.nextActions.length === 0) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["nextActions"],
      message: "UNSAFE and INCONCLUSIVE Bundles must be actionable",
    });
  }
});

/** Reads both wire versions. Producers should select an explicit version schema. */
export const CloudProofBundleSchema = z.union([CloudProofBundleV2Schema, CloudProofBundleV1Schema]);

export type AssertionV1 = z.infer<typeof AssertionV1Schema>;
export type AssertionV2 = z.infer<typeof AssertionV2Schema>;
export type Assertion = AssertionV1 | AssertionV2;
export type Coverage = z.infer<typeof CoverageSchema>;
export type ProvenanceV1 = z.infer<typeof ProvenanceV1Schema>;
export type ProvenanceV2 = z.infer<typeof ProvenanceV2Schema>;
export type Provenance = ProvenanceV1 | ProvenanceV2;
export type CloudProofBundleV1 = z.infer<typeof CloudProofBundleV1Schema>;
export type CloudProofBundleV2 = z.infer<typeof CloudProofBundleV2Schema>;
export type CloudProofBundleV1Input = z.input<typeof CloudProofBundleV1Schema>;
export type CloudProofBundleV2Input = z.input<typeof CloudProofBundleV2Schema>;
export type CloudProofBundle = CloudProofBundleV1 | CloudProofBundleV2;
export type ExecutionState = z.infer<typeof ExecutionStateSchema>;
export type Approval = z.infer<typeof ApprovalSchema>;
export type ApprovalV2 = z.infer<typeof ApprovalV2Schema>;
export type EvidenceReferenceV2 = z.infer<typeof EvidenceReferenceV2Schema>;
export type AttestationV2 = z.infer<typeof AttestationV2Schema>;
export type ReproductionContext = z.infer<typeof ReproductionContextSchema>;
export type ReproductionContextV2 = z.infer<typeof ReproductionContextV2Schema>;
export type CloudProofBundleFreshness = "not-yet-valid" | "fresh" | "expired";

/** Pure, deterministic freshness decision. Equality with expiresAt is expired. */
export function getCloudProofBundleFreshness(
  bundle: Pick<CloudProofBundleV2, "issuedAt" | "expiresAt">,
  now: Date | string | number = new Date(),
): CloudProofBundleFreshness {
  const instant = now instanceof Date ? now.getTime() : new Date(now).getTime();
  if (!Number.isFinite(instant)) throw new TypeError("Invalid freshness comparison instant");
  if (instant < Date.parse(bundle.issuedAt)) return "not-yet-valid";
  return instant < Date.parse(bundle.expiresAt) ? "fresh" : "expired";
}

type CanonicalJson = null | boolean | number | string | CanonicalJson[] | { [key: string]: CanonicalJson };

function canonicalJson(value: CanonicalJson): string {
  if (typeof value === "string") {
    for (let index = 0; index < value.length; index += 1) {
      const unit = value.charCodeAt(index);
      if (unit >= 0xd800 && unit <= 0xdbff) {
        const next = value.charCodeAt(index + 1);
        if (!(next >= 0xdc00 && next <= 0xdfff)) {
          throw new TypeError("RFC 8785 canonical JSON rejects unpaired UTF-16 surrogates");
        }
        index += 1;
      } else if (unit >= 0xdc00 && unit <= 0xdfff) {
        throw new TypeError("RFC 8785 canonical JSON rejects unpaired UTF-16 surrogates");
      }
    }
    return JSON.stringify(value);
  }
  if (value === null || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Canonical JSON cannot encode non-finite numbers");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value)
    .filter((key) => (value as Record<string, unknown>)[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key] as CanonicalJson)}`)
    .join(",")}}`;
}

function digestForContract(payload: string, declaredDigest: string): string {
  const separator = declaredDigest.indexOf(":");
  const algorithm = declaredDigest.slice(0, separator);
  if (algorithm !== "sha256" && algorithm !== "sha512") {
    throw new TypeError(`Unsupported Bundle digest algorithm: ${algorithm}`);
  }
  return `${algorithm}:${createHash(algorithm).update(payload, "utf8").digest("hex")}`;
}

/**
 * Returns the exact UTF-8 string a signer/verifier hashes. `integrity` and
 * `attestations` are excluded to avoid a circular digest. This helper hashes
 * nothing and verifies no signature; callers must use the algorithm named by
 * `integrity.payloadDigest` and apply their own trust-root policy.
 */
export type CloudProofBundleV2AttestationPayloadInput =
  | CloudProofBundleV2
  | Omit<CloudProofBundleV2, "integrity" | "attestations">;

export function createCloudProofBundleV2AttestationPayload(
  bundle: CloudProofBundleV2AttestationPayloadInput,
): string {
  const { integrity: _integrity, attestations: _attestations, ...payload } = bundle as CloudProofBundleV2;
  void _integrity;
  void _attestations;
  return canonicalJson(payload as unknown as CanonicalJson);
}

export const CLOUDPROOF_BUNDLE_V1_DSSE_PAYLOAD_TYPE =
  "application/vnd.cloudproof.bundle.v1+json" as const;

/**
 * Payload canónico de firma para cualquier versión del Bundle (gate 3 del
 * informe 2026-07-18). V2 excluye `integrity`/`attestations` (contrato
 * CLOUDPROOF_BUNDLE_V2_ATTESTATION_PAYLOAD_CONTRACT); V1 no tiene envelope de
 * integridad, así que el payload es el Bundle completo en JSON canónico
 * RFC 8785. Esta función no hashea ni firma nada: produce los bytes exactos
 * que un firmante/verificador debe procesar.
 */
export function createCloudProofBundleSigningPayload(bundle: CloudProofBundle): {
  payloadType:
    | typeof CLOUDPROOF_BUNDLE_V1_DSSE_PAYLOAD_TYPE
    | typeof CLOUDPROOF_BUNDLE_V2_DSSE_PAYLOAD_TYPE;
  payload: string;
} {
  if (bundle.version === "2") {
    return {
      payloadType: CLOUDPROOF_BUNDLE_V2_DSSE_PAYLOAD_TYPE,
      payload: createCloudProofBundleV2AttestationPayload(bundle),
    };
  }
  return {
    payloadType: CLOUDPROOF_BUNDLE_V1_DSSE_PAYLOAD_TYPE,
    payload: canonicalJson(bundle as unknown as CanonicalJson),
  };
}

/** Computes the algorithm-qualified integrity digest expected by v2. */
export function createCloudProofBundleV2PayloadDigest(
  bundle: CloudProofBundleV2AttestationPayloadInput,
  algorithm: "sha256" | "sha512" = "sha256",
): string {
  return digestForContract(
    createCloudProofBundleV2AttestationPayload(bundle),
    `${algorithm}:${"0".repeat(algorithm === "sha256" ? 64 : 128)}`,
  );
}

/** Structural check after a caller independently hashes the canonical payload. */
export function attestationPayloadDigestMatches(
  bundle: CloudProofBundleV2,
  independentlyComputedDigest: string,
): boolean {
  return (
    ContentDigestSchema.safeParse(independentlyComputedDigest).success &&
    bundle.integrity.payloadDigest === independentlyComputedDigest &&
    bundle.attestations.every(
      (attestation) => attestation.payloadDigest === independentlyComputedDigest,
    )
  );
}

/**
 * Bounded decoder for untrusted wire input. `CloudProofBundleSchema` remains a
 * historical reader; authorization gates must additionally require version 2,
 * freshness and cryptographic trust verification.
 */
export function parseCloudProofBundleJson(
  input: string | Uint8Array,
): CloudProofBundle {
  const bytes = typeof input === "string" ? Buffer.byteLength(input, "utf8") : input.byteLength;
  if (bytes > MAX_CLOUDPROOF_BUNDLE_JSON_BYTES) {
    throw new RangeError(`CloudProof Bundle exceeds ${MAX_CLOUDPROOF_BUNDLE_JSON_BYTES} bytes`);
  }
  const text = typeof input === "string" ? input : Buffer.from(input).toString("utf8");
  return CloudProofBundleSchema.parse(JSON.parse(text) as unknown);
}

export interface CloudProofBundleV2GatePolicy {
  now?: Date | string | number;
  /**
   * Must verify DSSE PAE/detached signatures, certificate chains, revocation,
   * signer identity and the consumer's trust roots. Structural parsing is not
   * a substitute for this callback.
   */
  verifyAttestations: (
    bundle: CloudProofBundleV2,
    canonicalPayload: string,
  ) => boolean | Promise<boolean>;
  /** Fetches/opens every non-blocked locator and verifies bytes against digest. */
  verifyEvidence: (bundle: CloudProofBundleV2) => boolean | Promise<boolean>;
}

/** Anti-downgrade, freshness and mandatory trust boundary for merge gates. */
export async function evaluateCloudProofBundleV2ForGate(
  input: unknown,
  policy: CloudProofBundleV2GatePolicy,
): Promise<CloudProofBundleV2> {
  const bundle = CloudProofBundleV2Schema.parse(input);
  if (bundle.conclusion !== "VERIFIED") {
    throw new Error(`CloudProof Bundle conclusion is ${bundle.conclusion}, not VERIFIED`);
  }
  const freshness = getCloudProofBundleFreshness(bundle, policy.now ?? new Date());
  if (freshness !== "fresh") {
    throw new Error(`CloudProof Bundle is ${freshness}; gate evidence must be fresh`);
  }
  const trusted = await policy.verifyAttestations(
    bundle,
    createCloudProofBundleV2AttestationPayload(bundle),
  );
  if (!trusted) {
    throw new Error("CloudProof Bundle attestations did not satisfy the gate trust policy");
  }
  const evidenceVerified = await policy.verifyEvidence(bundle);
  if (!evidenceVerified) {
    throw new Error("CloudProof Bundle evidence was unavailable or failed content-digest verification");
  }
  return bundle;
}

/**
 * INCONCLUSIVE if write coverage is insufficient; UNSAFE if an unapproved
 * mandatory assertion fails; VERIFIED only after every mandatory check ran.
 */
export function deriveConclusion(
  assertions: Pick<Assertion, "result" | "mandatory" | "approval">[],
  coverage: Coverage,
): z.infer<typeof ConclusionSchema> {
  const mandatory = assertions.filter((assertion) => assertion.mandatory !== false);
  if (
    mandatory.some(
      (assertion) => assertion.result === "fail" && assertion.approval === undefined,
    )
  ) {
    return "UNSAFE";
  }
  if (coverage.routesObserved === 0) return "INCONCLUSIVE";
  if (coverage.complete === false || coverage.source === "unknown") return "INCONCLUSIVE";
  if (coverage.changeSource === "unknown" || (coverage.changedRoutesMissing?.length ?? 0) > 0) {
    return "INCONCLUSIVE";
  }
  if (mandatory.some((assertion) => assertion.result === "skipped")) return "INCONCLUSIVE";
  if (mandatory.length === 0) return "INCONCLUSIVE";
  return "VERIFIED";
}
