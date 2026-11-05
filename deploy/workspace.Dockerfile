# Supply a reviewed Node 22 image pinned to its registry digest.
ARG NODE_IMAGE
FROM ${NODE_IMAGE}
WORKDIR /app
ENV NODE_ENV=production MAGENTIC_WORKBENCH_HOST=0.0.0.0 MAGENTIC_WORKBENCH_PORT=8080 MAGENTIC_WORKSPACES_DIR=/data
RUN mkdir /data && chown node:node /data
COPY --chown=node:node app/ /app/
USER node
EXPOSE 8080
# This checks the HTTP process, not Clerk, model access or workspace readiness.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 CMD ["node", "/app/healthcheck.mjs"]
CMD ["node", "/app/company-main.mjs"]
