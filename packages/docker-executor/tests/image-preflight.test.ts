import { describe, expect, it } from "vitest";
import { parseDockerfileStages, preflightImageRuntime } from "../src/image-preflight.js";

describe("parseDockerfileStages", () => {
  it("separa etapas, aliases y conserva la línea del FROM para evidencia", () => {
    const stages = parseDockerfileStages(
      [
        "FROM node:20-alpine AS deps",
        "RUN npm ci",
        "FROM deps AS runner",
        "COPY . .",
        "",
      ].join("\n"),
    );

    expect(stages).toHaveLength(2);
    expect(stages[0]).toMatchObject({ base: "node:20-alpine", name: "deps", fromLine: 1 });
    expect(stages[1]).toMatchObject({ base: "deps", name: "runner", fromLine: 3 });
    expect(stages[1]?.instructions).toEqual(["COPY . ."]);
  });

  it("une continuaciones de línea sin perder la numeración", () => {
    const stages = parseDockerfileStages(
      ["FROM node:20-alpine", "RUN apk add --no-cache \\", "    openssl"].join("\n"),
    );
    expect(stages[0]?.instructions).toEqual(["RUN apk add --no-cache      openssl"]);
  });
});

describe("preflightImageRuntime — Prisma + OpenSSL (informe Lubrisur)", () => {
  const ALPINE_NO_OPENSSL = ["FROM node:20-alpine", 'CMD ["node", "server.js"]'].join("\n");

  it("marca HIGH cuando la base final es Alpine y nadie instala OpenSSL", () => {
    const findings = preflightImageRuntime({
      dockerfileContents: ALPINE_NO_OPENSSL,
      usesPrisma: true,
    });
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ rule: "prisma-openssl-alpine", severity: "HIGH" });
    expect(findings[0]?.message).toContain("apk add --no-cache openssl");
    expect(findings[0]?.evidence[0]).toContain("FROM node:20-alpine (línea 1");
  });

  it("sin Prisma no hay requisito y no hay finding", () => {
    expect(
      preflightImageRuntime({ dockerfileContents: ALPINE_NO_OPENSSL, usesPrisma: false }),
    ).toEqual([]);
  });

  it("un apk add openssl en la etapa final lo satisface", () => {
    const findings = preflightImageRuntime({
      dockerfileContents: [
        "FROM node:20-alpine",
        "RUN apk add --no-cache openssl",
        'CMD ["node", "server.js"]',
      ].join("\n"),
      usesPrisma: true,
    });
    expect(findings).toEqual([]);
  });

  it("multi-stage: instalar OpenSSL solo en una etapa builder NO cuenta", () => {
    const findings = preflightImageRuntime({
      dockerfileContents: [
        "FROM node:20-alpine AS builder",
        "RUN apk add --no-cache openssl python3 make g++",
        "RUN npm ci && npm run build",
        "FROM node:20-alpine",
        "COPY --from=builder /app/dist ./dist",
        'CMD ["node", "dist/server.js"]',
      ].join("\n"),
      usesPrisma: true,
    });
    expect(findings).toHaveLength(1);
    expect(findings[0]?.rule).toBe("prisma-openssl-alpine");
  });

  it("multi-stage: la etapa final hereda lo instalado por sus ancestros por alias", () => {
    const findings = preflightImageRuntime({
      dockerfileContents: [
        "FROM node:20-alpine AS base",
        "RUN apk add --no-cache openssl",
        "FROM base AS runner",
        'CMD ["node", "server.js"]',
      ].join("\n"),
      usesPrisma: true,
    });
    expect(findings).toEqual([]);
  });

  it("Debian slim sin libssl también falla, con la receta apt-get", () => {
    const findings = preflightImageRuntime({
      dockerfileContents: ["FROM node:20-slim", 'CMD ["node", "server.js"]'].join("\n"),
      usesPrisma: true,
    });
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ rule: "prisma-openssl-debian-slim", severity: "HIGH" });
    expect(findings[0]?.message).toContain("apt-get install");
  });

  it("Debian completo (bookworm) ya trae OpenSSL: sin findings", () => {
    expect(
      preflightImageRuntime({
        dockerfileContents: ["FROM node:20-bookworm", 'CMD ["node", "server.js"]'].join("\n"),
        usesPrisma: true,
      }),
    ).toEqual([]);
  });
});
