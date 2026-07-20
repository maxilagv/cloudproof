# Prompt para Codex — Subfase 1.D (`proof reproduce` en vivo)

Correr con Codex parado en la raíz del repo `proof` (`C:\Users\User\OneDrive\Desktop\proof`).

Depende de la Subfase 1.A, que ya está implementada y verificada contra Docker real (`packages/docker-executor` — `ComposeExecutor` funcional, ver su README).

```xml
<task>
Repositorio: monorepo pnpm/Turborepo en la raíz actual. Paquete objetivo:
packages/cli/src/commands/reproduce.ts.

Antes de escribir código, leé en este orden:
1. docs/PHASE_1.md (sección "Subfase 1.D — proof reproduce en vivo")
2. packages/cli/src/commands/reproduce.ts (estado actual: findAssertion()
   ya lee bundles guardados en .proof/*.json y ubica la assertion fallida;
   runReproduce() muestra esa evidencia y después tira Error("no
   implementado") en el punto exacto donde hay que re-ejecutar en vivo)
3. packages/docker-executor/README.md y packages/docker-executor/src/types.ts
   (el DockerExecutor real que ya podés usar: buildImage, startEphemeralPostgres,
   startApp, teardown — está implementado y probado, no es un stub)
4. packages/postgres-verifier/src/verify.ts (para confirmar qué estado
   exacto produce las assertions de hoy: hoy TODAS las assertions de un
   Proof Bundle salen de una única combinación — la imagen A0 (buildeada
   desde subject.baseSha) corriendo contra Postgres S1 (migrado hasta
   subject.headSha). No asumas que hay múltiples combinaciones posibles
   todavía; si eso cambia en el futuro es una extensión, no algo a
   resolver ahora)
5. packages/proof-schema/src/proof-bundle.ts (el contrato de ProofBundle/
   Assertion tal como existe hoy)
6. packages/cli/src/commands/release-verify.ts (cómo se carga
   proof.config.ts con @proof/config para obtener el servicePath, y cómo
   se instancia ComposeExecutor)

Problema concreto a resolver: findAssertion() hoy devuelve solo el objeto
Assertion (id, result, evidence, reproduction) — no alcanza para
reconstruir el estado que la produjo. Te falta el baseSha/headSha del
bundle que contenía esa assertion (está en bundle.subject) y el
servicePath (viene de proof.config.ts vía @proof/config). Decidí cómo
propagar ese contexto: la opción más simple es que findAssertion (o una
función nueva al lado) devuelva también bundle.subject, ya que el
ProofBundleSchema actual ya lo tiene — evaluá si alcanza con eso antes de
tocar el schema. Si concluís que hace falta un campo nuevo en Assertion o
en el Proof Bundle para que esto funcione bien, hacelo ADITIVO (un campo
opcional nuevo, como ya se hizo con RunningContainer.hostConnectionUrl en
docker-executor) — nunca rompas el shape existente sin verificar primero
en el código quién más lo consume (release-verify.ts, check.ts, el
servidor MCP en mcp/serve.ts).

Implementá la re-ejecución en vivo en runReproduce(): usar un
ComposeExecutor (misma forma en que lo instancia release-verify.ts) para
reconstruir exactamente el estado que falló — buildImage con el baseSha,
startEphemeralPostgres en label "S1" con migrationsUpToSha=headSha,
startApp de esa imagen contra ese Postgres — y dejar al usuario con esa
app corriendo y alcanzable, no la tires abajo al final. Esto es
intencional: el comando existe para debuggear, no para volver a probar
algo que ya sabés que falla y descartarlo.

Como NO hacés teardown automático, tenés que resolver cómo el usuario
limpia esos recursos después sin que queden huérfanos silenciosos:
imprimí la URL/connection string de la app y de Postgres, y una forma
clara de tirar todo abajo cuando termine (puede ser un flag nuevo tipo
--cleanup, invocar ComposeExecutor.sweepAll() de docker-executor
explicado en su README, o lo que te parezca más simple — priorizá que no
quede nada corriendo en el olvido).
</task>

<structured_output_contract>
Devolvé al final:
1. cómo resolviste el problema de contexto faltante (tocaste el schema o
   alcanzó con lo que ya expone ProofBundle) y por qué
2. archivos tocados
3. cómo se verificó (comandos corridos, resultado)
4. cómo queda la limpieza de recursos para el usuario (qué comando corre
   y qué garantiza)
5. riesgos residuales o casos no cubiertos
</structured_output_contract>

<default_follow_through_policy>
Default a la interpretación de menor riesgo y seguí adelante sin parar a
preguntar por decisiones de implementación menores. Si para resolver el
problema de contexto faltante hace falta tocar packages/proof-schema,
hacelo vos mismo (es un cambio aditivo, de bajo riesgo) en vez de parar a
preguntar — pero documentalo explícitamente en el output.
</default_follow_through_policy>

<completeness_contract>
Resolvé la subfase completa según el criterio de "terminado" de
docs/PHASE_1.md: "proof reproduce <id> deja al usuario con una app
corriendo localmente contra el schema exacto que falló, lista para
debuggear". Esto incluye: reconstruir el estado, dejarlo corriendo,
imprimir cómo alcanzarlo, Y dar una salida clara para limpiarlo después —
las cuatro partes, no solo levantar la app.
</completeness_contract>

<verification_loop>
Antes de dar por terminado, verificá con Docker real (el mismo patrón de
gating que ya usa packages/docker-executor/tests/integration.test.ts:
PROOF_DOCKER_IT=1, y si tu test tarda por pulls de imágenes usá el mismo
criterio de PROOF_DOCKER_IT_FULL=1 si aplica):
1. Armá un repo git descartable con una migración que rompe la app vieja
   (podés inspirarte en el fixture de docker-executor/tests/integration.test.ts
   o en la demo canónica de la tesis, sección 19.5 — referenciada también
   en docs/PHASE_1.md, Subfase 1.C).
2. Corré el flujo de verify (verifyRelease o runReleaseVerify) contra ese
   repo para obtener un Proof Bundle real con al menos una assertion
   result:"fail", y guardalo en .proof/ como ya hace release-verify.ts.
3. Tomá el id de esa assertion y corré tu runReproduce() actualizado.
4. Confirmá que la app quedó corriendo y responde en la URL impresa
   (fetch real), y que el flujo de limpieza que implementaste efectivamente
   deja Docker en cero residuos para esa corrida (mismo chequeo por label
   que usa docker-executor: "docker ps -aq --filter label=dev.proof.run=<runId>"
   vacío después de limpiar).
Corré también "pnpm --filter @proof/cli typecheck" y confirmá que el
monorepo completo sigue compilando con "pnpm exec turbo run build" desde
la raíz antes de reportar terminado.
</verification_loop>

<action_safety>
Alcance principal: packages/cli/src/commands/reproduce.ts. Podés tocar
packages/proof-schema SOLO si concluiste que hace falta un campo aditivo
nuevo (documentalo en el output, y confirmá que no rompiste a nadie que
ya lo consume). No toques la implementación interna de
packages/docker-executor (Subfase 1.A, ya cerrada y verificada — si
encontrás que le falta algo, reportalo en el output en vez de
modificarlo). No toques packages/http-recorder (Subfase 1.B, de Sol). No
cambies la lógica de packages/postgres-verifier/src/verify.ts salvo un
mismatch real de contrato — en ese caso, avisalo en vez de cambiarlo
silenciosamente.
</action_safety>

<missing_context_gating>
No asumas que van a existir múltiples combinaciones de estado (A0/A1 +
S0/S1) por assertion todavía — hoy solo existe una, confirmalo leyendo
verify.ts antes de diseñar para un caso que no existe. Si necesitás un
dato que no está expuesto en ningún archivo de los listados arriba (por
ejemplo, el servicePath cuando hay más de un servicio en proof.config.ts),
decilo explícitamente en el output en vez de adivinarlo.
</missing_context_gating>
```
