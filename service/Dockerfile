FROM node:24.19.0-bookworm-slim AS dependencies
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts

FROM dependencies AS test
COPY tsconfig.json eslint.config.js ./
COPY src ./src
COPY test ./test
RUN npm run build && chown -R node:node /app
USER node
CMD ["npm", "test"]

FROM test AS build
USER root
RUN npm prune --omit=dev --ignore-scripts

FROM node:24.19.0-bookworm-slim AS runtime
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000
WORKDIR /app
COPY --from=build --chown=node:node /app/package.json ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist/src ./dist/src
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 CMD ["node", "-e", "fetch('http://127.0.0.1:' + (process.env.PORT || '3000') + '/healthz').then(r => { if (!r.ok) process.exit(1); }).catch(() => process.exit(1))"]
CMD ["node", "dist/src/main.js"]
