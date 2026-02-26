# 📧 MailHarvest

**Smart Email Contact Extractor** — Scrape emails, names & designations from any website domain, validate every email for deliverability, and export to Excel.

![MailHarvest Home](https://img.shields.io/badge/Node.js-18+-339933?logo=node.js) ![License](https://img.shields.io/badge/License-MIT-blue) ![Deploy](https://img.shields.io/badge/Deploy-Vercel-black?logo=vercel)

---

## ✨ Features

| Feature | Description |
|---------|-------------|
| 🔍 **Multi-Domain Scraping** | Crawl up to 30 pages per domain — prioritizes About, Team & Contact pages |
| 📡 **Real-Time Progress** | Live SSE streaming shows per-domain page count and contacts found |
| 🛡️ **Email Validation** | DNS MX lookup + SMTP verification + catch-all domain detection |
| 💡 **Smart Suggestions** | Auto-corrects 80+ common domain typos (`gmial.com` → `gmail.com`) |
| 📊 **Excel Export** | Color-coded `.xlsx` with validation status, names, designations |
| 🌐 **Two-Page UI** | Clean landing page → dedicated scraper page with dark-mode glassmorphism |
| ⚡ **Deploy Anywhere** | Works locally with `node server.js` or on Vercel serverless |

---

## 🚀 Quick Start

### Local Development

```bash
# Clone the repo
git clone https://github.com/YOUR_USERNAME/mailharvest.git
cd mailharvest

# Install dependencies
npm install

# Start the server
node server.js
```

Open **http://localhost:3000** in your browser.

### One-Click Launch (Windows)

Double-click **`MailHarvest.vbs`** — it auto-checks for Node.js, installs dependencies, and opens the browser.

---

## 🌐 Deploy to Vercel

1. Push to GitHub
2. Go to [vercel.com](https://vercel.com) → **Add New Project** → Import your repo
3. Click **Deploy** — no configuration needed!

The `api/` folder contains serverless functions that Vercel auto-detects. Static files in `public/` are served automatically.

> **Note:** Vercel's free tier has a 60-second function timeout. For large scraping jobs (10+ domains), use the local server instead.

---

## 📖 How It Works

### 1. Add Domains
Enter website domains (e.g. `example.com`) — no need for `https://` or trailing slashes.

### 2. Scrape & Validate
Click **Start Scraping** to extract emails with live progress. Then click **Validate Emails** to verify each address:

| Status | Meaning |
|--------|---------|
| ✓ **Valid** | MX records exist & SMTP confirmed the mailbox |
| ⚠ **Catch-All** | Domain accepts all addresses — individual mailbox unverifiable |
| ✗ **Invalid** | No MX records, SMTP rejected, or domain typo detected |

### 3. Export to Excel
Select contacts with checkboxes → **Download Excel** to get a formatted `.xlsx` with validation status columns.

---

## 🛡️ Validation System

The built-in email validator performs multi-layer checks:

```
Syntax Check → Domain Typo Detection → DNS MX Lookup → SMTP RCPT TO → Catch-All Test
```

**For invalid emails, MailHarvest suggests fixes:**
- **Typo corrections** — 80+ known domain misspellings
- **Similar domains** — Levenshtein distance matching to known providers
- **Re-scrape hint** — when the email may have been extracted incorrectly

---

## 📁 Project Structure

```
mailharvest/
├── api/                        # Vercel serverless functions
│   ├── scrape-stream.js        # SSE scraping endpoint
│   ├── validate-stream.js      # SSE validation endpoint
│   └── export.js               # Excel export endpoint
├── public/                     # Static frontend
│   ├── index.html              # Landing page
│   ├── scraper.html            # Scraper + validation page
│   ├── scraper.js              # Client-side logic
│   ├── style.css               # Dark-mode design system
│   └── favicon.svg             # Logo
├── scraper.js                  # Core scraping engine
├── validator.js                # Email validation engine
├── server.js                   # Local Express dev server
├── vercel.json                 # Vercel deployment config
├── package.json
└── .gitignore
```

---

## ⚙️ Tech Stack

- **Backend:** Node.js, Express, Axios, Cheerio
- **Validation:** DNS (`dns` module), SMTP (`net` module)
- **Export:** ExcelJS
- **Frontend:** Vanilla HTML/CSS/JS with SSE
- **Design:** Dark mode, glassmorphism, Inter font
- **Deploy:** Vercel Serverless / Local Node.js

---

## 📋 API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/scrape-stream?domain=example.com` | SSE stream — scrapes domains for contacts |
| `GET` | `/api/validate-stream?email=user@example.com` | SSE stream — validates email addresses |
| `POST` | `/api/export` | Returns `.xlsx` file from selected contacts |

All streaming endpoints use **Server-Sent Events (SSE)** for real-time progress.

---

## 📄 License

MIT License — free to use, modify, and distribute.

---

<p align="center">
  Built with ❤️ by <strong>MailHarvest</strong>
</p>
