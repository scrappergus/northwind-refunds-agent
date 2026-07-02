FROM node:20-bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl git \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /workspace
EXPOSE 3000

CMD ["tail", "-f", "/dev/null"]
