const express = require('express');
const path = require('path');
const fs = require('fs');
const ffmpegInstaller = require('@ffmpeg-installer/ffmpeg');
const rateLimit = require('express-rate-limit');

// Copy ffmpeg to a path without spaces (required for child_process on Windows via Git Bash)
const FFMPEG_DIR = 'C:/ffmpeg';
const ffmpegBinPath = path.join(FFMPEG_DIR, 'ffmpeg.exe');
if (!fs.existsSync(ffmpegBinPath)) {
  fs.mkdirSync(FFMPEG_DIR, { recursive: true });
  fs.copyFileSync(ffmpegInstaller.path, ffmpegBinPath);
}

const CONFIG = {
  PORT: process.env.PORT || 3000,
  MAX_FILE_SIZE: 500 * 1024 * 1024,
  MP3_BITRATE: '320k',
  MAX_CONCURRENT_CONVERSIONS: 2,
  MAX_QUEUE_SIZE: 10,
  MAX_FILES_PER_REQUEST: 10,
  PROGRESS_TIMEOUT_MS: 30 * 60 * 1000,
  REQUEST_TIMEOUT_MS: 10 * 60 * 1000,
  CLEANUP_INTERVAL_MS: 10 * 60 * 1000,
  FILE_MAX_AGE_MS: 30 * 60 * 1000,
  TASK_MAP_MAX_AGE_MS: 60 * 60 * 1000,
  MIN_FREE_DISK_SPACE: 1 * 1024 * 1024 * 1024,
  UPLOAD_DIR: path.join(__dirname, 'uploads'),
  OUTPUT_DIR: path.join(__dirname, 'outputs'),
};

const app = express();

const tasks = new Map();
app.locals.tasks = tasks;
app.locals.CONFIG = CONFIG;

// Trust proxy for rate limiter
app.set('trust proxy', 1);

// QR code real filename (prevent enumeration of the actual file)
const QR_REAL_NAME = 'donate_qr_xK9mP2vQ.jpg';

// Redirect public-facing /donate-qr.png to the real random file
app.use((req, res, next) => {
  if (req.path === '/donate-qr.png') {
    req.url = '/' + QR_REAL_NAME;
  }
  next();
});

// Hotlink protection for the QR code image
app.use((req, res, next) => {
  if (req.url.startsWith('/donate_qr_') && (req.url.endsWith('.png') || req.url.endsWith('.jpg'))) {
    const referer = req.get('Referer') || '';
    if (referer && !referer.includes(req.get('Host') || '')) return res.status(403).end();
  }
  next();
});

// Rate limiting
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: '请求过于频繁，请稍后再试' },
});
app.use('/api/', apiLimiter);

// Static files
app.use(express.static(path.join(__dirname, 'public')));

// Routes
app.use('/api', require('./routes/convert'));
app.use('/api', require('./routes/progress'));

// Download route
app.get('/downloads/:filename', (req, res) => {
  const filename = path.basename(req.params.filename);
  const filepath = path.join(CONFIG.OUTPUT_DIR, filename);

  if (!fs.existsSync(filepath)) {
    return res.status(404).json({ error: '文件不存在或已被删除' });
  }

  // Derive download name from stored filename: "song_uuid.mp3" → "song.mp3"
  const downloadName = filename.replace(/_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(\.mp3)$/i, '$1');
  res.download(filepath, downloadName, (err) => {
    if (err && !res.headersSent) {
      res.status(500).json({ error: '下载失败' });
    }
  });
});

// Global error handler
app.use((err, req, res, _next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: '服务器内部错误' });
});

// Disk cleanup: scan temp dirs every 10 min, delete files older than 30 min
function cleanupFiles() {
  const dirs = [CONFIG.UPLOAD_DIR, CONFIG.OUTPUT_DIR];
  const now = Date.now();
  for (const dir of dirs) {
    fs.readdir(dir, (err, files) => {
      if (err) return;
      for (const file of files) {
        const filepath = path.join(dir, file);
        fs.stat(filepath, (err, stats) => {
          if (err) return;
          if (now - stats.mtimeMs > CONFIG.FILE_MAX_AGE_MS) {
            fs.unlink(filepath, () => {});
          }
        });
      }
    });
  }
}

// Task Map cleanup: remove old non-converting entries every 10 min
function cleanupTaskMap() {
  const now = Date.now();
  for (const [id, task] of tasks) {
    if (task.status !== 'converting' && now - task.createdAt > CONFIG.TASK_MAP_MAX_AGE_MS) {
      tasks.delete(id);
    }
  }
}

setInterval(cleanupFiles, CONFIG.CLEANUP_INTERVAL_MS);
setInterval(cleanupTaskMap, CONFIG.CLEANUP_INTERVAL_MS);

const server = app.listen(CONFIG.PORT, () => {
  console.log(`Server running on http://localhost:${CONFIG.PORT}`);
  console.log(`ffmpeg: ${ffmpegBinPath}`);
});
server.timeout = CONFIG.REQUEST_TIMEOUT_MS;
server.keepAliveTimeout = CONFIG.REQUEST_TIMEOUT_MS;
server.requestTimeout = CONFIG.REQUEST_TIMEOUT_MS;
