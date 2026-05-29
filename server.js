const express = require('express');
const http = require('http');
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

// Write cookies from env var to file so yt-dlp can use them
if (process.env.YT_COOKIES) {
  fs.writeFileSync(COOKIES_FILE, process.env.YT_COOKIES, 'utf8');
  console.log('YouTube cookies loaded from environment');
}

function ytdlpArgs(extra = []) {
  const args = ['--js-runtimes', 'node', ...extra];
  if (fs.existsSync(COOKIES_FILE)) args.unshift('--cookies', COOKIES_FILE);
  return args;
}

app.use(express.json());
app.use(express.static('public'));

app.get('/health', (req, res) => res.send('ok'));

// downloads: videoId -> { filePath, process, ready, size, error }
const downloads = new Map();
// rooms: roomId -> { videoId, streamUrl, playing, currentTime, title, uploader }
const rooms = new Map();

function generateRoomId() {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}

function getTmpPath(videoId) {
  return path.join(TMP_DIR, `${videoId}.mp4`);
}

function cleanupVideo(videoId) {
  const info = downloads.get(videoId);
  if (!info) return;
  if (info.process) { try { info.process.kill(); } catch {} }
  try { if (fs.existsSync(info.filePath)) fs.unlinkSync(info.filePath); } catch {}
  downloads.delete(videoId);
}

function extractVideoId(input) {
  const urlMatch = input.match(/(?:v=|youtu\.be\/|embed\/)([a-zA-Z0-9_-]{11})/);
  return urlMatch ? urlMatch[1] : input.trim();
}

function startDownload(videoId) {
  return new Promise((resolve, reject) => {
    const filePath = getTmpPath(videoId);
    if (downloads.has(videoId)) return resolve(downloads.get(videoId));

    const info = { filePath, process: null, ready: false, size: 0, error: null };
    downloads.set(videoId, info);

    const ytdlp = spawn('yt-dlp', ytdlpArgs([
      '-f', 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best',
      '--merge-output-format', 'mp4',
      '-o', filePath,
      '--no-playlist',
      `https://www.youtube.com/watch?v=${videoId}`,
    ]));

    info.process = ytdlp;

    ytdlp.stderr.on('data', () => {
      if (!info.ready && fs.existsSync(filePath)) {
        info.ready = true;
        resolve(info);
      }
    });

    ytdlp.on('close', (code) => {
      info.process = null;
      if (code === 0) {
        info.ready = true;
        if (fs.existsSync(filePath)) info.size = fs.statSync(filePath).size;
        resolve(info);
      } else if (code !== null && !info.ready) {
        info.error = `yt-dlp exited with code ${code}`;
        reject(new Error(info.error));
      }
    });

    ytdlp.on('error', (err) => { info.error = err.message; reject(err); });

    setTimeout(() => {
      if (!info.ready && fs.existsSync(filePath)) { info.ready = true; resolve(info); }
    }, 2000);
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
    rooms.set(roomId, { videoId: null, streamUrl: null, playing: false, currentTime: 0, title: null, uploader: null });
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
    socket.emit('status', { msg: 'Fetching video info...', type: 'loading' });

    try {
      // Get metadata
      const meta = await new Promise((resolve, reject) => {
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

      room.videoId = videoId;
      room.title = meta.title;
      room.uploader = meta.uploader;
      room.currentTime = 0;
      room.playing = false;

      socket.emit('status', { msg: 'Starting download...', type: 'loading' });
      await startDownload(videoId);

      room.streamUrl = `/api/stream/${videoId}`;
      io.to(roomId).emit('video-loaded', {
        videoId,
        streamUrl: room.streamUrl,
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
      if (count === 0) {
        const room = rooms.get(currentRoomId);
        if (room?.videoId) cleanupVideo(room.videoId);
        rooms.delete(currentRoomId);
      } else {
        broadcastMemberCount(currentRoomId);
      }
    }, 500);
  });
});

// ── REST API ─────────────────────────────────────────────────────────────────

app.get('/api/progress/:videoId', (req, res) => {
  const info = downloads.get(req.params.videoId);
  if (!info) return res.json({ status: 'not_found' });
  const currentSize = fs.existsSync(info.filePath) ? fs.statSync(info.filePath).size : 0;
  res.json({
    status: info.error ? 'error' : info.process ? 'downloading' : 'complete',
    downloadedBytes: currentSize,
    error: info.error || null,
  });
});

app.get('/api/stream/:videoId', (req, res) => {
  const info = downloads.get(req.params.videoId);
  if (!info || !fs.existsSync(info.filePath)) return res.status(404).json({ error: 'Video not found' });

  const stat = fs.statSync(info.filePath);
  const fileSize = stat.size;
  const range = req.headers.range;

  if (range) {
    const parts = range.replace(/bytes=/, '').split('-');
    const start = parseInt(parts[0], 10);
    const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
    res.writeHead(206, {
      'Content-Range': `bytes ${start}-${end}/${fileSize}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': end - start + 1,
      'Content-Type': 'video/mp4',
    });
    fs.createReadStream(info.filePath, { start, end }).pipe(res);
  } else {
    res.writeHead(200, { 'Content-Length': fileSize, 'Content-Type': 'video/mp4', 'Accept-Ranges': 'bytes' });
    fs.createReadStream(info.filePath).pipe(res);
  }
});

process.on('exit', () => { for (const [id] of downloads) cleanupVideo(id); });
process.on('SIGINT', () => { for (const [id] of downloads) cleanupVideo(id); process.exit(); });

httpServer.listen(PORT, '0.0.0.0', () => console.log(`Shabang running at http://localhost:${PORT}`));
