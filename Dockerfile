FROM node:22-slim

RUN apt-get update && apt-get install -y ffmpeg python3 python3-pip --no-install-recommends && \
    pip3 install yt-dlp --break-system-packages && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY . .

RUN mkdir -p tmp

EXPOSE 3001
CMD ["node", "server.js"]
