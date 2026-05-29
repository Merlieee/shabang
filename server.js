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

// streams: videoId -> { title, uploader, duration, qualities: [1080,720,...] }
// qualityUrls: `${videoId}_${height}` -> { videoUrl, audioUrl? }
const streams = new Map();
const qualityUrls = new Map();
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
    let out = '', err = '';
    ytdlp.stdout.on('data', d => out += d);
    ytdlp.stderr.on('data', d => err += d);
    ytdlp.on('close', code => {
      if (code !== 0) return reject(new Error(err.trim() || 'yt-dlp failed'));
      try { resolve(JSON.parse(out)); } catch { reject(new Error('Failed to parse video info')); }
    });
    ytdlp.on('error', reject);
  });
}

function fetchStreamUrls(videoId, height) {
  const key = `${videoId}_${height || 'best'}`;
  if (qualityUrls.has(key)) return Promise.resolve(qualityUrls.get(key));

  const fmt = height
    ? `bestvideo[height<=${height}][ext=mp4]+bestaudio[ext=m4a]/bestvideo[height<=${height}]+bestaudio/best[height<=${height}][ext=mp4]/best[height<=${height}]`
    : `bestvideo[ext=mp4]+bestaudio[ext=m4a]/bestvideo+bestaudio/best[ext=mp4]/best`;

  return new Promise((resolve, reject) => {
    const ytdlp = spawn('yt-dlp', ytdlpArgs([
      '-g', '--format', fmt, '--no-playlist',
      `https://www.youtube.com/watch?v=${videoId}`,
    ]));
    let out = '', err = '';
    ytdlp.stdout.on('data', d => out += d);
    ytdlp.stderr.on('data', d => err += d);
    ytdlp.on('close', code => {
      const lines = out.trim().split('\n').filter(Boolean);
      if (code !== 0 || !lines.length) return reject(new Error(err.trim() || 'Failed to get stream URLs'));
      const urls = lines.length >= 2
        ? { videoUrl: lines[0], audioUrl: lines[1] }
        : { videoUrl: lines[0] };
      qualityUrls.set(key, urls);
      resolve(urls);
    });
    ytdlp.on('error', reject);
  });
}

function extractQualities(meta) {
  const formats = meta.formats || [];
  const heights = formats
    .filter(f => f.height && f.vcodec && f.vcodec !== 'none' && f.height >= 360)
    .map(f => f.height);
  return [...new Set(heights)].sort((a, b) => b - a);
}

function pipeStream(info, startTime, res) {
  if (info.audioUrl) {
    const ff = spawn('ffmpeg', [
      '-hide_banner', '-loglevel', 'error',
      '-ss', String(startTime), '-i', info.videoUrl,
      '-ss', String(startTime), '-i', info.audioUrl,
      '-map', '0:v:0', '-map', '1:a:0',
      '-c:v', 'copy', '-c:a', 'aac', '-b:a', '128k',
      '-f', 'mp4',
      '-movflags', 'frag_keyframe+empty_moov+default_base_moof',
      'pipe:1',
    ]);
    res.setHeader('Content-Type', 'video/mp4');
    ff.stdout.pipe(res);
    ff.stderr.on('data', () => {});
    ff.on('error', () => { if (!res.headersSent) res.status(500).end(); });
    return ff;
  } else {
    const ytUrl = new URL(info.videoUrl);
    const proxyReq = https.get({
      hostname: ytUrl.hostname,
      path: ytUrl.pathname + ytUrl.search,
      headers: { 'User-Agent': 'Mozilla/5.0 Chrome/120' },
    }, proxyRes => {
      ['content-type', 'content-length', 'content-range', 'accept-ranges']
        .forEach(h => { if (proxyRes.headers[h]) res.setHeader(h, proxyRes.headers[h]); });
      res.status(proxyRes.statusCode);
      proxyRes.pipe(res);
    });
    proxyReq.on('error', () => { if (!res.headersSent) res.status(502).end(); });
    return proxyReq;
  }
}

// ── Socket.io rooms ──────────────────────────────────────────────────────────

io.on('connection', (socket) => {
  let currentRoomId = null;

  function getMemberCount(roomId) {
    const r = io.sockets.adapter.rooms.get(roomId);
    return r ? r.size : 0;
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
      const [meta, defaultUrls] = await Promise.all([
        getVideoInfo(videoId),
        fetchStreamUrls(videoId, null),
      ]);

      const qualities = extractQualities(meta);
      streams.set(videoId, { title: meta.title, uploader: meta.uploader, duration: meta.duration, qualities });

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
        duration: meta.duration,
        qualities,
      });
    } catch (err) {
      socket.emit('status', { msg: `Error: ${err.message}`, type: 'error' });
    }
  });

  socket.on('play', ({ roomId, currentTime }) => {
    const room = rooms.get(roomId);
    if (!room) return;
    room.playing = true; room.currentTime = currentTime;
    socket.to(roomId).emit('play', { currentTime });
  });

  socket.on('pause', ({ roomId, currentTime }) => {
    const room = rooms.get(roomId);
    if (!room) return;
    room.playing = false; room.currentTime = currentTime;
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

app.get('/api/stream/:videoId', async (req, res) => {
  const { videoId } = req.params;
  const info = streams.get(videoId);
  if (!info) return res.status(404).json({ error: 'Stream not found' });

  const startTime = Math.max(0, parseFloat(req.query.t) || 0);
  const quality = req.query.quality ? parseInt(req.query.quality) : null;

  try {
    const urls = await fetchStreamUrls(videoId, quality);
    const proc = pipeStream(urls, startTime, res);
    req.on('close', () => { try { proc.destroy?.() || proc.kill?.('SIGKILL'); } catch {} });
  } catch (err) {
    if (!res.headersSent) res.status(500).json({ error: err.message });
  }
});

httpServer.listen(PORT, '0.0.0.0', () => console.log(`Shabang running at http://localhost:${PORT}`));
