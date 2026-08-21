# Use lightweight official Node.js 20 LTS image
FROM node:20-alpine

# Set working directory inside container
WORKDIR /app

# Copy package descriptors
COPY package*.json ./

# Install production dependencies
RUN npm ci --omit=dev

# Copy application source code
COPY . .

# Create persistent data & recordings directories and set permissions for non-root user
RUN mkdir -p data recordings && \
    addgroup -g 1001 -S nodeapp && \
    adduser -S nodeapp -u 1001 -G nodeapp && \
    chown -R nodeapp:nodeapp /app

# Switch to unprivileged user
USER nodeapp

# Health check
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:3000/ || exit 1

# Expose default port
EXPOSE 3000

# Environment defaults
ENV PORT=3000
ENV NODE_ENV=production

# Start application
CMD ["npm", "start"]
