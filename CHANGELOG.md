# Changelog

## [1.4.0] — 2026-07-15

### Added

- Advanced audio options: sample rate selector (original / 44100 / 48000 / 96000 Hz)
- Bit depth selector (original / 16 bit / 24 bit / 32 float)
- Desktop layout enhancement: wider card (560px) with increased horizontal padding

### Changed

- Codebase reformatted with Prettier (consistent single quotes, spacing, line breaks)
- Updated donate QR image

### Removed

- Prettier hook temporarily disabled (CI compatibility)

## [1.1.0] — 2026-06-12

### Added

- Multi-format batch conversion: FLAC, WAV, MP3 interconversion (9 input→output combinations)
- Format selector UI in the frontend (radio cards: MP3 / WAV / FLAC)
- Same-format stream copy (`-codec:a copy` lossless passthrough)
- Magic number validation for WAV (`RIFF....WAVE`) and MP3 (`ID3`/MPEG sync) file headers
- `targetFormat` field in the upload API to specify output format
- Batch SSE progress endpoint (`/api/batch-progress`) for multi-task monitoring
- Security headers middleware (CORS, X-Content-Type-Options, X-Frame-Options, etc.)
- `express-rate-limit` (30 requests per 15 minutes to `/api/`)
- Graceful shutdown handler (`SIGTERM`/`SIGINT` kills active ffmpeg processes)
- SEA single-file executable build (`npm run build` → `dist/mp3-converter.exe`)
- File name encoding fix for Chinese UTF-8 filenames in multipart uploads
- Disk space check before accepting uploads (`fs.statfsSync`, ≥1 GB required)

### Changed

- README.md fully rewritten for multi-format support (English & Chinese)
- Server startup now auto-copies ffmpeg to `C:/ffmpeg/ffmpeg.exe` (space-free path workaround)

### Removed

- Unused npm dependencies (cleanup)
- `dist/` directory added to `.gitignore`

## [1.0.0] — 2026-05-31

### Added

- Initial FLAC to MP3 batch converter
- Single-page web UI with drag-and-drop upload
- Dual-phase progress display (upload 0–50% + transcoding 50–100%) via SSE
- Magic number validation for FLAC files (`fLaC` header signature)
- Concurrent ffmpeg process management via `p-queue` (max 2 simultaneous)
- Download links with original filename restoration (UUID stripping)
- Automatic cleanup of temp files (30 min) and task data (60 min)
- Donation modal with QR code (focus trap, `aria-hidden`+`inert`, toast notifications)
- Analytics integration (Google Analytics, Baidu Analytics, Plausible)
- Dark theme, responsive layout (≤520px)
- Bilingual README (English / Chinese)
- ISC License
