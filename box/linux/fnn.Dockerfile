# The hotspot box's own Fiber node: the pinned FNN release, unpatched, the
# same "portable" builds and sha256 as deploy/server/install-fnn.sh. CKB
# testnet. Build context: the repository root.

FROM debian:bookworm-slim
ARG FNN_VERSION=v0.9.1
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl openssl \
 && rm -rf /var/lib/apt/lists/*
RUN set -eu; \
    case "$(uname -m)" in \
      aarch64) arch=aarch64; sha=c52c99b06bd954244b3fb91634d5b5031c23170208e46c7738ee308cb0bd3f0c ;; \
      x86_64)  arch=x86_64;  sha=6425bc90ce971a5b8f10bd93667227cc932ee2e50a70f584e2c07590ce446d0d ;; \
      *) echo "unsupported architecture: $(uname -m)" >&2; exit 1 ;; \
    esac; \
    asset="fnn_${FNN_VERSION}-${arch}-linux-portable.tar.gz"; \
    curl -fsSL -o "/tmp/$asset" "https://github.com/nervosnetwork/fiber/releases/download/${FNN_VERSION}/$asset"; \
    echo "$sha  /tmp/$asset" | sha256sum -c -; \
    mkdir /tmp/fnn && tar -xzf "/tmp/$asset" -C /tmp/fnn; \
    install -m 755 /tmp/fnn/fnn /tmp/fnn/fnn-cli /usr/local/bin/; \
    install -D -m 644 /tmp/fnn/config/testnet/config.yml /opt/fnn/testnet-config.yml; \
    rm -rf /tmp/fnn "/tmp/$asset"; \
    fnn --version
COPY box/linux/fnn-entrypoint.sh /usr/local/bin/fnn-entrypoint.sh
RUN chmod +x /usr/local/bin/fnn-entrypoint.sh
ENTRYPOINT ["/usr/local/bin/fnn-entrypoint.sh"]
