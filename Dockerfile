FROM node:20-alpine

WORKDIR /app

# Copy server package.json and install dependencies
COPY server/package.json ./
RUN npm ci --production 2>/dev/null || npm install --production

# Copy server source
COPY server/ ./

EXPOSE 8080 3000 5000

CMD ["node", "index.js"]
