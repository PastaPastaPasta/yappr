FROM node:20-bookworm

RUN apt-get update && apt-get install -y --no-install-recommends \
    git ca-certificates bash jq \
  && rm -rf /var/lib/apt/lists/*

COPY --from=ipfs/kubo:latest /usr/local/bin/ipfs /usr/local/bin/ipfs

WORKDIR /app
COPY entrypoint.sh /app/entrypoint.sh
RUN chmod +x /app/entrypoint.sh

ENV IPFS_PATH=/data/ipfs
ENV WORKDIR=/work
ENTRYPOINT ["/app/entrypoint.sh"]
