# Linux check: follow the README's "Try it in two minutes" from a fresh clone on Ubuntu 24.04 (x86_64, the platform
# Agave publishes Linux binaries for). Everything is fetched from official sources.
#   git bundle create docker/guardrail.bundle --all && docker build --platform linux/amd64 -t guardrail-linux docker && docker run --rm guardrail-linux
FROM --platform=linux/amd64 ubuntu:24.04
RUN apt-get update && apt-get install -y --no-install-recommends \
      curl ca-certificates git build-essential pkg-config libssl-dev libudev-dev bzip2 xz-utils python3 perl procps \
    && rm -rf /var/lib/apt/lists/*
# Rust (rustup, official)
RUN curl -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal --default-toolchain stable
ENV PATH=/root/.cargo/bin:$PATH
# Solana CLI 4.2.2 (Agave release, official GitHub)
RUN curl -sSfL https://github.com/anza-xyz/agave/releases/download/v4.2.2/solana-release-x86_64-unknown-linux-gnu.tar.bz2 | tar -xj -C /opt
ENV PATH=/opt/solana-release/bin:$PATH
# platform-tools v1.54 (Anza release, official GitHub)
RUN mkdir -p /root/.cache/solana/v1.54/platform-tools \
    && curl -sSfL https://github.com/anza-xyz/platform-tools/releases/download/v1.54/platform-tools-linux-x86_64.tar.bz2 \
       | tar -xj -C /root/.cache/solana/v1.54/platform-tools
# Node 22 (nodejs.org, official)
RUN curl -sSfL https://nodejs.org/dist/v22.12.0/node-v22.12.0-linux-x64.tar.xz | tar -xJ -C /opt \
    && ln -s /opt/node-v22.12.0-linux-x64/bin/* /usr/local/bin/
WORKDIR /work
COPY guardrail.bundle /work/guardrail.bundle
RUN git clone -q /work/guardrail.bundle guardrail
WORKDIR /work/guardrail
CMD ["bash", "scripts/linux-try-it.sh"]
