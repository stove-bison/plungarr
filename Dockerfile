FROM node:26-alpine@sha256:2d984a15c9b54fd0aeb608b8e0d0d83529eb34d2966db27a1fb4f1edc3d298a3
RUN apk add --no-cache su-exec
WORKDIR /app
COPY janitor.mjs entrypoint.sh ./
RUN chmod 0755 entrypoint.sh && mkdir /state
ENV STATE_FILE=/state/janitor-state.json
# entrypoint.sh chowns /state to PUID:PGID (default 99:100) and drops root.
ENTRYPOINT ["/app/entrypoint.sh"]
