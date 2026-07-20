# @proof/plugin-postgres

Detector de PostgreSQL para `proof init`/`proof doctor`: busca referencias a Postgres en `docker-compose.yml` y `.env`. El adaptador de ejecución real (spin-up de Postgres efímero) vive en `@proof/docker-executor`, no acá — este paquete es solo detección.
