# The Obsidian Connect server. CI builds and publishes it from main (see the
# docker job in .github/workflows/build.yml); by hand, from the repository root:
#
#   docker build -t obsidian-connect-server .
#   docker exec <container> obsidian-connect invite
FROM node:24-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
# Every workspace's manifest, or npm ci refuses the lockfile.
COPY packages/shared/package.json packages/shared/
COPY packages/server/package.json packages/server/
COPY packages/plugin/package.json packages/plugin/
RUN npm ci --omit=dev --workspace @obsidian-connect/server

FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=1234 \
    OBSIDIAN_CONNECT_DATA_DIR=/data
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/shared/src packages/shared/src
COPY packages/server/package.json packages/server/
COPY packages/server/src packages/server/src
COPY packages/server/bin packages/server/bin
RUN chmod +x packages/server/bin/obsidian-connect.mjs \
 && ln -s /app/packages/server/bin/obsidian-connect.mjs /usr/local/bin/obsidian-connect \
 && mkdir -p /data \
 && chown node:node /data
USER node
VOLUME /data
EXPOSE 1234
CMD ["node", "--import", "tsx", "packages/server/src/index.ts"]
