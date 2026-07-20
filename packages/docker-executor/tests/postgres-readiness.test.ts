import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ComposeExecutor,
  ExecutorError,
  isTransientPostgresError,
  waitPostgresTcpReady,
  type PostgresReadinessAttempt,
} from "../dist/index.js";
import { FakeRunner, type Responder } from "./fake-runner.js";

/**
 * Unit tests de la corrección de la carrera de readiness (P0 del informe
 * 2026-07-18): pg_isready respondía OK contra el postmaster temporal de
 * initdb y el executor seguía adelante contra una base que se estaba
 * apagando. La sonda nueva es SELECT 1 por TCP, dos éxitos consecutivos
 * sobre el mismo postmaster.
 */

const T0 = "2026-01-01 00:00:00.000000+00";
const T1 = "2026-01-01 00:00:05.000000+00";

function readinessResponder(probeResults: Array<{ ok?: string; err?: string }>): {
  responder: Responder;
  state: { probes: number };
} {
  const state = { probes: 0 };
  const responder: Responder = (command, args) => {
    if (command !== "docker") return undefined;
    const line = args.join(" ");
    if (args[0] === "inspect" && line.includes("{{.State.Running}}")) {
      return { stdout: "true\n" };
    }
    if (args[0] === "exec" && line.includes("pg_postmaster_start_time")) {
      const result = probeResults[Math.min(state.probes, probeResults.length - 1)];
      state.probes += 1;
      return result?.ok !== undefined
        ? { stdout: `1|${result.ok}\n` }
        : { exitCode: 2, stderr: result?.err ?? "psql: error: sin conexión" };
    }
    if (args[0] === "logs") {
      return { stdout: "log line\n" };
    }
    return undefined;
  };
  return { responder, state };
}

describe("waitPostgresTcpReady", () => {
  it("exige dos SELECT 1 consecutivos por TCP y descarta pg_isready", async () => {
    const { responder, state } = readinessResponder([
      { err: "psql: error: FATAL:  the database system is starting up" },
      { ok: T0 },
      { ok: T0 },
    ]);
    const runner = new FakeRunner(responder);
    const attempts: PostgresReadinessAttempt[] = [];

    await waitPostgresTcpReady(runner, "cid", {
      pollIntervalMs: 1,
      timeoutMs: 2_000,
      onAttempt: (attempt) => attempts.push(attempt),
    });

    expect(state.probes).toBe(3);
    expect(runner.count("pg_isready")).toBe(0);
    // La sonda usa el MISMO camino de conexión que tendrá la app: TCP + password.
    expect(runner.count("-h 127.0.0.1", "-p 5432", "SELECT 1, pg_postmaster_start_time();")).toBe(3);
    expect(runner.count("-e PGPASSWORD=proof")).toBe(3);
    expect(runner.count("ON_ERROR_STOP=1")).toBe(3);
    expect(attempts.map((attempt) => attempt.outcome)).toEqual(["waiting", "ok"]);
  });

  it("el postmaster temporal que se apaga entre sondas NO cuenta como readiness", async () => {
    // Reproduce la carrera reportada: una sonda OK (postmaster temporal),
    // después "shutting down", después el postmaster definitivo.
    const { responder, state } = readinessResponder([
      { ok: T0 },
      { err: "psql: error: FATAL:  the database system is shutting down" },
      { ok: T1 },
      { ok: T1 },
    ]);
    const runner = new FakeRunner(responder);

    await waitPostgresTcpReady(runner, "cid", { pollIntervalMs: 1, timeoutMs: 2_000 });

    expect(state.probes).toBe(4);
  });

  it("un reinicio del postmaster entre sondas resetea la confirmación", async () => {
    const { responder, state } = readinessResponder([{ ok: T0 }, { ok: T1 }, { ok: T1 }]);
    const runner = new FakeRunner(responder);
    const attempts: PostgresReadinessAttempt[] = [];

    await waitPostgresTcpReady(runner, "cid", {
      pollIntervalMs: 1,
      timeoutMs: 2_000,
      onAttempt: (attempt) => attempts.push(attempt),
    });

    expect(state.probes).toBe(3);
    expect(attempts.some((attempt) => attempt.outcome === "restarted")).toBe(true);
  });

  it("contenedor muerto durante la espera → ExecutorError con logs", async () => {
    const runner = new FakeRunner((command, args) => {
      if (command !== "docker") return undefined;
      if (args[0] === "inspect") return { stdout: "false\n" };
      if (args[0] === "logs") return { stderr: "FATAL: could not map memory\n" };
      return undefined;
    });

    await expect(
      waitPostgresTcpReady(runner, "cid", { label: "S0", pollIntervalMs: 1, timeoutMs: 2_000 }),
    ).rejects.toThrowError(/terminó antes de estar listo/);
  });

  it("timeout sin confirmación → ExecutorError con la evidencia del contenedor", async () => {
    const { responder } = readinessResponder([
      { err: "psql: error: FATAL:  the database system is starting up" },
    ]);
    const runner = new FakeRunner(responder);

    await expect(
      waitPostgresTcpReady(runner, "cid", { label: "S1", pollIntervalMs: 1, timeoutMs: 40 }),
    ).rejects.toThrowError(/no confirmó SELECT 1 por TCP/);
  });
});

describe("isTransientPostgresError", () => {
  it("clasifica como transitorios solo los errores de conexión/arranque conocidos", () => {
    expect(isTransientPostgresError("FATAL:  the database system is starting up")).toBe(true);
    expect(isTransientPostgresError("FATAL:  the database system is shutting down")).toBe(true);
    expect(isTransientPostgresError("FATAL:  the database system is in recovery mode")).toBe(true);
    expect(isTransientPostgresError("SQLSTATE 57P03")).toBe(true);
    expect(isTransientPostgresError("server closed the connection unexpectedly")).toBe(true);
    expect(
      isTransientPostgresError(
        'connection to server at "127.0.0.1", port 5432 failed: Connection refused',
      ),
    ).toBe(true);
    expect(isTransientPostgresError("could not connect to server: No such file")).toBe(true);
  });

  it("JAMÁS clasifica como transitorio un error SQL real de compatibilidad", () => {
    expect(
      isTransientPostgresError(
        'ERROR:  null value in column "currency" of relation "payments" violates not-null constraint',
      ),
    ).toBe(false);
    expect(isTransientPostgresError("SQLSTATE 23502")).toBe(false);
    expect(isTransientPostgresError('ERROR:  column "currency" does not exist')).toBe(false);
    expect(isTransientPostgresError('ERROR:  relation "payments" does not exist')).toBe(false);
    expect(isTransientPostgresError("ERROR:  permission denied for table payments")).toBe(false);
  });
});

describe("reintentos de lecturas SQL (dockerOkReadRetry)", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "proof-retry-ut-"));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  const DIGEST = `sha256:${"a".repeat(64)}`;

  function makeExecutor(runner: FakeRunner): ComposeExecutor {
    return new ComposeExecutor({ runner, repoRoot: tmp, runId: "test", pollIntervalMs: 1 });
  }

  it("reintenta un transitorio en lecturas y registra los intentos en attemptLog", async () => {
    let calls = 0;
    const runner = new FakeRunner((command, args) => {
      if (command === "docker" && args[0] === "exec") {
        calls += 1;
        return calls === 1
          ? { exitCode: 2, stderr: "psql: error: FATAL:  the database system is in recovery mode" }
          : { stdout: `${DIGEST}\n` };
      }
      return undefined;
    });
    const executor = makeExecutor(runner);

    const fingerprint = await executor.captureSchemaFingerprint("cid");

    expect(fingerprint.digest).toBe(DIGEST);
    expect(calls).toBe(2);
    const outcomes = executor.attemptLog().map((entry) => `${entry.phase}:${entry.outcome}`);
    expect(outcomes).toContain("sql-read-retry:transient");
    expect(outcomes).toContain("sql-read-retry:ok");
  });

  it("un error SQL real NO se reintenta: se propaga al primer intento", async () => {
    let calls = 0;
    const runner = new FakeRunner((command, args) => {
      if (command === "docker" && args[0] === "exec") {
        calls += 1;
        return { exitCode: 1, stderr: 'ERROR:  relation "pg_stat_user_tables" does not exist' };
      }
      return undefined;
    });
    const executor = makeExecutor(runner);

    await expect(executor.captureSchemaFingerprint("cid")).rejects.toThrowError(ExecutorError);
    expect(calls).toBe(1);
    expect(executor.attemptLog()).toHaveLength(0);
  });

  it("transitorio persistente → falla tras el máximo de intentos, con rastro completo", async () => {
    let calls = 0;
    const runner = new FakeRunner((command, args) => {
      if (command === "docker" && args[0] === "exec") {
        calls += 1;
        return { exitCode: 2, stderr: "server closed the connection unexpectedly" };
      }
      return undefined;
    });
    const executor = makeExecutor(runner);

    await expect(executor.captureSchemaFingerprint("cid")).rejects.toThrowError(
      /tras 3 intentos con errores transitorios/,
    );
    expect(calls).toBe(3);
    expect(
      executor.attemptLog().filter((entry) => entry.outcome === "transient"),
    ).toHaveLength(3);
  });
});
