FROM node:22-slim

RUN apt-get update && apt-get install -y ffmpeg python3 python3-venv --no-install-recommends && \
    python3 -m venv /opt/venv && \
    /opt/venv/bin/pip install yt-dlp && \
    ln -s /opt/venv/bin/yt-dlp /usr/local/bin/yt-dlp && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY . .

RUN mkdir -p tmp

EXPOSE 3001
CMD ["node", "server.js"]
