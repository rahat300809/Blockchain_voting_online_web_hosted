# Dockerfile — BlockVote Server (Node.js Cloud Edition)
# Deploys the blockchain voting system backend to any container platform
# (Fly.io, Railway, Render, Google Cloud Run, etc.)

FROM node:20-alpine

# Install system deps
RUN apk add --no-cache \
    dumb-init \
    curl

WORKDIR /app

# Copy package files and install dependencies
COPY api-server/package*.json ./
RUN npm ci --only=production && npm cache clean --force

# Copy application code
COPY api-server/server.js         ./server.js
COPY api-server/blockchain-core.js ./blockchain-core.js
COPY api-server/firebase-sync.js  ./firebase-sync.js
COPY core.cpp                     ./core.cpp

# Copy website for static serving
COPY website/ /website/

# Create persistent data directory (mount a volume here in production)
RUN mkdir -p /data && chown node:node /data

# Run as non-root user for security
USER node

# Environment
ENV NODE_ENV=production \
    PORT=3000 \
    DATA_DIR=/data

EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=15s --retries=3 \
    CMD curl -f http://localhost:3000/api/health || exit 1

# Use dumb-init to handle signals properly
ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "server.js"]
