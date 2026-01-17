FROM node:20-alpine

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm ci --only=production

# Copy compiled code
COPY dist ./dist

# Expose health check port
EXPOSE 8080

# Run the daemon
CMD ["node", "dist/index.js"]
