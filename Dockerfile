FROM node:22-alpine@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32
RUN apk add --no-cache su-exec
WORKDIR /app
COPY janitor.mjs entrypoint.sh ./
RUN chmod 0755 entrypoint.sh && mkdir /state
ENV STATE_FILE=/state/janitor-state.json
# entrypoint.sh chowns /state to PUID:PGID (default 99:100) and drops root.
ENTRYPOINT ["/app/entrypoint.sh"]
