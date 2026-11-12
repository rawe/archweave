# syntax=docker/dockerfile:1

FROM node:22-alpine AS build
WORKDIR /src
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build:web \
 && npx esbuild src/server/main.ts --bundle --platform=node --format=esm --target=node22 \
      --outfile=dist/server/main.js \
      --banner:js="import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);"

# The server is bundled with its dependencies, so the runtime image needs no node_modules.
FROM node:22-alpine
RUN apk add --no-cache git
WORKDIR /app
COPY --from=build /src/dist ./dist
ARG VERSION=dev
ARG GIT_COMMIT=unknown
ARG BUILD_DATE=unknown
LABEL org.opencontainers.image.title="ArchWeave" \
      org.opencontainers.image.description="A shared visual architecture workspace for developers and coding agents" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.revision="${GIT_COMMIT}" \
      org.opencontainers.image.created="${BUILD_DATE}"
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=4317 \
    ARCHWEAVE_REPO_DIR=/repo \
    ARCHWEAVE_VERSION=${VERSION}
EXPOSE 4317
USER node
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:' + process.env.PORT + '/api/health').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
CMD ["node", "dist/server/main.js"]
