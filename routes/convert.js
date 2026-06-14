const { Router } = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const { v4: uuidv4 } = require('uuid');
const { fileTypeFromFile } = require('file-type');
const { default: PQueue } = require('p-queue');

// ffmpeg binary path (pre-copied to a no-spaces location)
const FFMPEG_BIN = 'C:/ffmpeg/ffmpeg.exe';

// Track active ffmpeg child processes for graceful shutdown — Map<taskId, ChildProcess>
const activeProcesses = new Map();

const router = Router();

// Graceful shutdown: kill all active ffmpeg processes
router.shutdown = function () {
  const count = activeProcesses.size;
  if (count > 0) {
    console.log(`Terminating ${count} active ffmpeg process(es)...`);
    activeProcesses.forEach(p => {
      try {
        p.kill('SIGTERM');
        // Force kill after 2 seconds if SIGTERM didn't work
        setTimeout(() => { try { p.kill('SIGKILL'); } catch (_) {} }, 2000);
      } catch (_) {}
    });
    activeProcesses.clear();
  }
};

// p-queue for concurrency control
const queue = new PQueue({ concurrency: 2 });

// busboy decodes multipart filenames as latin1; convert back to UTF-8
function decodeFilename(name) {
  return Buffer.from(name, 'latin1').toString('utf8');
}

function getDirs(app) {
  return {
    uploadDir: app.locals.CONFIG.UPLOAD_DIR,
    outputDir: app.locals.CONFIG.OUTPUT_DIR,
  };
}

const ACCEPTED_EXTENSIONS = ['.flac', '.wav', '.mp3'];
const ACCEPTED_FORMATS = ['flac', 'wav', 'mp3'];

function buildFfmpegArgs(inputPath, outputPath, inputFormat, targetFormat, bitrate) {
  const args = ['-y', '-i', inputPath];
  if (inputFormat === targetFormat) {
    // Stream copy for same-format conversion (no quality loss)
    args.push('-codec:a', 'copy');
  } else {
    switch (targetFormat) {
      case 'wav':
        args.push('-codec:a', 'pcm_s16le', '-map_metadata', '0');
        break;
      case 'flac':
        args.push('-codec:a', 'flac', '-map_metadata', '0');
        break;
      case 'mp3':
      default:
        args.push('-codec:a', 'libmp3lame', '-b:a', bitrate || '320k', '-map_metadata', '0', '-id3v2_version', '3');
        break;
    }
  }
  args.push('-progress', 'pipe:1', '-nostats', outputPath);
  return args;
}

// multer storage
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const { uploadDir } = getDirs(req.app);
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    const id = uuidv4();
    const ext = path.extname(file.originalname).toLowerCase();
    req._fileIds = req._fileIds || [];
    req._fileIds.push(id);
    cb(null, id + ext);
  },
});

const upload = multer({
  storage,
  limits: {
    fileSize: 500 * 1024 * 1024, // 500MB per file
    fieldNameSize: 100,          // max field name length
    fieldSize: 1024,             // max field value length (bitrate value ~4 chars)
    fields: 5,                   // max non-file fields
  },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (!ACCEPTED_EXTENSIONS.includes(ext)) {
      return cb(new multer.MulterError('LIMIT_UNEXPECTED_FILE', 'audio'), false);
    }
    cb(null, true);
  },
}).array('files', 10);

// POST /api/convert
router.post('/convert', (req, res) => {
  // Origin check (CSRF protection) — allow same-origin only
  const origin = req.get('Origin') || req.get('Referer') || '';
  if (origin) {
    const expectedOrigin = req.protocol + '://' + req.get('Host');
    if (!origin.startsWith(expectedOrigin)) {
      return res.status(403).json({ error: '拒绝跨域请求' });
    }
  }

  upload(req, res, async (err) => {
    // Handle multer errors
    if (err) {
      if (req.files) req.files.forEach(f => fs.unlink(f.path, () => {}));
      if (req.file) fs.unlink(req.file.path, () => {});

      if (err instanceof multer.MulterError) {
        if (err.code === 'LIMIT_FILE_SIZE') {
          return res.status(413).json({ error: '单个文件最大 500MB' });
        }
        if (err.code === 'LIMIT_FILE_COUNT') {
          return res.status(400).json({ error: `单次最多上传 ${req.app.locals.CONFIG.MAX_FILES_PER_REQUEST} 个文件` });
        }
        if (err.code === 'LIMIT_UNEXPECTED_FILE') {
          return res.status(400).json({ error: '仅支持 .flac .wav .mp3 文件' });
        }
        return res.status(400).json({ error: '上传失败' });
      }
      return res.status(500).json({ error: '服务器错误' });
    }

    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ error: '请选择文件' });
    }

    // Read and validate target format
    const targetFormat = (req.body.targetFormat || 'mp3').toLowerCase();
    if (!ACCEPTED_FORMATS.includes(targetFormat)) {
      cleanupFiles(req.files);
      return res.status(400).json({ error: '无效的目标格式' });
    }

    // Read optional bitrate (only applies to MP3 output)
    let bitrate = req.body.bitrate || req.app.locals.CONFIG.MP3_BITRATE;
    // Validate bitrate format (e.g. 128k, 192k, 320k)
    if (typeof bitrate !== 'string' || !/^\d{2,4}k$/.test(bitrate)) {
      bitrate = req.app.locals.CONFIG.MP3_BITRATE;
    }

    const tasks = req.app.locals.tasks;
    const { outputDir } = getDirs(req.app);

    // Cleanup helper
    function cleanupFiles(files) {
      files.forEach(f => fs.unlink(f.path, () => {}));
    }

    try {
      // Magic number validation — all files must pass before any are queued
      const validationResults = await Promise.allSettled(
        req.files.map(f => fileTypeFromFile(f.path))
      );
      const invalidFiles = [];
      const detectedFormats = new Map(); // index → detected format ext
      for (let i = 0; i < validationResults.length; i++) {
        const r = validationResults[i];
        if (r.status === 'rejected' || !r.value || !ACCEPTED_FORMATS.includes(r.value.ext)) {
          invalidFiles.push(decodeFilename(req.files[i].originalname));
        } else {
          detectedFormats.set(i, r.value.ext);
        }
      }
      if (invalidFiles.length > 0) {
        cleanupFiles(req.files);
        return res.status(400).json({
          error: `以下文件不是有效的音频格式: ${invalidFiles.join(', ')}`
        });
      }

      // Check disk space (once for the batch)
      try {
        const stat = fs.statfsSync ? fs.statfsSync(outputDir) : null;
        if (stat) {
          const freeBytes = stat.bsize * stat.bfree;
          const minFree = req.app.locals.CONFIG.MIN_FREE_DISK_SPACE;
          if (freeBytes < minFree) {
            cleanupFiles(req.files);
            return res.status(507).json({ error: '服务器磁盘空间不足，请稍后重试' });
          }
        }
      } catch (_) {
        // statfs not available on this platform — skip check
      }

      // Check queue capacity (atomic: JS single-threaded, no await between check and enqueue)
      if (queue.size + queue.pending + req.files.length > req.app.locals.CONFIG.MAX_QUEUE_SIZE) {
        cleanupFiles(req.files);
        return res.status(429).json({ error: '当前转换请求过多，请稍后再试' });
      }

      // Create tasks and enqueue conversions
      const taskIds = [];

      for (let i = 0; i < req.files.length; i++) {
        const file = req.files[i];
        const id = req._fileIds[i];
        const inputPath = file.path;
        const originalStem = path.parse(decodeFilename(file.originalname)).name;
        const inputFormat = detectedFormats.get(i);
        const outputFilename = originalStem + '_' + id + '.' + targetFormat;
        const outputPath = path.join(outputDir, outputFilename);

        tasks.set(id, {
          percent: 0,
          status: 'converting',
          inputPath,
          outputPath,
          downloadUrl: null,
          errorMessage: null,
          originalName: decodeFilename(file.originalname),
          inputFormat,
          targetFormat,
          createdAt: Date.now(),
        });

        taskIds.push(id);
      }

      // Respond immediately with all task IDs
      res.json({ taskIds, queueSize: queue.size + queue.pending });

      // Enqueue one conversion per file
      for (let i = 0; i < req.files.length; i++) {
        const file = req.files[i];
        const id = taskIds[i];
        const inputPath = file.path;
        const outputPath = tasks.get(id).outputPath;
        const outputFilename = path.basename(outputPath);

        queue.add(async () => {
          return new Promise((resolve) => {
            const task = tasks.get(id);

            // Check if cancelled while waiting in queue
            if (!task || task.status === 'cancelled') {
              resolve();
              return;
            }

            const inputFormat = task ? task.inputFormat : null;
            const ffmpegArgs = buildFfmpegArgs(inputPath, outputPath, inputFormat, targetFormat, bitrate);
            const fileSize = fs.statSync(inputPath).size;
            console.log(JSON.stringify({
              event: 'convert_start', taskId: id, inputFormat, targetFormat,
              fileSize, bitrate, file: path.basename(inputPath)
            }));

            const proc = spawn(FFMPEG_BIN, ffmpegArgs);
            activeProcesses.set(id, proc);

            // Manual timeout (spawn does not have a timeout option)
            const timer = setTimeout(() => {
              console.log(`[${id}] timeout, killing`);
              proc.kill('SIGTERM');
              setTimeout(() => { try { proc.kill('SIGKILL'); } catch (_) {} }, 2000);
            }, 30 * 60 * 1000);

            let lastPercent = 0;
            let estTotal = 0;
            let stdoutBuffer = '';

            proc.stdout.on('data', (data) => {
              stdoutBuffer += data.toString();
              const lines = stdoutBuffer.split('\n');
              stdoutBuffer = lines.pop(); // keep the incomplete line for next chunk
              for (const line of lines) {
                const match = line.match(/^out_time_us=(\d+)/);
                if (match) {
                  const outTime = parseInt(match[1], 10) / 1000000;
                  const total = estTotal || 1;
                  const pct = Math.min(Math.round((outTime / total) * 100), 99);
                  if (pct > lastPercent) {
                    lastPercent = pct;
                    const t = tasks.get(id);
                    if (t) t.percent = pct;
                  }
                }
              }
            });

            let stderr = '';
            proc.stderr.on('data', (data) => {
              const chunk = data.toString();
              stderr += chunk;
              if (stderr.length > 100000) stderr = stderr.slice(-50000);
              // Parse Duration from ffmpeg stderr (e.g. "Duration: 00:30:25.10")
              if (!estTotal) {
                const durMatch = chunk.match(/Duration:\s*(\d+):(\d+):(\d+)\.(\d+)/);
                if (durMatch) {
                  estTotal = parseInt(durMatch[1]) * 3600 + parseInt(durMatch[2]) * 60 + parseInt(durMatch[3]) + parseInt(durMatch[4]) / 100;
                  if (estTotal < 1) estTotal = 1;
                }
              }
            });

            function onFinish() {
              activeProcesses.delete(id);
              clearTimeout(timer);
            }

            proc.on('close', (code) => {
              onFinish();
              if (code === 0) {
                const t = tasks.get(id);
                if (t) {
                  t.status = 'done';
                  t.percent = 100;
                  t.downloadUrl = '/downloads/' + encodeURIComponent(outputFilename);
                }
                const outSize = fs.statSync(outputPath).size;
                console.log(JSON.stringify({
                  event: 'convert_complete', taskId: id, inputFormat, targetFormat,
                  outputSize: outSize, duration: task.duration || 0
                }));
                resolve();
              } else {
                const t = tasks.get(id);
                if (t) {
                  t.status = 'error';
                  t.errorMessage = '格式转换失败';
                }
                console.error(JSON.stringify({
                  event: 'convert_fail', taskId: id, exitCode: code,
                  inputFormat, targetFormat, stderr: stderr.slice(-200)
                }));
                fs.unlink(outputPath, () => {});
                fs.unlink(inputPath, () => {});
                resolve();
              }
            });

            proc.on('error', (err) => {
              onFinish();
              const t = tasks.get(id);
              if (t) {
                t.status = 'error';
                t.errorMessage = '格式转换失败';
              }
              console.error(JSON.stringify({
                event: 'convert_error', taskId: id, error: err.message,
                inputFormat, targetFormat
              }));
              fs.unlink(outputPath, () => {});
              fs.unlink(inputPath, () => {});
              resolve();
            });
          });
        });
      }

    } catch (validationErr) {
      cleanupFiles(req.files);
      return res.status(400).json({ error: validationErr.message || '文件校验失败' });
    }
  });
});

// DELETE /api/convert/:taskId — cancel a queued or running conversion
router.delete('/convert/:taskId', (req, res) => {
  const { taskId } = req.params;
  const tasks = req.app.locals.tasks;
  const task = tasks.get(taskId);

  if (!task) {
    return res.status(404).json({ error: '任务不存在或已过期' });
  }

  if (task.status !== 'converting') {
    return res.status(400).json({ error: '任务已结束或已取消' });
  }

  // Mark as cancelled immediately
  task.status = 'cancelled';
  task.percent = 0;

  // Kill ffmpeg process if running
  const proc = activeProcesses.get(taskId);
  if (proc) {
    console.log(JSON.stringify({ event: 'cancel_kill', taskId }));
    try {
      proc.kill('SIGTERM');
      setTimeout(() => { try { proc.kill('SIGKILL'); } catch (_) {} }, 2000);
    } catch (_) {}
  }

  // Clean up input/output files
  fs.unlink(task.inputPath, () => {});
  fs.unlink(task.outputPath, () => {});

  res.json({ success: true });
});

module.exports = router;
