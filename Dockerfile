FROM node:22-alpine@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32
WORKDIR /app
COPY janitor.mjs .
RUN mkdir /state && chown node:node /state
USER node
ENV STATE_FILE=/state/janitor-state.json
CMD ["node", "janitor.mjs"]
