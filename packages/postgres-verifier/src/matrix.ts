/** Estados ejecutados por la matriz completa de release y rollback. */
export type MatrixStateId =
  | "BUILD_A0"
  | "BUILD_A1"
  | "A0_S0"
  | "MIGRATE_S0_TO_S1"
  | "A1_S0"
  | "A0_S1"
  | "COEXIST_A0_A1_S1"
  | "A1_S1"
  | "ROLLBACK_A0_AFTER_A1_WRITES"
  | "SQL_EFFECTS";

export interface MatrixState {
  id: MatrixStateId;
  label: string;
  objective: string;
  required: true;
}

/** Contrato ejecutable: verifyRelease deriva su ledger obligatorio de esta lista. */
export const RELEASE_MATRIX: MatrixState[] = [
  {
    id: "BUILD_A0",
    label: "Build A0",
    objective: "Construir la versión desplegada",
    required: true,
  },
  {
    id: "BUILD_A1",
    label: "Build A1",
    objective: "Construir el candidato",
    required: true,
  },
  {
    id: "A0_S0",
    label: "A0 + S0",
    objective: "Establecer un baseline atribuible",
    required: true,
  },
  {
    id: "MIGRATE_S0_TO_S1",
    label: "S0 → S1",
    objective: "Migrar estado limpio y poblado",
    required: true,
  },
  {
    id: "A1_S0",
    label: "A1 + S0",
    objective: "Validar compatibilidad hacia atrás del candidato",
    required: true,
  },
  {
    id: "A0_S1",
    label: "A0 + S1",
    objective: "Validar compatibilidad de la app desplegada",
    required: true,
  },
  {
    id: "COEXIST_A0_A1_S1",
    label: "A0 + A1 + S1",
    objective: "Ejecutar schedules A0-first y A1-first sobre estados compartidos frescos",
    required: true,
  },
  {
    id: "A1_S1",
    label: "A1 + S1",
    objective: "Validar el estado final del release",
    required: true,
  },
  {
    id: "ROLLBACK_A0_AFTER_A1_WRITES",
    label: "Rollback A0 sobre S1",
    objective: "Arrancar A0 después de escrituras producidas por A1",
    required: true,
  },
  {
    id: "SQL_EFFECTS",
    label: "Efectos SQL",
    objective: "Comparar contadores observables con cortes pre-start, post-readiness y post-workload",
    required: true,
  },
];
