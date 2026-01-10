FROM node:22-alpine

WORKDIR /app

COPY package.json ./
RUN npm install --production

COPY relay.js ./

# Key path configured via environment variable
ENV KEY_PATH=/app/data/relay-key.bin

EXPOSE 8080 9000

CMD ["node", "relay.js"]
