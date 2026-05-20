# node:22-bookworm-slim: multi-arch (linux/amd64 + linux/arm64), Node.js 22 LTS
FROM node:22-bookworm-slim

# Atualizar pacotes do sistema para corrigir CVEs do OS base (libgnutls30, etc.)
# Sem isto, Trivy reporta vulnerabilidades corrigíveis no Debian Bookworm
RUN apt-get update \
    && apt-get upgrade -y --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /opt/website
COPY ./website /opt/website

RUN npm install --omit=dev \
    && chown -R node:node /opt/website

# Usuário não-root — node (UID 1000, GID 1000) é built-in da imagem oficial
USER node

CMD ["node", "server.js"]
