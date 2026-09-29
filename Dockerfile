# openpayroll web app: shadow comparison against QuickBooks, journal export to Bigcapital.
# Zero runtime dependencies; TypeScript is only needed in the build stage.

FROM node:22-alpine AS build
WORKDIR /src
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci
COPY src ./src
COPY test ./test
COPY rules ./rules
# Build and run the test suite; the image is not produced if a test fails.
RUN npm test

FROM node:22-alpine
ENV NODE_ENV=production \
    DATA_DIR=/data \
    RULES_DIR=/app/rules \
    PORT=8100 \
    HOST=0.0.0.0
WORKDIR /app
COPY package.json ./
COPY --from=build /src/dist/src ./dist/src
COPY rules ./rules
# A new named volume inherits this ownership, so the non-root user can write to it.
RUN mkdir -p /data/statements && chown -R node:node /data
USER node
VOLUME ["/data"]
EXPOSE 8100
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8100/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/src/server.js"]
