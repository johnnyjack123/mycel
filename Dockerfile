# The Mycel server. CI builds and publishes it from main (see the
# docker job in .github/workflows/build.yml); by hand, from the repository root:
#
#   docker build -t mycel-server .
#   docker exec <container> mycel invite
FROM node:24-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
# Every workspace's manifest, or npm ci refuses the lockfile.
COPY packages/shared/package.json packages/shared/
COPY packages/server/package.json packages/server/
COPY packages/plugin/package.json packages/plugin/
COPY packages/backup/package.json packages/backup/
RUN npm ci --omit=dev --workspace @mycel/server

FROM node:24-alpine
WORKDIR /app
# su-exec: the entrypoint hands /data to the server's user, then runs it as that user.
RUN apk add --no-cache su-exec
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=1234 \
    MYCEL_DATA_DIR=/data \
    MYCEL_OWN=/data
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/shared/src packages/shared/src
COPY packages/server/package.json packages/server/
COPY packages/server/src packages/server/src
COPY packages/server/bin packages/server/bin
COPY docker/entrypoint.sh /usr/local/bin/mycel-entrypoint
RUN chmod +x packages/server/bin/mycel.mjs /usr/local/bin/mycel-entrypoint \
 && ln -s /app/packages/server/bin/mycel.mjs /usr/local/bin/mycel \
 && mkdir -p /data \
 && chown node:node /data
# No USER: the entrypoint starts as root, hands the folder over and drops to
# PUID:PGID (1000:1000, the image's node user) before the server runs.
VOLUME /data
EXPOSE 1234
ENTRYPOINT ["/usr/local/bin/mycel-entrypoint"]
CMD ["node", "--import", "tsx", "packages/server/src/index.ts"]
