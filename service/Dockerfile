FROM node:24.19.0-bookworm-slim AS dependencies
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts

FROM dependencies AS test
RUN apt-get update \
    && apt-get install --yes --no-install-recommends openssl \
    && rm -rf /var/lib/apt/lists/*
COPY tsconfig.json eslint.config.js ./
COPY Dockerfile ./Dockerfile
COPY runtime ./runtime
COPY src ./src
COPY test ./test
RUN npm run build && chown -R node:node /app
USER node
CMD ["npm", "test"]

FROM test AS build
USER root
RUN npm prune --omit=dev --ignore-scripts

FROM node:24.19.0-bookworm-slim AS runtime
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    ODK_VALIDATE_JAVA_EXECUTABLE=/usr/bin/java \
    ODK_VALIDATE_JAR_PATH=/opt/kusanya/ODK-Validate-v1.20.0.jar
WORKDIR /app
RUN apt-get update \
    && apt-get install --yes --no-install-recommends openjdk-17-jre-headless \
    && rm -rf /var/lib/apt/lists/* \
    && install -d -m 0755 /opt/kusanya /usr/share/doc/kusanya
ADD --checksum=sha256:92756ea4aed195355a07e5572f025f0921a31282387a870ae63e1f5cdf37e0c3 https://github.com/getodk/validate/releases/download/v1.20.0/ODK-Validate-v1.20.0.jar /opt/kusanya/ODK-Validate-v1.20.0.jar
COPY runtime/odk-validate-smoke.xml /tmp/odk-validate-smoke.xml
COPY runtime/ODK-Validate-v1.20.0-NOTICES.md /usr/share/doc/kusanya/ODK-Validate-v1.20.0-NOTICES.md
RUN /usr/bin/java -Xmx256m -Djava.awt.headless=true \
      -jar /opt/kusanya/ODK-Validate-v1.20.0.jar \
      /tmp/odk-validate-smoke.xml >/dev/null 2>&1 \
    && rm -f /tmp/odk-validate-smoke.xml \
    && chown root:root /opt/kusanya/ODK-Validate-v1.20.0.jar \
      /usr/share/doc/kusanya/ODK-Validate-v1.20.0-NOTICES.md \
    && chmod 0444 /opt/kusanya/ODK-Validate-v1.20.0.jar \
      /usr/share/doc/kusanya/ODK-Validate-v1.20.0-NOTICES.md
COPY --from=build --chown=node:node /app/package.json ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist/src ./dist/src
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 CMD ["node", "-e", "fetch('http://127.0.0.1:' + (process.env.PORT || '3000') + '/healthz').then(r => { if (!r.ok) process.exit(1); }).catch(() => process.exit(1))"]
CMD ["node", "dist/src/main.js"]
