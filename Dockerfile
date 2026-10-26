FROM rust:1.98-bookworm AS rust-build
WORKDIR /app
COPY rust-core ./rust-core
RUN cargo build --release --locked --jobs 2 --manifest-path rust-core/Cargo.toml

FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
COPY --from=rust-build /app/rust-core/target/release/mnemo-core ./bin/mnemo-core
RUN node scripts/build_rust.mjs --if-missing && npx tsc --noEmit && npx vite build

FROM python:3.12-slim-bookworm AS python-deps
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /resolver
COPY integrations/p115_resolver/requirements* ./
RUN python -m venv /opt/mnemo-p115 \
    && /opt/mnemo-p115/bin/python -m pip install --no-cache-dir --require-hashes --only-binary=:all: -r requirements-build.lock \
    && /opt/mnemo-p115/bin/python -m pip install --no-cache-dir --require-hashes --only-binary=:all: -r requirements.lock \
    && /opt/mnemo-p115/bin/python -m pip install --no-cache-dir --no-deps --no-build-isolation -r requirements.in

FROM python:3.12-slim-bookworm
RUN apt-get update && apt-get install -y --no-install-recommends libstdc++6 && rm -rf /var/lib/apt/lists/* \
    && groupadd --gid 1000 node && useradd --uid 1000 --gid node --create-home node
WORKDIR /app
ENV NODE_ENV=production HOST=0.0.0.0 PORT=4180 MNEMO_DATA_DIR=/data MNEMO_DOWNLOAD_DIR=/downloads MNEMO_PYTHON=/opt/mnemo-p115/bin/python
COPY --from=build /usr/local/bin/node /usr/local/bin/node
COPY --from=python-deps /opt/mnemo-p115 /opt/mnemo-p115
COPY --from=build /app/package*.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/server ./server
COPY --from=build /app/shared ./shared
COPY --from=rust-build /app/rust-core/target/release/mnemo-core ./bin/mnemo-core
COPY integrations/p115_resolver ./integrations/p115_resolver
RUN mkdir /data /downloads && chown node:node /data /downloads
USER node
VOLUME ["/data", "/downloads"]
EXPOSE 4180
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://127.0.0.1:4180/api/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node", "--import", "tsx", "server/index.ts"]
