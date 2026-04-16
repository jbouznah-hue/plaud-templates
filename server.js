import express from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import multer from 'multer';
import { v4 as uuidv4 } from 'uuid';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';
import ffmpeg from 'fluent-ffmpeg';
import ffmpegPath from 'ffmpeg-static';
import PDFDocument from 'pdfkit';
import nodemailer from 'nodemailer';

ffmpeg.setFfmpegPath(ffmpegPath);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

const DATA_DIR = '/data';
const TEMPLATES_FILE = path.join(DATA_DIR, 'templates.json');
const CATEGORIES_FILE = path.join(DATA_DIR, 'categories.json');
const UPLOADS_DIR = path.join(DATA_DIR, 'uploads');
const JOBS_DIR = path.join(DATA_DIR, 'jobs');
const RESULTS_DIR = path.join(DATA_DIR, 'results');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const JWT_SECRET_FILE = path.join(DATA_DIR, '.jwt_secret');

// Create all directories on startup
for (const dir of [DATA_DIR, UPLOADS_DIR, JOBS_DIR, RESULTS_DIR]) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}
if (!fs.existsSync(TEMPLATES_FILE)) fs.writeFileSync(TEMPLATES_FILE, '[]');
if (!fs.existsSync(CATEGORIES_FILE)) fs.writeFileSync(CATEGORIES_FILE, '[]');
if (!fs.existsSync(USERS_FILE)) fs.writeFileSync(USERS_FILE, '[]');

// JWT Secret
let JWT_SECRET;
if (fs.existsSync(JWT_SECRET_FILE)) {
  JWT_SECRET = fs.readFileSync(JWT_SECRET_FILE, 'utf-8').trim();
} else {
  JWT_SECRET = process.env.JWT_SECRET || uuidv4() + uuidv4();
  fs.writeFileSync(JWT_SECRET_FILE, JWT_SECRET);
}

app.use(express.json());
app.use(express.static(__dirname));

// Helpers
function readJSON(file) { return JSON.parse(fs.readFileSync(file, 'utf-8')); }
function writeJSON(file, data) { fs.writeFileSync(file, JSON.stringify(data, null, 2)); }

function readJob(id) {
  const p = path.join(JOBS_DIR, `${id}.json`);
  if (!fs.existsSync(p)) return null;
  return readJSON(p);
}
function writeJob(job) {
  writeJSON(path.join(JOBS_DIR, `${job.id}.json`), job);
}
function readResult(id) {
  const p = path.join(RESULTS_DIR, `${id}.json`);
  if (!fs.existsSync(p)) return null;
  return readJSON(p);
}
function writeResult(result) {
  writeJSON(path.join(RESULTS_DIR, `${result.id}.json`), result);
}

// Auth middleware
function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing or invalid Authorization header' });
  }
  const token = authHeader.slice(7);
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    const users = readJSON(USERS_FILE);
    const user = users.find(u => u.id === payload.id);
    if (!user) return res.status(401).json({ error: 'User not found' });
    req.user = { id: user.id, email: user.email, name: user.name };
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

// ─── AUTH ─────────────────────────────────────────────────────────────────────

app.post('/api/auth/register', async (req, res) => {
  try {
    const { email, password, name } = req.body;
    if (!email || !password || !name) return res.status(400).json({ error: 'email, password and name are required' });
    const users = readJSON(USERS_FILE);
    if (users.find(u => u.email === email)) return res.status(409).json({ error: 'Email already registered' });
    const hashed = await bcrypt.hash(password, 10);
    const user = { id: uuidv4(), email, name, password: hashed, createdAt: new Date().toISOString() };
    users.push(user);
    writeJSON(USERS_FILE, users);
    const token = jwt.sign({ id: user.id }, JWT_SECRET, { expiresIn: '30d' });
    res.status(201).json({ token, user: { id: user.id, email: user.email, name: user.name } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'email and password are required' });
    const users = readJSON(USERS_FILE);
    const user = users.find(u => u.email === email);
    if (!user) return res.status(401).json({ error: 'Invalid credentials' });
    const match = await bcrypt.compare(password, user.password);
    if (!match) return res.status(401).json({ error: 'Invalid credentials' });
    const token = jwt.sign({ id: user.id }, JWT_SECRET, { expiresIn: '30d' });
    res.json({ token, user: { id: user.id, email: user.email, name: user.name } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/auth/me', requireAuth, (req, res) => {
  res.json({ user: req.user });
});

// ─── MULTER ───────────────────────────────────────────────────────────────────

const ACCEPTED_MIMETYPES = [
  'audio/mpeg', 'audio/wav', 'audio/mp4', 'audio/x-m4a', 'audio/ogg',
  'audio/flac', 'audio/aac', 'audio/webm', 'audio/x-wav',
  'video/mp4', 'video/x-matroska', 'video/x-msvideo', 'video/quicktime',
  'video/webm', 'video/avi', 'video/mov'
];
const ACCEPTED_EXTENSIONS = ['.mp3', '.wav', '.m4a', '.mp4', '.mkv', '.avi', '.mov', '.webm', '.ogg', '.flac', '.aac'];

const upload = multer({
  dest: UPLOADS_DIR,
  limits: { fileSize: 500 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (ACCEPTED_MIMETYPES.includes(file.mimetype) || ACCEPTED_EXTENSIONS.includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error('Unsupported file type'));
    }
  }
});

// ─── TRANSCRIPTION ───────────────────────────────────────────────────────────

const VIDEO_EXTENSIONS = ['.mp4', '.mkv', '.avi', '.mov', '.webm'];

function isVideoFile(filename) {
  return VIDEO_EXTENSIONS.includes(path.extname(filename).toLowerCase());
}

function extractAudio(inputPath, outputPath) {
  return new Promise((resolve, reject) => {
    ffmpeg(inputPath)
      .audioChannels(1)
      .audioFrequency(16000)
      .toFormat('wav')
      .on('end', resolve)
      .on('error', reject)
      .save(outputPath);
  });
}

function getAudioDuration(filePath) {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(filePath, (err, metadata) => {
      if (err) return reject(err);
      resolve(metadata.format.duration || 0);
    });
  });
}

function splitAudio(inputPath, outputDir, chunkDurationSec = 600) {
  return new Promise(async (resolve, reject) => {
    try {
      const duration = await getAudioDuration(inputPath);
      const chunks = [];
      const numChunks = Math.ceil(duration / chunkDurationSec);
      const promises = [];
      for (let i = 0; i < numChunks; i++) {
        const start = i * chunkDurationSec;
        const chunkPath = path.join(outputDir, `chunk_${i}.wav`);
        chunks.push(chunkPath);
        promises.push(new Promise((res, rej) => {
          ffmpeg(inputPath)
            .setStartTime(start)
            .setDuration(chunkDurationSec)
            .audioChannels(1)
            .audioFrequency(16000)
            .toFormat('wav')
            .on('end', res)
            .on('error', rej)
            .save(chunkPath);
        }));
      }
      await Promise.all(promises);
      resolve(chunks);
    } catch (err) {
      reject(err);
    }
  });
}

async function processJob(jobId) {
  const job = readJob(jobId);
  if (!job) return;

  const tmpDir = path.join(DATA_DIR, 'tmp_' + jobId);
  if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });

  try {
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

    let audioPath = job.filePath;

    // Step 1: Extract audio if video
    if (isVideoFile(job.filename)) {
      job.status = 'extracting_audio';
      job.progress = 5;
      writeJob(job);
      const extractedPath = path.join(tmpDir, 'audio.wav');
      await extractAudio(audioPath, extractedPath);
      audioPath = extractedPath;
    }

    // Step 2: Split into chunks
    job.status = 'splitting';
    job.progress = 15;
    writeJob(job);
    const chunks = await splitAudio(audioPath, tmpDir);

    // Step 3: Transcribe each chunk
    job.status = 'transcribing';
    job.progress = 20;
    writeJob(job);

    const allSegments = [];
    let fullTranscript = '';
    let segmentOffset = 0;

    for (let i = 0; i < chunks.length; i++) {
      const chunkPath = chunks[i];
      const transcription = await openai.audio.transcriptions.create({
        file: fs.createReadStream(chunkPath),
        model: 'whisper-1',
        response_format: 'verbose_json',
        timestamp_granularities: ['segment']
      });

      const chunkText = transcription.text || '';
      fullTranscript += (fullTranscript ? ' ' : '') + chunkText;

      if (transcription.segments) {
        for (const seg of transcription.segments) {
          allSegments.push({
            ...seg,
            start: seg.start + segmentOffset,
            end: seg.end + segmentOffset
          });
        }
        // Update offset based on last segment end time
        if (transcription.segments.length > 0) {
          const lastSeg = transcription.segments[transcription.segments.length - 1];
          segmentOffset += lastSeg.end;
        }
      }

      job.progress = 20 + Math.round(((i + 1) / chunks.length) * 45);
      writeJob(job);
    }

    // Step 4: Detect ambiguous terms with Claude Haiku
    job.status = 'detecting_ambiguous';
    job.progress = 70;
    writeJob(job);

    let ambiguousTerms = [];
    try {
      const detection = await anthropic.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 4096,
        messages: [{
          role: 'user',
          content: `Analyse cette transcription et identifie les mots potentiellement mal transcrits, les noms propres douteux, les termes techniques ambigus, et les mots en langue étrangère potentiellement mal orthographiés. Pour chaque terme ambigu, donne: le mot original, sa position approximative (numéro de mot), une suggestion de correction, et un niveau de confiance (low/medium/high).

Retourne UNIQUEMENT un JSON array, sans commentaire:
[{"word": "...", "position": N, "suggestion": "...", "confidence": "low|medium|high", "reason": "..."}]

Transcription:
${fullTranscript}`
        }]
      });

      const content = detection.content[0]?.text || '[]';
      const jsonMatch = content.match(/\[[\s\S]*\]/);
      if (jsonMatch) {
        ambiguousTerms = JSON.parse(jsonMatch[0]);
      }
    } catch {
      ambiguousTerms = [];
    }

    // Step 5: Save result
    job.status = 'ready_for_validation';
    job.progress = 95;
    job.transcript = fullTranscript;
    job.segments = allSegments;
    job.ambiguousTerms = ambiguousTerms;
    writeJob(job);

    // Cleanup temp files
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      if (job.filePath && fs.existsSync(job.filePath)) {
        fs.unlinkSync(job.filePath);
      }
    } catch {}

    job.progress = 100;
    writeJob(job);

  } catch (err) {
    job.status = 'error';
    job.error = err.message;
    writeJob(job);
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      if (job.filePath && fs.existsSync(job.filePath)) {
        fs.unlinkSync(job.filePath);
      }
    } catch {}
  }
}

app.post('/api/transcribe', requireAuth, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

    const job = {
      id: uuidv4(),
      userId: req.user.id,
      status: 'uploading',
      filename: req.file.originalname,
      filePath: req.file.path,
      createdAt: new Date().toISOString(),
      progress: 0
    };
    writeJob(job);

    // Start background processing (don't await)
    processJob(job.id).catch(err => {
      console.error('processJob error:', err);
    });

    res.json({ jobId: job.id, status: 'processing' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/transcribe/:id', requireAuth, (req, res) => {
  try {
    const job = readJob(req.params.id);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    if (job.userId !== req.user.id) return res.status(403).json({ error: 'Forbidden' });

    if (['uploading', 'extracting_audio', 'splitting', 'transcribing', 'detecting_ambiguous'].includes(job.status)) {
      return res.json({ id: job.id, status: job.status, progress: job.progress || 0 });
    }

    res.json(job);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/transcribe/:id/validate', requireAuth, async (req, res) => {
  try {
    const job = readJob(req.params.id);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    if (job.userId !== req.user.id) return res.status(403).json({ error: 'Forbidden' });

    const { corrections = [], mode = 'manual' } = req.body;
    let transcript = job.transcript;

    if (mode === 'auto' && job.ambiguousTerms && job.ambiguousTerms.length > 0) {
      const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
      const result = await anthropic.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 8192,
        messages: [{
          role: 'user',
          content: `Corrige automatiquement ces termes ambigus dans la transcription. Applique uniquement les corrections avec confiance "high" ou "medium". Retourne uniquement la transcription corrigée, sans commentaire.

Termes ambigus identifiés:
${JSON.stringify(job.ambiguousTerms, null, 2)}

Transcription originale:
${transcript}`
        }]
      });
      transcript = result.content[0]?.text || transcript;
    } else if (corrections.length > 0) {
      // Apply manual corrections by replacing words
      for (const correction of corrections) {
        if (correction.original && correction.corrected) {
          transcript = transcript.split(correction.original).join(correction.corrected);
        }
      }
    }

    job.transcript = transcript;
    job.corrections = corrections;
    job.status = 'validated';
    writeJob(job);

    res.json({ id: job.id, status: 'validated', transcript });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── PROCESS WITH CLAUDE SONNET ──────────────────────────────────────────────

app.post('/api/process', requireAuth, async (req, res) => {
  try {
    const { jobId, promptTemplate, promptContent } = req.body;
    if (!jobId || !promptContent) return res.status(400).json({ error: 'jobId and promptContent are required' });

    const job = readJob(jobId);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    if (job.userId !== req.user.id) return res.status(403).json({ error: 'Forbidden' });
    if (!job.transcript) return res.status(400).json({ error: 'Job has no transcript. Make sure it is validated first.' });

    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const transcript = job.transcript;

    let resultText = '';

    // If very long transcript, split into sections and process sequentially
    if (transcript.length > 100000) {
      const sectionSize = 80000;
      const sections = [];
      for (let i = 0; i < transcript.length; i += sectionSize) {
        sections.push(transcript.slice(i, i + sectionSize));
      }

      const sectionResults = [];
      for (let i = 0; i < sections.length; i++) {
        const sectionContent = i === 0
          ? `${promptContent}\n\n---\n\nTranscription (partie ${i + 1}/${sections.length}):\n${sections[i]}`
          : `Continue l'analyse pour la partie ${i + 1}/${sections.length} de la transcription:\n${sections[i]}`;

        const result = await anthropic.messages.create({
          model: 'claude-sonnet-4-20250514',
          max_tokens: 8192,
          messages: [{ role: 'user', content: sectionContent }]
        });
        sectionResults.push(result.content[0]?.text || '');
      }
      resultText = sectionResults.join('\n\n');
    } else {
      const result = await anthropic.messages.create({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 8192,
        messages: [{
          role: 'user',
          content: `${promptContent}\n\n---\n\nTranscription:\n${transcript}`
        }]
      });
      resultText = result.content[0]?.text || '';
    }

    const saved = {
      id: uuidv4(),
      userId: req.user.id,
      jobId,
      templateName: promptTemplate || 'Custom',
      transcript,
      result: resultText,
      createdAt: new Date().toISOString()
    };
    writeResult(saved);

    res.json(saved);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── HISTORY ─────────────────────────────────────────────────────────────────

app.get('/api/history', requireAuth, (req, res) => {
  try {
    const files = fs.readdirSync(RESULTS_DIR).filter(f => f.endsWith('.json'));
    const results = files
      .map(f => {
        try { return readJSON(path.join(RESULTS_DIR, f)); } catch { return null; }
      })
      .filter(r => r && r.userId === req.user.id)
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    res.json(results);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/history/:id', requireAuth, (req, res) => {
  try {
    const result = readResult(req.params.id);
    if (!result) return res.status(404).json({ error: 'Result not found' });
    if (result.userId !== req.user.id) return res.status(403).json({ error: 'Forbidden' });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/history/:id', requireAuth, (req, res) => {
  try {
    const result = readResult(req.params.id);
    if (!result) return res.status(404).json({ error: 'Result not found' });
    if (result.userId !== req.user.id) return res.status(403).json({ error: 'Forbidden' });
    const p = path.join(RESULTS_DIR, `${req.params.id}.json`);
    fs.unlinkSync(p);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── EXPORT ───────────────────────────────────────────────────────────────────

app.get('/api/history/:id/pdf', requireAuth, (req, res) => {
  try {
    const result = readResult(req.params.id);
    if (!result) return res.status(404).json({ error: 'Result not found' });
    if (result.userId !== req.user.id) return res.status(403).json({ error: 'Forbidden' });

    const doc = new PDFDocument({ margin: 50 });
    const filename = `result_${result.id}.pdf`;

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    doc.pipe(res);

    // Title
    doc.fontSize(20).font('Helvetica-Bold').text(result.templateName || 'Result', { align: 'center' });
    doc.moveDown(0.5);
    doc.fontSize(10).font('Helvetica').fillColor('#666').text(new Date(result.createdAt).toLocaleString(), { align: 'center' });
    doc.moveDown(1);

    // Transcript excerpt
    doc.fontSize(13).font('Helvetica-Bold').fillColor('#000').text('Transcript Excerpt');
    doc.moveDown(0.3);
    const excerpt = (result.transcript || '').slice(0, 600) + ((result.transcript || '').length > 600 ? '...' : '');
    doc.fontSize(10).font('Helvetica').fillColor('#333').text(excerpt);
    doc.moveDown(1);

    // Full result
    doc.fontSize(13).font('Helvetica-Bold').fillColor('#000').text('Result');
    doc.moveDown(0.3);
    doc.fontSize(10).font('Helvetica').fillColor('#333').text(result.result || '');

    doc.end();
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/history/:id/md', requireAuth, (req, res) => {
  try {
    const result = readResult(req.params.id);
    if (!result) return res.status(404).json({ error: 'Result not found' });
    if (result.userId !== req.user.id) return res.status(403).json({ error: 'Forbidden' });

    const date = new Date(result.createdAt).toLocaleString();
    const excerpt = (result.transcript || '').slice(0, 600) + ((result.transcript || '').length > 600 ? '...' : '');
    const md = `# ${result.templateName || 'Result'}\n\n_${date}_\n\n## Transcript Excerpt\n\n${excerpt}\n\n## Result\n\n${result.result || ''}\n`;

    const filename = `result_${result.id}.md`;
    res.setHeader('Content-Type', 'text/markdown');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(md);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/history/:id/email', requireAuth, async (req, res) => {
  try {
    const result = readResult(req.params.id);
    if (!result) return res.status(404).json({ error: 'Result not found' });
    if (result.userId !== req.user.id) return res.status(403).json({ error: 'Forbidden' });

    const { to } = req.body;
    if (!to) return res.status(400).json({ error: 'to email is required' });

    // Generate PDF buffer
    const pdfBuffer = await new Promise((resolve, reject) => {
      const doc = new PDFDocument({ margin: 50 });
      const chunks = [];
      doc.on('data', d => chunks.push(d));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      doc.fontSize(20).font('Helvetica-Bold').text(result.templateName || 'Result', { align: 'center' });
      doc.moveDown(0.5);
      doc.fontSize(10).font('Helvetica').fillColor('#666').text(new Date(result.createdAt).toLocaleString(), { align: 'center' });
      doc.moveDown(1);
      doc.fontSize(13).font('Helvetica-Bold').fillColor('#000').text('Transcript Excerpt');
      doc.moveDown(0.3);
      const excerpt = (result.transcript || '').slice(0, 600) + ((result.transcript || '').length > 600 ? '...' : '');
      doc.fontSize(10).font('Helvetica').fillColor('#333').text(excerpt);
      doc.moveDown(1);
      doc.fontSize(13).font('Helvetica-Bold').fillColor('#000').text('Result');
      doc.moveDown(0.3);
      doc.fontSize(10).font('Helvetica').fillColor('#333').text(result.result || '');
      doc.end();
    });

    const transporter = nodemailer.createTransport({
      host: 'smtp.gmail.com',
      port: 587,
      auth: {
        user: process.env.SMTP_USER || 'bouznahjeremy@gmail.com',
        pass: process.env.SMTP_PASS
      }
    });

    const html = `<h1>${result.templateName || 'Result'}</h1>
<p><em>${new Date(result.createdAt).toLocaleString()}</em></p>
<h2>Result</h2>
<pre style="white-space:pre-wrap;font-family:sans-serif">${(result.result || '').replace(/</g, '&lt;')}</pre>`;

    await transporter.sendMail({
      from: process.env.SMTP_USER || 'bouznahjeremy@gmail.com',
      to,
      subject: `${result.templateName || 'Transcription Result'} - ${new Date(result.createdAt).toLocaleDateString()}`,
      html,
      attachments: [{
        filename: `result_${result.id}.pdf`,
        content: pdfBuffer,
        contentType: 'application/pdf'
      }]
    });

    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── TEMPLATES CRUD (existing) ────────────────────────────────────────────────

app.get('/api/templates', (req, res) => res.json(readJSON(TEMPLATES_FILE)));
app.post('/api/templates', (req, res) => {
  const templates = readJSON(TEMPLATES_FILE);
  const t = { ...req.body, _customId: Date.now().toString(), isCustom: true, isMyTemplate: true };
  templates.push(t);
  writeJSON(TEMPLATES_FILE, templates);
  res.status(201).json(t);
});
app.put('/api/templates/:id', (req, res) => {
  const templates = readJSON(TEMPLATES_FILE);
  const idx = templates.findIndex(t => t._customId === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Not found' });
  templates[idx] = { ...templates[idx], ...req.body };
  writeJSON(TEMPLATES_FILE, templates);
  res.json(templates[idx]);
});
app.delete('/api/templates/:id', (req, res) => {
  let templates = readJSON(TEMPLATES_FILE);
  templates = templates.filter(t => t._customId !== req.params.id);
  writeJSON(TEMPLATES_FILE, templates);
  res.json({ ok: true });
});

// ─── CATEGORIES CRUD (existing) ──────────────────────────────────────────────

app.get('/api/categories', (req, res) => res.json(readJSON(CATEGORIES_FILE)));
app.post('/api/categories', (req, res) => {
  const cats = readJSON(CATEGORIES_FILE);
  cats.push(req.body);
  writeJSON(CATEGORIES_FILE, cats);
  res.status(201).json(req.body);
});
app.delete('/api/categories/:name', (req, res) => {
  let cats = readJSON(CATEGORIES_FILE);
  cats = cats.filter(c => c.name !== req.params.name);
  writeJSON(CATEGORIES_FILE, cats);
  res.json({ ok: true });
});

// ─── FALLBACK ─────────────────────────────────────────────────────────────────

app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

const PORT = process.env.PORT || 80;
app.listen(PORT, '0.0.0.0', () => console.log('Server running on port ' + PORT));
