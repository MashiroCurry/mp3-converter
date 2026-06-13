# Multi-Format Audio Converter (FLAC / WAV / MP3)

A single-page web application for batch converting between FLAC, WAV, and MP3 — all 9 input→output combinations supported. Built with Express 5 + vanilla JavaScript frontend, powered by ffmpeg for transcoding.

> [中文版](README.zh.md)

## Features

- **Multi-Format Batch Conversion** — Convert between FLAC, WAV, and MP3 in any direction (9 combinations)
- **Same-Format Stream Copy** — Converting a file to its own format uses `-codec:a copy` for lossless passthrough
- **Drag & Drop** — Drag files onto the page or click to select; duplicate files (same name + size + lastModified) auto-skipped
- **Magic Number Validation** — Reads file header signatures (`fLaC` for FLAC, `RIFF....WAVE` for WAV, `ID3`/MPEG sync for MP3) to prevent extension spoofing
- **Real-time Progress** — Dual-phase display: upload progress (0–50%) + transcoding progress (50–100%), delivered via SSE (Server-Sent Events)
- **Download Links** — Download converted files with original filenames restored (UUID stripped automatically)
- **Concurrency Control** — Maximum 2 simultaneous ffmpeg processes; additional tasks are queued (max 10)
- **Automatic Cleanup** — Temporary files auto-deleted after 30 minutes; task data expires after 60 minutes
- **Graceful Shutdown** — On `SIGTERM`/`SIGINT`, all active ffmpeg processes are terminated and the HTTP server shuts down cleanly

## Tech Stack

| Layer          | Technology                                                   |
| -------------- | ------------------------------------------------------------ |
| Backend        | Node.js + Express 5                                          |
| Frontend       | Vanilla JavaScript (no framework)                            |
| Transcoder     | ffmpeg (binary provided by `@ffmpeg-installer/ffmpeg`)       |
| File Upload    | multer 2                                                     |
| File Validation| file-type (reads magic number from file header)              |
| Concurrency    | p-queue                                                      |
| Real-time Comms| Server-Sent Events (SSE)                                     |
| Rate Limiting  | express-rate-limit                                           |

## Quick Start

### Prerequisites

- Node.js ≥ 18
- **Windows only** (ffmpeg path is hardcoded to `C:/ffmpeg/`; see [Design Notes](#ffmpeg-path-handling))
- Administrator privileges may be required on first run to create `C:/ffmpeg/`

### Install & Launch

```bash
# Clone the repository
git clone <repo-url>
cd flac-to-mp3-converter

# Install dependencies
npm install

# Start the server (listens on port 3000 by default)
npm start
```

Visit `http://localhost:3000` after startup.

On first launch, the ffmpeg binary is automatically copied to `C:/ffmpeg/ffmpeg.exe`. The `uploads/` and `outputs/` directories are also auto-created.

### Custom Port

```bash
PORT=8080 npm start
```

### Single-File Executable (Windows)

Build a standalone `.exe` (~253 MB) that includes Node.js runtime, ffmpeg, and the application — no dependencies required on the target machine:

```bash
npm run build
```

Output: `dist/mp3-converter.exe`

The executable uses Node.js SEA (Single Executable Application) technology. Just double-click or run from terminal — no Node.js or ffmpeg installation needed. On first run it extracts ffmpeg to `C:/ffmpeg/ffmpeg.exe`.

> **Note**: Antivirus software may flag the executable due to binary-in-binary packaging. This is a false positive.

## API

### POST /api/convert

Upload audio files (FLAC / WAV / MP3) and begin conversion.

- **Content-Type**: `multipart/form-data`
- **Field name**: `files` (accepts multiple files)
- **Field name**: `targetFormat` — one of `mp3`, `wav`, `flac` (required, shared across all uploaded files)
- **Limits**: 500 MB max per file, 10 files max per request, `.flac` / `.wav` / `.mp3` extensions only
- **Rate-limited**: 30 requests per 15 minutes to `/api/` endpoints

**Success Response** (200):

```json
{
  "taskIds": ["uuid-1", "uuid-2"]
}
```

**Error Responses**:

| Status | Description                                   |
| ------ | --------------------------------------------- |
| 400    | Invalid file format / not a valid audio file  |
| 413    | File exceeds 500 MB limit                     |
| 429    | Too many requests / Queue full (10 tasks max) |
| 507    | Insufficient server disk space (< 1 GB)        |

### GET /api/progress/:taskId

SSE endpoint for a single task. Connection is held open during conversion; receives updates every 500ms. Times out after **12 minutes** (note: this differs from the batch endpoint).

**Event Types**:

| Event        | Description                                  |
| ------------ | -------------------------------------------- |
| `progress`   | Progress update, `{ percent: 0-100 }`        |
| `complete`   | Conversion finished, `{ downloadUrl }`        |
| `task-error` | Conversion failed / task expired             |

### GET /api/batch-progress?ids=id1,id2,id3

SSE endpoint for multiple tasks. Polls every 1000ms. Sends `progress`, `complete`, and `task-error` events — each includes a `taskId` field for disambiguation. Connection auto-closes when all tasks complete. Times out after **30 minutes**.

Example:
```bash
curl -N "http://localhost:3000/api/batch-progress?ids=task1-uuid,task2-uuid"
```

### GET /downloads/:filename

Downloads the converted file. The UUID portion of the filename is automatically stripped to restore the original filename.

> **Download link validity**: Links remain valid as long as the server is running and the file is less than 30 minutes old. Restarting the server invalidates all previous download links.

## Browser Compatibility

Chrome, Firefox, Edge, Safari (modern versions). Requires EventSource (SSE), Drag & Drop API, `fetch`, and `FormData` support.

## Project Structure

```
flac-to-mp3-converter/
├── server.js                # Entry point: Express config, middleware, cleanup timers
├── build-sea.js             # SEA single-file executable build script
├── routes/
│   ├── convert.js           # POST /api/convert — upload, magic validation, ffmpeg queue
│   └── progress.js          # SSE endpoints — single-task & batch progress push
├── public/
│   ├── index.html           # Frontend page (zh-CN)
│   ├── js/
│   │   └── app.js           # Upload logic, SSE listener, format selector, donation modal
│   └── css/
│       └── style.css        # Dark theme, responsive (≤520px)
├── uploads/                 # Upload temp directory (gitignored, auto-created)
├── outputs/                 # Transcoding output directory (gitignored, auto-created)
├── dist/                    # SEA build output (gitignored)
├── package.json
├── README.md
├── README.zh.md
└── CHANGELOG.md
```

## Configuration

All tunable parameters are centralized in the `CONFIG` object at the top of [server.js](server.js). Edit the file before starting the server to change values.

| Parameter                     | Default     | Description                        |
| ----------------------------- | ----------- | ---------------------------------- |
| `PORT`                        | 3000        | Server port                        |
| `MAX_FILE_SIZE`               | 500 MB      | Max size per file                  |
| `MP3_BITRATE`                 | `320k`      | MP3 output bitrate                 |
| `MAX_CONCURRENT_CONVERSIONS`  | 2           | Parallel transcoding count         |
| `MAX_QUEUE_SIZE`              | 10          | Queue capacity                     |
| `MAX_FILES_PER_REQUEST`       | 10          | Max files per request              |
| `PROGRESS_TIMEOUT_MS`         | 30 min      | SSE progress timeout (batch)       |
| `FILE_MAX_AGE_MS`             | 30 min      | Temp file retention period         |
| `CLEANUP_INTERVAL_MS`         | 10 min      | Cleanup task interval              |

## Design Notes

### ffmpeg Path Handling

On Windows, `child_process.spawn` cannot handle paths containing spaces. To work around this, the ffmpeg binary from `@ffmpeg-installer/ffmpeg` is copied to `C:/ffmpeg/ffmpeg.exe` (a space-free path) on startup. This is why the current version only supports Windows.

> **For macOS/Linux users**: Modify `FFMPEG_DIR` in `routes/convert.js` and use a system-installed ffmpeg instead of `@ffmpeg-installer/ffmpeg`.

### Transcoder Selection Logic

The `buildFfmpegArgs()` function in `routes/convert.js` selects the codec pair based on input→output:
- **Different formats**: Uses specific encoders — `libmp3lame` (MP3), `pcm_s16le` (WAV), `flac` (FLAC)
- **Same format**: Uses `-codec:a copy` for lossless stream copy (no re-encoding)

### Concurrency Model

`p-queue` limits simultaneous ffmpeg processes to 2 to prevent CPU and memory overload. The queue capacity is 10; exceeding it returns HTTP 429. Queue size checks are atomic (JavaScript single-threaded, no `await` between check and add).

### In-Memory State

Task state is stored in an in-memory `Map` shared across routes via Express `app.locals`. This means:
- All in-progress and completed task information is lost on server restart
- Download links for completed tasks are only valid while the server is running

### Security Measures

- **No shell injection**: ffmpeg is called via `child_process.spawn` with an arguments array (no shell intermediary)
- **Magic number validation**: File header signatures are verified before any conversion begins (`Promise.allSettled` ensures all files pass before the queue starts)
- **Extension filtering**: Backend filters `.flac`/`.wav`/`.mp3` extensions via multer
- **Path traversal prevention**: Download route uses `path.basename()` to constrain filenames
- **Rate limiting**: 30 requests per 15 minutes to `/api/` endpoints via `express-rate-limit`
- **Security headers**: Inline middleware sets CORS, X-Content-Type-Options, X-Frame-Options, Referrer-Policy, Permissions-Policy
- **Disk space check**: `fs.statfsSync` verifies ≥1 GB free before accepting uploads

### Graceful Shutdown

On `SIGTERM`/`SIGINT`:
1. `routes/convert.js` exports a `shutdown()` method
2. Iterates `activeProcesses` Set and kills all running ffmpeg processes
3. HTTP server closes with a 10-second forced exit timeout

## Troubleshooting

| Problem                          | Likely Cause                              | Fix                                                  |
| -------------------------------- | ----------------------------------------- | ---------------------------------------------------- |
| ffmpeg copy fails on startup     | Permission denied on `C:\ffmpeg\`         | Run terminal as Administrator, or create the dir manually |
| Port 3000 already in use         | Another service is using the port         | Use `PORT=8080 npm start`, or stop the other process |
| "Task expired" error             | Server was restarted / task > 60 min old  | Re-upload the file                                   |
| Upload fails mid-way             | File exceeds 500 MB limit                 | Split the file or adjust `MAX_FILE_SIZE`             |
| "请求过于频繁" (429)            | Too many API requests                     | Wait ~15 minutes before retrying                     |
| MP3 download has no metadata     | ffmpeg `map_metadata` limitations         | Some metadata (cover art) can't be preserved to MP3  |
| Antivirus flags the .exe         | Binary-in-binary SEA packaging            | This is a false positive; add an exclusion rule      |

## FAQ

**Q: Where did my files go after a server restart?**  
A: All task state and download links are stored in memory — restarting the server clears them. File artifacts are deleted from disk after 30 minutes. Download your files promptly.

**Q: Why can only 2 files transcode at a time?**  
A: This prevents CPU and memory overload. You can upload up to 10 files — they queue and process sequentially.

**Q: Can I change the output bitrate or format?**  
A: Bitrate is adjustable via `MP3_BITRATE` in the `CONFIG` object. Output format is selected in the UI (MP3 / WAV / FLAC radio cards).

**Q: Can this run on Linux or macOS?**  
A: Not without modification — the ffmpeg path is hardcoded to `C:/ffmpeg/`. See [Design Notes](#ffmpeg-path-handling) for migration guidance.

**Q: Where is the `donate-qr.png` image?**  
A: Place it in the project root directory. The filename is obfuscated at runtime to prevent hotlinking.

**Q: Is my usage being tracked?**  
A: The application uses Google Analytics, Baidu Analytics, and Plausible for anonymous usage tracking. No audio files or personal data are sent to analytics services.

## License

ISC
