const express = require('express');
const path = require('path');
const crypto = require('crypto');
const session = require('express-session');
const compression = require('compression');
const fs = require('fs');
const nodemailer = require('nodemailer');
const XLSX = require('xlsx');

const app = express();
const PORT = process.env.PORT || 8080;

// ─── SIMPLE FILE-BASED DATABASE (pure JS, no compilation needed!) ─────────────
const DB_FILE = path.join(__dirname, 'ekprinters-data.json');

function loadDB() {
  if (!fs.existsSync(DB_FILE)) {
    const defaultAdmin = {
      username: 'admin',
      password: crypto.createHash('sha256').update('ekprinters2025').digest('hex')
    };
    fs.writeFileSync(DB_FILE, JSON.stringify({ quotes: [], admin: defaultAdmin, nextId: 1 }, null, 2));
    console.log('✅ Database created. Admin login: admin / ekprinters2025');
  }
  return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
}

function saveDB(data) {
  fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
}

// ─── MIDDLEWARE ────────────────────────────────────────────────────────────────
app.use(compression());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(session({
  secret: process.env.SESSION_SECRET || 'ek-printers-secret-2025',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 8 * 60 * 60 * 1000 }
}));
// Note: express.static is registered after all dynamic routes so paths like
// /admin are never shadowed by public/admin/index.html or similar on deploy.

function canSendEmail() {
  return Boolean(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS && process.env.NOTIFY_TO);
}

async function sendQuoteEmail({ id, createdAt, name, phone, email, requirement }) {
  if (!canSendEmail()) return;

  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: String(process.env.SMTP_SECURE || '').toLowerCase() === 'true',
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
  });

  const from = process.env.SMTP_FROM || process.env.SMTP_USER;
  const to = process.env.NOTIFY_TO;
  const subject = `New Quote Request #${id} · EK Printers`;
  const text =
`New quote request received

ID: #${id}
Time: ${createdAt}
Name: ${name}
Phone: ${phone}
Email: ${email || '-'}

Requirement:
${requirement}
`;

  await transporter.sendMail({ from, to, subject, text });
}

// ─── AUTH MIDDLEWARE ───────────────────────────────────────────────────────────
function requireAuth(req, res, next) {
  if (req.session && req.session.adminId) return next();
  return res.redirect('/admin/login');
}

// ─── PUBLIC API ────────────────────────────────────────────────────────────────
app.post('/api/quote', (req, res) => {
  const { name, phone, email, requirement } = req.body;
  if (!name || !phone || !requirement) {
    return res.status(400).json({ success: false, message: 'Name, phone and requirement are required.' });
  }
  const db = loadDB();
  const id = db.nextId++;
  const now = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });
  const quote = {
    id, name: name.trim(), phone: phone.trim(),
    email: (email || '').trim(), requirement: requirement.trim(),
    status: 'new', notes: '', created_at: now,
    created_date: new Date().toISOString().slice(0, 10)
  };
  db.quotes.unshift(quote);
  saveDB(db);

  const waNumber = String(process.env.WHATSAPP_NUMBER || '').replace(/[^0-9]/g, '');
  const waText = encodeURIComponent(
    `Hi EK Printers! New quote request (#${id}).\n` +
    `Name: ${quote.name}\nPhone: ${quote.phone}\nEmail: ${quote.email || '-'}\n` +
    `Requirement: ${quote.requirement}`
  );
  const whatsappUrl = waNumber ? `https://wa.me/${waNumber}?text=${waText}` : '';

  sendQuoteEmail({
    id,
    createdAt: quote.created_at,
    name: quote.name,
    phone: quote.phone,
    email: quote.email,
    requirement: quote.requirement
  }).catch(err => console.error('Email notify failed:', err.message));

  return res.json({
    success: true,
    id,
    message: 'Quote request submitted! We will contact you within 24 hours.',
    whatsappUrl
  });
});

// ─── ADMIN AUTH ────────────────────────────────────────────────────────────────
app.get('/admin/login', (req, res) => {
  if (req.session.adminId) return res.redirect('/admin');
  res.send(loginPageHTML());
});

app.post('/admin/login', (req, res) => {
  const { username, password } = req.body;
  const hashed = crypto.createHash('sha256').update(password || '').digest('hex');
  const db = loadDB();
  if (db.admin.username === username && db.admin.password === hashed) {
    req.session.adminId = 1;
    req.session.username = username;
    return res.redirect('/admin');
  }
  res.send(loginPageHTML('Invalid username or password.'));
});

app.get('/admin/logout', (req, res) => {
  req.session.destroy();
  res.redirect('/admin/login');
});

// ─── ADMIN PANEL ──────────────────────────────────────────────────────────────
app.get('/admin', requireAuth, (req, res) => {
  const filter = req.query.status || 'all';
  const search = (req.query.search || '').toLowerCase();
  const fromDate = req.query.fromDate || '';
  const toDate = req.query.toDate || '';
  const db = loadDB();
  let quotes = db.quotes;
  if (filter !== 'all') quotes = quotes.filter(q => q.status === filter);
  if (fromDate || toDate) {
    quotes = quotes.filter(q => {
      const quoteDate = getQuoteDate(q);
      if (!quoteDate) return false;
      if (fromDate && quoteDate < fromDate) return false;
      if (toDate && quoteDate > toDate) return false;
      return true;
    });
  }
  if (search) quotes = quotes.filter(q =>
    q.name.toLowerCase().includes(search) ||
    q.phone.includes(search) ||
    q.requirement.toLowerCase().includes(search)
  );
  const all = db.quotes;
  const stats = {
    total: all.length,
    new: all.filter(q => q.status === 'new').length,
    inProgress: all.filter(q => q.status === 'in_progress').length,
    completed: all.filter(q => q.status === 'completed').length,
  };
  res.send(adminPanelHTML(quotes, stats, filter, search, fromDate, toDate, req.session.username));
});

app.post('/admin/quote/:id/status', requireAuth, (req, res) => {
  const { status } = req.body;
  const valid = ['new', 'in_progress', 'completed', 'cancelled'];
  if (!valid.includes(status)) return res.status(400).json({ error: 'Invalid status' });
  const db = loadDB();
  const q = db.quotes.find(q => q.id == req.params.id);
  if (q) { q.status = status; saveDB(db); }
  res.json({ success: true });
});

app.post('/admin/quote/:id/notes', requireAuth, (req, res) => {
  const db = loadDB();
  const q = db.quotes.find(q => q.id == req.params.id);
  if (q) { q.notes = req.body.notes || ''; saveDB(db); }
  res.json({ success: true });
});

app.delete('/admin/quote/:id', requireAuth, (req, res) => {
  const db = loadDB();
  db.quotes = db.quotes.filter(q => q.id != req.params.id);
  saveDB(db);
  res.json({ success: true });
});

app.get('/admin/export', requireAuth, (req, res) => {
  const filter = req.query.status || 'all';
  const search = (req.query.search || '').toLowerCase();
  const fromDate = req.query.fromDate || '';
  const toDate = req.query.toDate || '';
  const db = loadDB();
  let quotes = db.quotes;
  if (filter !== 'all') quotes = quotes.filter(q => q.status === filter);
  if (fromDate || toDate) {
    quotes = quotes.filter(q => {
      const quoteDate = getQuoteDate(q);
      if (!quoteDate) return false;
      if (fromDate && quoteDate < fromDate) return false;
      if (toDate && quoteDate > toDate) return false;
      return true;
    });
  }
  if (search) quotes = quotes.filter(q =>
    q.name.toLowerCase().includes(search) ||
    q.phone.includes(search) ||
    q.requirement.toLowerCase().includes(search)
  );

  const excelRows = quotes.map(q => ({
    ID: q.id,
    Name: q.name,
    Phone: q.phone,
    Email: q.email || '',
    Requirement: q.requirement || '',
    Status: q.status,
    Notes: q.notes || '',
    Date: getQuoteDate(q) || '',
    'Created At': q.created_at || ''
  }));

  const workbook = XLSX.utils.book_new();
  const worksheet = XLSX.utils.json_to_sheet(excelRows);
  XLSX.utils.book_append_sheet(workbook, worksheet, 'Quotes');
  const fileBuffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });

  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', 'attachment; filename="ek-printers-quotes.xlsx"');
  res.send(fileBuffer);
});

function getQuoteDate(q) {
  if (q.created_date && /^\d{4}-\d{2}-\d{2}$/.test(q.created_date)) return q.created_date;
  const raw = String(q.created_at || '');
  const match = raw.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (!match) return '';
  const [, d, m, y] = match;
  const dd = d.padStart(2, '0');
  const mm = m.padStart(2, '0');
  return `${y}-${mm}-${dd}`;
}

function withQuery(paramsObj) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(paramsObj)) {
    if (value !== undefined && value !== null && String(value).trim() !== '') params.set(key, value);
  }
  return params.toString();
}

function esc(s) { return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function escJs(s) { return String(s||'').replace(/\\/g,'\\\\').replace(/`/g,'\\`').replace(/\$/g,'\\$'); }
function normalizeWhatsAppNumber(phone) {
  const digits = String(phone || '').replace(/[^0-9]/g, '');
  if (!digits) return '';
  return digits.length === 10 ? `91${digits}` : digits;
}
function customerWhatsAppText(q) {
  return encodeURIComponent(
    `Hi ${q.name}, this is EK Printers about your quote #${q.id}.\n` +
    `Requirement: ${q.requirement || '-'}\n` +
    `Please confirm quantity and timeline.`
  );
}

function statusBadge(status) {
  const map = {
    new: ['#E8F4F1','#006B5E','🔵 New'],
    in_progress: ['#FFF8E1','#B8860B','🟡 In Progress'],
    completed: ['#E8F5E9','#2E7D32','🟢 Completed'],
    cancelled: ['#FFEBEE','#C62828','🔴 Cancelled'],
  };
  const [bg,color,label] = map[status] || map['new'];
  return `<span style="background:${bg};color:${color};font-size:0.65rem;font-weight:600;padding:0.2rem 0.7rem;border-radius:100px">${label}</span>`;
}

function loginPageHTML(error = '') {
  const err = error ? `<div class="error">⚠️ ${esc(error)}</div>` : '';
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Admin Login · EK Printers</title>
  <style>
    *{margin:0;padding:0;box-sizing:border-box}
    :root{--teal:#006B5E;--teal2:#008F7A;--bg:#FAFAF8;--surface:#F2F0EB;--ink:#161412}
    body{background:var(--bg);font-family:'Inter',sans-serif;color:var(--ink);min-height:100vh;display:flex;align-items:center;justify-content:center;transition:background 0.25s ease,color 0.25s ease}
    body.dark-mode{--bg:#121416;--surface:#1A1D20;--ink:#ECEFF1}
    .card{background:#fff;border:1px solid rgba(22,20,18,0.1);border-radius:20px;padding:2.5rem;width:380px;box-shadow:0 20px 60px rgba(22,20,18,0.06);position:relative}
    body.dark-mode .card{background:#1E2226;border-color:rgba(236,239,241,0.12)}
    .logo{display:flex;align-items:center;gap:0.7rem;margin-bottom:2rem}
    .mark{width:38px;height:38px;background:var(--teal);border-radius:10px;display:flex;align-items:center;justify-content:center;font-family:'Inter',sans-serif;font-weight:800;color:#fff;font-size:0.9rem}
    h1{font-family:'Inter',sans-serif;font-weight:800;font-size:1.55rem;margin-bottom:0.4rem;letter-spacing:-0.01em}
    .sub{font-size:0.78rem;color:rgba(22,20,18,0.45);margin-bottom:2rem}
    .field{margin-bottom:1rem}
    label{display:block;font-size:0.72rem;font-weight:600;color:rgba(22,20,18,0.5);margin-bottom:0.4rem;letter-spacing:0.05em;text-transform:uppercase}
    input{width:100%;background:var(--surface);border:1.5px solid transparent;border-radius:10px;padding:0.8rem 1rem;font-size:0.82rem;font-family:'Inter',sans-serif;color:var(--ink);outline:none;transition:all 0.2s}
    input:focus{border-color:var(--teal);background:#fff;box-shadow:0 0 0 3px rgba(0,107,94,0.08)}
    .btn{width:100%;background:var(--teal);color:#fff;border:none;border-radius:10px;padding:0.9rem;font-size:0.85rem;font-weight:600;font-family:'Inter',sans-serif;cursor:pointer;margin-top:0.5rem;transition:background 0.2s}
    .btn:hover{background:var(--teal2)}
    .error{background:rgba(232,93,58,0.08);border:1px solid rgba(232,93,58,0.2);color:#c0392b;padding:0.7rem 1rem;border-radius:8px;font-size:0.75rem;margin-bottom:1rem}
    .theme-toggle{position:absolute;right:1rem;top:1rem;background:transparent;color:var(--ink);border:1px solid rgba(22,20,18,0.18);border-radius:999px;padding:0.35rem 0.7rem;font-size:0.72rem;cursor:pointer}
    body.dark-mode .theme-toggle{border-color:rgba(236,239,241,0.28)}
    body.dark-mode h1,
    body.dark-mode .sub,
    body.dark-mode label,
    body.dark-mode .logo span{color:var(--ink)!important}
    body.dark-mode .sub{color:rgba(236,239,241,0.68)!important}
    body.dark-mode input{background:var(--surface);color:var(--ink);border-color:transparent}
    body.dark-mode input::placeholder{color:rgba(236,239,241,0.48)}
  </style>
</head>
<body>
  <div class="card">
    <button class="theme-toggle" id="themeToggle" type="button">🌙 Dark</button>
    <div class="logo"><div class="mark">EK</div><span style="font-family:'Inter',sans-serif;font-weight:700;font-size:0.95rem">EK Printers Admin</span></div>
    <h1>Welcome back</h1>
    <p class="sub">Sign in to manage quote requests</p>
    ` + err + `
    <form method="POST" action="/admin/login">
      <div class="field"><label>Username</label><input type="text" name="username" placeholder="admin" required autofocus></div>
      <div class="field"><label>Password</label><input type="password" name="password" placeholder="••••••••" required></div>
      <button class="btn" type="submit">Sign In →</button>
    </form>
  </div>
  <script>
    const THEME_KEY = 'ek-theme';
    function applyTheme(theme) {
      const dark = theme === 'dark';
      document.body.classList.toggle('dark-mode', dark);
      const btn = document.getElementById('themeToggle');
      if (btn) btn.textContent = dark ? '☀ Light' : '🌙 Dark';
    }
    applyTheme(localStorage.getItem(THEME_KEY) || 'light');
    const toggle = document.getElementById('themeToggle');
    if (toggle) {
      toggle.addEventListener('click', () => {
        const next = document.body.classList.contains('dark-mode') ? 'light' : 'dark';
        localStorage.setItem(THEME_KEY, next);
        applyTheme(next);
      });
    }
  </script>
</body>
</html>
`;
}

function adminPanelHTML(quotes, stats, filter, search, fromDate, toDate, username) {
  const rows = quotes.map(q => {
    const waNumber = normalizeWhatsAppNumber(q.phone);
    const waText = customerWhatsAppText(q);
    const waHref = waNumber ? `https://wa.me/${waNumber}?text=${waText}` : '#';
    const emailHref = q.email ? `mailto:${encodeURIComponent(q.email)}?subject=${encodeURIComponent(`EK Printers quote #${q.id}`)}` : '';
    return `
    <tr id="row-${q.id}" style="border-bottom:1px solid rgba(22,20,18,0.06)">
      <td style="padding:1rem 0.8rem;font-size:0.7rem;color:rgba(22,20,18,0.35);font-weight:600">#${q.id}</td>
      <td style="padding:1rem 0.8rem">
        <div style="font-weight:600;font-size:0.82rem;font-family:'Inter',sans-serif">${esc(q.name)}</div>
        <div style="font-size:0.7rem;color:rgba(22,20,18,0.45);margin-top:0.2rem">${esc(q.phone)}</div>
        ${q.email ? `<div style="font-size:0.68rem;color:rgba(22,20,18,0.35)">${esc(q.email)}</div>` : ''}
      </td>
      <td class="req-cell" style="padding:1rem 0.8rem;font-size:0.78rem;color:rgba(22,20,18,0.65);line-height:1.5">${esc(q.requirement)}</td>
      <td style="padding:1rem 0.8rem">${statusBadge(q.status)}</td>
      <td style="padding:1rem 0.8rem;font-size:0.68rem;color:rgba(22,20,18,0.4)">${q.created_at}</td>
      <td style="padding:1rem 0.8rem">
        <div style="display:flex;gap:0.5rem;align-items:center;flex-wrap:wrap">
          <select onchange="updateStatus(${q.id},this.value)" style="font-size:0.7rem;padding:0.3rem 0.5rem;border:1px solid rgba(22,20,18,0.12);border-radius:6px;background:#fff;cursor:pointer;outline:none;font-family:'Inter',sans-serif">
            <option value="new" ${q.status==='new'?'selected':''}>New</option>
            <option value="in_progress" ${q.status==='in_progress'?'selected':''}>In Progress</option>
            <option value="completed" ${q.status==='completed'?'selected':''}>Completed</option>
            <option value="cancelled" ${q.status==='cancelled'?'selected':''}>Cancelled</option>
          </select>
          <button onclick="openNotes(${q.id},\`${escJs(q.notes)}\`)" style="background:#F2F0EB;border:1px solid rgba(22,20,18,0.1);border-radius:6px;padding:0.3rem 0.6rem;font-size:0.7rem;cursor:pointer">📝</button>
          <a href="${waHref}" ${waNumber ? 'target="_blank" rel="noopener noreferrer"' : ''} title="${waNumber ? 'Open WhatsApp chat' : 'Invalid phone number'}" style="background:#E8F5E9;border:1px solid #c8e6c9;border-radius:6px;padding:0.3rem 0.6rem;font-size:0.7rem;text-decoration:none;${waNumber ? '' : 'opacity:0.45;pointer-events:none;'}">💬</a>
          <a href="${emailHref || '#'}" ${emailHref ? '' : 'aria-disabled="true"'} title="${emailHref ? 'Send email' : 'No email provided'}" style="background:#E8F4FF;border:1px solid #c9dfff;border-radius:6px;padding:0.3rem 0.6rem;font-size:0.7rem;text-decoration:none;${emailHref ? '' : 'opacity:0.45;pointer-events:none;'}">✉️</a>
          <button onclick="deleteQuote(${q.id})" style="background:#FFEBEE;border:1px solid #ffcdd2;border-radius:6px;padding:0.3rem 0.6rem;font-size:0.7rem;cursor:pointer">🗑️</button>
        </div>
        ${q.notes ? `<div class="note-snippet" style="margin-top:0.5rem;font-size:0.68rem;color:rgba(22,20,18,0.5);background:#F2F0EB;padding:0.4rem 0.6rem;border-radius:6px;line-height:1.4">${esc(q.notes)}</div>` : ''}
      </td>
    </tr>`;
  }).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Admin Panel · EK Printers</title>
  <link rel="prefetch" href="/">
  <link rel="prefetch" href="/admin">
  <style>
    *{margin:0;padding:0;box-sizing:border-box}
    :root{--teal:#006B5E;--teal2:#008F7A;--bg:#FAFAF8;--surface:#F2F0EB;--ink:#161412}
    html,body{min-height:100%;width:100%;overflow-x:auto}
    body{background:var(--bg);font-family:'Inter',sans-serif;color:var(--ink);transition:background 0.25s ease,color 0.25s ease}
    body.dark-mode{--bg:#121416;--surface:#1A1D20;--ink:#ECEFF1}
    .topbar{background:#fff;border-bottom:1px solid rgba(22,20,18,0.08);padding:1rem 1.25rem;display:flex;align-items:center;gap:1rem;flex-wrap:wrap;position:sticky;top:0;z-index:50}
    .logo{display:flex;align-items:center;gap:0.7rem;flex:0 1 auto;min-width:0}
    .mark{width:34px;height:34px;background:var(--teal);border-radius:8px;display:flex;align-items:center;justify-content:center;font-family:'Inter',sans-serif;font-weight:800;color:#fff;font-size:0.8rem}
    .logo-text{font-family:'Inter',sans-serif;font-weight:800;font-size:0.9rem}
    .badge{background:var(--surface);font-size:0.65rem;padding:0.2rem 0.6rem;border-radius:100px;font-weight:600;color:rgba(22,20,18,0.5);margin-left:0.5rem}
    .topbar-right{display:flex;gap:0.8rem;align-items:center;flex-wrap:wrap;margin-left:auto}
    .theme-toggle{font-size:0.72rem;padding:0.4rem 0.9rem;border-radius:100px;border:1.5px solid rgba(22,20,18,0.12);background:transparent;cursor:pointer;color:var(--ink)}
    .user-pill{font-size:0.75rem;color:rgba(22,20,18,0.5);background:var(--surface);padding:0.35rem 0.9rem;border-radius:100px}
    .btn-sm{font-size:0.72rem;padding:0.4rem 1rem;border-radius:100px;border:1.5px solid rgba(22,20,18,0.12);background:transparent;cursor:pointer;font-family:'Inter',sans-serif;text-decoration:none;color:var(--ink);transition:all 0.2s}
    .btn-sm:hover{background:var(--ink);color:#fff;border-color:var(--ink)}
    .content{padding:1.25rem 1.25rem 2rem;width:100%;max-width:100%;box-sizing:border-box}
    .stats-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:0.75rem;margin-bottom:1.5rem;width:100%}
    .stat-card{background:#fff;border:1px solid rgba(22,20,18,0.07);border-radius:14px;padding:1rem 1.1rem;min-width:0}
    .stat-label{font-size:0.68rem;color:rgba(22,20,18,0.4);font-weight:600;letter-spacing:0.07em;text-transform:uppercase;margin-bottom:0.4rem}
    .stat-val{font-family:'Inter',sans-serif;font-weight:800;font-size:2rem;letter-spacing:-0.02em}
    .controls{display:flex;flex-direction:column;gap:0.85rem;margin-bottom:1.5rem;width:100%}
    .controls-filters{display:flex;flex-wrap:wrap;gap:0.5rem;align-items:center}
    .controls-toolbar{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:0.65rem;align-items:center;width:100%}
    .date-field{width:100%;max-width:none}
    .search-main{grid-column:1/-1;width:100%;min-width:0;max-width:none}
    .controls-toolbar .export-btn{grid-column:1/-1;justify-self:start}
    .filter-btn{font-size:0.72rem;padding:0.45rem 1.1rem;border-radius:100px;border:1.5px solid rgba(22,20,18,0.1);background:transparent;cursor:pointer;font-family:'Inter',sans-serif;font-weight:500;text-decoration:none;color:var(--ink);transition:all 0.2s}
    .filter-btn.active{background:var(--teal);color:#fff;border-color:var(--teal)}
    .search-box{background:#fff;border:1.5px solid rgba(22,20,18,0.1);border-radius:10px;padding:0.5rem 0.85rem;font-size:0.78rem;font-family:'Inter',sans-serif;outline:none;transition:all 0.2s;box-sizing:border-box}
    .search-box:focus{border-color:var(--teal)}
    .export-btn{background:var(--teal);color:#fff;border:none;border-radius:10px;padding:0.5rem 1.2rem;font-size:0.72rem;font-weight:600;font-family:'Inter',sans-serif;cursor:pointer;text-decoration:none;transition:background 0.2s;white-space:nowrap;flex-shrink:0}
    .export-btn:hover{background:var(--teal2)}
    .table-wrap{background:#fff;border:1px solid rgba(22,20,18,0.07);border-radius:16px;overflow:auto;width:100%;min-width:0}
    table{width:100%;border-collapse:collapse;table-layout:auto}
    th{padding:0.8rem;text-align:left;font-size:0.67rem;font-weight:600;color:rgba(22,20,18,0.4);letter-spacing:0.07em;text-transform:uppercase;background:var(--surface)}
    th:nth-child(3),td.req-cell{min-width:10rem;max-width:36rem}
    .note-snippet{max-width:100%}
    .empty{text-align:center;padding:4rem;color:rgba(22,20,18,0.3);font-size:0.85rem}
    .modal-overlay{display:none;position:fixed;inset:0;background:rgba(0,0,0,0.4);z-index:200;align-items:center;justify-content:center}
    .modal-overlay.open{display:flex}
    .modal{background:#fff;border-radius:16px;padding:1.5rem;width:400px;max-width:90vw}
    .modal h3{font-family:'Inter',sans-serif;font-weight:700;font-size:1rem;margin-bottom:1rem}
    .modal textarea{width:100%;background:var(--surface);border:1.5px solid transparent;border-radius:10px;padding:0.8rem;font-size:0.8rem;font-family:'Inter',sans-serif;outline:none;resize:vertical;min-height:100px;transition:all 0.2s}
    .modal textarea:focus{border-color:var(--teal);background:#fff}
    .modal-actions{display:flex;gap:0.7rem;margin-top:1rem;justify-content:flex-end}
    .modal-save{background:var(--teal);color:#fff;border:none;border-radius:8px;padding:0.6rem 1.3rem;font-size:0.78rem;font-weight:600;font-family:'Inter',sans-serif;cursor:pointer}
    .modal-cancel{background:transparent;color:rgba(22,20,18,0.5);border:1.5px solid rgba(22,20,18,0.1);border-radius:8px;padding:0.6rem 1.3rem;font-size:0.78rem;font-family:'Inter',sans-serif;cursor:pointer}
    @media (min-width:640px){
      .stats-grid{grid-template-columns:repeat(4,minmax(0,1fr));gap:1rem;margin-bottom:2rem}
      .stat-card{padding:1.2rem 1.5rem}
    }
    @media (min-width:720px){
      .content{padding:1.5rem 2rem 2rem}
    }
    @media (min-width:900px){
      .topbar{padding:1rem 2rem}
      .content{padding:2rem}
      .controls{flex-direction:row;align-items:center;gap:1rem 1.25rem}
      .controls-filters{flex-shrink:0}
      .controls-toolbar{display:flex;flex-wrap:wrap;flex:1;min-width:0;justify-content:flex-end;gap:0.65rem}
      .controls-toolbar .search-main{grid-column:auto;flex:1 1 14rem;width:auto;max-width:24rem}
      .controls-toolbar .export-btn{grid-column:auto;justify-self:auto}
      .date-field{width:auto;min-width:10.5rem}
    }
    body.dark-mode .topbar,body.dark-mode .stat-card,body.dark-mode .table-wrap,body.dark-mode .modal{background:#1E2226;border-color:rgba(236,239,241,0.12)}
    body.dark-mode th{background:var(--surface)}
    body.dark-mode .search-box{background:var(--surface);border-color:rgba(236,239,241,0.2);color:var(--ink)}
    body.dark-mode .btn-sm,body.dark-mode .theme-toggle{border-color:rgba(236,239,241,0.24);color:var(--ink)}
    body.dark-mode td,body.dark-mode th,body.dark-mode label,body.dark-mode input,body.dark-mode select,body.dark-mode textarea{color:var(--ink)}
    body.dark-mode .stat-label,body.dark-mode .badge,body.dark-mode .user-pill,body.dark-mode .empty{color:rgba(236,239,241,0.68)}
    body.dark-mode [style*="rgba(22,20,18,0.35)"]{color:rgba(236,239,241,0.66)!important}
    body.dark-mode [style*="rgba(22,20,18,0.4)"]{color:rgba(236,239,241,0.66)!important}
    body.dark-mode [style*="rgba(22,20,18,0.45)"]{color:rgba(236,239,241,0.7)!important}
    body.dark-mode [style*="rgba(22,20,18,0.5)"]{color:rgba(236,239,241,0.72)!important}
    body.dark-mode [style*="rgba(22,20,18,0.65)"]{color:rgba(236,239,241,0.84)!important}
    body.dark-mode [style*="background:#F2F0EB"]{background:#243037!important}
    body.dark-mode [style*="background:#fff"]{background:#1E2226!important}
  </style>
</head>
<body>
  <div class="topbar">
    <div class="logo">
      <div class="mark">EK</div>
      <span class="logo-text">EK Printers</span>
      <span class="badge">Admin Panel</span>
    </div>
    <div class="topbar-right">
      <button id="themeToggle" class="theme-toggle" type="button">🌙 Dark</button>
      <span class="user-pill">👤 ${esc(username)}</span>
      <a href="/" class="btn-sm" data-instant-nav>← Website</a>
      <a href="/admin/logout" class="btn-sm">Logout</a>
    </div>
  </div>
  <div class="content">
    <div class="stats-grid">
      <div class="stat-card"><div class="stat-label">Total Quotes</div><div class="stat-val" style="color:var(--teal)">${stats.total}</div></div>
      <div class="stat-card"><div class="stat-label">New</div><div class="stat-val" style="color:#006B5E">${stats.new}</div></div>
      <div class="stat-card"><div class="stat-label">In Progress</div><div class="stat-val" style="color:#B8860B">${stats.inProgress}</div></div>
      <div class="stat-card"><div class="stat-label">Completed</div><div class="stat-val" style="color:#2E7D32">${stats.completed}</div></div>
    </div>
    <div class="controls">
      <div class="controls-filters">
        <a href="${'/admin?' + withQuery({ status: 'all', search, fromDate, toDate })}" class="filter-btn ${filter === 'all' ? 'active' : ''}">All</a>
        <a href="${'/admin?' + withQuery({ status: 'new', search, fromDate, toDate })}" class="filter-btn ${filter === 'new' ? 'active' : ''}">🔵 New</a>
        <a href="${'/admin?' + withQuery({ status: 'in_progress', search, fromDate, toDate })}" class="filter-btn ${filter === 'in_progress' ? 'active' : ''}">🟡 In Progress</a>
        <a href="${'/admin?' + withQuery({ status: 'completed', search, fromDate, toDate })}" class="filter-btn ${filter === 'completed' ? 'active' : ''}">🟢 Completed</a>
      </div>
      <div class="controls-toolbar">
        <input id="fromDate" class="search-box date-field" type="date" value="${esc(fromDate)}" onchange="applyFilters()">
        <input id="toDate" class="search-box date-field" type="date" value="${esc(toDate)}" onchange="applyFilters()">
        <input id="searchInput" class="search-box search-main" type="text" placeholder="Search name, phone..." value="${esc(search)}" oninput="debounceSearch(this)">
        <a id="exportBtn" href="${'/admin/export?' + withQuery({ status: filter, search, fromDate, toDate })}" class="export-btn">⬇ Export Excel</a>
      </div>
    </div>
    <div class="table-wrap">
      <table>
        <thead><tr><th>#</th><th>Client</th><th>Requirement</th><th>Status</th><th>Date</th><th>Actions</th></tr></thead>
        <tbody>${rows || '<tr><td colspan="6" class="empty">No quote requests yet.</td></tr>'}</tbody>
      </table>
    </div>
  </div>
  <div class="modal-overlay" id="notesModal">
    <div class="modal">
      <h3>📝 Internal Notes</h3>
      <textarea id="notesText" placeholder="Add notes about this order..."></textarea>
      <div class="modal-actions">
        <button class="modal-cancel" onclick="closeNotes()">Cancel</button>
        <button class="modal-save" onclick="saveNotes()">Save Notes</button>
      </div>
    </div>
  </div>
  <script>
    const THEME_KEY = 'ek-theme';
    function applyTheme(theme) {
      const dark = theme === 'dark';
      document.body.classList.toggle('dark-mode', dark);
      const btn = document.getElementById('themeToggle');
      if (btn) btn.textContent = dark ? '☀ Light' : '🌙 Dark';
    }
    applyTheme(localStorage.getItem(THEME_KEY) || 'light');
    const themeBtn = document.getElementById('themeToggle');
    if (themeBtn) {
      themeBtn.addEventListener('click', () => {
        const next = document.body.classList.contains('dark-mode') ? 'light' : 'dark';
        localStorage.setItem(THEME_KEY, next);
        applyTheme(next);
      });
    }
    document.querySelectorAll('a[data-instant-nav]').forEach(link => {
      link.addEventListener('pointerdown', () => {
        const href = link.getAttribute('href');
        if (href) fetch(href, { credentials: 'include' }).catch(() => {});
      }, { passive: true });
    });
    let activeNoteId = null;
    async function updateStatus(id, status) {
      await fetch('/admin/quote/'+id+'/status',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({status})});
    }
    function openNotes(id, notes) {
      activeNoteId = id;
      document.getElementById('notesText').value = notes || '';
      document.getElementById('notesModal').classList.add('open');
    }
    function closeNotes() { activeNoteId = null; document.getElementById('notesModal').classList.remove('open'); }
    async function saveNotes() {
      const notes = document.getElementById('notesText').value;
      await fetch('/admin/quote/'+activeNoteId+'/notes',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({notes})});
      closeNotes(); location.reload();
    }
    async function deleteQuote(id) {
      if (!confirm('Delete this quote? Cannot be undone.')) return;
      await fetch('/admin/quote/'+id,{method:'DELETE'});
      document.getElementById('row-'+id).remove();
    }
    let t;
    function debounceSearch(el) { clearTimeout(t); t = setTimeout(() => applyFilters(), 500); }
    function applyFilters() {
      const params = new URLSearchParams();
      const search = document.getElementById('searchInput').value.trim();
      const fromDate = document.getElementById('fromDate').value;
      const toDate = document.getElementById('toDate').value;
      const status = ${JSON.stringify(filter)};
      if (status) params.set('status', status);
      if (search) params.set('search', search);
      if (fromDate) params.set('fromDate', fromDate);
      if (toDate) params.set('toDate', toDate);
      location.href = '/admin?' + params.toString();
    }
    document.getElementById('notesModal').addEventListener('click', e => { if(e.target===e.currentTarget) closeNotes(); });
  </script>
</body>
</html>
`;
}

app.get('/about', (req, res) => res.sendFile(path.join(__dirname, 'public', 'about.html')));

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.use(express.static(path.join(__dirname, 'public'), {
  etag: true,
  lastModified: true,
  maxAge: '1d'
}));

app.listen(PORT, '0.0.0.0', () => {
  console.log(`EK Printers running at http://localhost:${PORT}`);
});
