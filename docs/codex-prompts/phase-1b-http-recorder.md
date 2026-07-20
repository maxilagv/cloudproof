# Prompt para Codex — Subfase 1.B (motor de captura/replay HTTP)

Correr con Codex parado en la raíz del repo `proof` (`C:\Users\User\OneDrive\Desktop\proof`).

```xml
<task>
Repositorio: monorepo pnpm/Turborepo en la raíz actual. Paquete objetivo: packages/http-recorder.

Antes de escribir código, leé en este orden:
1. docs/ARCHITECTURE.md
2. docs/PHASE_1.md (sección "Subfase 1.B — Motor de captura y replay HTTP")
3. packages/http-recorder/README.md
4. packages/http-recorder/src/types.ts (contrato de tipos, ya definido, no modificar)
5. packages/http-recorder/src/normalizers.ts (ya implementado y correcto, no modificar salvo bug real)
6. packages/postgres-verifier/src/verify.ts (cómo se consumen Recorder y Replayer en el flujo end-to-end)

Implementá Recorder (packages/http-recorder/src/recorder.ts) y Replayer
(packages/http-recorder/src/replayer.ts), hoy ambos son stubs que tiran
Error("no implementado").

Recorder.start()/stop() debe capturar los requests/responses que genera la
suite de tests existente del usuario corriendo contra la app base (A0+S0).
No hay que capturar tráfico de producción — eso es fuera de alcance
(ver docs/PHASE_1.md). Es MVP genérico: tiene que funcionar contra
cualquier repo de usuario con cualquier test runner, no asumas un
framework de testing específico.

Replayer.replay() debe tomar los RecordedExchange ya capturados y
reproducirlos contra una URL base de la app candidata, devolviendo
ReplayResult[] usando compareExchange() (ya implementado, reusalo, no
lo reimplementes).

Decisión de diseño que tenés que tomar y documentar: mecanismo de
captura — proxy HTTP local que intercepta las llamadas de la suite de
tests, vs. instrumentación directa del test runner. Elegí uno,
documentá el porqué en un comentario al tope de recorder.ts y en
packages/http-recorder/README.md (agregar sección, no reescribir el
archivo entero).
</task>

<structured_output_contract>
Devolvé al final:
1. decisión de diseño tomada (mecanismo de captura) y por qué
2. archivos tocados
3. cómo se verificó (comandos corridos, resultado)
4. riesgos residuales o casos no cubiertos
</structured_output_contract>

<default_follow_through_policy>
Default a la interpretación de menor riesgo y seguí adelante sin parar a
preguntar por decisiones de implementación menores. Sí parar y preguntar
si hace falta elegir una dependencia externa nueva (paquete npm) que no
esté ya en package.json de algún paquete del monorepo.
</default_follow_through_policy>

<completeness_contract>
Resolvé la subfase completa, no solo un happy path parcial. Los criterios
de "terminado" están en docs/PHASE_1.md bajo Subfase 1.B: grabar los
requests de una suite de tests real contra una app de prueba, y
reproducirlos contra la misma app sin cambios, con matches:true en el
100% de los casos. Incluí también manejo de timeout/error de red al
reproducir contra una app candidata que no levanta — eso es en sí mismo
un finding (matches:false con evidencia), no una excepción sin controlar.
</completeness_contract>

<verification_loop>
Antes de dar por terminado: escribí y corré un test (vitest, el runner ya
configurado en package.json de este paquete) que arme una app HTTP mínima
de prueba, grabe requests contra ella con Recorder, y los reproduzca con
Replayer contra la misma app sin cambios — confirmá matches:true en el
100% de los casos. Agregá un segundo test donde la respuesta candidata
difiere (ej. un campo distinto) y confirmá matches:false. Corré
"pnpm --filter @proof/http-recorder typecheck" y
"pnpm --filter @proof/http-recorder test" y confirmá que ambos pasan
antes de reportar terminado.
</verification_loop>

<action_safety>
Alcance: solo packages/http-recorder. No toques packages/docker-executor
(es la Subfase 1.A, la está trabajando otra persona en paralelo), no
toques packages/postgres-verifier/src/verify.ts salvo que descubras un
mismatch real de tipos con lo que ya expone types.ts (en ese caso,
avisalo en el output en vez de cambiarlo silenciosamente), y no toques
packages/proof-schema. No agregues dependencias de orquestación Docker
ni nada que se superponga con la Subfase 1.A.
</action_safety>

<missing_context_gating>
No asumas un framework de testing específico del usuario final (Jest,
Vitest, etc. del repo que use Proof) — el mecanismo de captura tiene que
ser agnóstico a eso. Si para la decisión de diseño hace falta información
que no está en los documentos listados arriba, decilo explícitamente en
vez de asumirla.
</missing_context_gating>
```
