ARG DENO_VERSION=2.5.6

FROM denoland/deno:${DENO_VERSION}

ARG TARGETARCH
ARG GITLEAKS_VERSION=8.30.1
ARG TRIVY_VERSION=0.70.0

USER root

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates \
    coreutils \
    curl \
    git \
    gzip \
    tar \
  && rm -rf /var/lib/apt/lists/*

RUN set -eux; \
  arch="${TARGETARCH:-amd64}"; \
  case "$arch" in \
    amd64) gitleaks_arch="x64"; trivy_arch="64bit" ;; \
    arm64) gitleaks_arch="arm64"; trivy_arch="ARM64" ;; \
    *) echo "Unsupported TARGETARCH: $arch" >&2; exit 1 ;; \
  esac; \
  work_dir="$(mktemp -d)"; \
  cd "$work_dir"; \
  gitleaks_asset="gitleaks_${GITLEAKS_VERSION}_linux_${gitleaks_arch}.tar.gz"; \
  curl -fsSLO "https://github.com/gitleaks/gitleaks/releases/download/v${GITLEAKS_VERSION}/${gitleaks_asset}"; \
  curl -fsSLO "https://github.com/gitleaks/gitleaks/releases/download/v${GITLEAKS_VERSION}/gitleaks_${GITLEAKS_VERSION}_checksums.txt"; \
  grep " ${gitleaks_asset}$" "gitleaks_${GITLEAKS_VERSION}_checksums.txt" | sha256sum -c -; \
  tar -xzf "$gitleaks_asset"; \
  install -m 0755 gitleaks /usr/local/bin/gitleaks; \
  trivy_asset="trivy_${TRIVY_VERSION}_Linux-${trivy_arch}.tar.gz"; \
  curl -fsSLO "https://github.com/aquasecurity/trivy/releases/download/v${TRIVY_VERSION}/${trivy_asset}"; \
  curl -fsSLO "https://github.com/aquasecurity/trivy/releases/download/v${TRIVY_VERSION}/trivy_${TRIVY_VERSION}_checksums.txt"; \
  grep " ${trivy_asset}$" "trivy_${TRIVY_VERSION}_checksums.txt" | sha256sum -c -; \
  tar -xzf "$trivy_asset"; \
  install -m 0755 trivy /usr/local/bin/trivy; \
  cd /; \
  rm -rf "$work_dir"; \
  gitleaks version; \
  trivy --version

WORKDIR /app

COPY deno.json README.md ./
COPY src/ ./src/

RUN deno cache src/cli.ts

RUN mkdir -p /workspace/reports /workspace/.repo-sentry \
  && chown -R deno:deno /workspace /app

ENV DENO_DIR=/workspace/.repo-sentry/deno-cache
ENV TRIVY_CACHE_DIR=/workspace/.repo-sentry/trivy-cache

WORKDIR /workspace
USER deno

ENTRYPOINT ["deno", "run", "--allow-read=/app,/workspace", "--allow-write=/workspace/reports,/workspace/.repo-sentry", "--allow-env=GITHUB_TOKEN,SLACK_WEBHOOK_URL,OPENAI_API_KEY,OPENAI_MODEL,CLEARWING_PROVIDER,DENO_DIR,TRIVY_CACHE_DIR,OLLAMA_HOST,OLLAMA_MODEL", "--allow-net=api.github.com,api.openai.com,host.docker.internal", "--allow-run=gitleaks,trivy", "/app/src/cli.ts"]

CMD ["--help"]
