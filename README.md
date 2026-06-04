# FLAC → MP3 Converter

A single-page web application for batch converting FLAC lossless audio to MP3. Built with Express 5 + vanilla JavaScript frontend, powered by ffmpeg for transcoding.

> [中文版](README.zh.md)

## Features

- **Batch Conversion** — Upload up to 10 FLAC files at once, transcoded sequentially
- **Drag & Drop** — Drag files onto the page or click to select
- **Magic Number Validation** — Verifies the `fLaC` file header signature to ensure files are genuine FLAC, preventing extension spoofing
- **Real-time Progress** — Dual-phase display: upload progress + transcoding progress, delivered via SSE (Server-Sent Events)
- **Download Links** — Direct MP3 download available upon completion
- **Concurrency Control** — Maximum 2 simultaneous ffmpeg processes; additional tasks are queued
- **Automatic Cleanup** — Temporary files auto-deleted after 30 minutes; task data expires after 60 minutes

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

## Quick Start

### Prerequisites

- Node.js ≥ 18
- Windows (ffmpeg path is hardcoded to `C:/ffmpeg/`; see [Design Notes](#design-notes))

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

On first launch, the ffmpeg binary is automatically copied to `C:/ffmpeg/ffmpeg.exe`.

### Custom Port

```bash
PORT=8080 npm start
```

## API

### POST /api/convert

Upload FLAC files and begin conversion.

- **Content-Type**: `multipart/form-data`
- **Field name**: `files` (accepts multiple)
- **Limits**: 500 MB max per file, 10 files max per request, `.flac` extension only

**Success Response** (200):

```json
{
  "taskIds": ["uuid-1", "uuid-2"]
}
```

**Error Responses**:

| Status | Description                          |
| ------ | ------------------------------------ |
| 400    | Invalid file format / not a FLAC file|
| 413    | File exceeds 500 MB limit            |
| 429    | Queue full (10 tasks max)            |
| 507    | Insufficient server disk space       |

### GET /api/progress/:taskId

SSE endpoint. Listens for progress updates for a single task.

**Event Types**:

| Event       | Description                             |
| ----------- | --------------------------------------- |
| `progress`  | Progress update, `{ percent: 0-100 }`   |
| `complete`  | Conversion finished, `{ downloadUrl }`  |
| `task-error`| Conversion failed / task expired        |

### GET /api/batch-progress?ids=id1,id2,id3

SSE endpoint. Listens for progress updates across multiple tasks. Each event includes an additional `taskId` field for disambiguation.

### GET /downloads/:filename

Downloads the converted MP3 file. The UUID portion of the filename is automatically stripped, restoring the original filename on download.

## Project Structure

```
flac-to-mp3-converter/
├── server.js                # Entry point: Express config, middleware, cleanup timers
├── routes/
│   ├── convert.js           # POST /api/convert — upload, validation, transcoding queue
│   └── progress.js          # SSE endpoints — single-task & batch progress push
├── public/
│   ├── index.html           # Frontend page
│   ├── js/
│   │   └── app.js           # Upload logic, SSE listener, donation modal
│   └── css/
│       └── style.css        # Dark theme styles
├── uploads/                 # Upload temp directory (gitignored)
├── outputs/                 # Transcoding output directory (gitignored)
├── package.json
├── README.md
└── README.zh.md
```

## Configuration

All tunable parameters are centralized in the `CONFIG` object at the top of [server.js](server.js):

| Parameter                     | Default     | Description                        |
| ----------------------------- | ----------- | ---------------------------------- |
| `PORT`                        | 3000        | Server port                        |
| `MAX_FILE_SIZE`               | 500 MB      | Max size per file                  |
| `MP3_BITRATE`                 | `320k`      | MP3 output bitrate                 |
| `MAX_CONCURRENT_CONVERSIONS`  | 2           | Parallel transcoding count         |
| `MAX_QUEUE_SIZE`              | 10          | Queue capacity                     |
| `MAX_FILES_PER_REQUEST`       | 10          | Max files per request              |
| `PROGRESS_TIMEOUT_MS`         | 30 min      | SSE progress timeout               |
| `FILE_MAX_AGE_MS`             | 30 min      | Temp file retention period         |
| `CLEANUP_INTERVAL_MS`         | 10 min      | Cleanup task interval              |

## Design Notes

### ffmpeg Path Handling

On Windows, `child_process.exec` cannot handle paths containing spaces. To work around this, the ffmpeg binary from `@ffmpeg-installer/ffmpeg` is copied to `C:/ffmpeg/ffmpeg.exe` (a space-free path) on startup. This is why the current version only supports Windows.

### Concurrency Model

`p-queue` limits simultaneous ffmpeg processes to 2 to prevent CPU and memory overload. The queue capacity is 10; exceeding it returns HTTP 429.

### In-Memory State

Task state is stored in an in-memory `Map` shared across routes via Express `app.locals`. This means:
- All in-progress and completed task information is lost on server restart
- Download links for completed tasks are only valid while the server is running

### Unused Dependencies

The `fluent-ffmpeg` and `ffmpeg-static` packages in `package.json` are not actually used. Due to the same space-in-path issue, the code invokes ffmpeg directly via `child_process.exec` instead.

## License

ISC
