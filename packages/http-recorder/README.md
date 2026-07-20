# @proof/http-recorder

Proxy HTTP local que captura el workload baseline y lo reproduce en orden
contra otra combinacion app/schema. Reverse proxy es el modo recomendado; no
hace MITM TLS.

```ts
const recorder = new Recorder({ targetUrl: baseAppUrl, executionProfile });
const testBaseUrl = await recorder.start();
await runExistingTests({ baseUrl: testBaseUrl });
const rawExchanges = recorder.stop();
const results = await new Replayer({ executionProfile }).replay(
  rawExchanges,
  candidateAppUrl,
);
```

## Privacidad de evidencia

Recorder conserva headers/cuerpos crudos solo en memoria: Replayer necesita
cookies y tokens para una sesion autenticada. Antes de persistir usa
`redactExchangeForEvidence`, `redactReplayResultForEvidence` o
`Recorder.getEvidenceExchanges()`.

La politica default redacta headers de autenticacion/cookies, query params
sensibles, claves JSON de secretos y PII, patrones de tokens/credenciales y
cuerpos binarios opacos. Los helpers devuelven metadata con conteos, nunca los
valores. `redactTextForEvidence()` cubre stderr, logs y output tails.

Una reproduccion posterior autenticada debe recibir secretos de nuevo por un
canal autorizado: el bundle no los conserva.

En `internal`/`fork`, Recorder y Replayer solo apuntan a loopback y forward
proxy esta prohibido para cerrar SSRF. El server limita headers, body y tiempos.
