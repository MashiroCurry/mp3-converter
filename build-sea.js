/**
 * SEA Build Script
 * ===============
 * Creates dist/mp3-converter.exe — a self-contained single executable.
 *
 * Usage:  node build-sea.js
 * Output: dist/mp3-converter.exe
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = __dirname;
const DIST = path.join(ROOT, 'dist');

function mkdir(d) { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); }
mkdir(DIST);

// ══════════════════════════════════════════════════════════════════════════════
// Step 1: Collect static assets (public/)
// ══════════════════════════════════════════════════════════════════════════════

console.log('1/5  Collecting static assets...');
const assets = {};
function walk(dir, urlPrefix) {
  if (!fs.existsSync(dir)) return;
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    const urlPath = (urlPrefix + '/' + name).replace(/\\/g, '/');
    if (fs.statSync(full).isDirectory()) {
      walk(full, urlPath);
    } else {
      const ext = path.extname(name).toLowerCase();
      const mimeMap = {
        '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
        '.js': 'application/javascript; charset=utf-8', '.png': 'image/png',
        '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.svg': 'image/svg+xml',
        '.ico': 'image/x-icon', '.json': 'application/json',
      };
      assets[urlPath] = {
        mime: mimeMap[ext] || 'application/octet-stream',
        b64: fs.readFileSync(full).toString('base64'),
      };
    }
  }
}
walk(path.join(ROOT, 'public'), '');
console.log(`   ${Object.keys(assets).length} static files collected`);

// ══════════════════════════════════════════════════════════════════════════════
// Step 2: Embed ffmpeg.exe
// ══════════════════════════════════════════════════════════════════════════════

console.log('2/5  Embedding ffmpeg binary...');
const ffmpegSrc = path.join(ROOT, 'node_modules', '@ffmpeg-installer', 'win32-x64', 'ffmpeg.exe');
if (!fs.existsSync(ffmpegSrc)) { console.error('ERROR: ffmpeg.exe not found!'); process.exit(1); }
const ffmpegB64 = fs.readFileSync(ffmpegSrc).toString('base64');
console.log(`   ffmpeg.exe embedded (${(fs.statSync(ffmpegSrc).size / 1024 / 1024).toFixed(1)} MB → ${(Buffer.byteLength(ffmpegB64, 'utf8') / 1024 / 1024).toFixed(1)} MB base64)`);

// ══════════════════════════════════════════════════════════════════════════════
// Step 3: Write the SEA entry point (processed by esbuild)
// ══════════════════════════════════════════════════════════════════════════════

console.log('3/5  Writing SEA entry point...');

// This entry file does three things before loading the server:
// 1. Extracts ffmpeg.exe from embedded base64 → C:/ffmpeg/ffmpeg.exe (once)
// 2. Mocks @ffmpeg-installer/ffmpeg so the require() in server.js succeeds
// 3. Replaces express.static with an embedded-asset-aware version

const seaEntryContent = `// ─── SEA entry point (pre-processor shim) ───────────────────────────────
const path = require('path');
const fs = require('fs');

// --- Embedded data (injected at build time) ---
const EMBEDDED_ASSETS = ${JSON.stringify(assets)};
const FFMPEG_B64 = ${JSON.stringify(ffmpegB64)};

// --- Extract ffmpeg on first run ---
// server.js wraps its @ffmpeg-installer/ffmpeg require in try/catch,
// so it gracefully degrades when the package isn't available (SEA mode).
// We just need to make sure ffmpeg.exe is on disk before the server starts.
const FFMPEG_DIR = 'C:/ffmpeg';
const FFMPEG_BIN = path.join(FFMPEG_DIR, 'ffmpeg.exe');
if (!fs.existsSync(FFMPEG_BIN)) {
  try {
    fs.mkdirSync(FFMPEG_DIR, { recursive: true });
    fs.writeFileSync(FFMPEG_BIN, Buffer.from(FFMPEG_B64, 'base64'));
  } catch (e) {
    console.error('WARNING: Could not extract ffmpeg to', FFMPEG_BIN, e.message);
  }
}

// --- Replace express.static with embedded-asset version ---
// In SEA, there's no real filesystem for public/ — everything must come from
// the embedded assets map. We wrap express.static so it checks embedded assets
// first, and falls through to the real filesystem only if no match.
const express = require('express');
const _origExpressStatic = express.static;

express.static = function embeddedStatic(root, options) {
  return function serveAssets(req, res, next) {
    let urlPath = req.path || '/';
    if (urlPath === '/') urlPath = '/index.html';

    let asset = EMBEDDED_ASSETS[urlPath];

    if (!asset) {
      asset = EMBEDDED_ASSETS[urlPath + 'index.html'] ||
              EMBEDDED_ASSETS[urlPath.replace(/\\/$/, '') + '/index.html'];
    }

    if (asset) {
      const buf = Buffer.from(asset.b64, 'base64');
      res.writeHead(200, {
        'Content-Type': asset.mime,
        'Content-Length': buf.length,
        'Cache-Control': 'public, max-age=3600',
      });
      res.end(buf);
      return;
    }

    // Not embedded → let real filesystem handle it (e.g. /downloads/)
    next();
  };
};

// --- Now load the main server ---
require('./server');
`;

fs.writeFileSync(path.join(DIST, 'sea-entry.js'), seaEntryContent, 'utf8');

// ══════════════════════════════════════════════════════════════════════════════
// Step 4: Bundle everything with esbuild
// ══════════════════════════════════════════════════════════════════════════════

console.log('4/5  Bundling with esbuild...');

// Copy server.js to dist/ so esbuild can resolve './server'
fs.copyFileSync(
  path.join(ROOT, 'server.js'),
  path.join(DIST, 'server.js')
);
// Copy routes to dist/
const distRoutes = path.join(DIST, 'routes');
mkdir(distRoutes);
fs.copyFileSync(path.join(ROOT, 'routes', 'convert.js'), path.join(distRoutes, 'convert.js'));
fs.copyFileSync(path.join(ROOT, 'routes', 'progress.js'), path.join(distRoutes, 'progress.js'));

// Bundle: sea-entry.js is the entry point, it requires ./server which requires ./routes/*
// esbuild resolves all of this into a single file.
// We externalize @ffmpeg-installer/* because sea-entry.js mocks it at runtime.
execSync(
  `npx esbuild "${path.join(DIST, 'sea-entry.js')}" ` +
  `--bundle --platform=node --target=node18 ` +
  `--outfile="${path.join(DIST, 'sea-bundle.js')}" ` +
  `--external:@ffmpeg-installer/ffmpeg --external:@ffmpeg-installer/win32-x64 ` +
  `--format=cjs --minify=false`,
  { cwd: ROOT, stdio: 'inherit', maxBuffer: 50 * 1024 * 1024 }
);

const bundleSize = (fs.statSync(path.join(DIST, 'sea-bundle.js')).size / 1024 / 1024).toFixed(1);
console.log(`   sea-bundle.js created (${bundleSize} MB)`);

// ══════════════════════════════════════════════════════════════════════════════
// Step 5: Generate SEA blob and inject
// ══════════════════════════════════════════════════════════════════════════════

console.log('5/5  Creating SEA executable...');

const seaConfig = {
  main: path.join(DIST, 'sea-bundle.js'),
  output: path.join(DIST, 'sea-prep.blob'),
  disableExperimentalSEAWarning: true,
  useSnapshot: false,
  useCodeCache: true,
};
fs.writeFileSync(path.join(DIST, 'sea-config.json'), JSON.stringify(seaConfig, null, 2));

execSync(
  `node --experimental-sea-config "${path.join(DIST, 'sea-config.json')}"`,
  { cwd: ROOT, stdio: 'inherit', maxBuffer: 50 * 1024 * 1024 }
);
console.log(`   sea-prep.blob generated (${(fs.statSync(path.join(DIST, 'sea-prep.blob')).size / 1024 / 1024).toFixed(1)} MB)`);

// Copy node.exe and inject blob
const targetExe = path.join(DIST, 'mp3-converter.exe');

// If a previous exe exists, remove it first (avoids postject write errors)
if (fs.existsSync(targetExe)) fs.unlinkSync(targetExe);
fs.copyFileSync(process.execPath, targetExe);

// Inject the SEA blob with postject
// postject sometimes prints warnings about corrupted signatures (expected)
// and may exit with non-zero code. We use stdio:'pipe' and check file size.
const sentinel = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2';
const blob = path.join(DIST, 'sea-prep.blob');
const preSize = fs.statSync(targetExe).size;

try {
  execSync(
    `npx --yes postject "${targetExe}" NODE_SEA_BLOB "${blob}" --sentinel-fuse ${sentinel}`,
    { cwd: ROOT, stdio: 'pipe', maxBuffer: 50 * 1024 * 1024, timeout: 120000 }
  );
} catch (e) {
  // postject may throw even on success (warnings go to stderr).
  // Check if the file actually grew — that means injection worked.
  const postSize = fs.existsSync(targetExe) ? fs.statSync(targetExe).size : 0;
  if (postSize <= preSize + 1000000) {
    // Size didn't grow enough — injection likely failed
    console.error('postject error:', e.stderr ? e.stderr.toString().slice(0, 500) : e.message);
    console.error('Injection appears to have failed. Trying once more...');
    // Retry once after a short delay
    try {
      execSync(
        `npx --yes postject "${targetExe}" NODE_SEA_BLOB "${blob}" --sentinel-fuse ${sentinel}`,
        { cwd: ROOT, stdio: 'pipe', maxBuffer: 50 * 1024 * 1024, timeout: 120000 }
      );
    } catch (e2) {
      const finalSize = fs.statSync(targetExe).size;
      if (finalSize <= preSize + 1000000) {
        console.error('postject failed twice. File size:', finalSize);
        process.exit(1);
      }
    }
  }
}

const exeSize = (fs.statSync(targetExe).size / 1024 / 1024).toFixed(1);
console.log(`\n✓  SUCCESS:  dist/mp3-converter.exe  (${exeSize} MB)`);
console.log('   Double-click to run the converter.\n');

// Keep sea-config.json for potential rebuilds, clean up the rest
['sea-entry.js', 'sea-bundle.js', 'server.js'].forEach(f => {
  const p = path.join(DIST, f);
  if (fs.existsSync(p)) fs.unlinkSync(p);
});
const rd = path.join(DIST, 'routes');
if (fs.existsSync(rd)) {
  fs.unlinkSync(path.join(rd, 'convert.js'));
  fs.unlinkSync(path.join(rd, 'progress.js'));
  fs.rmdirSync(rd);
}
