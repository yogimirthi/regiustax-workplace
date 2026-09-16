FROM node:20-slim

# Install sqlite3 build tools if needed
RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy dependency files
COPY package*.json ./

# Install production dependencies
RUN npm install --omit=dev

# Copy application files
COPY . .

# Create persistent storage directories
RUN mkdir -p /data/uploads

# Environment configuration
ENV NODE_ENV=production
ENV PORT=3000
ENV DATA_DIR=/data
ENV UPLOADS_DIR=/data/uploads

EXPOSE 3000

# Start production server
CMD ["node", "server.js"]
