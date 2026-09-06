import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProjectConfig } from "@cloudproof/config";
import type { CloudProofBundle } from "@cloudproof/schema";
import { afterEach, describe, expect, it } from "vitest";
import {
  AssertionAmbiguousError,
  ReproductionContextError,
  ReproductionStateError,
  findAssertion,
  findAssertionContext,
  reproductionManifestPath,
  runReproduce,
  type ReproduceDependencies,
  type ReproductionExecutor,
  type ReproductionExecutorOptions,
} from "../src/commands/reproduce.js";

const temporaryRoots: string[] = [];

function temporaryRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "cloudproof-reproduce-unit-"));
  temporaryRoots.push(root);
  mkdirSync(join(root, ".cloudproof"), { recursive: true });
  return root;
}

function bundle(baseSha = "base-sha", headSha = "head-sha"): CloudProofBundle {
  return {
    version: "1",
    subject: { baseSha, headSha },
    conclusion: "UNSAFE",
    assertions: [
      {
        id: "postgres.old-app-new-schema.0",
        result: "fail",
        evidence: ["POST /orders status 500", "SQLSTATE 23502: currency cannot be null"],
      },
    ],
    coverage: { routesObserved: 1, routesDetected: 1 },
    provenance: { runner: "unit-run", artifacts: [] },
  };
}

function writeBundle(root: string, filename: string, value: CloudProofBundle): string {
  const path = join(root, ".cloudproof", filename);
  writeFileSync(path, JSON.stringify(value), "utf-8");
  return path;
}

const oneServiceConfig: ProjectConfig = {
  services: { api: { kind: "node", path: "apps/api" } },
  data: { main: { kind: "postgres", version: 16 } },
  flows: [],
  release: { strategy: "migration-first", rollback: "application" },
  policies: [],
  approvals: [],
};

interface FakeState {
  calls: Array<{ operation: string; value?: unknown }>;
  createdWith: ReproductionExecutorOptions[];
  failStartApp?: boolean;
}

function fakeExecutor(runId: string, state: FakeState): ReproductionExecutor {
  let postgresCount = 0;
  return {
    runId,
    async buildImage(spec) {
      state.calls.push({ operation: "buildImage", value: spec });
      return "cloudproof-app:base";
    },
    async startEphemeralPostgres(spec) {
      state.calls.push({ operation: "startEphemeralPostgres", value: spec });
      postgresCount += 1;
      const isS0 = postgresCount === 1;
      return {
        id: isS0 ? "postgres-s0-id" : "postgres-s1-id",
        serviceName: isS0 ? "cloudproof-pg-s0" : "cloudproof-pg-s1",
        connectionUrl: `postgresql://cloudproof:cloudproof@cloudproof-pg-${isS0 ? "s0" : "s1"}:5432/cloudproof`,
        hostConnectionUrl: `postgresql://cloudproof:cloudproof@127.0.0.1:${isS0 ? "55431" : "55432"}/cloudproof`,
      };
    },
    async startApp(imageTag, env) {
      state.calls.push({ operation: "startApp", value: { imageTag, env } });
      if (state.failStartApp === true) {
        throw new Error("app failed readiness");
      }
      return {
        id: "app-id",
        serviceName: "cloudproof-app-0",
        connectionUrl: "http://127.0.0.1:43123",
        containerPort: 3000,
      };
    },
    async imageDigest(imageTag) {
      state.calls.push({ operation: "imageDigest", value: imageTag });
      return `sha256:${imageTag}`;
    },
    async captureSqlEffects(containerId) {
      state.calls.push({ operation: "captureSqlEffects", value: containerId });
      return { tables: [] };
    },
    async captureSchemaFingerprint(containerId) {
      state.calls.push({ operation: "captureSchemaFingerprint", value: containerId });
      return { digest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" };
    },
    async teardown(containerId) {
      state.calls.push({ operation: "teardown", value: containerId });
    },
    async exportPostgres(containerId, destinationPath) {
      state.calls.push({
        operation: "exportPostgres",
        value: { containerId, destinationPath },
      });
      writeFileSync(destinationPath, "-- unit snapshot\n", "utf-8");
    },
    async disposeRun() {
      state.calls.push({ operation: "disposeRun", value: runId });
    },
  };
}

function dependencies(
  state: FakeState,
  output: string[],
  config: ProjectConfig = oneServiceConfig,
): Partial<ReproduceDependencies> {
  return {
    createExecutor(options) {
      state.createdWith.push(options);
      return fakeExecutor(options.runId ?? "live-run", state);
    },
    async loadProjectConfig() {
      return config;
    },
    async verifyRunDisposed(runId) {
      state.calls.push({ operation: "verifyRunDisposed", value: runId });
    },
    writeOutput(text) {
      output.push(text);
    },
    now() {
      return "2026-07-14T12:00:00.000Z";
    },
  };
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("cloudproof reproduce", () => {
  it("reconstructs A0 + S1, leaves it running, and later cleans only its run", async () => {
    const root = temporaryRepo();
    const bundlePath = writeBundle(root, "release.json", bundle());
    const state: FakeState = { calls: [], createdWith: [] };
    const output: string[] = [];
    const injected = dependencies(state, output);

    const started = await runReproduce(
      "postgres.old-app-new-schema.0",
      { cwd: root },
      injected,
    );

    expect(started).toMatchObject({
      kind: "started",
      subject: { baseSha: "base-sha", headSha: "head-sha" },
      bundlePath,
      servicePath: "apps/api",
      runId: "live-run",
      appUrl: "http://127.0.0.1:43123",
      postgresUrl: "postgresql://cloudproof:cloudproof@127.0.0.1:55432/cloudproof",
      cleanupCommand: 'cloudproof reproduce "postgres.old-app-new-schema.0" --cleanup',
    });
    expect(state.calls).toEqual([
      {
        operation: "buildImage",
        value: { sha: "base-sha", servicePath: "apps/api" },
      },
      {
        operation: "startEphemeralPostgres",
        value: { label: "S0", migrationsUpToSha: "base-sha", servicePath: "apps/api" },
      },
      {
        operation: "startEphemeralPostgres",
        value: {
          label: "S1",
          migrationsUpToSha: "head-sha",
          servicePath: "apps/api",
          cloneFromContainerId: "postgres-s0-id",
        },
      },
      {
        operation: "exportPostgres",
        value: {
          containerId: "postgres-s1-id",
          destinationPath: expect.stringMatching(/\.cloudproof[\\/]reproductions[\\/].+\.sql$/),
        },
      },
      {
        operation: "startApp",
        value: {
          imageTag: "cloudproof-app:base",
          env: { DATABASE_URL: "postgresql://cloudproof:cloudproof@cloudproof-pg-s1:5432/cloudproof" },
        },
      },
      { operation: "teardown", value: "postgres-s0-id" },
    ]);
    expect(output.join("")).toContain("Reproducción en vivo lista (A0 + S1)");
    expect(output.join("")).toContain("http://127.0.0.1:43123");
    if (started.kind !== "started") throw new Error("se esperaba reproducción live");
    const compose = readFileSync(started.composePath, "utf-8");
    expect(compose).toContain("internal: true");
    expect(compose).toContain("proxy:");
    expect(compose).toContain("networks: [cloudproof_internal, cloudproof_access]");
    expect(existsSync(started.sqlSnapshotPath)).toBe(true);

    const manifestPath = reproductionManifestPath("postgres.old-app-new-schema.0", root);
    expect(existsSync(manifestPath)).toBe(true);
    expect(JSON.parse(readFileSync(manifestPath, "utf-8"))).toMatchObject({
      runId: "live-run",
      status: "ready",
      subject: { baseSha: "base-sha", headSha: "head-sha" },
      app: { id: "app-id", url: "http://127.0.0.1:43123" },
      postgres: { id: "postgres-s1-id" },
    });

    const cleaned = await runReproduce(
      "postgres.old-app-new-schema.0",
      { cwd: root, cleanup: true },
      injected,
    );

    expect(cleaned).toEqual({
      kind: "cleaned",
      assertionId: "postgres.old-app-new-schema.0",
      runId: "live-run",
    });
    expect(state.createdWith[1]).toEqual({ repoRoot: root, runId: "live-run" });
    expect(state.calls.slice(-2)).toEqual([
      { operation: "disposeRun", value: "live-run" },
      { operation: "verifyRunDisposed", value: "live-run" },
    ]);
    expect(existsSync(manifestPath)).toBe(false);
  });

  it("automatically disposes a partially-started run and removes its manifest", async () => {
    const root = temporaryRepo();
    writeBundle(root, "release.json", bundle());
    const state: FakeState = { calls: [], createdWith: [], failStartApp: true };

    await expect(
      runReproduce(
        "postgres.old-app-new-schema.0",
        { cwd: root },
        dependencies(state, []),
      ),
    ).rejects.toThrow("app failed readiness");

    expect(state.calls.slice(-2)).toEqual([
      { operation: "disposeRun", value: "live-run" },
      { operation: "verifyRunDisposed", value: "live-run" },
    ]);
    expect(existsSync(reproductionManifestPath("postgres.old-app-new-schema.0", root))).toBe(
      false,
    );
  });

  it("refuses to guess a service when cloudproof.config.ts contains more than one", async () => {
    const root = temporaryRepo();
    writeBundle(root, "release.json", bundle());
    const state: FakeState = { calls: [], createdWith: [] };
    const multiServiceConfig: ProjectConfig = {
      ...oneServiceConfig,
      services: {
        api: { kind: "node", path: "apps/api" },
        worker: { kind: "node", path: "apps/worker" },
      },
    };

    await expect(
      runReproduce(
        "postgres.old-app-new-schema.0",
        { cwd: root },
        dependencies(state, [], multiServiceConfig),
      ),
    ).rejects.toBeInstanceOf(ReproductionContextError);
    expect(state.createdWith).toHaveLength(0);
  });

  it("requires --bundle for duplicate assertion ids and uses its exact subject", () => {
    const root = temporaryRepo();
    const firstPath = writeBundle(root, "first.json", bundle("base-1", "head-1"));
    writeBundle(root, "second.json", bundle("base-2", "head-2"));

    expect(() => findAssertionContext("postgres.old-app-new-schema.0", root)).toThrow(
      AssertionAmbiguousError,
    );
    expect(
      findAssertionContext(
        "postgres.old-app-new-schema.0",
        root,
        join(".cloudproof", "first.json"),
      ),
    ).toMatchObject({
      subject: { baseSha: "base-1", headSha: "head-1" },
      bundlePath: firstPath,
    });

    // MCP tampoco elige un bundle arbitrario; puede desambiguar explícitamente.
    expect(() => findAssertion("postgres.old-app-new-schema.0", root)).toThrow(
      AssertionAmbiguousError,
    );
    expect(findAssertion("postgres.old-app-new-schema.0", root, firstPath).result).toBe("fail");
  });

  it("fails safely when cleanup has no targeted manifest", async () => {
    const root = temporaryRepo();
    const state: FakeState = { calls: [], createdWith: [] };

    await expect(
      runReproduce(
        "postgres.old-app-new-schema.0",
        { cwd: root, cleanup: true },
        dependencies(state, []),
      ),
    ).rejects.toBeInstanceOf(ReproductionStateError);
    expect(state.createdWith).toHaveLength(0);
  });

  it("keeps the manifest when Docker cannot confirm that cleanup reached zero", async () => {
    const root = temporaryRepo();
    writeBundle(root, "release.json", bundle());
    const state: FakeState = { calls: [], createdWith: [] };
    const injected = dependencies(state, []);
    await runReproduce("postgres.old-app-new-schema.0", { cwd: root }, injected);
    const manifestPath = reproductionManifestPath("postgres.old-app-new-schema.0", root);

    await expect(
      runReproduce(
        "postgres.old-app-new-schema.0",
        { cwd: root, cleanup: true },
        {
          ...injected,
          async verifyRunDisposed() {
            throw new ReproductionStateError("quedaron recursos");
          },
        },
      ),
    ).rejects.toThrow("quedaron recursos");

    expect(existsSync(manifestPath)).toBe(true);
  });
});
