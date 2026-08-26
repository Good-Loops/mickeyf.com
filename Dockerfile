# Registry-verified multi-platform digest for the supported Node 22 LTS Alpine
# image. Update the tag and digest together during a reviewed runtime upgrade.
FROM node:22-alpine@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32 AS node-runtime-base

# Artifact Registry identifies Alpine's OpenSSL 3.5.7-r0 package record as
# affected. This patches Alpine's shared libraries; Node's separately embedded
# OpenSSL remains part of each reviewed Node runtime upgrade. Upgrade only the
# installed libraries, verify the result, and discard the repository indexes.
RUN apk update \
    && apk add --no-cache --upgrade \
        libcrypto3=3.5.8-r0 \
        libssl3=3.5.8-r0 \
    && apk info --exists 'libcrypto3=3.5.8-r0' > /dev/null \
    && apk info --exists 'libssl3=3.5.8-r0' > /dev/null \
    && rm -rf /var/cache/apk/*

FROM node-runtime-base AS npm-base

# Match the packageManager contract used to generate the lockfile. This stage
# is not part of the final runtime image.
RUN npm install --global npm@11.6.2 --no-audit --no-fund \
    && test "$(npm --version)" = "11.6.2"


FROM npm-base AS build

WORKDIR /usr/src/app/backend

# Install the exact locked dependency graph, including build tooling.
COPY backend/package.json backend/package-lock.json ./
RUN npm ci

# The allowlisted Docker context excludes local configuration and generated
# output, so only reviewed backend sources enter this stage.
COPY backend/ ./
RUN npm run prod


FROM npm-base AS production-dependencies

ENV NODE_ENV=production
WORKDIR /usr/src/app/backend

# Resolve a clean runtime-only dependency tree rather than copying build tools
# into the production image.
COPY backend/package.json backend/package-lock.json ./
RUN npm ci --omit=dev


FROM node-runtime-base AS runtime

ENV NODE_ENV=production
WORKDIR /usr/src/app/backend

# Package managers and their bundled dependency trees are not needed to run the
# service. Removing them reduces the production image's executable surface.
RUN rm -rf \
    /opt/yarn-v* \
    /usr/local/bin/corepack \
    /usr/local/bin/npm \
    /usr/local/bin/npx \
    /usr/local/bin/yarn \
    /usr/local/bin/yarnpkg \
    /usr/local/lib/node_modules/corepack \
    /usr/local/lib/node_modules/npm

# Keep application files root-owned and read-only to the runtime user.
COPY --from=production-dependencies \
    /usr/src/app/backend/package.json \
    /usr/src/app/backend/package-lock.json \
    ./
COPY --from=production-dependencies \
    /usr/src/app/backend/node_modules \
    ./node_modules
COPY --from=build /usr/src/app/backend/dist ./dist

# The official Node image provides the unprivileged node user (UID/GID 1000).
USER node

EXPOSE 8080

CMD ["node", "dist/server.min.js"]
