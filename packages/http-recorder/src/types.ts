/**
 * Ver tesis, sección 19.3, pasos 4 y 7-8: "Ejecutar baseline tests y
 * capturar requests" / "Reproducir workload" / "Comparar respuestas,
 * errores y efectos SQL".
 */

export interface RecordedRequest {
  method: string;
  path: string;
  headers: Record<string, string>;
  body?: unknown;
}

export interface RecordedResponse {
  status: number;
  body?: unknown;
  /** Errores de base de datos observados durante el request, ej. SQLSTATE. */
  sqlErrors?: string[];
}

export interface RecordedExchange {
  request: RecordedRequest;
  baselineResponse: RecordedResponse;
}

export interface ReplayResult {
  exchange: RecordedExchange;
  candidateResponse: RecordedResponse;
  matches: boolean;
}
