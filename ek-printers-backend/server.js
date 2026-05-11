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
  const subject = `New Quote Request #${id} · EK PRINTERS`;
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
    `Hi EK PRINTERS! New quote request (#${id}).\n` +
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

app.post('/admin/change-password', requireAuth, (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  if (!currentPassword || !newPassword || typeof newPassword !== 'string') {
    return res.status(400).json({ success: false, message: 'Enter your current password and a new password.' });
  }
  if (newPassword.length < 8) {
    return res.status(400).json({ success: false, message: 'New password must be at least 8 characters.' });
  }
  if (newPassword.length > 200) {
    return res.status(400).json({ success: false, message: 'New password is too long.' });
  }
  const db = loadDB();
  const curHash = crypto.createHash('sha256').update(String(currentPassword)).digest('hex');
  if (db.admin.password !== curHash) {
    return res.status(401).json({ success: false, message: 'Current password is incorrect.' });
  }
  db.admin.password = crypto.createHash('sha256').update(newPassword).digest('hex');
  saveDB(db);
  res.json({ success: true, message: 'Password updated. Use it next time you sign in.' });
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
    `Hi ${q.name}, this is EK PRINTERS about your quote #${q.id}.\n` +
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
  <title>Admin Login · EK PRINTERS</title>
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
    <div class="logo"><div class="mark">EK</div><span style="font-family:'Inter',sans-serif;font-weight:700;font-size:0.95rem">EK PRINTERS Admin</span></div>
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

const SVG_WA = '<svg class="icon-svg" viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.435 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z"/></svg>';
const SVG_MAIL = '<svg class="icon-svg" viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M20 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm0 4l-8 5-8-5V6l8 5 8-5v2z"/></svg>';
const SVG_TRASH = '<svg class="icon-svg" viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg>';

function adminPanelHTML(quotes, stats, filter, search, fromDate, toDate, username) {
  const rows = quotes.map(q => {
    const waNumber = normalizeWhatsAppNumber(q.phone);
    const waText = customerWhatsAppText(q);
    const waHref = waNumber ? `https://wa.me/${waNumber}?text=${waText}` : '#';
    const emailHref = q.email ? `mailto:${encodeURIComponent(q.email)}?subject=${encodeURIComponent(`EK PRINTERS quote #${q.id}`)}` : '';
    const notesEnc = encodeURIComponent(q.notes || '');
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
        <div class="action-row">
          <select class="action-status" onchange="updateStatus(${q.id},this.value)">
            <option value="new" ${q.status==='new'?'selected':''}>New</option>
            <option value="in_progress" ${q.status==='in_progress'?'selected':''}>In Progress</option>
            <option value="completed" ${q.status==='completed'?'selected':''}>Completed</option>
            <option value="cancelled" ${q.status==='cancelled'?'selected':''}>Cancelled</option>
          </select>
          <div class="action-icons">
            <a class="icon-action icon-wa${waNumber ? '' : ' is-disabled'}" href="${waHref}" ${waNumber ? 'target="_blank" rel="noopener noreferrer"' : ''} title="${waNumber ? 'WhatsApp' : 'Invalid phone'}" aria-label="WhatsApp">${SVG_WA}</a>
            <a class="icon-action icon-mail${emailHref ? '' : ' is-disabled'}" href="${emailHref || '#'}" title="${emailHref ? 'Email' : 'No email'}" aria-label="Email"${emailHref ? '' : ' aria-disabled="true"'}>${SVG_MAIL}</a>
            <button type="button" class="icon-action icon-del" onclick="deleteQuote(${q.id})" title="Delete" aria-label="Delete">${SVG_TRASH}</button>
          </div>
          <button type="button" class="notes-link" data-nid="${q.id}" data-notes="${notesEnc}">Notes</button>
        </div>
        ${q.notes ? `<div class="note-snippet" style="margin-top:0.5rem;font-size:0.68rem;color:rgba(22,20,18,0.5);background:#F2F0EB;padding:0.4rem 0.6rem;border-radius:6px;line-height:1.4">${esc(q.notes)}</div>` : ''}
      </td>
    </tr>`;
  }).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Admin Panel · EK PRINTERS</title>
  <link rel="prefetch" href="/">
  <link rel="prefetch" href="/admin">
  <style>
    *{margin:0;padding:0;box-sizing:border-box}
    :root{--teal:#006B5E;--teal2:#008F7A;--bg:#FAFAF8;--surface:#F2F0EB;--ink:#161412}
    html,body{min-height:100%;width:100%;overflow-x:auto}
    body{background:var(--bg);font-family:'Inter',sans-serif;color:var(--ink);transition:background 0.25s ease,color 0.25s ease}
    body.dark-mode{--bg:#121416;--surface:#1A1D20;--ink:#ECEFF1}
    .topbar{background:#fff;border-bottom:1px solid rgba(22,20,18,0.08);padding:0.75rem 1rem;display:flex;align-items:center;justify-content:space-between;gap:0.5rem;flex-wrap:nowrap;position:sticky;top:0;z-index:50;width:100%;box-sizing:border-box}
    .logo{display:flex;align-items:center;gap:0.45rem;flex:1 1 auto;min-width:0;max-width:calc(100% - 7.5rem)}
    .mark{width:32px;height:32px;flex-shrink:0;background:var(--teal);border-radius:8px;display:flex;align-items:center;justify-content:center;font-family:'Inter',sans-serif;font-weight:800;color:#fff;font-size:0.78rem}
    .logo-text{font-family:'Inter',sans-serif;font-weight:800;font-size:clamp(0.78rem,3.2vw,0.95rem);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0}
    .badge{background:var(--surface);font-size:0.58rem;padding:0.15rem 0.45rem;border-radius:100px;font-weight:600;color:rgba(22,20,18,0.5);margin-left:0.25rem;flex-shrink:0;white-space:nowrap}
    .topbar-right{display:flex;gap:0.45rem;align-items:center;flex-wrap:nowrap;flex-shrink:0;margin-left:0}
    .theme-toggle{font-size:0.65rem;padding:0.32rem 0.55rem;border-radius:100px;border:1.5px solid rgba(22,20,18,0.12);background:transparent;cursor:pointer;color:var(--ink);white-space:nowrap;flex-shrink:0}
    .profile-wrap{position:relative;flex-shrink:0}
    .profile-btn{width:36px;height:36px;border-radius:50%;border:2px solid var(--teal);background:var(--surface);color:var(--teal);cursor:pointer;display:inline-flex;align-items:center;justify-content:center;padding:0;flex-shrink:0;transition:background .2s,border-color .2s,transform .15s}
    .profile-btn:hover{background:rgba(0,107,94,0.08)}
    .profile-btn:focus-visible{outline:2px solid var(--teal);outline-offset:2px}
    .profile-btn[aria-expanded="true"]{background:rgba(0,107,94,0.12);border-color:var(--teal2)}
    @media (max-width:360px){
      .stats-grid{gap:0.35rem}
      .stat-card{padding:0.55rem 0.4rem}
      .stat-label{font-size:0.52rem}
      .filter-btn{font-size:0.58rem;padding:0.32rem 0.52rem}
    }
    .profile-menu{display:none;position:absolute;right:0;top:calc(100% + 8px);min-width:12.5rem;padding:0.35rem;border-radius:12px;background:#fff;border:1px solid rgba(22,20,18,0.1);box-shadow:0 14px 44px rgba(22,20,18,0.12);z-index:120}
    .profile-menu.is-open{display:block}
    .profile-item{display:flex;align-items:center;width:100%;padding:0.65rem 0.85rem;font-size:0.8rem;font-weight:500;color:var(--ink);text-decoration:none;border-radius:8px;border:none;background:transparent;cursor:pointer;font-family:'Inter',sans-serif;text-align:left;box-sizing:border-box}
    .profile-item:hover{background:var(--surface)}
    .profile-item-danger{color:#c0392b}
    .profile-item-danger:hover{background:rgba(192,57,43,0.08)}
    .profile-hint{font-size:0.65rem;color:rgba(22,20,18,0.45);padding:0.35rem 0.85rem 0.25rem;border-top:1px solid rgba(22,20,18,0.08);margin-top:0.2rem}
    .btn-sm{font-size:0.72rem;padding:0.4rem 1rem;border-radius:100px;border:1.5px solid rgba(22,20,18,0.12);background:transparent;cursor:pointer;font-family:'Inter',sans-serif;text-decoration:none;color:var(--ink);transition:all 0.2s}
    .btn-sm:hover{background:var(--ink);color:#fff;border-color:var(--ink)}
    .content{padding:1.25rem 1.25rem 2rem;width:100%;max-width:100%;box-sizing:border-box}
    .stats-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:0.45rem;margin-bottom:1.5rem;width:100%}
    .stat-card{background:#fff;border:1px solid rgba(22,20,18,0.07);border-radius:12px;padding:0.65rem 0.5rem;min-width:0}
    .stat-label{font-size:0.58rem;color:rgba(22,20,18,0.4);font-weight:600;letter-spacing:0.05em;text-transform:uppercase;margin-bottom:0.25rem;line-height:1.2}
    .stat-val{font-family:'Inter',sans-serif;font-weight:800;font-size:clamp(1.15rem,4.2vw,2rem);letter-spacing:-0.02em;line-height:1}
    .controls{display:flex;flex-direction:column;gap:0.85rem;margin-bottom:1.5rem;width:100%}
    .controls-filters{display:flex;flex-wrap:nowrap;gap:0.35rem;align-items:center;overflow-x:auto;-webkit-overflow-scrolling:touch;padding-bottom:2px;scrollbar-width:thin;width:100%}
    .controls-filters::-webkit-scrollbar{height:4px}
    .controls-filters::-webkit-scrollbar-thumb{background:rgba(22,20,18,0.15);border-radius:4px}
    .controls-toolbar{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:0.65rem;align-items:center;width:100%}
    .controls-toolbar .date-field:nth-of-type(1){grid-column:1}
    .controls-toolbar .date-field:nth-of-type(2){grid-column:2}
    .controls-toolbar .search-main{grid-column:1/-1;width:100%;min-width:0;max-width:none}
    .controls-toolbar .export-btn{grid-column:1/-1;justify-self:end}
    .filter-btn{flex:0 0 auto;font-size:0.64rem;padding:0.38rem 0.65rem;border-radius:100px;border:1.5px solid rgba(22,20,18,0.1);background:transparent;cursor:pointer;font-family:'Inter',sans-serif;font-weight:500;text-decoration:none;color:var(--ink);transition:all 0.2s;white-space:nowrap}
    .filter-btn.active{background:var(--teal);color:#fff;border-color:var(--teal)}
    .search-box{background:#fff;border:1.5px solid rgba(22,20,18,0.1);border-radius:10px;padding:0.5rem 0.85rem;font-size:0.78rem;font-family:'Inter',sans-serif;outline:none;transition:all 0.2s;box-sizing:border-box}
    .search-box:focus{border-color:var(--teal)}
    .export-btn{background:var(--teal);color:#fff;border:none;border-radius:10px;padding:0.5rem 1.2rem;font-size:0.72rem;font-weight:600;font-family:'Inter',sans-serif;cursor:pointer;text-decoration:none;transition:background 0.2s;white-space:nowrap;flex-shrink:0}
    .export-btn:hover{background:var(--teal2)}
    .table-wrap{background:#fff;border:1px solid rgba(22,20,18,0.07);border-radius:16px;overflow-x:auto;width:100%;min-width:0;-webkit-overflow-scrolling:touch}
    table{width:100%;min-width:100%;border-collapse:collapse;table-layout:auto}
    th{padding:0.8rem;text-align:left;font-size:0.67rem;font-weight:600;color:rgba(22,20,18,0.4);letter-spacing:0.07em;text-transform:uppercase;background:var(--surface)}
    th:nth-child(3),td.req-cell{min-width:10rem;max-width:36rem}
    .note-snippet{max-width:100%}
    .action-row{display:flex;flex-wrap:wrap;align-items:center;gap:0.45rem 0.6rem}
    .action-status{font-size:0.7rem;padding:0.3rem 0.45rem;border:1px solid rgba(22,20,18,0.12);border-radius:6px;background:#fff;cursor:pointer;outline:none;font-family:'Inter',sans-serif;flex-shrink:0}
    .action-icons{display:inline-flex;align-items:center;gap:0.35rem;flex-shrink:0}
    .icon-action{display:inline-flex;align-items:center;justify-content:center;width:2rem;height:2rem;border-radius:8px;text-decoration:none;border:1px solid transparent;cursor:pointer;padding:0;font-family:'Inter',sans-serif;box-sizing:border-box;vertical-align:middle}
    .icon-action .icon-svg{display:block;flex-shrink:0}
    .icon-wa{background:#e8f8ec;border-color:rgba(37,211,102,0.35);color:#128c4e}
    .icon-wa:hover{background:#d4f0dc;color:#075e54}
    .icon-mail{background:#e8f2fc;border-color:rgba(21,101,192,0.25);color:#1565c0}
    .icon-mail:hover{background:#d7e8f8;color:#0d47a1}
    .icon-del{background:#ffebee;border-color:rgba(198,40,40,0.25);color:#c62828}
    .icon-del:hover{background:#ffcdd2}
    .icon-action.is-disabled{opacity:0.42;pointer-events:none}
    .notes-link{background:none;border:none;padding:0;font-size:0.68rem;font-weight:600;color:var(--teal);cursor:pointer;text-decoration:underline;font-family:'Inter',sans-serif;margin-left:0.15rem}
    .notes-link:hover{color:var(--teal2)}
    .empty{text-align:center;padding:4rem;color:rgba(22,20,18,0.3);font-size:0.85rem}
    .modal-overlay{display:none;position:fixed;inset:0;background:rgba(0,0,0,0.4);z-index:200;align-items:center;justify-content:center}
    .modal-overlay.open{display:flex}
    .modal{background:#fff;border-radius:16px;padding:1.5rem;width:400px;max-width:90vw}
    .modal.pass-modal{width:min(100%,380px)}
    .modal h3{font-family:'Inter',sans-serif;font-weight:700;font-size:1rem;margin-bottom:1rem}
    .modal .field{margin-bottom:0.85rem}
    .modal .field label{display:block;font-size:0.68rem;font-weight:600;color:rgba(22,20,18,0.5);margin-bottom:0.35rem;text-transform:uppercase;letter-spacing:0.04em}
    .modal .field input{width:100%;box-sizing:border-box;background:var(--surface);border:1.5px solid rgba(22,20,18,0.1);border-radius:10px;padding:0.65rem 0.85rem;font-size:0.85rem;font-family:'Inter',sans-serif;color:var(--ink);outline:none}
    .modal .field input:focus{border-color:var(--teal);background:#fff}
    .pass-msg{font-size:0.75rem;margin-bottom:0.75rem;padding:0.55rem 0.7rem;border-radius:8px;display:none}
    .pass-msg.err{display:block;background:rgba(192,57,43,0.1);color:#a82315;border:1px solid rgba(192,57,43,0.2)}
    .pass-msg.ok{display:block;background:rgba(0,107,94,0.1);color:var(--teal);border:1px solid rgba(0,107,94,0.2)}
    .modal textarea{width:100%;background:var(--surface);border:1.5px solid transparent;border-radius:10px;padding:0.8rem;font-size:0.8rem;font-family:'Inter',sans-serif;outline:none;resize:vertical;min-height:100px;transition:all 0.2s}
    .modal textarea:focus{border-color:var(--teal);background:#fff}
    .modal-actions{display:flex;gap:0.7rem;margin-top:1rem;justify-content:flex-end}
    .modal-save{background:var(--teal);color:#fff;border:none;border-radius:8px;padding:0.6rem 1.3rem;font-size:0.78rem;font-weight:600;font-family:'Inter',sans-serif;cursor:pointer}
    .modal-cancel{background:transparent;color:rgba(22,20,18,0.5);border:1.5px solid rgba(22,20,18,0.1);border-radius:8px;padding:0.6rem 1.3rem;font-size:0.78rem;font-family:'Inter',sans-serif;cursor:pointer}
    @media (min-width:480px){
      .topbar{padding:0.85rem 1.15rem;gap:0.65rem}
      .logo{gap:0.65rem;max-width:calc(100% - 8.5rem)}
      .mark{width:34px;height:34px;font-size:0.8rem}
      .theme-toggle{font-size:0.72rem;padding:0.4rem 0.85rem}
      .profile-btn{width:40px;height:40px}
      .badge{font-size:0.65rem;padding:0.2rem 0.55rem}
    }
    @media (max-width:380px){
      .topbar .badge{display:none}
      .logo{max-width:calc(100% - 6.5rem)}
    }
    @media (min-width:640px){
      .stats-grid{gap:1rem;margin-bottom:2rem}
      .stat-card{padding:1.2rem 1.5rem;border-radius:14px}
      .stat-label{font-size:0.68rem;margin-bottom:0.4rem;letter-spacing:0.07em}
      .stat-val{font-size:2rem}
      .filter-btn{font-size:0.72rem;padding:0.45rem 1rem}
    }
    @media (min-width:720px){
      .content{padding:1.5rem 2rem 2rem}
    }
    @media (min-width:900px){
      .topbar{padding:1rem 2rem;gap:1rem}
      .logo{max-width:none}
      .logo-text{font-size:0.95rem}
      .content{padding:2rem}
      .controls{flex-direction:row;align-items:center;gap:1rem 1.25rem}
      .controls-filters{flex-shrink:0}
      .controls-toolbar{display:flex;flex-direction:row;flex-wrap:nowrap;flex:1;min-width:0;justify-content:flex-end;align-items:center;gap:0.65rem}
      .controls-toolbar .date-field:nth-of-type(1),.controls-toolbar .date-field:nth-of-type(2){grid-column:auto;width:auto;min-width:10.5rem}
      .controls-toolbar .search-main{grid-column:auto;flex:1 1 14rem;width:auto;min-width:8rem;max-width:24rem}
      .controls-toolbar .export-btn{grid-column:auto;justify-self:auto;margin-left:0}
    }
    body.dark-mode .topbar,body.dark-mode .stat-card,body.dark-mode .table-wrap,body.dark-mode .modal{background:#1E2226;border-color:rgba(236,239,241,0.12)}
    body.dark-mode th{background:var(--surface)}
    body.dark-mode .search-box{background:var(--surface);border-color:rgba(236,239,241,0.2);color:var(--ink)}
    body.dark-mode .btn-sm,body.dark-mode .theme-toggle{border-color:rgba(236,239,241,0.24);color:var(--ink)}
    body.dark-mode td,body.dark-mode th,body.dark-mode label,body.dark-mode input,body.dark-mode select,body.dark-mode textarea{color:var(--ink)}
    body.dark-mode .stat-label,body.dark-mode .badge,body.dark-mode .empty{color:rgba(236,239,241,0.68)}
    body.dark-mode .profile-menu{background:#1E2226;border-color:rgba(236,239,241,0.14);box-shadow:0 14px 44px rgba(0,0,0,0.45)}
    body.dark-mode .profile-item:hover{background:rgba(236,239,241,0.06)}
    body.dark-mode .profile-hint{color:rgba(236,239,241,0.5);border-color:rgba(236,239,241,0.1)}
    body.dark-mode .profile-btn{background:#243038;border-color:#5ec4b0;color:#a7e8de}
    body.dark-mode .profile-btn:hover{background:rgba(94,196,176,0.12)}
    body.dark-mode .modal .field label{color:rgba(236,239,241,0.55)}
    body.dark-mode .modal .field input{background:var(--surface);border-color:rgba(236,239,241,0.2);color:var(--ink)}
    body.dark-mode .pass-msg.err{background:rgba(239,83,80,0.12)!important;color:#ffcdd2!important;border-color:rgba(239,83,80,0.25)!important}
    body.dark-mode .pass-msg.ok{background:rgba(0,107,94,0.2)!important;color:#7fe8d6!important;border-color:rgba(0,107,94,0.35)!important}
    body.dark-mode [style*="rgba(22,20,18,0.35)"]{color:rgba(236,239,241,0.66)!important}
    body.dark-mode [style*="rgba(22,20,18,0.4)"]{color:rgba(236,239,241,0.66)!important}
    body.dark-mode [style*="rgba(22,20,18,0.45)"]{color:rgba(236,239,241,0.7)!important}
    body.dark-mode [style*="rgba(22,20,18,0.5)"]{color:rgba(236,239,241,0.72)!important}
    body.dark-mode [style*="rgba(22,20,18,0.65)"]{color:rgba(236,239,241,0.84)!important}
    body.dark-mode [style*="background:#F2F0EB"]{background:#243037!important}
    body.dark-mode [style*="background:#fff"]{background:#1E2226!important}
    body.dark-mode .action-status{background:var(--surface)!important;border-color:rgba(236,239,241,0.22)!important;color:var(--ink)!important}
    body.dark-mode .icon-wa{background:#143d28!important;border-color:rgba(37,211,102,0.35)!important;color:#7fe8a8!important}
    body.dark-mode .icon-mail{background:#1a2f4a!important;border-color:rgba(100,181,246,0.35)!important;color:#90caf9!important}
    body.dark-mode .icon-del{background:#3d2426!important;border-color:rgba(239,83,80,0.35)!important;color:#ef9a9a!important}
    body.dark-mode .notes-link{color:#6ee7d6}
  </style>
</head>
<body>
  <div class="topbar">
    <div class="logo">
      <div class="mark">EK</div>
      <span class="logo-text">EK PRINTERS</span>
      <span class="badge">Admin Panel</span>
    </div>
    <div class="topbar-right">
      <button id="themeToggle" class="theme-toggle" type="button">🌙 Dark</button>
      <div class="profile-wrap" id="profileWrap">
        <button type="button" class="profile-btn" id="profileBtn" aria-expanded="false" aria-haspopup="true" aria-label="Account menu, signed in as ${esc(username)}">
          <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path fill="currentColor" d="M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z"/></svg>
        </button>
        <div class="profile-menu" id="profileMenu" role="menu">
          <a role="menuitem" class="profile-item" href="/" data-instant-nav>Open website</a>
          <button type="button" role="menuitem" class="profile-item" id="openChangePass">Change password</button>
          <a role="menuitem" class="profile-item profile-item-danger" href="/admin/logout">Log out</a>
          <div class="profile-hint">Signed in as <strong>${esc(username)}</strong></div>
        </div>
      </div>
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
  <div class="modal-overlay" id="passModal">
    <div class="modal pass-modal">
      <h3>Change password</h3>
      <p style="font-size:0.78rem;color:rgba(22,20,18,0.55);margin-bottom:1rem;line-height:1.45">Enter your current password, then a new password. Minimum 8 characters.</p>
      <div id="passMsg" class="pass-msg" role="alert"></div>
      <div class="field"><label for="passCurrent">Current password</label><input type="password" id="passCurrent" autocomplete="current-password"></div>
      <div class="field"><label for="passNew">New password</label><input type="password" id="passNew" autocomplete="new-password"></div>
      <div class="field"><label for="passNew2">Confirm new password</label><input type="password" id="passNew2" autocomplete="new-password"></div>
      <div class="modal-actions">
        <button type="button" class="modal-cancel" id="passCancel">Cancel</button>
        <button type="button" class="modal-save" id="passSave">Update password</button>
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
    (function profileMenu(){
      const wrap = document.getElementById('profileWrap');
      const btn = document.getElementById('profileBtn');
      const menu = document.getElementById('profileMenu');
      if (!wrap || !btn || !menu) return;
      function setOpen(open) {
        menu.classList.toggle('is-open', open);
        btn.setAttribute('aria-expanded', open ? 'true' : 'false');
      }
      btn.addEventListener('click', function(e) {
        e.stopPropagation();
        setOpen(!menu.classList.contains('is-open'));
      });
      document.addEventListener('click', function() { setOpen(false); });
      wrap.addEventListener('click', function(e) { e.stopPropagation(); });
      document.addEventListener('keydown', function(e) {
        if (e.key === 'Escape') setOpen(false);
      });
    })();
    (function changePassword(){
      const overlay = document.getElementById('passModal');
      const msg = document.getElementById('passMsg');
      const cur = document.getElementById('passCurrent');
      const n1 = document.getElementById('passNew');
      const n2 = document.getElementById('passNew2');
      const openBtn = document.getElementById('openChangePass');
      const cancel = document.getElementById('passCancel');
      const save = document.getElementById('passSave');
      if (!overlay || !openBtn) return;
      function showMsg(text, ok) {
        msg.textContent = text || '';
        msg.className = 'pass-msg' + (text ? (ok ? ' ok' : ' err') : '');
      }
      function openPass() {
        showMsg('', false);
        if (cur) cur.value = '';
        if (n1) n1.value = '';
        if (n2) n2.value = '';
        overlay.classList.add('open');
        const menu = document.getElementById('profileMenu');
        const pbtn = document.getElementById('profileBtn');
        if (menu) menu.classList.remove('is-open');
        if (pbtn) pbtn.setAttribute('aria-expanded', 'false');
        setTimeout(function() { if (cur) cur.focus(); }, 50);
      }
      function closePass() {
        overlay.classList.remove('open');
        showMsg('', false);
      }
      openBtn.addEventListener('click', function(e) {
        e.preventDefault();
        openPass();
      });
      if (cancel) cancel.addEventListener('click', closePass);
      overlay.addEventListener('click', function(e) { if (e.target === overlay) closePass(); });
      if (save) save.addEventListener('click', async function() {
        showMsg('', false);
        const currentPassword = (cur && cur.value) || '';
        const newPassword = (n1 && n1.value) || '';
        const c2 = (n2 && n2.value) || '';
        if (!currentPassword || !newPassword) {
          showMsg('Fill in all fields.', false);
          return;
        }
        if (newPassword.length < 8) {
          showMsg('New password must be at least 8 characters.', false);
          return;
        }
        if (newPassword !== c2) {
          showMsg('New password and confirmation do not match.', false);
          return;
        }
        save.disabled = true;
        try {
          const res = await fetch('/admin/change-password', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify({ currentPassword, newPassword })
          });
          const data = await res.json().catch(function() { return {}; });
          if (res.ok && data.success) {
            showMsg(data.message || 'Password updated.', true);
            setTimeout(function() { closePass(); }, 1200);
          } else {
            showMsg(data.message || 'Could not update password.', false);
          }
        } catch (err) {
          showMsg('Network error. Try again.', false);
        } finally {
          save.disabled = false;
        }
      });
    })();
    let activeNoteId = null;
    async function updateStatus(id, status) {
      await fetch('/admin/quote/'+id+'/status',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({status})});
    }
    function openNotes(id, notes) {
      activeNoteId = id;
      document.getElementById('notesText').value = notes || '';
      document.getElementById('notesModal').classList.add('open');
    }
    document.addEventListener('click', function(e) {
      const link = e.target.closest('.notes-link');
      if (!link) return;
      e.preventDefault();
      const id = parseInt(link.getAttribute('data-nid'), 10);
      let notes = '';
      try { notes = decodeURIComponent(link.getAttribute('data-notes') || ''); } catch (err) { notes = ''; }
      openNotes(id, notes);
    });
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
    document.getElementById('passModal').addEventListener('click', e => { if(e.target===e.currentTarget) document.getElementById('passCancel').click(); });
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
  console.log(`EK PRINTERS running at http://localhost:${PORT}`);
});
