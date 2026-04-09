const express = require('express');
const fetch = require('node-fetch');
const path = require('path');
const session = require('express-session');
const fs = require('fs');
const multer = require('multer');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const bcrypt = require('bcryptjs');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// ─── Config file (auto-create jika belum ada) ────────────────────────────────
const CONFIG_PATH    = path.join(__dirname, 'config.json');
const KNOWLEDGE_PATH = path.join(__dirname, 'knowledge.txt');
const DB_PATH        = path.join(__dirname, 'database.json');
const LOGS_PATH      = path.join(__dirname, 'logs.json');
const UPLOADS_META_PATH = path.join(__dirname, 'uploads_meta.json');

// ─── Database helpers ─────────────────────────────────────────────────────────
const DEFAULT_DB = {
  classes: [{ id: 'kelas-default', name: 'Kelas Default', isActive: true }],
  users: [
    { username: 'dosen', password: 'admin', role: 'dosen' },
    { username: 'mhs',   password: '123',   role: 'mhs', classId: 'kelas-default' }
  ]
};

function readDB() {
  if (!fs.existsSync(DB_PATH)) {
    fs.writeFileSync(DB_PATH, JSON.stringify(DEFAULT_DB, null, 2), 'utf8');
    console.log('✅ database.json dibuat dengan nilai default.');
  }
  return JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
}

function writeDB(data) {
  fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2), 'utf8');
}

// ─── Uploads meta helpers ─────────────────────────────────────────────────────
function readUploadsMeta() {
  if (!fs.existsSync(UPLOADS_META_PATH)) return [];
  return JSON.parse(fs.readFileSync(UPLOADS_META_PATH, 'utf8'));
}

function writeUploadsMeta(data) {
  fs.writeFileSync(UPLOADS_META_PATH, JSON.stringify(data, null, 2), 'utf8');
}

// ─── Logs helpers ─────────────────────────────────────────────────────────────
function readLogs() {
  if (!fs.existsSync(LOGS_PATH)) {
    fs.writeFileSync(LOGS_PATH, JSON.stringify([], null, 2), 'utf8');
  }
  return JSON.parse(fs.readFileSync(LOGS_PATH, 'utf8'));
}

function writeLogs(data) {
  fs.writeFileSync(LOGS_PATH, JSON.stringify(data, null, 2), 'utf8');
}

// ─── Single-device session tracker ───────────────────────────────────────────
const activeSessions = {};

// ─── SSE sound event clients ──────────────────────────────────────────────────
const sseClients = {}; // username -> res

// ─── Multer (PDF upload, memory storage) ─────────────────────────────────────
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB
  fileFilter: (req, file, cb) => {
    if (file.mimetype === 'application/pdf') cb(null, true);
    else cb(new Error('Hanya file PDF yang diizinkan'), false);
  }
});

const DEFAULT_CONFIG = {
  systemPrompt: `Kamu adalah asisten ahli microcontroller bernama "QuantumBot".

ATURAN WAJIB:
1. Jawab seputar microcontroller (Arduino, ESP32, dll) dan elektronika.
2. Jika di luar topik, tolak dengan sopan.
3. Jawab singkat maksimal 4 kalimat.
4. JIKA USER MEMINTA PINOUT ARDUINO UNO, kamu WAJIB MEMBALAS dengan teks persis seperti di bawah ini, berikan tanda seru (!) di depan kurung siku:
![Pinout Arduino Uno](https://lh3.googleusercontent.com/d/1Cbt25QaWO0sYzUTme_QxCT7aEOfQ5PSk)

PENTING: Jangan ubah format markdown gambarnya! Harus diawali dengan tanda seru (!).`,
  allowOffTopic: false,
  useProModel: false,
  welcomeTitle: 'Halo! Saya QuantumBot',
  welcomeDesc: 'Asisten khusus microcontroller. Tanya seputar Arduino, ESP32, sensor, dan elektronika!',
  suggestions: [
    'Cara blink LED dengan Arduino',
    'Tampilkan pinout Arduino Uno',
    'Cara koneksi ESP32 ke WiFi',
    'Cara pakai sensor DHT22 dengan Arduino'
  ],
  driveLink: 'https://drive.google.com/drive/folders/1cZQxedFSfy6nf0-T8UCJZLWWkTeq6ppB?usp=sharing'
};

function readConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(DEFAULT_CONFIG, null, 2), 'utf8');
    console.log('✅ config.json dibuat dengan nilai default.');
  }
  return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
}

function writeConfig(data) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(data, null, 2), 'utf8');
}

// ─── Middleware ───────────────────────────────────────────────────────────────

// Security headers
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc:  ["'self'", "'unsafe-inline'", "fonts.googleapis.com"],
      styleSrc:   ["'self'", "'unsafe-inline'", "fonts.googleapis.com"],
      fontSrc:    ["'self'", "fonts.gstatic.com"],
      imgSrc:     ["'self'", "data:", "https:", "lh3.googleusercontent.com"],
      connectSrc: ["'self'"],
    },
  },
  crossOriginEmbedderPolicy: false,
}));

// Hanya izinkan request dari origin yang sama (no CORS untuk browser lain)
app.use((req, res, next) => {
  const origin = req.headers.origin;
  // Jika ada origin header dan bukan same-origin, tolak
  if (origin) {
    const host = req.headers.host;
    const originHost = new URL(origin).host;
    if (originHost !== host) {
      return res.status(403).json({ error: 'Cross-origin request tidak diizinkan.' });
    }
  }
  next();
});

app.use(express.json({ limit: '1mb' }));

const sessionSecret = process.env.SESSION_SECRET;
if (!sessionSecret) {
  console.warn('⚠️  WARNING: SESSION_SECRET tidak diset di .env! Gunakan secret yang kuat di production.');
}

app.use(session({
  secret: sessionSecret || require('crypto').randomBytes(32).toString('hex'),
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: false,           // set true jika pakai HTTPS
    httpOnly: true,          // cegah akses cookie dari JavaScript
    sameSite: 'strict',      // cegah CSRF lintas domain
    maxAge: 1000 * 60 * 60 * 2 // 2 jam
  }
}));

// ─── Auth middleware ──────────────────────────────────────────────────────────
function requireAuth(req, res, next) {
  if (req.session && req.session.user) return next();
  res.status(401).json({ error: 'Belum login' });
}

function requireDosen(req, res, next) {
  if (req.session && req.session.role === 'dosen') return next();
  res.status(403).json({ error: 'Akses ditolak: hanya untuk dosen' });
}

// ─── Rate limiter login (max 10 percobaan per 15 menit per IP) ───────────────
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Terlalu banyak percobaan login. Coba lagi dalam 15 menit.' },
});

// ─── Auth routes ──────────────────────────────────────────────────────────────
app.post('/api/login', loginLimiter, async (req, res) => {
  const { username, password } = req.body;

  if (!username || !password || typeof username !== 'string' || typeof password !== 'string') {
    return res.status(400).json({ error: 'Username dan password wajib diisi.' });
  }

  const db   = readDB();
  const user = db.users.find(u => u.username === username);

  if (!user) {
    // Dummy compare agar timing-attack tidak bisa deteksi user valid/tidak
    await bcrypt.compare(password, '$2b$10$dummyhashfortimingattackprevention00000000000000000000');
    return res.status(401).json({ error: 'Username atau password salah' });
  }

  // Cek password: dukung hash bcrypt dan plaintext lama (migrasi otomatis)
  let passwordMatch = false;
  if (user.password.startsWith('$2')) {
    // Sudah di-hash
    passwordMatch = await bcrypt.compare(password, user.password);
  } else {
    // Masih plaintext — cek lalu migrate ke hash
    passwordMatch = (user.password === password);
    if (passwordMatch) {
      user.password = await bcrypt.hash(password, 10);
      writeDB(db);
    }
  }

  if (!passwordMatch) {
    return res.status(401).json({ error: 'Username atau password salah' });
  }

  // Cek isActive kelas untuk mahasiswa
  if (user.role === 'mhs') {
    const kelas = db.classes.find(c => c.id === user.classId);
    if (kelas && kelas.isActive === false) {
      return res.status(403).json({ error: 'Akses kelas ini sedang ditutup oleh Dosen.' });
    }
  }

  // Single-device check
  if (activeSessions[username] && activeSessions[username] !== req.sessionID) {
    return res.status(403).json({ error: 'Akun sedang digunakan di perangkat lain!' });
  }

  req.session.user = username;
  req.session.role = user.role;
  activeSessions[username] = req.sessionID;

  const redirect = user.role === 'dosen' ? '/admin' : '/chat';
  res.json({ redirect });
});

app.post('/api/logout', (req, res) => {
  if (req.session.user) delete activeSessions[req.session.user];
  req.session.destroy(() => {
    res.json({ message: 'Logout berhasil' });
  });
});

// ─── Page routes ──────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.redirect('/login.html');
});

app.get('/chat', (req, res) => {
  if (!req.session || !req.session.user) return res.redirect('/login.html');
  res.sendFile(path.join(__dirname, 'public', 'chat.html'));
});

app.get('/admin', (req, res) => {
  if (!req.session || !req.session.user) return res.redirect('/login.html');
  if (req.session.role !== 'dosen') return res.redirect('/login.html');
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// ─── Me (cek sesi aktif + validasi kelas untuk mhs) ──────────────────────────
app.get('/api/me', (req, res) => {
  if (!req.session || !req.session.user) {
    return res.status(401).json({ error: 'Belum login' });
  }

  // Untuk mahasiswa: cek apakah kelasnya masih aktif
  if (req.session.role === 'mhs') {
    const db   = readDB();
    const user = db.users.find(u => u.username === req.session.user);
    if (user) {
      const kelas = db.classes.find(c => c.id === user.classId);
      if (kelas && kelas.isActive === false) {
        // Hapus dari active sessions dan hancurkan sesi
        delete activeSessions[req.session.user];
        req.session.destroy(() => {});
        return res.status(403).json({ error: 'Kelas ditutup oleh Dosen.' });
      }
    }
  }

  res.json({ username: req.session.user, role: req.session.role });
});

// ─── Welcome config (semua user yang sudah login) ─────────────────────────────
app.get('/api/welcome', requireAuth, (req, res) => {
  const { welcomeTitle, welcomeDesc, suggestions, driveLink } = readConfig();
  res.json({ welcomeTitle, welcomeDesc, suggestions, driveLink });
});

// ─── Config routes (hanya dosen) ─────────────────────────────────────────────
app.get('/api/config', requireAuth, requireDosen, (req, res) => {
  const config = readConfig();
  res.json(config);
});

app.post('/api/config', requireAuth, requireDosen, (req, res) => {
  const current = readConfig();
  const updated = { ...current, ...req.body };
  writeConfig(updated);
  res.json({ message: 'Config berhasil disimpan', config: updated });
});

// ─── Chat route ───────────────────────────────────────────────────────────────
app.post('/api/chat', requireAuth, async (req, res) => {
  const apiKey = process.env.OPENAI_API_KEY;

  if (!apiKey) {
    return res.status(500).json({ error: 'OPENAI_API_KEY belum diset' });
  }

  try {
    const { messages } = req.body;
    const config = readConfig();

    // ── Catat log aktivitas ──────────────────────────────────────────────────
    const lastUserMsg = [...messages].reverse().find(m => m.role === 'user');
    if (lastUserMsg) {
      const logs = readLogs();
      logs.unshift({
        timestamp: new Date().toISOString(),
        username:  req.session.user,
        message:   lastUserMsg.content
      });
      writeLogs(logs.slice(0, 200));
    }

    const baseUrl = process.env.BASE_URL || 'https://api.openai.com';
    const model = process.env.MODEL_NAME || 'o3-mini';

    let systemContent = config.systemPrompt;
    if (fs.existsSync(KNOWLEDGE_PATH)) {
      const knowledge = fs.readFileSync(KNOWLEDGE_PATH, 'utf8').trim();
      if (knowledge) systemContent += `\n\nREFERENSI MATERI DOSEN:\n${knowledge}`;
    }

    const response = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: model,
        messages: [
          { role: 'system', content: systemContent },
          ...messages
        ],
        max_tokens: 800
      })
    });

    const data = await response.json();

    if (data.error) {
      return res.status(400).json({ error: data.error.message });
    }

    res.json(data);

  } catch (err) {
    res.status(500).json({ error: 'Gagal terhubung: ' + err.message });
  }
});

// ─── Upload Materi PDF ────────────────────────────────────────────────────────
app.post('/api/upload-materi', requireAuth, requireDosen, upload.single('materi'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Tidak ada file yang diupload' });

    const { PDFParse } = require('pdf-parse');
    const buf = req.file.buffer;
    const arrayBuffer = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    const parser = new PDFParse({ data: arrayBuffer });
    const textResult = await parser.getText();
    const infoResult = await parser.getInfo({ parsePageInfo: true });
    await parser.destroy();

    const text = textResult.text.trim();
    const numpages = infoResult.total;

    if (!text) return res.status(400).json({ error: 'PDF tidak mengandung teks yang dapat diekstrak' });

    // Append ke knowledge.txt dengan separator
    const existing = fs.existsSync(KNOWLEDGE_PATH) ? fs.readFileSync(KNOWLEDGE_PATH, 'utf8').trim() : '';
    const separator = existing ? `\n\n--- ${req.file.originalname} ---\n` : `--- ${req.file.originalname} ---\n`;
    fs.writeFileSync(KNOWLEDGE_PATH, (existing ? existing + separator : separator) + text, 'utf8');

    // Simpan metadata nama file
    const meta = readUploadsMeta();
    meta.push({ filename: req.file.originalname, uploadedAt: new Date().toISOString(), pages: numpages, chars: text.length });
    writeUploadsMeta(meta);

    res.json({
      message: `Materi berhasil diupload (${numpages} halaman, ${text.length} karakter).`,
      filename: req.file.originalname
    });
  } catch (err) {
    res.status(500).json({ error: 'Gagal memproses PDF: ' + err.message });
  }
});

// ─── Knowledge files (hanya dosen) ───────────────────────────────────────────
app.get('/api/knowledge-files', requireAuth, requireDosen, (req, res) => {
  res.json(readUploadsMeta());
});

app.delete('/api/knowledge-files', requireAuth, requireDosen, (req, res) => {
  fs.writeFileSync(KNOWLEDGE_PATH, '', 'utf8');
  writeUploadsMeta([]);
  res.json({ message: 'Semua materi berhasil dihapus.' });
});

// ─── User management (hanya dosen) ───────────────────────────────────────────
app.post('/api/users', requireAuth, requireDosen, async (req, res) => {
  const { username, password, role, classId } = req.body;

  if (!username || !password || !['mhs', 'dosen'].includes(role)) {
    return res.status(400).json({ error: 'username, password, dan role (mhs/dosen) wajib diisi.' });
  }

  if (typeof username !== 'string' || typeof password !== 'string') {
    return res.status(400).json({ error: 'Input tidak valid.' });
  }

  if (role === 'mhs' && !classId) {
    return res.status(400).json({ error: 'classId wajib diisi untuk role mhs.' });
  }

  const db = readDB();

  if (db.users.find(u => u.username === username)) {
    return res.status(400).json({ error: 'Username sudah dipakai!' });
  }

  const hashedPassword = await bcrypt.hash(password, 10);
  const newUser = { username, password: hashedPassword, role };
  if (role === 'mhs') newUser.classId = classId;
  db.users.push(newUser);
  writeDB(db);

  res.json({ message: `User '${username}' berhasil ditambahkan.` });
});

// ─── Delete user (hanya dosen, tidak bisa hapus akun role dosen) ─────────────
app.delete('/api/users/:username', requireAuth, requireDosen, (req, res) => {
  const { username } = req.params;
  const db   = readDB();
  const user = db.users.find(u => u.username === username);

  if (!user) return res.status(404).json({ error: 'User tidak ditemukan.' });
  if (user.role === 'dosen') return res.status(403).json({ error: 'Akun dosen tidak bisa dihapus dari sini.' });

  db.users = db.users.filter(u => u.username !== username);
  writeDB(db);
  res.json({ message: `User '${username}' berhasil dihapus.` });
});

// ─── Reset semua mhs di satu kelas ───────────────────────────────────────────
app.post('/api/users/reset', requireAuth, requireDosen, (req, res) => {
  const { classId } = req.body;
  if (!classId) return res.status(400).json({ error: 'classId wajib diisi.' });

  const db    = readDB();
  const before = db.users.length;
  db.users = db.users.filter(u => !(u.role === 'mhs' && u.classId === classId));
  const deleted = before - db.users.length;
  writeDB(db);

  res.json({ message: `${deleted} mahasiswa di kelas ini berhasil dihapus.` });
});

// ─── List users per kelas (hanya dosen) ──────────────────────────────────────
app.get('/api/users', requireAuth, requireDosen, (req, res) => {
  const { classId } = req.query;
  const db = readDB();
  const users = classId
    ? db.users.filter(u => u.role === 'mhs' && u.classId === classId)
    : db.users.filter(u => u.role === 'mhs');
  res.json(users.map(u => ({ username: u.username, role: u.role, classId: u.classId })));
});

// ─── Class management (hanya dosen) ──────────────────────────────────────────
app.get('/api/classes', requireAuth, requireDosen, (req, res) => {
  const db = readDB();
  res.json(db.classes);
});

app.post('/api/classes', requireAuth, requireDosen, (req, res) => {
  const { name } = req.body;
  if (!name || !name.trim()) {
    return res.status(400).json({ error: 'Nama kelas wajib diisi.' });
  }

  const db = readDB();
  if (db.classes.find(c => c.name.toLowerCase() === name.trim().toLowerCase())) {
    return res.status(400).json({ error: 'Nama kelas sudah ada!' });
  }

  const newClass = {
    id:       'kelas-' + Date.now(),
    name:     name.trim(),
    isActive: true
  };
  db.classes.push(newClass);
  writeDB(db);

  res.json({ message: `Kelas '${newClass.name}' berhasil ditambahkan.`, class: newClass });
});

app.patch('/api/classes/:id', requireAuth, requireDosen, (req, res) => {
  const db  = readDB();
  const cls = db.classes.find(c => c.id === req.params.id);
  if (!cls) return res.status(404).json({ error: 'Kelas tidak ditemukan.' });

  cls.isActive = !!req.body.isActive;
  writeDB(db);
  res.json({ message: 'Status kelas diperbarui.', class: cls });
});

app.delete('/api/classes/:id', requireAuth, requireDosen, (req, res) => {
  const { id } = req.params;
  if (id === 'kelas-default') {
    return res.status(403).json({ error: 'Kelas default tidak bisa dihapus.' });
  }

  const db = readDB();
  const cls = db.classes.find(c => c.id === id);
  if (!cls) return res.status(404).json({ error: 'Kelas tidak ditemukan.' });

  db.classes = db.classes.filter(c => c.id !== id);
  db.users   = db.users.filter(u => !(u.role === 'mhs' && u.classId === id));
  writeDB(db);
  res.json({ message: `Kelas '${cls.name}' beserta seluruh mahasiswanya berhasil dihapus.` });
});

// ─── Log aktivitas (hanya dosen) ─────────────────────────────────────────────
app.get('/api/logs', requireAuth, requireDosen, (req, res) => {
  res.json(readLogs());
});

app.delete('/api/logs', requireAuth, requireDosen, (req, res) => {
  writeLogs([]);
  res.json({ message: 'Log berhasil dibersihkan.' });
});

// ─── Live Status Monitor (hanya dosen) ───────────────────────────────────────
app.get('/api/status', requireAuth, requireDosen, (req, res) => {
  const db = readDB();
  const mhsList = db.users.filter(u => u.role === 'mhs');
  const result = mhsList.map(u => ({
    username: u.username,
    classId:  u.classId,
    status:   activeSessions[u.username] ? 'Online' : 'Offline'
  }));
  res.json(result);
});

// ─── SSE Sound Events (mahasiswa subscribe) ───────────────────────────────────
app.get('/api/sound-events', requireAuth, (req, res) => {
  const username = req.session.user;
  if (req.session.role !== 'mhs') return res.status(403).end();

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  sseClients[username] = res;

  // Heartbeat setiap 25 detik agar koneksi tidak putus
  const hb = setInterval(() => res.write(':ping\n\n'), 25000);

  req.on('close', () => {
    delete sseClients[username];
    clearInterval(hb);
  });
});

// ─── Trigger play sound (hanya dosen) ────────────────────────────────────────
app.post('/api/play-sound', requireAuth, requireDosen, (req, res) => {
  const { target } = req.body; // 'all' atau username spesifik

  let sent = 0;
  const sendEvent = (clientRes) => {
    clientRes.write('data: play\n\n');
    sent++;
  };

  if (target === 'all') {
    Object.values(sseClients).forEach(sendEvent);
  } else if (target && sseClients[target]) {
    sendEvent(sseClients[target]);
  }

  res.json({ message: `Sound dikirim ke ${sent} user.`, sent });
});

// ─── Google Drive placeholder ─────────────────────────────────────────────────
// TODO: Integrasi Google Drive API
//
// Cara integrasi:
// 1. Install: npm install googleapis
// 2. Buat credentials di Google Cloud Console → OAuth 2.0 Client ID
//    atau Service Account untuk akses server-to-server.
// 3. Simpan credentials di .env: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET,
//    GOOGLE_REDIRECT_URI, GOOGLE_REFRESH_TOKEN (untuk OAuth)
//    atau path ke file service-account.json.
// 4. Inisialisasi client:
//    const { google } = require('googleapis');
//    const drive = google.drive({ version: 'v3', auth: oAuth2Client });
// 5. Gunakan drive.files.list(), drive.files.get(), drive.files.create(), dll.
//
// Endpoint ini bisa dipakai untuk:
// - Upload materi (dosen) → drive.files.create()
// - List file tersedia → drive.files.list()
// - Download/akses file → drive.files.get()
app.post('/api/drive', requireAuth, requireDosen, (req, res) => {
  res.status(501).json({ message: 'Google Drive integration belum diimplementasikan' });
});

// ─── Static files (login page, dll) ──────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));

app.listen(PORT, () => {
  readConfig(); // pastikan config.json ada saat startup
  console.log(`\n✅ Server berjalan di http://localhost:${PORT}\n`);
});
