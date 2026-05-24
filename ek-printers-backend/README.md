# 🖨️ EK Printers - Backend

Full-stack backend for the EK Printers website with quote management and admin panel.

## 🚀 Quick Start

### 1. Install dependencies
```bash
npm install
```

### 2. Start the server
```bash
node server.js
```

### 3. Open your browser
- **Website:** http://localhost:3000
- **Admin Panel:** http://localhost:3000/admin

---

## 🔐 Default Admin Login
| Field    | Value           |
|----------|-----------------|
| Username | `ekprinters2026` |
| Password | `Eb10/12/2003@` |

> ⚠️ **Change your password after first login** — see the "Change Password" section below.

---

## 📁 Project Structure

```
ek-printers-backend/
├── server.js          ← Main server (API + admin panel)
├── package.json       ← Dependencies
├── ekprinters.db      ← SQLite database (auto-created)
└── public/
    └── index.html     ← Your frontend website
```

---

## ⚙️ Features

### Public Website (`/`)
- Quote request form submits to `/api/quote`
- Success/error feedback shown to user
- WhatsApp-friendly phone numbers

### Admin Panel (`/admin`)
- 📊 **Dashboard stats** — Total, New, In Progress, Completed
- 🔍 **Search** by name, phone, or requirement
- 🏷️ **Filter** by status
- ✏️ **Update status** — New → In Progress → Completed → Cancelled
- 📝 **Internal notes** per quote
- 💬 **WhatsApp shortcut** to contact client directly
- 🗑️ **Delete** quote requests
- ⬇️ **Export CSV** of all quotes

---

## 📱 WhatsApp Setup (Important!)

In `server.js`, find this line and replace with EK Printers' actual WhatsApp number:

```js
const waLink = `https://wa.me/919XXXXXXXXX?text=${waText}`;
//                         ↑ Replace with actual number (e.g. 919876543210)
```

---

## 🔑 Change Admin Password

Run this in the project folder:
```bash
node -e "
const db = require('better-sqlite3')('ekprinters.db');
const crypto = require('crypto');
const pw = 'YOUR_NEW_PASSWORD'; // ← change this
const hash = crypto.createHash('sha256').update(pw).digest('hex');
db.prepare('UPDATE admin_users SET password = ? WHERE username = ?').run(hash, 'admin');
console.log('Password updated!');
"
```

---

## 🌐 Deploy to Railway (Free Hosting)

1. Create account at [railway.app](https://railway.app)
2. Click **New Project → Deploy from GitHub**
3. Push this folder to a GitHub repo and connect it
4. Railway auto-detects Node.js and runs `npm start`
5. Your site goes live with a free URL!

> **Alternative:** [Render.com](https://render.com) works the same way — free tier, auto-deploy from GitHub.

---

## 🗄️ Database

Uses **SQLite** (file-based, zero config). The database file `ekprinters.db` is created automatically on first run.

To view the database manually, install [DB Browser for SQLite](https://sqlitebrowser.org/) — it's free.

---

## 📋 API Reference

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/api/quote` | Submit a quote request |
| `GET`  | `/admin` | Admin panel (login required) |
| `POST` | `/admin/login` | Login |
| `GET`  | `/admin/logout` | Logout |
| `POST` | `/admin/quote/:id/status` | Update quote status |
| `POST` | `/admin/quote/:id/notes` | Update internal notes |
| `DELETE` | `/admin/quote/:id` | Delete a quote |
| `GET`  | `/admin/export` | Download CSV of all quotes |
