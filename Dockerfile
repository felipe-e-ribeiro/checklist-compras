# node:22-bookworm-slim: multi-arch (linux/amd64 + linux/arm64), Node.js 22 LTS
# Debian Bookworm slim — menor superfície de ataque que a versão full
FROM node:22-bookworm-slim

WORKDIR /opt/website
COPY ./website /opt/website

RUN npm install --omit=dev \
    # Garantir que todos os arquivos pertencem ao usuário node (UID 1000)
    && chown -R node:node /opt/website

# Usuário não-root — node (UID 1000, GID 1000) é built-in da imagem oficial
USER node

CMD ["node", "server.js"]
