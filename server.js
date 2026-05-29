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

// streams: videoId -> { videoUrl, audioUrl?, title, uploader }
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

// Get best video+audio URLs. Returns { videoUrl, audioUrl? }
// High quality: separate video+audio streams (720p+)
// Fallback: single pre-muxed stream
function getStreamUrls(videoId) {
  return new Promise((resolve, reject) => {
    const ytdlp = spawn('yt-dlp', ytdlpArgs([
      '-g',
      '--format', 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/bestvideo+bestaudio/best[ext=mp4]/best',
      '--no-playlist',
      `https://www.youtube.com/watch?v=${videoId}`,
    ]));
    let out = '', err = '';
    ytdlp.stdout.on('data', d => out += d);
    ytdlp.stderr.on('data', d => err += d);
    ytdlp.on('close', code => {
      const lines = out.trim().split('\n').filter(Boolean);
      if (code !== 0 || !lines.length) return reject(new Error(err.trim() || 'Failed to get stream URLs'));
      if (lines.length >= 2) {
        resolve({ videoUrl: lines[0], audioUrl: lines[1] });
      } else {
        resolve({ videoUrl: lines[0] });
      }
    });
    ytdlp.on('error', reject);
  });
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
      const [meta, urls] = await Promise.all([
        getVideoInfo(videoId),
        getStreamUrls(videoId),
      ]);

      streams.set(videoId, { ...urls, title: meta.title, uploader: meta.uploader });

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

app.get('/api/stream/:videoId', (req, res) => {
  const info = streams.get(req.params.videoId);
  if (!info) return res.status(404).json({ error: 'Stream not found' });

  const startTime = Math.max(0, parseFloat(req.query.t) || 0);

  if (info.audioUrl) {
    // High quality: merge video+audio in real time with ffmpeg
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
    ff.on('error', err => { if (!res.headersSent) res.status(500).end(); });
    req.on('close', () => { try { ff.kill('SIGKILL'); } catch {} });
  } else {
    // Pre-muxed: proxy with range request support
    const ytUrl = new URL(info.videoUrl);
    const options = {
      hostname: ytUrl.hostname,
      path: ytUrl.pathname + ytUrl.search,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36',
        ...(req.headers.range ? { Range: req.headers.range } : {}),
      },
    };
    const proxyReq = https.get(options, proxyRes => {
      ['content-type', 'content-length', 'content-range', 'accept-ranges'].forEach(h => {
        if (proxyRes.headers[h]) res.setHeader(h, proxyRes.headers[h]);
      });
      res.status(proxyRes.statusCode);
      proxyRes.pipe(res);
    });
    proxyReq.on('error', err => { if (!res.headersSent) res.status(502).end(); });
    req.on('close', () => proxyReq.destroy());
  }
});

httpServer.listen(PORT, '0.0.0.0', () => console.log(`Shabang running at http://localhost:${PORT}`));
