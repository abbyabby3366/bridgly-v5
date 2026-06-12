FROM node:20-alpine

WORKDIR /app

# Copy package files and install dependencies
COPY package.json package-lock.json ./
RUN npm ci --production

# Copy server code and public assets
COPY bridgly-sms-server/ ./bridgly-sms-server/

# Render injects PORT as an environment variable
ENV PORT=8932
EXPOSE 8932

CMD ["node", "bridgly-sms-server/server.js"]
