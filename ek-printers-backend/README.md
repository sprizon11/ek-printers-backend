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

Sign in to the admin panel and use **Change Password** there. The new password
is written to whichever store is in use (Postgres in production), so it now
survives restarts — it did not when the data lived only in a file on Render.

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

**Production uses Postgres.** Set `DATABASE_URL` on the host and the app stores
every enquiry there. Without it, the app falls back to the local
`ekprinters-data.json` file — fine for development, but **never for production**:
Render's filesystem is reset on every restart, deploy and wake-from-sleep, so a
file-backed deployment silently loses every enquiry it received since it last
started.

### Setting it up on Render

1. Create a free Postgres database (Neon at [neon.tech](https://neon.tech) or
   Supabase at [supabase.com](https://supabase.com)) and copy its connection
   string. It looks like
   `postgresql://user:password@host.neon.tech/dbname?sslmode=require`.
2. In the Render dashboard → your service → **Environment**, add:
   | Key | Value |
   |-----|-------|
   | `DATABASE_URL` | the connection string from step 1 |
   | `RETENTION_DAYS` | `10` (optional — this is the default) |
3. Deploy. On first boot the app creates its `app_state` table and copies over
   whatever is in `ekprinters-data.json` — including the current admin password —
   so nothing is lost in the switch. After that the file is never read again.

The startup log says which store is in use:
`💾 Storage: Postgres · keeping 10 days of enquiries`.

### 🧹 Automatic 10-day cleanup

Each enquiry is kept for **10 days from the day it arrived**, then dropped
automatically. It is a rolling window per quote, not a scheduled wipe of
everything — an enquiry that came in yesterday always gets its full 10 days.

The sweep runs at startup, every 6 hours, and at most once every 15 minutes on
ordinary traffic (so a service that sleeps and wakes still honours the window).
Change the window with the `RETENTION_DAYS` environment variable; set it to `0`
to keep enquiries forever.

> Anything older than 10 days is gone for good. If you need a longer record,
> either raise `RETENTION_DAYS`, use **Export Excel** in the admin panel before
> the window closes, or configure the email notifications below so a copy of
> every enquiry also lands in your inbox.

### 📧 Email backup (recommended)

Set `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM` and
`NOTIFY_TO` and every incoming quote is emailed to you as it arrives. This is
the safety net: even if the database is unreachable, you still get the lead.

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
