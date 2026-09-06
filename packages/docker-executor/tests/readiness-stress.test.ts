import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { SpawnRunner, waitPostgresTcpReady } from "../dist/index.js";

/**
 * Criterio P0 del informe 2026-07-18: cero fallos intermitentes de arranque.
 * Repite N ciclos completos de run → readiness TCP → WRITE SQL inmediato →
 * rm. El write inmediato es la prueba definitiva: con pg_isready, era
 * exactamente lo que fallaba de forma intermitente ("FATAL: the database
 * system is shutting down" justo después de un pg_isready OK).
 *
 * Ninguna iteración tiene reintentos del lado del test: un solo fallo de
 * arranque es un fallo del suite.
 *
 * Gates: CLOUDPROOF_DOCKER_IT=1 y CLOUDPROOF_DOCKER_IT_STRESS=1.
 * CLOUDPROOF_STRESS_BOOTS (default 20) controla las iteraciones; el workflow
 * nightly lo sube. CLOUDPROOF_PG_IMAGE permite ejercer otras versiones
 * (postgres:14-alpine … postgres:17-alpine).
 */
const enabled =
  process.env["CLOUDPROOF_DOCKER_IT"] === "1" && process.env["CLOUDPROOF_DOCKER_IT_STRESS"] === "1";
const BOOTS = Number(process.env["CLOUDPROOF_STRESS_BOOTS"] ?? "20");
const IMAGE = process.env["CLOUDPROOF_PG_IMAGE"] ?? "postgres:16-alpine";

describe.skipIf(!enabled)(`estrés de readiness de Postgres (${IMAGE})`, () => {
  const runner = new SpawnRunner();

  it(
    `${BOOTS} arranques consecutivos confirman readiness y aceptan un write inmediato`,
    async () => {
      for (let boot = 0; boot < BOOTS; boot += 1) {
        const name = `cloudproof-readiness-stress-${randomUUID().slice(0, 8)}`;
        const started = await runner.run(
          "docker",
          [
            "run",
            "--rm",
            "-d",
            "--name",
            name,
            "-e",
            "POSTGRES_USER=cloudproof",
            "-e",
            "POSTGRES_PASSWORD=cloudproof",
            "-e",
            "POSTGRES_DB=cloudproof",
            IMAGE,
          ],
          { timeoutMs: 120_000 },
        );
        expect(started.exitCode, `boot ${boot}: ${started.stderr}`).toBe(0);
        const id = started.stdout.trim();
        try {
          await waitPostgresTcpReady(runner, id, {
            label: `stress-boot-${boot}`,
            timeoutMs: 60_000,
          });
          const write = await runner.run("docker", [
            "exec",
            "-e",
            "PGPASSWORD=cloudproof",
            id,
            "psql",
            "-X",
            "-v",
            "ON_ERROR_STOP=1",
            "-h",
            "127.0.0.1",
            "-U",
            "cloudproof",
            "-d",
            "cloudproof",
            "-c",
            "CREATE TABLE stress_probe(id int); INSERT INTO stress_probe VALUES (1);",
          ]);
          expect(write.exitCode, `boot ${boot}: ${write.stderr}`).toBe(0);
        } finally {
          await runner.run("docker", ["rm", "-f", id]);
        }
      }
    },
    Math.max(600_000, BOOTS * 45_000),
  );
});
