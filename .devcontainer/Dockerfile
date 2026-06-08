FROM node:22-bullseye

RUN apt-get update && apt-get install -y \
    git curl ca-certificates openssl \
    default-mysql-client \
  && rm -rf /var/lib/apt/lists/*

RUN curl -Lo /usr/local/bin/cloud-sql-proxy \
      https://storage.googleapis.com/cloud-sql-connectors/cloud-sql-proxy/v2.11.4/cloud-sql-proxy.linux.amd64 \
  && chmod +x /usr/local/bin/cloud-sql-proxy

WORKDIR /workspaces/mickeyf.com
