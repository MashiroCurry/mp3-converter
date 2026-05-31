const { Router } = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { exec } = require('child_process');
const { v4: uuidv4 } = require('uuid');
const { fileTypeFromFile } = require('file-type');
const { default: PQueue } = require('p-queue');

// ffmpeg binary path (pre-copied to a no-spaces location)
const FFMPEG_BIN = 'C:/ffmpeg/ffmpeg.exe';

const router = Router();

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
  limits: { fileSize: 500 * 1024 * 1024 }, // 500MB
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (ext !== '.flac') {
      return cb(new multer.MulterError('LIMIT_UNEXPECTED_FILE', 'flac'), false);
    }
    cb(null, true);
  },
}).array('files', 10);

// POST /api/convert
router.post('/convert', (req, res) => {
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
          return res.status(400).json({ error: '仅支持 .flac 文件' });
        }
        return res.status(400).json({ error: '上传失败' });
      }
      return res.status(500).json({ error: '服务器错误' });
    }

    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ error: '请选择文件' });
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
      for (let i = 0; i < validationResults.length; i++) {
        const r = validationResults[i];
        if (r.status === 'rejected' || !r.value || r.value.ext !== 'flac') {
          invalidFiles.push(decodeFilename(req.files[i].originalname));
        }
      }
      if (invalidFiles.length > 0) {
        cleanupFiles(req.files);
        return res.status(400).json({
          error: `以下文件不是有效的 FLAC 格式: ${invalidFiles.join(', ')}`
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
        const outputFilename = originalStem + '_' + id + '.mp3';
        const outputPath = path.join(outputDir, outputFilename);

        tasks.set(id, {
          percent: 0,
          status: 'converting',
          inputPath,
          outputPath,
          downloadUrl: null,
          errorMessage: null,
          originalName: decodeFilename(file.originalname),
          createdAt: Date.now(),
        });

        taskIds.push(id);
      }

      // Respond immediately with all task IDs
      res.json({ taskIds });

      // Enqueue one conversion per file
      for (let i = 0; i < req.files.length; i++) {
        const file = req.files[i];
        const id = taskIds[i];
        const inputPath = file.path;
        const outputPath = tasks.get(id).outputPath;
        const outputFilename = path.basename(outputPath);

        queue.add(async () => {
          return new Promise((resolve) => {
            function quote(s) { return s.includes(' ') ? `"${s}"` : s; }
            const cmd = [
              quote(FFMPEG_BIN),
              '-y',
              '-i', quote(inputPath),
              '-codec:a', 'libmp3lame',
              '-b:a', '320k',
              '-map_metadata', '0',
              '-id3v2_version', '3',
              '-progress', 'pipe:1',
              '-nostats',
              quote(outputPath),
            ].join(' ');
            console.log(`[${id}] ffmpeg start`);

            const proc = exec(cmd, { timeout: 30 * 60 * 1000, maxBuffer: 16 * 1024 * 1024 });

            let lastPercent = 0;
            let estTotal = 0;

            proc.stdout.on('data', (data) => {
              const match = data.toString().match(/out_time_us=(\d+)/);
              if (match) {
                const outTime = parseInt(match[1], 10) / 1000000;
                const total = estTotal || 1;
                const pct = Math.min(Math.round((outTime / total) * 100), 99);
                if (pct > lastPercent) {
                  lastPercent = pct;
                  const task = tasks.get(id);
                  if (task) task.percent = pct;
                }
              }
            });

            let stderr = '';
            proc.stderr.on('data', (data) => {
              const chunk = data.toString();
              stderr += chunk;
              // Parse Duration from ffmpeg stderr (e.g. "Duration: 00:30:25.10")
              if (!estTotal) {
                const durMatch = chunk.match(/Duration:\s*(\d+):(\d+):(\d+)\.(\d+)/);
                if (durMatch) {
                  estTotal = parseInt(durMatch[1]) * 3600 + parseInt(durMatch[2]) * 60 + parseInt(durMatch[3]) + parseInt(durMatch[4]) / 100;
                  if (estTotal < 1) estTotal = 1;
                }
              }
            });

            proc.on('close', (code) => {
              if (code === 0) {
                const task = tasks.get(id);
                if (task) {
                  task.status = 'done';
                  task.percent = 100;
                  task.downloadUrl = '/downloads/' + encodeURIComponent(outputFilename);
                }
                console.log(`[${id}] complete`);
                resolve();
              } else {
                const task = tasks.get(id);
                if (task) {
                  task.status = 'error';
                  task.errorMessage = '格式转换失败';
                }
                console.error(`[${id}] exit ${code}:`, stderr.slice(-400));
                fs.unlink(outputPath, () => {});
                fs.unlink(inputPath, () => {});
                resolve();
              }
            });

            proc.on('error', (err) => {
              const task = tasks.get(id);
              if (task) {
                task.status = 'error';
                task.errorMessage = '格式转换失败';
              }
              console.error(`[${id}] error:`, err.message);
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

module.exports = router;
