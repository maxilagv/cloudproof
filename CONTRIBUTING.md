# Contribuir a Proof

Gracias por el interés. Este proyecto está en etapa temprana (Fase 1-2 del roadmap) — todavía no hay una release pública ni un proceso de RFC formal activo.

## Antes de abrir un PR

1. Confirmá que el cambio corresponde a Fase 1 o Fase 2 del roadmap (CLI local + integración GitHub + MCP). Cambios de fases posteriores (Project Graph, previews, observabilidad, incident memory) se documentan como propuesta en un issue antes de implementarse.
2. Los comandos núcleo (`release verify`, `check`) son deterministas — ninguna contribución debe introducir una dependencia de un modelo de lenguaje en el camino que produce un resultado `VERIFIED | UNSAFE | INCONCLUSIVE`.
3. Todo hallazgo bloqueante debe ser reproducible localmente vía `proof reproduce <id>`.

## Proceso de RFC

Para cambios de diseño no triviales, usar la plantilla de RFC del documento de tesis (Apéndice C) antes de implementar.

## Licencia

Proof no es software libre ni de código abierto: se distribuye bajo la
Proof Restricted Use License (ver [LICENSE](./LICENSE)), que limita el uso
a Proof como producto terminado y prohíbe redistribución, obras derivadas
y uso competitivo del código o la documentación.

Al enviar una contribución (PR, patch, issue con código), aceptás que:

1. Cedés al Licenciante, a título gratuito, todos los derechos de
   propiedad intelectual sobre tu contribución, incluyendo el derecho a
   incorporarla al Software y a licenciarla bajo los mismos términos
   restrictivos que el resto del proyecto.
2. Declarás que tenés el derecho de ceder dicha contribución (por
   ejemplo, que no viola un acuerdo de confidencialidad o propiedad
   intelectual con un tercero).
3. Entendés que el Licenciante puede rechazar, modificar o no publicar tu
   contribución a su sola discreción.

Si no estás de acuerdo con estos términos, no envíes contribuciones al
repositorio.
