FROM node:lts

WORKDIR /opt/website
COPY ./website /opt/website

RUN npm install --omit=dev

CMD ["node", "server.js"]
