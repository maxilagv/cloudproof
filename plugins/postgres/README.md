# @cloudproof/plugin-postgres

Detector de PostgreSQL para `cloudproof init`/`cloudproof doctor`: busca referencias a Postgres en `docker-compose.yml` y `.env`. El adaptador de ejecución real (spin-up de Postgres efímero) vive en `@cloudproof/docker-executor`, no acá — este paquete es solo detección.
