const express = require('express');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();
const PORT = 3001;
const TMP_DIR = path.join(__dirname, 'tmp');

if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR);

app.use(express.json());
app.use(express.static('public'));

// Track active downloads: videoId -> { filePath, process, ready, size }
const downloads = new Map();
// Track current video per session: sessionId -> videoId
const sessions = new Map();

function getTmpPath(videoId) {
  return path.join(TMP_DIR, `${videoId}.mp4`);
}

function cleanupVideo(videoId) {
  const info = downloads.get(videoId);
  if (!info) return;
  if (info.process) {
    try { info.process.kill(); } catch {}
  }
  try {
    if (fs.existsSync(info.filePath)) fs.unlinkSync(info.filePath);
  } catch {}
  downloads.delete(videoId);
}

// Extract video ID from URL or return as-is if already an ID
function extractVideoId(input) {
  const urlMatch = input.match(/(?:v=|youtu\.be\/|embed\/)([a-zA-Z0-9_-]{11})/);
  return urlMatch ? urlMatch[1] : input.trim();
}

// Start downloading a video, resolve when file starts being written
function startDownload(videoId) {
  return new Promise((resolve, reject) => {
    const filePath = getTmpPath(videoId);

    if (downloads.has(videoId)) {
      return resolve(downloads.get(videoId));
    }

    const info = { filePath, process: null, ready: false, size: 0, error: null };
    downloads.set(videoId, info);

    const url = `https://www.youtube.com/watch?v=${videoId}`;
    const ytdlp = spawn('yt-dlp', [
      '-f', 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best',
      '--merge-output-format', 'mp4',
      '-o', filePath,
      '--no-playlist',
      url,
    ]);

    info.process = ytdlp;

    ytdlp.stderr.on('data', (data) => {
      const text = data.toString();
      // Resolve as soon as yt-dlp starts writing the file
      if (!info.ready && fs.existsSync(filePath)) {
        info.ready = true;
        resolve(info);
      }
    });

    ytdlp.on('close', (code) => {
      info.process = null;
      if (code === 0) {
        info.ready = true;
        info.size = fs.existsSync(filePath) ? fs.statSync(filePath).size : 0;
        if (!info.ready) resolve(info);
      } else if (code !== null) {
        info.error = `yt-dlp exited with code ${code}`;
        if (!info.ready) reject(new Error(info.error));
      }
    });

    ytdlp.on('error', (err) => {
      info.error = err.message;
      reject(err);
    });

    // Also resolve after a short wait if file exists (handles fast starts)
    setTimeout(() => {
      if (!info.ready && fs.existsSync(filePath)) {
        info.ready = true;
        resolve(info);
      }
    }, 2000);
  });
}

// Get video metadata without downloading
app.get('/api/info', async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: 'url required' });

  const videoId = extractVideoId(url);

  const ytdlp = spawn('yt-dlp', [
    '--dump-json',
    '--no-playlist',
    `https://www.youtube.com/watch?v=${videoId}`,
  ]);

  let output = '';
  ytdlp.stdout.on('data', (d) => (output += d));
  ytdlp.on('close', (code) => {
    if (code !== 0) return res.status(500).json({ error: 'Failed to fetch video info' });
    try {
      const info = JSON.parse(output);
      res.json({
        id: info.id,
        title: info.title,
        duration: info.duration,
        thumbnail: info.thumbnail,
        uploader: info.uploader,
      });
    } catch {
      res.status(500).json({ error: 'Failed to parse video info' });
    }
  });
});

// Start playing a video for a session
app.post('/api/play', async (req, res) => {
  const { url, sessionId } = req.body;
  if (!url) return res.status(400).json({ error: 'url required' });

  const videoId = extractVideoId(url);
  const sid = sessionId || crypto.randomUUID();

  // Clean up previous video for this session
  const prevVideoId = sessions.get(sid);
  if (prevVideoId && prevVideoId !== videoId) {
    // Check if any other session is using this video before deleting
    const otherSession = [...sessions.values()].find(
      (v, i) => v === prevVideoId && [...sessions.keys()][i] !== sid
    );
    if (!otherSession) cleanupVideo(prevVideoId);
  }

  sessions.set(sid, videoId);

  try {
    await startDownload(videoId);
    res.json({ videoId, sessionId: sid, streamUrl: `/api/stream/${videoId}` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Stream video with range request support
app.get('/api/stream/:videoId', (req, res) => {
  const { videoId } = req.params;
  const info = downloads.get(videoId);

  if (!info || !fs.existsSync(info.filePath)) {
    return res.status(404).json({ error: 'Video not found or not yet downloaded' });
  }

  const filePath = info.filePath;
  const stat = fs.statSync(filePath);
  const fileSize = stat.size;
  const range = req.headers.range;

  if (range) {
    const parts = range.replace(/bytes=/, '').split('-');
    const start = parseInt(parts[0], 10);
    const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
    const chunkSize = end - start + 1;

    res.writeHead(206, {
      'Content-Range': `bytes ${start}-${end}/${fileSize}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': chunkSize,
      'Content-Type': 'video/mp4',
    });

    fs.createReadStream(filePath, { start, end }).pipe(res);
  } else {
    res.writeHead(200, {
      'Content-Length': fileSize,
      'Content-Type': 'video/mp4',
      'Accept-Ranges': 'bytes',
    });
    fs.createReadStream(filePath).pipe(res);
  }
});

// Get download progress
app.get('/api/progress/:videoId', (req, res) => {
  const { videoId } = req.params;
  const info = downloads.get(videoId);

  if (!info) return res.json({ status: 'not_found' });

  const currentSize = fs.existsSync(info.filePath)
    ? fs.statSync(info.filePath).size
    : 0;

  res.json({
    status: info.error ? 'error' : info.process ? 'downloading' : 'complete',
    downloadedBytes: currentSize,
    error: info.error || null,
  });
});

// Clean up on process exit
process.on('exit', () => {
  for (const [videoId] of downloads) cleanupVideo(videoId);
});
process.on('SIGINT', () => {
  for (const [videoId] of downloads) cleanupVideo(videoId);
  process.exit();
});

app.listen(PORT, () => {
  console.log(`Shabang running at http://localhost:${PORT}`);
});
