# Use lightweight official Node.js 20 LTS image
FROM node:20-alpine

# Set working directory inside container
WORKDIR /app

# Copy package descriptors
COPY package*.json ./

# Install production dependencies
RUN npm ci --only=production

# Copy application source code
COPY . .

# Create persistent data & recordings directories
RUN mkdir -p data recordings

# Expose default port
EXPOSE 3000

# Environment defaults
ENV PORT=3000
ENV NODE_ENV=production

# Start application
CMD ["npm", "start"]
