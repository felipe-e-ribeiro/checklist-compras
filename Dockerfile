ARG ARCH=
FROM ${ARCH}node:lts-alpine3.19

ENV DB_CLIENT=$DB_CLIENT
ENV DB_HOST=$DB_HOST
ENV DB_USER=$DB_USER
ENV DB_PASSWORD=$DB_PASSWORD
ENV DB_NAME=$DB_NAME

WORKDIR /opt/website
COPY ./website /opt/website

RUN npm install
CMD node server.js