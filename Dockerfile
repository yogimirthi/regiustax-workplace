FROM node:20-bookworm-slim

RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./

RUN npm install --omit=dev --build-from-source

COPY . .

RUN mkdir -p /data/uploads

ENV NODE_ENV=production
ENV PORT=3000
ENV DATA_DIR=/data
ENV UPLOADS_DIR=/data/uploads

EXPOSE 3000

CMD ["node", "server.js"]
