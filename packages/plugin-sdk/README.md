# @proof/plugin-sdk

Interfaz mínima para plugins. En el MVP (Fase 1-2), solo se define `Detector` — la capacidad que usan `proof init` y `proof doctor` para reconocer el stack del repositorio.

## Alcance deliberadamente mínimo

La API completa de plugins (fixtures, mocks, analizadores, targets de ejecución — tesis, sección 5.2) no se define todavía. Diseñar esa superficie sin haber escrito un plugin real primero es el tipo de abstracción prematura que el propio documento de tesis advierte evitar (sección 17.1). Se amplía cuando el primer plugin real (`plugins/postgres`) necesite una capacidad que `Detector` no cubre.
