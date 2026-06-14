const express = require('express');
const path = require('path');
const fs = require('fs');
// Security headers middleware (replaces helmet to avoid dependency)
function securityHeaders(req, res, next) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('X-DNS-Prefetch-Control', 'off');
  res.setHeader('X-Download-Options', 'noopen');
  res.setHeader('X-Permitted-Cross-Domain-Policies', 'none');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), interest-cohort=()');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' https://www.googletagmanager.com https://www.google-analytics.com https://analytics.google.com https://*.baidu.com https://plausible.io; img-src 'self' data: https://www.google-analytics.com https://www.googletagmanager.com https://*.baidu.com; connect-src 'self' https://www.google-analytics.com https://*.baidu.com https://plausible.io; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'; form-action 'self'");
  next();
}
// ffmpeg-installer — optional; in SEA builds ffmpeg is pre-extracted by the shim
let ffmpegInstaller = null;
try { ffmpegInstaller = require('@ffmpeg-installer/ffmpeg'); } catch (_) { /* SEA: pre-extracted */ }
const rateLimit = require('express-rate-limit');

// Copy ffmpeg to a path without spaces (required for child_process on Windows via Git Bash)
const FFMPEG_DIR = 'C:/ffmpeg';
const ffmpegBinPath = path.join(FFMPEG_DIR, 'ffmpeg.exe');
if (!fs.existsSync(ffmpegBinPath) && ffmpegInstaller) {
  fs.mkdirSync(FFMPEG_DIR, { recursive: true });
  fs.copyFileSync(ffmpegInstaller.path, ffmpegBinPath);
}

// Verify ffmpeg binary integrity (should be ~60 MB)
if (fs.existsSync(ffmpegBinPath)) {
  const stat = fs.statSync(ffmpegBinPath);
  if (stat.size < 1024 * 1024) {
    console.error(`WARNING: ffmpeg binary at ${ffmpegBinPath} appears invalid (${(stat.size / 1024).toFixed(0)} KB)`);
  } else {
    console.log(`ffmpeg: ${(stat.size / 1024 / 1024).toFixed(1)} MB at ${ffmpegBinPath}`);
  }
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

// Security headers
app.use(securityHeaders);

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

// Health check endpoint (not rate-limited)
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', uptime: process.uptime() });
});

// Routes
app.use('/api', require('./routes/convert'));
app.use('/api', require('./routes/progress'));

// Download route
app.get('/downloads/:filename', (req, res) => {
  const filename = path.basename(req.params.filename);
  const outputDir = path.resolve(CONFIG.OUTPUT_DIR);
  const filepath = path.join(outputDir, filename);

  // Ensure resolved path is inside the output directory
  if (!filepath.startsWith(outputDir)) {
    return res.status(403).json({ error: '访问被拒绝' });
  }

  if (!fs.existsSync(filepath)) {
    return res.status(404).json({ error: '文件不存在或已被删除' });
  }

  // Derive download name from stored filename: "song_uuid.mp3" → "song.mp3"
  const downloadName = filename.replace(/_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(\.(mp3|wav|flac))$/i, '$1');
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
      if (err) {
        if (err.code !== 'ENOENT') console.error(`cleanup readdir ${dir}:`, err.message);
        return;
      }
      for (const file of files) {
        const filepath = path.join(dir, file);
        fs.stat(filepath, (err, stats) => {
          if (err) {
            if (err.code !== 'ENOENT') console.error(`cleanup stat ${filepath}:`, err.message);
            return;
          }
          if (now - stats.mtimeMs > CONFIG.FILE_MAX_AGE_MS) {
            fs.unlink(filepath, (err) => {
              if (err && err.code !== 'ENOENT') console.error(`cleanup unlink ${filepath}:`, err.message);
            });
          }
        });
      }
    });
  }
}

// Task Map cleanup: remove old non-converting entries every 10 min
function cleanupTaskMap() {
  const now = Date.now();
  const stale = [];
  for (const [id, task] of tasks) {
    if (task.status !== 'converting' && now - task.createdAt > CONFIG.TASK_MAP_MAX_AGE_MS) {
      stale.push(id);
    }
  }
  for (const id of stale) tasks.delete(id);
}

setInterval(cleanupFiles, CONFIG.CLEANUP_INTERVAL_MS);
setInterval(cleanupTaskMap, CONFIG.CLEANUP_INTERVAL_MS);

const server = app.listen(CONFIG.PORT, () => {
  console.log(`Server running on http://localhost:${CONFIG.PORT}`);
  console.log(`ffmpeg: ${ffmpegBinPath}`);
});
server.timeout = CONFIG.REQUEST_TIMEOUT_MS;
server.keepAliveTimeout = 30000;
server.requestTimeout = CONFIG.REQUEST_TIMEOUT_MS;

// Graceful shutdown
function shutdown(signal) {
  console.log(`\nReceived ${signal}, shutting down gracefully...`);
  require('./routes/convert').shutdown();
  server.close(() => {
    console.log('Server closed.');
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10000);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// Process crash protection — log and clean up rather than silent death
process.on('uncaughtException', (err) => {
  console.error('UNCAUGHT EXCEPTION:', err);
  // Attempt graceful shutdown (SIGKILL ffmpeg processes, close server)
  try { require('./routes/convert').shutdown(); } catch (_) {}
  server.close(() => process.exit(1));
  setTimeout(() => process.exit(1), 5000);
});

process.on('unhandledRejection', (reason) => {
  console.error('UNHANDLED REJECTION:', reason);
});
