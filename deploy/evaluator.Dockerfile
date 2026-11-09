# Supply a scanned, digest-pinned Node 22 base image before building.
ARG NODE_IMAGE
FROM ${NODE_IMAGE}
WORKDIR /app
RUN mkdir -p /opt/ml/processing/input /opt/ml/processing/output && chown -R node:node /opt/ml/processing
COPY --chown=node:node runner.mjs /app/runner.mjs
USER node
ENTRYPOINT ["node", "/app/runner.mjs"]
