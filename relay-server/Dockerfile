FROM node:22-alpine

WORKDIR /app

COPY package.json ./
RUN npm install --production

COPY relay.js ./

# Persist the identity key via volume
VOLUME /app/data
ENV KEY_PATH=/app/data/relay-key.bin

EXPOSE 8080 9000

CMD ["node", "relay.js"]
