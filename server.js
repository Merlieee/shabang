const express = require('express');
const http = require('http');
const https = require('https');
const { Server } = require('socket.io');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const app = express();
const httpServer = http.createServer(app);
const io = new Server(httpServer);

const PORT = process.env.PORT || 3001;
const TMP_DIR = path.join(__dirname, 'tmp');
const COOKIES_FILE = path.join(TMP_DIR, 'yt-cookies.txt');

if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR);

if (process.env.YT_COOKIES) {
  fs.writeFileSync(COOKIES_FILE, process.env.YT_COOKIES, 'utf8');
  console.log('YouTube cookies loaded from environment');
}

function ytdlpArgs(extra = []) {
  const args = ['--js-runtimes', 'node', '--remote-components', 'ejs:github', ...extra];
  if (fs.existsSync(COOKIES_FILE)) args.unshift('--cookies', COOKIES_FILE);
  return args;
}

function extractVideoId(input) {
  const urlMatch = input.match(/(?:v=|youtu\.be\/|embed\/)([a-zA-Z0-9_-]{11})/);
  return urlMatch ? urlMatch[1] : input.trim();
}

// streams: videoId -> { url, title, uploader, fetchedAt }
const streams = new Map();
// rooms: roomId -> { videoId, playing, currentTime, title, uploader }
const rooms = new Map();

function generateRoomId() {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}

function getVideoInfo(videoId) {
  return new Promise((resolve, reject) => {
    const ytdlp = spawn('yt-dlp', ytdlpArgs([
      '--dump-json', '--no-playlist',
      `https://www.youtube.com/watch?v=${videoId}`,
    ]));
    let out = '';
    let err = '';
    ytdlp.stdout.on('data', d => out += d);
    ytdlp.stderr.on('data', d => err += d);
    ytdlp.on('close', code => {
      if (code !== 0) return reject(new Error(err.trim() || 'yt-dlp failed'));
      try { resolve(JSON.parse(out)); } catch { reject(new Error('Failed to parse video info')); }
    });
    ytdlp.on('error', reject);
  });
}

// Get direct stream URL — picks best pre-muxed format so we get a single URL
function getStreamUrl(videoId) {
  return new Promise((resolve, reject) => {
    const ytdlp = spawn('yt-dlp', ytdlpArgs([
      '-g',
      '--format', 'best[height<=1080][ext=mp4]/best[height<=1080]/best[ext=mp4]/best',
      '--no-playlist',
      `https://www.youtube.com/watch?v=${videoId}`,
    ]));
    let out = '';
    let err = '';
    ytdlp.stdout.on('data', d => out += d);
    ytdlp.stderr.on('data', d => err += d);
    ytdlp.on('close', code => {
      const url = out.trim().split('\n')[0]; // take first URL if multiple
      if (code !== 0 || !url) return reject(new Error(err.trim() || 'Failed to get stream URL'));
      resolve(url);
    });
    ytdlp.on('error', reject);
  });
}

// ── Socket.io rooms ──────────────────────────────────────────────────────────

io.on('connection', (socket) => {
  let currentRoomId = null;

  function getMemberCount(roomId) {
    const room = io.sockets.adapter.rooms.get(roomId);
    return room ? room.size : 0;
  }

  function broadcastMemberCount(roomId) {
    io.to(roomId).emit('member-count', getMemberCount(roomId));
  }

  socket.on('create-room', (callback) => {
    const roomId = generateRoomId();
    rooms.set(roomId, { videoId: null, playing: false, currentTime: 0, title: null, uploader: null });
    socket.join(roomId);
    currentRoomId = roomId;
    broadcastMemberCount(roomId);
    callback({ roomId });
  });

  socket.on('join-room', (roomId, callback) => {
    const room = rooms.get(roomId);
    if (!room) return callback({ error: 'Room not found' });
    socket.join(roomId);
    currentRoomId = roomId;
    broadcastMemberCount(roomId);
    callback({ room });
  });

  socket.on('load-video', async ({ roomId, url }) => {
    const room = rooms.get(roomId);
    if (!room) return;

    const videoId = extractVideoId(url);
    socket.emit('status', { msg: 'Fetching video...', type: 'loading' });

    try {
      // Run info + stream URL fetch in parallel
      const [meta, streamUrl] = await Promise.all([
        getVideoInfo(videoId),
        getStreamUrl(videoId),
      ]);

      streams.set(videoId, { url: streamUrl, fetchedAt: Date.now() });

      room.videoId = videoId;
      room.title = meta.title;
      room.uploader = meta.uploader;
      room.currentTime = 0;
      room.playing = false;

      io.to(roomId).emit('video-loaded', {
        videoId,
        streamUrl: `/api/stream/${videoId}`,
        title: room.title,
        uploader: room.uploader,
      });
    } catch (err) {
      socket.emit('status', { msg: `Error: ${err.message}`, type: 'error' });
    }
  });

  socket.on('play', ({ roomId, currentTime }) => {
    const room = rooms.get(roomId);
    if (!room) return;
    room.playing = true;
    room.currentTime = currentTime;
    socket.to(roomId).emit('play', { currentTime });
  });

  socket.on('pause', ({ roomId, currentTime }) => {
    const room = rooms.get(roomId);
    if (!room) return;
    room.playing = false;
    room.currentTime = currentTime;
    socket.to(roomId).emit('pause', { currentTime });
  });

  socket.on('seek', ({ roomId, currentTime }) => {
    const room = rooms.get(roomId);
    if (!room) return;
    room.currentTime = currentTime;
    socket.to(roomId).emit('seek', { currentTime });
  });

  socket.on('disconnect', () => {
    if (!currentRoomId) return;
    setTimeout(() => {
      const count = getMemberCount(currentRoomId);
      if (count === 0) rooms.delete(currentRoomId);
      else broadcastMemberCount(currentRoomId);
    }, 500);
  });
});

// ── REST API ─────────────────────────────────────────────────────────────────

app.use(express.json());
app.use(express.static('public'));
app.get('/health', (req, res) => res.send('ok'));

// Proxy YouTube stream through our server with range request support
app.get('/api/stream/:videoId', (req, res) => {
  const info = streams.get(req.params.videoId);
  if (!info) return res.status(404).json({ error: 'Stream not found' });

  const ytUrl = new URL(info.url);
  const options = {
    hostname: ytUrl.hostname,
    path: ytUrl.pathname + ytUrl.search,
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36',
      ...(req.headers.range ? { Range: req.headers.range } : {}),
    },
  };

  const proxyReq = https.get(options, (proxyRes) => {
    const forward = ['content-type', 'content-length', 'content-range', 'accept-ranges'];
    forward.forEach(h => { if (proxyRes.headers[h]) res.setHeader(h, proxyRes.headers[h]); });
    res.status(proxyRes.statusCode);
    proxyRes.pipe(res);
  });

  proxyReq.on('error', (err) => {
    if (!res.headersSent) res.status(502).json({ error: err.message });
  });

  req.on('close', () => proxyReq.destroy());
});

httpServer.listen(PORT, '0.0.0.0', () => console.log(`Shabang running at http://localhost:${PORT}`));
