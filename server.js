import express from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const DATA_DIR = '/data';
const TEMPLATES_FILE = path.join(DATA_DIR, 'templates.json');
const CATEGORIES_FILE = path.join(DATA_DIR, 'categories.json');

app.use(express.json());
app.use(express.static(__dirname));

// Initialize data files
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(TEMPLATES_FILE)) fs.writeFileSync(TEMPLATES_FILE, '[]');
if (!fs.existsSync(CATEGORIES_FILE)) fs.writeFileSync(CATEGORIES_FILE, '[]');

function readJSON(file) { return JSON.parse(fs.readFileSync(file, 'utf-8')); }
function writeJSON(file, data) { fs.writeFileSync(file, JSON.stringify(data, null, 2)); }

// Templates CRUD
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

// Categories CRUD
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

// Fallback
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

const PORT = process.env.PORT || 80;
app.listen(PORT, '0.0.0.0', () => console.log('Server running on port ' + PORT));
