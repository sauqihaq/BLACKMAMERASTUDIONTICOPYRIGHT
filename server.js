/**
 * BlackMamer Studio — Backend Server
 * Handles: YouTube / SoundCloud URL download via yt-dlp + ffmpeg conversion
 * Run: node server.js
 * Port: 3001
 */

const express = require('express');
const cors    = require('cors');
const { execFile, spawn } = require('child_process');
const path    = require('path');
const fs      = require('fs');
const os      = require('os');
const crypto  = require('crypto');

const app  = express();
const PORT = 3001;

app.use(cors());
app.use(express.json());

// Temp directory for downloads
const TMP = path.join(os.tmpdir(), 'bms-studio');
if (!fs.existsSync(TMP)) fs.mkdirSync(TMP, { recursive: true });

/* ── util: clean up temp files ── */
function cleanup(...files) {
  files.forEach(f => { try { if (fs.existsSync(f)) fs.unlinkSync(f); } catch {} });
}

/* ── util: run yt-dlp as promise ── */
function ytDlp(args) {
  return new Promise((resolve, reject) => {
    const proc = spawn('yt-dlp', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    proc.stdout.on('data', d => stdout += d);
    proc.stderr.on('data', d => stderr += d);
    proc.on('close', code => {
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(stderr.slice(-500) || 'yt-dlp failed'));
    });
  });
}

/* ── util: run ffmpeg as promise ── */
function ffmpeg(args) {
  return new Promise((resolve, reject) => {
    const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    proc.stderr.on('data', d => stderr += d);
    proc.on('close', code => {
      if (code === 0) resolve();
      else reject(new Error(stderr.slice(-400) || 'ffmpeg failed'));
    });
  });
}

/* ══════════════════════════════════════════════
   POST /api/convert-url
   Body: { url, format, speed, amp, dur }
   Returns: audio file download
══════════════════════════════════════════════ */
app.post('/api/convert-url', async (req, res) => {
  const { url, format = 'mp3', speed = 4.3, amp = -2, dur = 350 } = req.body;

  if (!url || typeof url !== 'string') {
    return res.status(400).json({ error: 'URL required' });
  }

  // Validate URL (any host) — conversion will be handled by yt-dlp
  try { new URL(url); } catch {
    return res.status(400).json({ error: 'Invalid URL' });
  }


  const id  = crypto.randomBytes(8).toString('hex');
  const raw = path.join(TMP, `${id}_raw`);     // yt-dlp output (no extension yet)
  const out = path.join(TMP, `${id}_out.wav`); // ffmpeg output

  try {
    // 1. Get title for filename
    let title = 'audio';
    try {
      title = await ytDlp(['--get-title', '--no-playlist', url]);
      title = title.replace(/[^\w\s\-]/g,'').trim().slice(0,80) || 'audio';
    } catch {}

    // 2. Download best audio with yt-dlp
    await ytDlp([
      '--no-playlist',
      '--format', 'bestaudio/best',
      '--output', raw + '.%(ext)s',
      '--no-warnings',
      url
    ]);

    // Find the downloaded file (extension unknown)
    const files = fs.readdirSync(TMP).filter(f => f.startsWith(`${id}_raw.`));
    if (!files.length) throw new Error('Download failed — no file produced');
    const rawFile = path.join(TMP, files[0]);

    // 3. ffmpeg: speed + amplify + trim + encode
    const atempo = buildAtempo(parseFloat(speed));
    const gainDb = parseFloat(amp);
    const maxDur = parseInt(dur);
    const safeFormat = ['mp3','wav','ogg','flac','aac'].includes(format) ? format : 'mp3';
    const outExt = safeFormat === 'ogg' ? 'ogg' : safeFormat === 'wav' ? 'wav' : safeFormat === 'flac' ? 'flac' : safeFormat === 'aac' ? 'aac' : 'mp3';
    const outFile = path.join(TMP, `${id}_out.${outExt}`);

    const filterChain = [...atempo, `volume=${gainDb}dB`].join(',');

    const ffArgs = [
      '-y',
      '-i', rawFile,
      '-t', String(maxDur),
      '-af', filterChain,
    ];

    // Codec args per format
    if (safeFormat === 'mp3')  ffArgs.push('-c:a','libmp3lame','-q:a','2');
    else if (safeFormat === 'wav')  ffArgs.push('-c:a','pcm_s16le');
    else if (safeFormat === 'ogg')  ffArgs.push('-c:a','libvorbis','-q:a','6');
    else if (safeFormat === 'flac') ffArgs.push('-c:a','flac');
    else if (safeFormat === 'aac')  ffArgs.push('-c:a','aac','-b:a','192k');

    ffArgs.push(outFile);
    await ffmpeg(ffArgs);

    // 4. Auto-compress to under 20 MB if needed
    const MAX_SIZE = 19.5 * 1024 * 1024; // 19.5 MB — safe buffer below 20 MB
    const finalFile = await compressToLimit(outFile, outExt, MAX_SIZE);
    const finalExt  = path.extname(finalFile).slice(1); // may change if fallback mp3
    const finalSize = fs.statSync(finalFile).size;
    console.log(`[convert-url] Final: ${(finalSize/1024/1024).toFixed(2)} MB (${finalExt})`);

    // 5. Stream file back
    const safeTitle   = title.replace(/[^\w\s\-]/g,'').replace(/\s+/g,'_').trim();
    const normalSpeed = (1 / parseFloat(speed)).toFixed(3);
    const dlName      = `BMS_${safeTitle}_rblx.${finalExt}`;

    res.setHeader('Content-Disposition', `attachment; filename="${dlName}"`);
    res.setHeader('Content-Type', mimeType(finalExt));
    res.setHeader('X-Title', encodeURIComponent(title));
    res.setHeader('X-Normal-Speed', normalSpeed);
    res.setHeader('X-File-Size-MB', (finalSize / 1024 / 1024).toFixed(2));

    const stream = fs.createReadStream(finalFile);
    stream.pipe(res);
    stream.on('end',  () => cleanup(rawFile, finalFile, outFile));
    stream.on('error',() => cleanup(rawFile, finalFile, outFile));

  } catch (err) {
    cleanup(raw + '.webm', raw + '.m4a', raw + '.mp3', out);
    console.error('[convert-url]', err.message);
    return res.status(500).json({ error: err.message });
  }
});

/* ══════════════════════════════════════════════
   GET /api/info?url=...
   Returns: { title, duration, thumbnail, uploader }
══════════════════════════════════════════════ */
app.get('/api/info', async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: 'URL required' });

  try {
    const json = await ytDlp([
      '--no-playlist', '--dump-json', '--no-warnings', url
    ]);
    const data = JSON.parse(json);
    res.json({
      title: data.title || 'Unknown',
      duration: data.duration,
      thumbnail: data.thumbnail,
      uploader: data.uploader || data.channel || '',
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ── Health check ── */
app.get('/api/health', (_, res) => res.json({ ok: true, version: '1.0.0' }));

/* ── util: compress file to under maxBytes by re-encoding at lower bitrate ── */
async function compressToLimit(inputFile, outExt, maxBytes = 19.5 * 1024 * 1024) {
  const size = fs.statSync(inputFile).size;
  if (size <= maxBytes) return inputFile; // already under limit

  // Bitrate ladder to try (kbps), from decent to minimum
  const bitrates = [192, 128, 96, 64, 48, 32];
  const compFile = inputFile.replace(/(\.\w+)$/, '_compressed$1');

  for (const br of bitrates) {
    const ffArgs = ['-y', '-i', inputFile, '-b:a', `${br}k`];
    if (outExt === 'mp3')       ffArgs.push('-c:a', 'libmp3lame');
    else if (outExt === 'ogg')  ffArgs.push('-c:a', 'libvorbis');
    else if (outExt === 'aac')  ffArgs.push('-c:a', 'aac');
    else if (outExt === 'flac') { /* flac is lossless — skip bitrate compression, truncate instead */ break; }
    else                         ffArgs.push('-c:a', 'pcm_s16le'); // wav — bitrate doesn't apply, fall through
    ffArgs.push(compFile);

    try {
      await ffmpeg(ffArgs);
      const newSize = fs.statSync(compFile).size;
      console.log(`[compress] ${br}kbps → ${(newSize/1024/1024).toFixed(2)} MB`);
      if (newSize <= maxBytes) {
        cleanup(inputFile); // remove uncompressed original
        return compFile;
      }
      cleanup(compFile);
    } catch (e) {
      console.warn(`[compress] ${br}kbps failed:`, e.message);
    }
  }

  // Last resort for wav/flac: convert to mp3 at 64kbps
  const fallbackFile = inputFile.replace(/\.\w+$/, '_fallback.mp3');
  try {
    await ffmpeg(['-y', '-i', inputFile, '-c:a', 'libmp3lame', '-b:a', '64k', fallbackFile]);
    const finalSize = fs.statSync(fallbackFile).size;
    if (finalSize <= maxBytes) {
      cleanup(inputFile);
      console.log(`[compress] fallback mp3 64k → ${(finalSize/1024/1024).toFixed(2)} MB`);
      return fallbackFile;
    }
    cleanup(fallbackFile);
  } catch {}

  console.warn('[compress] Could not compress below limit, returning original');
  return inputFile; // return as-is if all attempts fail
}

/* ── util: atempo chain (ffmpeg atempo max is 2.0 per filter) ── */
function buildAtempo(speed) {
  // atempo range: 0.5–100 per filter in modern ffmpeg, but chain for safety
  if (speed >= 0.5 && speed <= 100) return [`atempo=${speed.toFixed(4)}`];
  // fallback chain
  const filters = [];
  let s = speed;
  while (s > 2.0) { filters.push('atempo=2.0'); s /= 2.0; }
  while (s < 0.5) { filters.push('atempo=0.5'); s /= 0.5; }
  filters.push(`atempo=${s.toFixed(4)}`);
  return filters;
}

function mimeType(ext) {
  const m = { mp3:'audio/mpeg', wav:'audio/wav', ogg:'audio/ogg', flac:'audio/flac', aac:'audio/aac' };
  return m[ext] || 'audio/mpeg';
}

app.listen(PORT, () => {
  console.log(`\n✅ BlackMamer Studio Backend`);
  console.log(`   Running on http://localhost:${PORT}`);
  console.log(`   Endpoints:`);
  console.log(`     GET  /api/health`);
  console.log(`     GET  /api/info?url=...`);
  console.log(`     POST /api/convert-url\n`);
});
