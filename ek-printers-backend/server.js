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

function insertQuoteRecord(db, fields) {
  const id = db.nextId++;
  const now = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });
  const cleanService = String(fields.service || '').trim();
  const cleanBizType = String(fields.bizType || '').trim();
  const cleanQuantity = String(fields.quantity || '').trim();
  const cleanRequirementText = String(fields.requirementText || '').trim();
  const requirement = String(fields.requirement || '').trim() || [
    cleanQuantity ? `Quantity: ${cleanQuantity}` : '',
    cleanRequirementText ? `Requirement: ${cleanRequirementText}` : ''
  ].filter(Boolean).join('\n') || 'Manual entry';
  const quote = {
    id,
    name: String(fields.name || '').trim(),
    phone: String(fields.phone || '').trim(),
    email: String(fields.email || '').trim(),
    company: String(fields.company || '').trim(),
    location: String(fields.location || '').trim(),
    service: cleanService,
    biz_type: cleanBizType,
    quantity: cleanQuantity,
    requirement_text: cleanRequirementText,
    requirement,
    status: fields.status || 'new',
    notes: String(fields.notes || '').trim(),
    created_at: now,
    created_date: new Date().toISOString().slice(0, 10)
  };
  db.quotes.unshift(quote);
  saveDB(db);
  return quote;
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

async function sendQuoteEmail({ id, createdAt, name, phone, email, company, location, service, bizType, quantity, requirement }) {
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
Company: ${company || '-'}
Location: ${location || '-'}
Service: ${service || '-'}${bizType ? ` (${bizType})` : ''}
Quantity: ${quantity || '-'}

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
  const { name, phone, email, company, location, service, bizType, quantity, requirement, requirementText } = req.body;
  if (!name || !phone || !company || !location || !service || !quantity || !requirement) {
    return res.status(400).json({ success: false, message: 'Please fill all required quote fields.' });
  }
  const db = loadDB();
  const quote = insertQuoteRecord(db, {
    name, phone, email, company, location, service, bizType, quantity,
    requirementText, requirement: requirement.trim(), status: 'new', notes: ''
  });

  const waNumber = String(process.env.WHATSAPP_NUMBER || '').replace(/[^0-9]/g, '');
  const serviceLabel = quote.biz_type ? `${quote.service} (${quote.biz_type})` : quote.service;
  const waText = encodeURIComponent(
    `Hi EK PRINTERS! New quote request (#${quote.id}).\n` +
    `Client: ${quote.name}\nPhone: ${quote.phone}\nEmail: ${quote.email || '-'}\n` +
    `Company: ${quote.company || '-'}\nLocation: ${quote.location || '-'}\n` +
    `Service: ${serviceLabel || '-'}\nQuantity: ${quote.quantity || '-'}\n` +
    `Requirement: ${quote.requirement_text || quote.requirement || '-'}`
  );
  const whatsappUrl = waNumber ? `https://wa.me/${waNumber}?text=${waText}` : '';

  sendQuoteEmail({
    id: quote.id,
    createdAt: quote.created_at,
    name: quote.name,
    phone: quote.phone,
    email: quote.email,
    company: quote.company,
    location: quote.location,
    service: quote.service,
    bizType: quote.biz_type,
    quantity: quote.quantity,
    requirement: quote.requirement
  }).catch(err => console.error('Email notify failed:', err.message));

  return res.json({
    success: true,
    id: quote.id,
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
    String(q.name || '').toLowerCase().includes(search) ||
    String(q.phone || '').includes(search) ||
    String(q.email || '').toLowerCase().includes(search) ||
    String(q.company || '').toLowerCase().includes(search) ||
    String(q.location || '').toLowerCase().includes(search) ||
    String(q.service || '').toLowerCase().includes(search) ||
    String(q.biz_type || '').toLowerCase().includes(search) ||
    String(q.requirement_text || q.requirement || '').toLowerCase().includes(search)
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

app.get('/admin/reports', requireAuth, (req, res) => {
  const db = loadDB();
  const quotes = db.quotes.map(normalizedQuoteView);
  res.send(adminReportsHTML(quotes, req.session.username));
});

app.get('/admin/reports/data', requireAuth, (req, res) => {
  const db = loadDB();
  const quotes = db.quotes.map(normalizedQuoteView);
  res.json({ quotes });
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

app.post('/admin/quote/add', requireAuth, (req, res) => {
  const { name, phone, email, company, location, service, bizType, quantity, requirementText, requirement, status, notes } = req.body || {};
  if (!String(name || '').trim() || !String(phone || '').trim()) {
    return res.status(400).json({ success: false, message: 'Name and phone are required.' });
  }
  const allowed = ['new', 'in_progress', 'completed', 'cancelled'];
  const cleanStatus = allowed.includes(status) ? status : 'new';
  const db = loadDB();
  const quote = insertQuoteRecord(db, {
    name,
    phone,
    email,
    company,
    location,
    service: service || 'Manual',
    bizType,
    quantity,
    requirementText,
    requirement,
    status: cleanStatus,
    notes
  });
  res.json({ success: true, id: quote.id, message: 'Customer added successfully.' });
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
    String(q.name || '').toLowerCase().includes(search) ||
    String(q.phone || '').includes(search) ||
    String(q.email || '').toLowerCase().includes(search) ||
    String(q.company || '').toLowerCase().includes(search) ||
    String(q.location || '').toLowerCase().includes(search) ||
    String(q.service || '').toLowerCase().includes(search) ||
    String(q.biz_type || '').toLowerCase().includes(search) ||
    String(q.requirement_text || q.requirement || '').toLowerCase().includes(search)
  );

  const excelRows = quotes.map(q => ({
    ID: q.id,
    Client: q.name,
    Email: q.email || '',
    Phone: q.phone,
    Company: q.company || '',
    Location: q.location || '',
    Service: q.biz_type ? `${q.service || ''} (${q.biz_type})` : (q.service || ''),
    Quantity: q.quantity || '',
    Requirement: q.requirement_text || q.requirement || '',
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
  const serviceLabel = q.biz_type ? `${q.service || '-'} (${q.biz_type})` : (q.service || '-');
  const reqText = q.requirement_text || q.requirement || '-';
  return encodeURIComponent(
    `Hi ${q.name}, this is EK PRINTERS about your quote #${q.id}.\n` +
    `Service: ${serviceLabel}\n` +
    `Quantity: ${q.quantity || '-'}\n` +
    `Requirement: ${reqText}\n` +
    `Please confirm quantity and timeline.`
  );
}

function extractLegacyField(requirement, label) {
  const re = new RegExp(`${label}:\\s*([^\\n]+)`, 'i');
  const m = String(requirement || '').match(re);
  return m ? m[1].trim() : '';
}

function normalizedQuoteView(q) {
  const requirement = String(q.requirement || '');
  return {
    ...q,
    company: q.company || extractLegacyField(requirement, 'Company'),
    location: q.location || extractLegacyField(requirement, 'Customer location'),
    service: q.service || extractLegacyField(requirement, 'Service'),
    quantity: q.quantity || extractLegacyField(requirement, 'Quantity'),
    requirement_text: q.requirement_text || extractLegacyField(requirement, 'Requirement') || requirement
  };
}

function serviceLabel(q) {
  const service = String(q.service || '').trim() || '-';
  const type = String(q.biz_type || '').trim();
  return type ? `${service} (${type})` : service;
}

function buildQuoteReport(quotes) {
  const serviceCounts = {};
  const statusCounts = { new: 0, in_progress: 0, completed: 0, cancelled: 0 };
  const locationCounts = {};
  const dailyCounts = {};

  quotes.forEach(q => {
    const svc = serviceLabel(q);
    serviceCounts[svc] = (serviceCounts[svc] || 0) + 1;

    const st = String(q.status || 'new');
    statusCounts[st] = (statusCounts[st] || 0) + 1;

    const loc = String(q.location || 'Unknown').trim() || 'Unknown';
    locationCounts[loc] = (locationCounts[loc] || 0) + 1;

    const d = getQuoteDate(q) || String(q.created_date || '');
    if (d) dailyCounts[d] = (dailyCounts[d] || 0) + 1;
  });

  const topService = Object.entries(serviceCounts).sort((a, b) => b[1] - a[1])[0] || ['-', 0];
  const topLocation = Object.entries(locationCounts).sort((a, b) => b[1] - a[1])[0] || ['-', 0];

  return {
    total: quotes.length,
    topService: { name: topService[0], count: topService[1] },
    topLocation: { name: topLocation[0], count: topLocation[1] },
    serviceCounts,
    statusCounts,
    locationCounts,
    dailyCounts
  };
}

function adminReportsHTML(quotes, username) {
  const json = escJs(JSON.stringify(quotes || []));
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Reports · EK PRINTERS</title>
  <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
  <style>
    *{margin:0;padding:0;box-sizing:border-box}
    :root{--teal:#1B9A59;--teal2:#39B86B;--bg:#f4f8f3;--surface:#ffffff;--ink:#0f172a;--muted:#475569}
    body{font-family:'Inter',sans-serif;background:var(--bg);color:var(--ink)}
    body.dark-mode{--bg:#0f1513;--surface:#1a2320;--ink:#e7f0ec;--muted:#a9bbb3}
    .topbar{position:sticky;top:0;z-index:20;background:rgba(255,255,255,0.92);backdrop-filter:blur(10px);border-bottom:1px solid rgba(15,23,42,0.08);padding:0.9rem 1.2rem;display:flex;justify-content:space-between;align-items:center;gap:0.8rem}
    body.dark-mode .topbar{background:rgba(14,20,18,0.86);border-bottom-color:rgba(231,240,236,0.12)}
    .left{display:flex;align-items:center;gap:0.8rem}
    .right{display:flex;align-items:center;gap:0.55rem}
    .chip{font-size:0.72rem;padding:0.35rem 0.7rem;border-radius:999px;border:1px solid rgba(15,23,42,0.14);text-decoration:none;color:var(--ink)}
    body.dark-mode .chip{border-color:rgba(231,240,236,0.24)}
    .theme-toggle{font-size:0.72rem;padding:0.35rem 0.7rem;border-radius:999px;border:1px solid rgba(15,23,42,0.14);background:transparent;color:var(--ink);cursor:pointer}
    body.dark-mode .theme-toggle{border-color:rgba(231,240,236,0.24)}
    .container{padding:1.2rem;max-width:1340px;margin:0 auto}
    .toolbar{display:grid;grid-template-columns:repeat(6,minmax(0,1fr));gap:0.6rem;margin-bottom:0.9rem}
    .tb-input,.tb-btn{
      width:100%;font-size:0.74rem;border:1px solid rgba(15,23,42,0.14);border-radius:10px;padding:0.52rem 0.7rem;background:var(--surface);color:var(--ink);font-family:'Inter',sans-serif
    }
    .tb-btn{cursor:pointer;font-weight:700}
    .tb-btn.primary{background:linear-gradient(135deg,var(--teal),var(--teal2));border-color:transparent;color:#fff}
    body.dark-mode .tb-input,body.dark-mode .tb-btn{border-color:rgba(231,240,236,0.24)}
    .cards{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:0.8rem;margin-bottom:1rem}
    .card{background:var(--surface);border:1px solid rgba(15,23,42,0.08);border-radius:14px;padding:0.9rem;box-shadow:0 8px 22px rgba(15,23,42,0.08)}
    body.dark-mode .card{border-color:rgba(231,240,236,0.12);box-shadow:none}
    .k{font-size:0.68rem;color:var(--muted);text-transform:uppercase;letter-spacing:0.08em;font-weight:700}
    .v{font-size:1.5rem;font-weight:800;margin-top:0.25rem}
    .small{font-size:0.76rem;color:var(--muted);margin-top:0.25rem}
    .grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:0.9rem}
    .panel{background:var(--surface);border:1px solid rgba(15,23,42,0.08);border-radius:14px;padding:0.9rem}
    body.dark-mode .panel{border-color:rgba(231,240,236,0.12)}
    .panel h3{font-size:0.92rem;font-weight:800;margin-bottom:0.55rem}
    canvas{width:100%!important;height:260px!important}
    .top-table{width:100%;border-collapse:collapse}
    .top-table th,.top-table td{font-size:0.75rem;padding:0.48rem 0.35rem;border-bottom:1px solid rgba(15,23,42,0.08);text-align:left}
    .top-table th{font-size:0.68rem;color:var(--muted);text-transform:uppercase;letter-spacing:0.07em}
    body.dark-mode .top-table th,body.dark-mode .top-table td{border-bottom-color:rgba(231,240,236,0.12)}
    @media (max-width:1200px){.toolbar{grid-template-columns:repeat(3,minmax(0,1fr))}}
    @media (max-width:1024px){.cards{grid-template-columns:repeat(2,minmax(0,1fr))}.grid{grid-template-columns:1fr}}
    @media (max-width:620px){.cards{grid-template-columns:1fr}}
  </style>
</head>
<body>
  <div class="topbar">
    <div class="left">
      <img src="/ek-printers-logo.png?v=8" alt="EK PRINTERS" style="height:30px;width:auto">
      <strong style="font-size:0.95rem">Reports Analytics</strong>
    </div>
    <div class="right">
      <a class="chip" href="/admin">Back to Admin</a>
      <button class="theme-toggle" id="themeToggle" type="button">🌙 Dark</button>
      <a class="chip" href="/admin/logout">Log out</a>
    </div>
  </div>
  <div class="container">
    <div class="toolbar">
      <select id="datePreset" class="tb-input">
        <option value="last_7">Last 7 days</option>
        <option value="today">Today</option>
        <option value="last_30">Last 30 days</option>
        <option value="all">All time</option>
        <option value="custom">Custom range</option>
      </select>
      <input id="fromDate" class="tb-input" type="date">
      <input id="toDate" class="tb-input" type="date">
      <select id="serviceFilter" class="tb-input"><option value="">All services</option></select>
      <button id="csvBtn" class="tb-btn">Export CSV</button>
      <button id="pdfBtn" class="tb-btn primary">Print / PDF</button>
    </div>
    <div class="cards">
      <div class="card"><div class="k">Total Quotes</div><div class="v" id="totalQuotes">0</div></div>
      <div class="card"><div class="k">Top Service</div><div class="v" id="topService">-</div><div class="small" id="topServiceCount"></div></div>
      <div class="card"><div class="k">Top Location</div><div class="v" id="topLocation">-</div><div class="small" id="topLocationCount"></div></div>
      <div class="card"><div class="k">Revenue Estimate</div><div class="v" id="estRevenue">INR 0</div><div class="small">Based on qty × service price</div></div>
    </div>
    <div class="grid">
      <div class="panel"><h3>Service-wise Requests</h3><canvas id="serviceChart"></canvas></div>
      <div class="panel"><h3>Status Distribution</h3><canvas id="statusChart"></canvas></div>
      <div class="panel"><h3>Top Locations</h3><canvas id="locationChart"></canvas></div>
      <div class="panel"><h3>Daily Trend</h3><canvas id="dailyChart"></canvas></div>
      <div class="panel"><h3>Conversion Trend (%)</h3><canvas id="conversionChart"></canvas></div>
      <div class="panel">
        <h3>Top Clients</h3>
        <table class="top-table" id="topClientsTable">
          <thead><tr><th>Client</th><th>Quotes</th><th>Main Service</th></tr></thead>
          <tbody></tbody>
        </table>
      </div>
      <div class="panel"><h3>Estimated Revenue by Service</h3><canvas id="revenueChart"></canvas></div>
      <div class="panel">
        <h3>Service Price Inputs (INR per piece)</h3>
        <table class="top-table" id="priceTable">
          <thead><tr><th>Service</th><th>Price</th></tr></thead>
          <tbody></tbody>
        </table>
      </div>
    </div>
  </div>
  <script>
    const THEME_KEY = 'ek-theme';
    let allQuotes = JSON.parse(\`${json}\`);
    const charts = {};
    const PRICE_KEY = 'ek-report-service-prices';

    function parseNum(v){
      const n = Number(String(v || '').replace(/[^0-9.]/g, ''));
      return Number.isFinite(n) ? n : 0;
    }
    function toServiceLabel(q){
      const svc = String(q.service || '-').trim() || '-';
      const t = String(q.biz_type || '').trim();
      return t ? svc + ' (' + t + ')' : svc;
    }
    function getDateOnly(q){
      if (q.created_date && /^\\d{4}-\\d{2}-\\d{2}$/.test(q.created_date)) return q.created_date;
      const raw = String(q.created_at || '');
      const m = raw.match(/(\\d{1,2})\\/(\\d{1,2})\\/(\\d{4})/);
      if (!m) return '';
      const dd = m[1].padStart(2,'0');
      const mm = m[2].padStart(2,'0');
      return m[3] + '-' + mm + '-' + dd;
    }
    function dateRangeFromPreset(preset){
      const now = new Date();
      const to = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      const fmt = (d) => d.toISOString().slice(0,10);
      if (preset === 'today') return { from: fmt(to), to: fmt(to) };
      if (preset === 'last_30') {
        const from = new Date(to); from.setDate(from.getDate() - 29);
        return { from: fmt(from), to: fmt(to) };
      }
      if (preset === 'last_7') {
        const from = new Date(to); from.setDate(from.getDate() - 6);
        return { from: fmt(from), to: fmt(to) };
      }
      if (preset === 'all') return { from: '', to: '' };
      return { from: '', to: '' };
    }

    function applyTheme(theme){
      const dark = theme === 'dark';
      document.body.classList.toggle('dark-mode', dark);
      const btn = document.getElementById('themeToggle');
      if (btn) btn.textContent = dark ? '☀ Light' : '🌙 Dark';
    }
    applyTheme(localStorage.getItem(THEME_KEY) || 'light');
    document.getElementById('themeToggle').addEventListener('click', () => {
      const next = document.body.classList.contains('dark-mode') ? 'light' : 'dark';
      localStorage.setItem(THEME_KEY, next);
      applyTheme(next);
    });

    function getPrices(){
      try { return JSON.parse(localStorage.getItem(PRICE_KEY) || '{}'); } catch(_) { return {}; }
    }
    function setPrices(pr){ try { localStorage.setItem(PRICE_KEY, JSON.stringify(pr)); } catch(_) {} }
    function aggregateBy(arr, keyFn){
      const m = {};
      arr.forEach(x => { const k = keyFn(x); m[k] = (m[k] || 0) + 1; });
      return m;
    }
    function sortedEntries(obj){ return Object.entries(obj || {}).sort((a,b)=>b[1]-a[1]); }
    function refreshServiceFilterOptions(){
      const select = document.getElementById('serviceFilter');
      const current = select.value;
      const labels = Array.from(new Set(allQuotes.map(toServiceLabel))).sort();
      select.innerHTML = '<option value="">All services</option>' + labels.map(x => '<option value="' + x.replace(/"/g,'&quot;') + '">' + x + '</option>').join('');
      select.value = labels.includes(current) ? current : '';
    }
    function applyFilters(){
      const preset = document.getElementById('datePreset').value;
      const servicePick = document.getElementById('serviceFilter').value;
      let from = document.getElementById('fromDate').value;
      let to = document.getElementById('toDate').value;
      if (preset !== 'custom') {
        const r = dateRangeFromPreset(preset);
        from = r.from; to = r.to;
        document.getElementById('fromDate').value = from;
        document.getElementById('toDate').value = to;
      }
      return allQuotes.filter(q => {
        const d = getDateOnly(q);
        if (from && d && d < from) return false;
        if (to && d && d > to) return false;
        if (servicePick && toServiceLabel(q) !== servicePick) return false;
        return true;
      });
    }
    function renderPriceTable(filtered){
      const prices = getPrices();
      const services = Array.from(new Set(filtered.map(toServiceLabel))).sort();
      const tbody = document.querySelector('#priceTable tbody');
      tbody.innerHTML = services.map(s => {
        const val = prices[s] != null ? String(prices[s]) : '';
        return '<tr><td>' + s + '</td><td><input class="tb-input" data-svc="' + s.replace(/"/g,'&quot;') + '" value="' + val + '" placeholder="0"></td></tr>';
      }).join('');
      tbody.querySelectorAll('input[data-svc]').forEach(inp => {
        inp.addEventListener('input', () => {
          const p = getPrices();
          p[inp.getAttribute('data-svc')] = parseNum(inp.value);
          setPrices(p);
          renderAll();
        });
      });
    }
    function upsertChart(id, type, data, options){
      if (charts[id]) {
        charts[id].data = data;
        charts[id].options = options;
        charts[id].update();
        return;
      }
      charts[id] = new Chart(document.getElementById(id), { type, data, options });
    }
    function renderTopClients(filtered){
      const byClient = {};
      filtered.forEach(q => {
        const key = String(q.name || '-').trim() || '-';
        if (!byClient[key]) byClient[key] = { count: 0, services: {} };
        byClient[key].count += 1;
        const svc = toServiceLabel(q);
        byClient[key].services[svc] = (byClient[key].services[svc] || 0) + 1;
      });
      const rows = Object.entries(byClient)
        .map(([name, val]) => {
          const topSvc = sortedEntries(val.services)[0]?.[0] || '-';
          return { name, count: val.count, topSvc };
        })
        .sort((a,b)=>b.count-a.count)
        .slice(0,10);
      const tbody = document.querySelector('#topClientsTable tbody');
      tbody.innerHTML = rows.length ? rows.map(r => '<tr><td>' + r.name + '</td><td>' + r.count + '</td><td>' + r.topSvc + '</td></tr>').join('') : '<tr><td colspan="3">No data</td></tr>';
    }
    function renderAll(){
      const filtered = applyFilters();
      const serviceCounts = aggregateBy(filtered, toServiceLabel);
      const statusCounts = aggregateBy(filtered, q => String(q.status || 'new'));
      const locationCounts = aggregateBy(filtered, q => String(q.location || 'Unknown').trim() || 'Unknown');
      const dayCounts = aggregateBy(filtered, q => getDateOnly(q) || 'Unknown');
      const dayRows = Object.entries(dayCounts).filter(x => x[0] !== 'Unknown').sort((a,b)=>a[0].localeCompare(b[0]));

      const topSvc = sortedEntries(serviceCounts)[0] || ['-', 0];
      const topLoc = sortedEntries(locationCounts)[0] || ['-', 0];
      const total = filtered.length;
      const completed = Number(statusCounts.completed || 0);
      const conversion = total ? Math.round((completed / total) * 100) : 0;
      const prices = getPrices();
      const revenueByService = {};
      filtered.forEach(q => {
        const svc = toServiceLabel(q);
        const qty = parseNum(q.quantity);
        const price = parseNum(prices[svc]);
        revenueByService[svc] = (revenueByService[svc] || 0) + (qty * price);
      });
      const estRevenue = Object.values(revenueByService).reduce((a,b)=>a+b,0);

      document.getElementById('totalQuotes').textContent = String(total);
      document.getElementById('topService').textContent = topSvc[0];
      document.getElementById('topServiceCount').textContent = String(topSvc[1]) + ' requests';
      document.getElementById('topLocation').textContent = topLoc[0];
      document.getElementById('topLocationCount').textContent = String(topLoc[1]) + ' requests';
      document.getElementById('estRevenue').textContent = 'INR ' + Math.round(estRevenue).toLocaleString('en-IN');

      const svcRows = sortedEntries(serviceCounts);
      const locRows = sortedEntries(locationCounts).slice(0,8);
      const revRows = sortedEntries(revenueByService);
      const convByDay = {};
      dayRows.forEach(([d]) => {
        const rows = filtered.filter(q => (getDateOnly(q) || '') === d);
        const c = rows.length;
        const done = rows.filter(q => q.status === 'completed').length;
        convByDay[d] = c ? Math.round((done / c) * 100) : 0;
      });

      const baseOpts = { responsive:true, animation:{duration:850}, plugins:{legend:{display:false}} };
      upsertChart('serviceChart','bar',{labels:svcRows.map(x=>x[0]),datasets:[{label:'Requests',data:svcRows.map(x=>x[1]),backgroundColor:'#1B9A59',borderRadius:8}]},{...baseOpts,scales:{y:{beginAtZero:true,ticks:{precision:0}}}});
      upsertChart('statusChart','bar',{labels:['New','In Progress','Completed','Cancelled'],datasets:[{data:[statusCounts.new||0,statusCounts.in_progress||0,statusCounts.completed||0,statusCounts.cancelled||0],backgroundColor:['#00A6FF','#FFC542','#22C55E','#F87171'],borderRadius:8}]},{...baseOpts,scales:{y:{beginAtZero:true,ticks:{precision:0}}}});
      upsertChart('locationChart','bar',{labels:locRows.map(x=>x[0]),datasets:[{label:'Requests',data:locRows.map(x=>x[1]),backgroundColor:'#2563EB',borderRadius:8}]},{...baseOpts,indexAxis:'y',scales:{x:{beginAtZero:true,ticks:{precision:0}}}});
      upsertChart('dailyChart','bar',{labels:dayRows.map(x=>x[0]),datasets:[{label:'Requests',data:dayRows.map(x=>x[1]),backgroundColor:'#7C3AED',borderRadius:8}]},{...baseOpts,scales:{y:{beginAtZero:true,ticks:{precision:0}}}});
      upsertChart('conversionChart','line',{labels:Object.keys(convByDay),datasets:[{label:'Conversion %',data:Object.values(convByDay),borderColor:'#F59E0B',backgroundColor:'rgba(245,158,11,.2)',fill:true,tension:.3}]},{...baseOpts,scales:{y:{beginAtZero:true,max:100}}});
      upsertChart('revenueChart','bar',{labels:revRows.map(x=>x[0]),datasets:[{label:'INR',data:revRows.map(x=>Math.round(x[1])),backgroundColor:'#0EA5E9',borderRadius:8}]},{...baseOpts,scales:{y:{beginAtZero:true}}});

      renderTopClients(filtered);
      renderPriceTable(filtered);
    }
    async function refreshData(){
      try{
        const res = await fetch('/admin/reports/data', { credentials:'include' });
        const data = await res.json();
        if (Array.isArray(data.quotes)) allQuotes = data.quotes;
        refreshServiceFilterOptions();
        renderAll();
      } catch(_){}
    }
    document.getElementById('datePreset').addEventListener('change', () => {
      renderAll();
    });
    document.getElementById('fromDate').addEventListener('change', () => {
      document.getElementById('datePreset').value = 'custom';
      renderAll();
    });
    document.getElementById('toDate').addEventListener('change', () => {
      document.getElementById('datePreset').value = 'custom';
      renderAll();
    });
    document.getElementById('serviceFilter').addEventListener('change', renderAll);
    document.getElementById('csvBtn').addEventListener('click', () => {
      const rows = applyFilters();
      const header = ['S.No','Client','Email','Phone','Company','Location','Service','Quantity','Requirement','Status','Date'];
      const body = rows.map((q,i) => [i+1,q.name||'',q.email||'',q.phone||'',q.company||'',q.location||'',toServiceLabel(q),q.quantity||'',q.requirement_text||'',q.status||'',getDateOnly(q)||'']);
      const csv = [header].concat(body).map(r => r.map(v => '"' + String(v).replace(/"/g,'""') + '"').join(',')).join('\\n');
      const blob = new Blob([csv], { type:'text/csv;charset=utf-8;' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = 'ek-reports.csv'; a.click();
      URL.revokeObjectURL(url);
    });
    document.getElementById('pdfBtn').addEventListener('click', () => window.print());

    document.getElementById('datePreset').value = 'last_7';
    const d = dateRangeFromPreset('last_7');
    document.getElementById('fromDate').value = d.from;
    document.getElementById('toDate').value = d.to;
    refreshServiceFilterOptions();
    renderAll();
    setInterval(refreshData, 30000);
  </script>
</body>
</html>`;
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
    :root{--teal:#1B9A59;--teal2:#39B86B;--bg:#F5F9F4;--surface:#EDF5EA;--ink:#111827}
    body{background:var(--bg);font-family:'Inter',sans-serif;color:var(--ink);min-height:100vh;display:flex;align-items:center;justify-content:center;transition:background 0.25s ease,color 0.25s ease}
    body.dark-mode{--bg:#111715;--surface:#16201B;--ink:#E9F0EC}
    .card{background:#fff;border:1px solid rgba(27,154,89,0.16);border-radius:20px;padding:2.5rem;width:380px;box-shadow:0 24px 60px rgba(17,24,39,0.1);position:relative}
    body.dark-mode .card{background:#1E2226;border-color:rgba(236,239,241,0.12)}
    .logo{display:flex;align-items:center;gap:0.7rem;margin-bottom:2rem}
    .mark{width:38px;height:38px;background:linear-gradient(135deg,var(--teal),var(--teal2));border-radius:10px;display:flex;align-items:center;justify-content:center;font-family:'Inter',sans-serif;font-weight:800;color:#fff;font-size:0.9rem;box-shadow:0 10px 20px rgba(27,154,89,0.28)}
    h1{font-family:'Inter',sans-serif;font-weight:800;font-size:1.55rem;margin-bottom:0.4rem;letter-spacing:-0.01em}
    .sub{font-size:0.78rem;color:rgba(17,24,39,0.58);margin-bottom:2rem}
    .field{margin-bottom:1rem}
    label{display:block;font-size:0.72rem;font-weight:600;color:rgba(17,24,39,0.6);margin-bottom:0.4rem;letter-spacing:0.05em;text-transform:uppercase}
    input{width:100%;background:var(--surface);border:1.5px solid rgba(27,154,89,0.14);border-radius:10px;padding:0.8rem 1rem;font-size:0.82rem;font-family:'Inter',sans-serif;color:var(--ink);outline:none;transition:all 0.2s}
    input:focus{border-color:var(--teal);background:#fff;box-shadow:0 0 0 4px rgba(27,154,89,0.12)}
    .pass-wrap{position:relative}
    .pass-wrap input{padding-right:3rem}
    .pass-toggle{
      position:absolute;right:0.45rem;top:50%;transform:translateY(-50%);
      width:2.1rem;height:2.1rem;border-radius:8px;border:1px solid rgba(22,20,18,0.1);
      background:rgba(255,255,255,0.7);color:rgba(22,20,18,0.65);cursor:pointer;
      display:inline-flex;align-items:center;justify-content:center;font-size:1rem;line-height:1;
    }
    .pass-toggle:hover{background:#fff;color:var(--ink)}
    .btn{width:100%;background:linear-gradient(135deg,var(--teal),var(--teal2));color:#fff;border:none;border-radius:10px;padding:0.9rem;font-size:0.85rem;font-weight:700;font-family:'Inter',sans-serif;cursor:pointer;margin-top:0.5rem;transition:filter 0.2s;box-shadow:0 14px 26px rgba(27,154,89,0.28)}
    .btn:hover{filter:brightness(1.06)}
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
    body.dark-mode .pass-toggle{background:#1f2327;border-color:rgba(236,239,241,0.16);color:rgba(236,239,241,0.75)}
    body.dark-mode .pass-toggle:hover{background:#262b30;color:#fff}
  </style>
</head>
<body>
  <div class="card">
    <button class="theme-toggle" id="themeToggle" type="button">🌙 Dark</button>
    <div class="logo"><img src="/ek-printers-logo.png?v=8" alt="PRINTERS" style="height:36px;width:auto;object-fit:contain"><span style="font-family:'Inter',sans-serif;font-weight:700;font-size:0.95rem;margin-left:0.5rem">Admin</span></div>
    <h1>Welcome back</h1>
    <p class="sub">Sign in to manage quote requests</p>
    ` + err + `
    <form method="POST" action="/admin/login">
      <div class="field"><label>Username</label><input type="text" name="username" placeholder="admin" required autofocus></div>
      <div class="field"><label>Password</label><div class="pass-wrap"><input id="adminPassword" type="password" name="password" placeholder="••••••••" required><button type="button" id="togglePassword" class="pass-toggle" aria-label="Show password" aria-pressed="false">👁</button></div></div>
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
    const passInput = document.getElementById('adminPassword');
    const passToggle = document.getElementById('togglePassword');
    if (passInput && passToggle) {
      passToggle.addEventListener('click', () => {
        const isHidden = passInput.type === 'password';
        passInput.type = isHidden ? 'text' : 'password';
        passToggle.textContent = isHidden ? '🙈' : '👁';
        passToggle.setAttribute('aria-label', isHidden ? 'Hide password' : 'Show password');
        passToggle.setAttribute('aria-pressed', isHidden ? 'true' : 'false');
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
  const rows = quotes.map((raw, idx) => {
    const q = normalizedQuoteView(raw);
    const serviceLabel = q.biz_type ? `${q.service || '-'} (${q.biz_type})` : (q.service || '-');
    const waNumber = normalizeWhatsAppNumber(q.phone);
    const waText = customerWhatsAppText(q);
    const waHref = waNumber ? `https://wa.me/${waNumber}?text=${waText}` : '#';
    const emailHref = q.email ? `mailto:${encodeURIComponent(q.email)}?subject=${encodeURIComponent(`EK PRINTERS quote #${q.id}`)}` : '';
    const notesEnc = encodeURIComponent(q.notes || '');
    return `
    <tr id="row-${q.id}" class="data-row">
      <td class="quote-id" style="padding:1rem 0.8rem">${idx + 1}</td>
      <td class="client-cell" style="padding:1rem 0.8rem">
        <div class="client-name">${esc(q.name)}</div>
        ${q.email ? `<div class="client-email">${esc(q.email)}</div>` : '<div class="client-email">-</div>'}
      </td>
      <td class="phone-cell" style="padding:1rem 0.8rem">${esc(q.phone || '-')}</td>
      <td class="company-cell" style="padding:1rem 0.8rem">${esc(q.company || '-')}</td>
      <td class="location-cell" style="padding:1rem 0.8rem">${esc(q.location || '-')}</td>
      <td class="service-cell" style="padding:1rem 0.8rem">
        <div class="service-main">${esc(serviceLabel)}</div>
        <div class="service-qty">Qty: ${esc(q.quantity || '-')}</div>
      </td>
      <td class="req-cell" style="padding:1rem 0.8rem">${esc(q.requirement_text || '-')}</td>
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
        ${q.notes ? `<div class="note-snippet" style="margin-top:0.5rem">${esc(q.notes)}</div>` : ''}
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
    :root{--teal:#1B9A59;--teal2:#39B86B;--bg:#F5F9F4;--surface:#EDF5EA;--ink:#111827}
    html,body{min-height:100%;width:100%;overflow-x:auto}
    body{background:var(--bg);font-family:'Inter',sans-serif;color:var(--ink);transition:background 0.25s ease,color 0.25s ease;position:relative}
    body::before{
      content:'';position:fixed;inset:-18% -18% auto;height:60vh;z-index:-1;pointer-events:none;
      background:
        radial-gradient(circle at 18% 22%, rgba(27,154,89,0.14), transparent 46%),
        radial-gradient(circle at 84% 12%, rgba(57,184,107,0.09), transparent 40%),
        radial-gradient(circle at 52% 70%, rgba(232,93,58,0.05), transparent 36%);
      filter:blur(2px);
    }
    body.dark-mode{--bg:#111715;--surface:#16201B;--ink:#E9F0EC}
    body.dark-mode::before{
      background:
        radial-gradient(circle at 20% 24%, rgba(110,231,214,0.1), transparent 46%),
        radial-gradient(circle at 78% 18%, rgba(66,245,215,0.07), transparent 40%),
        radial-gradient(circle at 48% 75%, rgba(63,81,181,0.1), transparent 40%);
    }
    .topbar{background:rgba(245,249,244,0.84);backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px);border-bottom:1px solid rgba(17,24,39,0.08);padding:0.75rem 1rem;display:flex;align-items:center;justify-content:space-between;gap:0.5rem;flex-wrap:nowrap;position:sticky;top:0;z-index:50;width:100%;box-sizing:border-box;box-shadow:0 8px 24px rgba(17,24,39,0.08)}
    .logo{display:flex;align-items:center;gap:0.55rem;flex:1 1 auto;min-width:0;max-width:calc(100% - 7.5rem)}
    .logo-word{display:flex;align-items:baseline;gap:0.16rem;min-width:0;line-height:1}
    .logo-mark-text{font-family:'Inter',sans-serif;font-weight:900;font-size:clamp(1.35rem,5vw,1.75rem);letter-spacing:0.01em;color:var(--teal)}
    .logo-rest-text{font-family:'Inter',sans-serif;font-weight:900;font-size:clamp(1.35rem,5vw,1.75rem);letter-spacing:-0.02em;color:var(--ink)}
    .badge{background:var(--surface);font-size:0.58rem;padding:0.15rem 0.45rem;border-radius:100px;font-weight:700;color:rgba(17,24,39,0.54);margin-left:0.25rem;flex-shrink:0;white-space:nowrap}
    .topbar-right{display:flex;gap:0.45rem;align-items:center;flex-wrap:nowrap;flex-shrink:0;margin-left:0}
    .theme-toggle{font-size:0.65rem;padding:0.32rem 0.55rem;border-radius:100px;border:1.5px solid rgba(22,20,18,0.12);background:transparent;cursor:pointer;color:var(--ink);white-space:nowrap;flex-shrink:0}
    .profile-wrap{position:relative;flex-shrink:0}
    .profile-btn{width:36px;height:36px;border-radius:50%;border:2px solid var(--teal);background:var(--surface);color:var(--teal);cursor:pointer;display:inline-flex;align-items:center;justify-content:center;padding:0;flex-shrink:0;transition:background .2s,border-color .2s,transform .15s}
    .profile-btn:hover{background:rgba(27,154,89,0.1)}
    .profile-btn:focus-visible{outline:2px solid var(--teal);outline-offset:2px}
    .profile-btn[aria-expanded="true"]{background:rgba(27,154,89,0.14);border-color:var(--teal2)}
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
    .stat-card{background:#fff;border:1px solid rgba(27,154,89,0.14);border-radius:12px;padding:0.65rem 0.5rem;min-width:0;box-shadow:0 10px 22px rgba(17,24,39,0.08);transition:transform .2s ease,box-shadow .2s ease}
    .stat-card:hover{transform:translateY(-2px);box-shadow:0 16px 30px rgba(17,24,39,0.12)}
    .stat-label{font-size:0.58rem;color:rgba(17,24,39,0.5);font-weight:700;letter-spacing:0.05em;text-transform:uppercase;margin-bottom:0.25rem;line-height:1.2}
    .stat-val{font-family:'Inter',sans-serif;font-weight:800;font-size:clamp(1.15rem,4.2vw,2rem);letter-spacing:-0.02em;line-height:1}
    .controls{display:flex;flex-direction:column;gap:0.85rem;margin-bottom:1.5rem;width:100%}
    .controls-filters{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:0.5rem;align-items:stretch;width:100%}
    .controls-toolbar{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:0.65rem;align-items:center;width:100%}
    .controls-toolbar .date-field:nth-of-type(1){grid-column:1}
    .controls-toolbar .date-field:nth-of-type(2){grid-column:2}
    .controls-toolbar .search-main{grid-column:1/-1;width:100%;min-width:0;max-width:none}
      .controls-toolbar .btn-add-customer{grid-column:1/-1;justify-self:stretch;width:100%}
      .controls-toolbar .export-btn{grid-column:1/-1;justify-self:stretch;width:100%;text-align:center}
    .filter-btn{display:flex;justify-content:center;align-items:center;width:100%;font-size:0.68rem;padding:0.5rem 0.65rem;border-radius:100px;border:1.5px solid rgba(27,154,89,0.22);background:#fff;cursor:pointer;font-family:'Inter',sans-serif;font-weight:700;text-decoration:none;color:var(--ink);transition:all 0.2s;white-space:nowrap}
    .filter-btn.active{background:var(--teal);color:#fff;border-color:var(--teal)}
    .search-box{background:#fff;border:1.5px solid rgba(27,154,89,0.16);border-radius:10px;padding:0.5rem 0.85rem;font-size:0.78rem;font-family:'Inter',sans-serif;outline:none;transition:all 0.2s;box-sizing:border-box;box-shadow:inset 0 1px 0 rgba(255,255,255,0.6);color:var(--ink)}
    .search-box:focus{border-color:var(--teal)}
    .search-box::placeholder{color:rgba(17,24,39,0.48)}
    .export-btn{background:linear-gradient(135deg,var(--teal),var(--teal2));color:#fff;border:none;border-radius:10px;padding:0.5rem 1.2rem;font-size:0.72rem;font-weight:700;font-family:'Inter',sans-serif;cursor:pointer;text-decoration:none;transition:filter 0.2s;white-space:nowrap;flex-shrink:0;box-shadow:0 12px 24px rgba(27,154,89,0.28)}
    .export-btn:hover{filter:brightness(1.06)}
    .btn-add-customer{background:linear-gradient(135deg,#1565c0,#1e88e5);color:#fff;border:none;border-radius:10px;padding:0.5rem 1.1rem;font-size:0.72rem;font-weight:700;font-family:'Inter',sans-serif;cursor:pointer;white-space:nowrap;flex-shrink:0;box-shadow:0 12px 24px rgba(21,101,192,0.28)}
    .btn-add-customer:hover{filter:brightness(1.06)}
    .modal.add-modal{width:min(100%,520px);max-height:90vh;overflow-y:auto}
    .modal .field select,.modal .field textarea{width:100%;box-sizing:border-box;background:var(--surface);border:1.5px solid rgba(22,20,18,0.1);border-radius:10px;padding:0.65rem 0.85rem;font-size:0.85rem;font-family:'Inter',sans-serif;color:var(--ink);outline:none}
    .modal .field select:focus,.modal .field textarea:focus{border-color:var(--teal);background:#fff}
    .modal .field textarea{resize:vertical;min-height:72px}
    .add-form-grid{display:grid;grid-template-columns:1fr;gap:0}
    @media (min-width:520px){.add-form-grid{grid-template-columns:1fr 1fr}.add-form-grid .field.span-2{grid-column:1/-1}}
    .table-wrap{background:#fff;border:1px solid rgba(27,154,89,0.14);border-radius:16px;overflow-x:auto;width:100%;min-width:0;-webkit-overflow-scrolling:touch;box-shadow:0 16px 38px rgba(17,24,39,0.12)}
    table{width:100%;min-width:100%;border-collapse:separate;border-spacing:0;table-layout:auto}
    thead th{position:sticky;top:0;z-index:2}
    th{padding:0.88rem 0.8rem;text-align:left;font-size:0.68rem;font-weight:800;color:rgba(22,20,18,0.56);letter-spacing:0.08em;text-transform:uppercase;background:linear-gradient(180deg,#f3f8f2,#edf6eb);border-bottom:1px solid rgba(22,20,18,0.08)}
    td{font-size:0.79rem;color:rgba(22,20,18,0.86);vertical-align:top}
    .data-row td{border-bottom:1px solid rgba(22,20,18,0.06)}
    .data-row:nth-child(even) td{background:rgba(245,249,244,0.42)}
    .quote-id{font-size:0.72rem;color:rgba(22,20,18,0.5);font-weight:800;min-width:2.5rem}
    .client-cell,.phone-cell,.company-cell,.location-cell,.service-cell,.req-cell{line-height:1.45}
    .client-name{font-weight:700;font-size:0.84rem;color:rgba(22,20,18,0.94)}
    .client-email{font-size:0.71rem;color:rgba(22,20,18,0.56);margin-top:0.2rem}
    .phone-cell{font-weight:700}
    .service-main{font-weight:700;color:#0f5132}
    .service-qty{font-size:0.7rem;color:rgba(22,20,18,0.56);margin-top:0.18rem}
    .req-cell{min-width:12rem;max-width:28rem;font-size:0.76rem;color:rgba(22,20,18,0.74)}
    .note-snippet{max-width:100%}
    .note-snippet{font-size:0.68rem;color:rgba(22,20,18,0.6);background:#F2F0EB;padding:0.4rem 0.6rem;border-radius:6px;line-height:1.4}
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
    .modal-save{background:linear-gradient(135deg,var(--teal),var(--teal2));color:#fff;border:none;border-radius:8px;padding:0.6rem 1.3rem;font-size:0.78rem;font-weight:700;font-family:'Inter',sans-serif;cursor:pointer}
    .modal-cancel{background:transparent;color:rgba(22,20,18,0.5);border:1.5px solid rgba(22,20,18,0.1);border-radius:8px;padding:0.6rem 1.3rem;font-size:0.78rem;font-family:'Inter',sans-serif;cursor:pointer}
    @media (min-width:480px){
      .topbar{padding:0.85rem 1.15rem;gap:0.65rem}
      .logo{gap:0.65rem;max-width:calc(100% - 8.5rem)}
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
      .controls-filters{display:flex;flex-wrap:nowrap;gap:0.35rem;align-items:center;overflow-x:auto;-webkit-overflow-scrolling:touch;padding-bottom:2px;scrollbar-width:thin;width:auto;flex-shrink:0}
      .controls-filters::-webkit-scrollbar{height:4px}
      .controls-filters::-webkit-scrollbar-thumb{background:rgba(22,20,18,0.15);border-radius:4px}
      .controls-toolbar{display:flex;flex-direction:row;flex-wrap:nowrap;flex:1;min-width:0;justify-content:flex-end;align-items:center;gap:0.65rem}
      .controls-toolbar .date-field:nth-of-type(1),.controls-toolbar .date-field:nth-of-type(2){grid-column:auto;width:auto;min-width:10.5rem}
      .controls-toolbar .search-main{grid-column:auto;flex:1 1 14rem;width:auto;min-width:8rem;max-width:24rem}
      .controls-toolbar .btn-add-customer{grid-column:auto;justify-self:auto;width:auto}
      .controls-toolbar .export-btn{grid-column:auto;justify-self:auto;margin-left:0;width:auto;text-align:left}
    }
    body.dark-mode .topbar,body.dark-mode .stat-card,body.dark-mode .table-wrap,body.dark-mode .modal{background:#1E2226;border-color:rgba(236,239,241,0.12)}
    body.dark-mode .topbar{background:rgba(18,20,22,0.82);box-shadow:0 10px 26px rgba(0,0,0,0.3)}
    body.dark-mode .filter-btn{
      background:var(--surface);
      border-color:rgba(236,239,241,0.22);
      color:var(--ink);
    }
    body.dark-mode .filter-btn:hover{
      background:rgba(236,239,241,0.08);
      border-color:rgba(236,239,241,0.34);
    }
    body.dark-mode .filter-btn.active{
      background:linear-gradient(135deg,var(--teal),var(--teal2));
      border-color:transparent;
      color:#fff;
      box-shadow:0 10px 22px rgba(27,154,89,0.3);
    }
    body.dark-mode th{background:linear-gradient(180deg,#1b2622,#17221f);color:rgba(236,239,241,0.72);border-bottom-color:rgba(236,239,241,0.12)}
    body.dark-mode .data-row td{border-bottom-color:rgba(236,239,241,0.08)}
    body.dark-mode .data-row:nth-child(even) td{background:rgba(236,239,241,0.03)}
    body.dark-mode .search-box{background:var(--surface);border-color:rgba(236,239,241,0.2);color:var(--ink)}
    body.dark-mode .btn-sm,body.dark-mode .theme-toggle{border-color:rgba(236,239,241,0.24);color:var(--ink)}
    body.dark-mode td,body.dark-mode th,body.dark-mode label,body.dark-mode input,body.dark-mode select,body.dark-mode textarea{color:var(--ink)}
    body.dark-mode .search-box::placeholder{color:rgba(236,239,241,0.52)}
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
    body.dark-mode .quote-id{color:rgba(236,239,241,0.66)}
    body.dark-mode .client-name{color:#f7fbff}
    body.dark-mode .client-email,body.dark-mode .service-qty{color:rgba(236,239,241,0.62)}
    body.dark-mode .phone-cell,body.dark-mode .company-cell,body.dark-mode .location-cell{color:rgba(236,239,241,0.86)}
    body.dark-mode .req-cell{color:rgba(236,239,241,0.86)}
    body.dark-mode .service-main{color:#96f4c9}
    body.dark-mode .note-snippet{background:#243037!important;color:rgba(236,239,241,0.78)!important}
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
      <div class="logo-word"><img src="/ek-printers-logo.png?v=8" alt="PRINTERS" style="height:32px;width:auto;object-fit:contain"></div>
      <span class="badge">Admin Panel</span>
    </div>
    <div class="topbar-right">
      <a href="/admin/reports" class="btn-sm">Reports</a>
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
        <input id="searchInput" class="search-box search-main" type="text" placeholder="Search client, phone, company, service..." value="${esc(search)}" oninput="debounceSearch(this)">
        <button type="button" class="btn-add-customer" id="openAddCustomer">+ Add Customer</button>
        <a id="exportBtn" href="${'/admin/export?' + withQuery({ status: filter, search, fromDate, toDate })}" class="export-btn">⬇ Export Excel</a>
      </div>
    </div>
    <div class="table-wrap">
      <table>
        <thead><tr><th>S.No</th><th>Client</th><th>Phone</th><th>Company</th><th>Location</th><th>Service</th><th>Requirement</th><th>Status</th><th>Date</th><th>Actions</th></tr></thead>
        <tbody>${rows || '<tr><td colspan="10" class="empty">No quote requests yet.</td></tr>'}</tbody>
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
  <div class="modal-overlay" id="addCustomerModal">
    <div class="modal add-modal">
      <h3>Add customer manually</h3>
      <p style="font-size:0.78rem;color:rgba(22,20,18,0.55);margin-bottom:1rem;line-height:1.45">Add walk-in or phone enquiries. Name and phone are required.</p>
      <div id="addCustomerMsg" class="pass-msg" role="alert"></div>
      <div class="add-form-grid">
        <div class="field"><label for="addName">Client name *</label><input type="text" id="addName" autocomplete="name"></div>
        <div class="field"><label for="addPhone">Phone / WhatsApp *</label><input type="tel" id="addPhone" autocomplete="tel"></div>
        <div class="field"><label for="addEmail">Email</label><input type="email" id="addEmail" autocomplete="email"></div>
        <div class="field"><label for="addCompany">Company</label><input type="text" id="addCompany"></div>
        <div class="field"><label for="addLocation">Location</label><input type="text" id="addLocation" placeholder="City / area"></div>
        <div class="field"><label for="addService">Service</label><input type="text" id="addService" placeholder="e.g. Folding cards, Hang tag"></div>
        <div class="field"><label for="addBizType">Type / finish</label><input type="text" id="addBizType" placeholder="e.g. Gold foil"></div>
        <div class="field"><label for="addQty">Quantity</label><input type="text" id="addQty"></div>
        <div class="field span-2"><label for="addReq">Requirement notes</label><textarea id="addReq" placeholder="What they need..."></textarea></div>
        <div class="field"><label for="addStatus">Status</label>
          <select id="addStatus">
            <option value="new">New</option>
            <option value="in_progress">In Progress</option>
            <option value="completed">Completed</option>
            <option value="cancelled">Cancelled</option>
          </select>
        </div>
      </div>
      <div class="modal-actions">
        <button type="button" class="modal-cancel" id="addCustomerCancel">Cancel</button>
        <button type="button" class="modal-save" id="addCustomerSave">Save customer</button>
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
    (function addCustomerModal(){
      const overlay = document.getElementById('addCustomerModal');
      const msg = document.getElementById('addCustomerMsg');
      const openBtn = document.getElementById('openAddCustomer');
      const cancel = document.getElementById('addCustomerCancel');
      const save = document.getElementById('addCustomerSave');
      if (!overlay || !openBtn) return;
      function showMsg(text, ok) {
        msg.textContent = text || '';
        msg.className = 'pass-msg' + (text ? (ok ? ' ok' : ' err') : '');
      }
      function openAdd() {
        showMsg('', false);
        ['addName','addPhone','addEmail','addCompany','addLocation','addService','addBizType','addQty','addReq'].forEach(function(id) {
          const el = document.getElementById(id);
          if (el) el.value = '';
        });
        const st = document.getElementById('addStatus');
        if (st) st.value = 'new';
        overlay.classList.add('open');
        setTimeout(function() { const n = document.getElementById('addName'); if (n) n.focus(); }, 50);
      }
      function closeAdd() {
        overlay.classList.remove('open');
        showMsg('', false);
      }
      openBtn.addEventListener('click', openAdd);
      if (cancel) cancel.addEventListener('click', closeAdd);
      overlay.addEventListener('click', function(e) { if (e.target === overlay) closeAdd(); });
      if (save) save.addEventListener('click', async function() {
        showMsg('', false);
        const name = (document.getElementById('addName') || {}).value || '';
        const phone = (document.getElementById('addPhone') || {}).value || '';
        if (!name.trim() || !phone.trim()) {
          showMsg('Name and phone are required.', false);
          return;
        }
        save.disabled = true;
        save.textContent = 'Saving...';
        try {
          const res = await fetch('/admin/quote/add', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              name: name.trim(),
              phone: phone.trim(),
              email: ((document.getElementById('addEmail') || {}).value || '').trim(),
              company: ((document.getElementById('addCompany') || {}).value || '').trim(),
              location: ((document.getElementById('addLocation') || {}).value || '').trim(),
              service: ((document.getElementById('addService') || {}).value || '').trim(),
              bizType: ((document.getElementById('addBizType') || {}).value || '').trim(),
              quantity: ((document.getElementById('addQty') || {}).value || '').trim(),
              requirementText: ((document.getElementById('addReq') || {}).value || '').trim(),
              status: ((document.getElementById('addStatus') || {}).value || 'new')
            })
          });
          const data = await res.json().catch(function() { return {}; });
          if (res.ok && data.success) {
            location.reload();
          } else {
            showMsg(data.message || 'Could not save customer.', false);
          }
        } catch (err) {
          showMsg('Network error. Try again.', false);
        } finally {
          save.disabled = false;
          save.textContent = 'Save customer';
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
      location.reload();
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

app.get('/about', (req, res) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.sendFile(path.join(__dirname, 'public', 'about.html'));
});

app.get('/', (req, res) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/category.html', (req, res) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.sendFile(path.join(__dirname, 'public', 'category.html'));
});

app.use(express.static(path.join(__dirname, 'public'), {
  etag: true,
  lastModified: true,
  maxAge: '1d',
  setHeaders(res, filePath) {
    if (filePath.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    }
  }
}));

app.listen(PORT, '0.0.0.0', () => {
  console.log(`EK PRINTERS running at http://localhost:${PORT}`);
});
