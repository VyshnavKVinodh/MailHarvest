# 📧 MailHarvest

**Smart Contact Extractor** — Scrape emails, phone numbers, names, designations & LinkedIn profiles from any website domain, validate every email for deliverability, and export to Excel.

![Node.js](https://img.shields.io/badge/Node.js-18+-339933?logo=node.js) ![License](https://img.shields.io/badge/License-MIT-blue) ![Deploy](https://img.shields.io/badge/Deploy-Vercel-black?logo=vercel)

---

## ✨ Features

| Feature | Description |
|---------|-------------|
| 🔍 **Multi-Domain Scraping** | Crawl up to 30 or 200 pages per domain with a smart two-phase priority algorithm |
| 📞 **Phone Extraction** | Automatically detects phone numbers from `tel:` links, tables, and nearby context |
| 🔗 **LinkedIn Discovery** | Generates LinkedIn profile search links for every named contact |
| 🌍 **Auto-Translation** | Translates non-English names and designations to English via Google Translate |
| 📡 **Real-Time Progress** | Live SSE streaming shows per-domain page count, phase, queue, and contacts found |
| 🛡️ **Email Validation** | DNS MX lookup + SMTP verification + catch-all domain detection |
| 💡 **Smart Suggestions** | Auto-corrects 80+ common domain typos (`gmial.com` → `gmail.com`) |
| 📊 **Excel Export** | Color-coded `.xlsx` with Name, Designation, Phone, Email, Validation, LinkedIn |
| ⚡ **Quick & Deep Modes** | Quick (30 priority pages, Vercel-compatible) or Deep (200 pages, self-hosted) |
| 📋 **Batch Domain Paste** | Paste a column of domains from Excel — all are added instantly |
| 🎯 **Contact Limit** | Optionally cap contacts per domain (5, 10, 25, 50, or 100) |
| 🔎 **Advanced Filters** | Filter results by name, email, domain, validation status, phone, or designation |
| 🌐 **Two-Page UI** | Clean landing page → dedicated scraper page with dark-mode glassmorphism |
| ⏱️ **Elapsed Timer** | Live timer during scraping so you know exactly how long it takes |
| 🚀 **Deploy Anywhere** | Works locally with `node server.js` or on Vercel serverless |

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

Double-click **`start.bat`** — it auto-checks for Node.js, installs dependencies, starts the server, and opens your browser.

> You can also use **`MailHarvest.vbs`** which launches `start.bat` silently in the background.

---

## 🌐 Deploy to Vercel

1. Push to GitHub
2. Go to [vercel.com](https://vercel.com) → **Add New Project** → Import your repo
3. Click **Deploy** — no configuration needed!

The `api/` folder contains serverless functions that Vercel auto-detects. Static files in `public/` are served automatically.

> **Note:** Vercel's free tier has a 60-second function timeout. Use **Quick mode** (30 pages) on Vercel. For **Deep mode** (200 pages), use the local server.

---

## 📖 How It Works

### 1. Add Domains
Enter website domains (e.g. `example.com`) — no `https://` or trailing slashes needed. You can also **paste multiple domains** directly from an Excel column.

### 2. Configure Options
- **Contact Limit** — Toggle on to cap results at 5, 10, 25, 50, or 100 contacts per domain
- **Crawl Mode** — Choose Quick (30 priority pages, fast) or Deep (200 pages, thorough)

### 3. Scrape
Click **Start Scraping** to begin. The two-phase crawler works as follows:

| Phase | What It Does |
|-------|--------------|
| ⚡ **Phase 1 — Priority Sweep** | Targets Contact, About, Team, Leadership, Faculty, and Staff pages first (score ≥ 50) |
| 🌐 **Phase 2 — Full-Site BFS** | Crawls remaining pages, still prioritizing late-discovered high-value links |

During scraping you'll see live updates per domain: pages scraped, contacts found, current phase, queue size, and elapsed time.

### 4. Review Results
The results table shows:
- **Name** — Extracted from headings, card elements, and structured data
- **Designation** — Job titles matched against 100+ keywords in multiple languages
- **Phone** — From `tel:` links, table rows, and nearby context
- **Email** — From `mailto:` links, team sections, cards, tables, and full body text
- **LinkedIn** — Profile search link generated from the contact name
- **Source Page** — The exact URL where the contact was found

> Contacts with a **phone number but no email** are still captured (phone-only entries).

### 5. Validate Emails
Click **Validate Emails** to verify each address:

| Status | Meaning |
|--------|---------|
| ✓ **Valid** | MX records exist & SMTP confirmed the mailbox |
| ⚠ **Catch-All** | Domain accepts all addresses — individual mailbox unverifiable |
| ✗ **Invalid** | No MX records, SMTP rejected, or domain typo detected |

Click an **Invalid** status badge to see:
- **Typo corrections** — `gmial.com` → `gmail.com` (80+ known typos)
- **Similar domains** — Levenshtein distance matching to known providers
- **Re-scrape suggestion** — when the email may have been extracted incorrectly

### 6. Filter & Select
Use the search bar and dropdowns to filter by:
- Text (name, email, domain, phone)
- Domain
- Validation status (Valid, Catch-All, Invalid, Unchecked)
- Has Name, Has Designation, Has Phone

Select individual contacts or use **Select All / Deselect All**.

### 7. Export to Excel
Click **Download Excel** to get a formatted `.xlsx` with columns:

`S.No | Name | Designation | Phone | Email | Validation | Validation Note | Domain | Source Page | LinkedIn`

The spreadsheet includes color-coded validation status, alternating row colors, and auto-filters.

---

## 📁 Project Structure

```
mailharvest/
├── api/                        # Vercel serverless functions
│   ├── scrape-stream.js        # SSE scraping endpoint (POST/GET)
│   ├── validate-stream.js      # SSE validation endpoint (POST/GET)
│   └── export.js               # Excel export endpoint (POST)
├── public/                     # Static frontend
│   ├── index.html              # Landing page with instructions
│   ├── scraper.html            # Scraper + validation + export page
│   ├── scraper.js              # Client-side logic (SSE, UI, filters)
│   ├── style.css               # Dark-mode glassmorphism design system
│   └── favicon.svg             # Logo
├── scraper.js                  # Core scraping engine (two-phase crawl)
├── validator.js                # Email validation engine (DNS + SMTP)
├── server.js                   # Local Express dev server
├── start.bat                   # Windows auto-launch script
├── MailHarvest.vbs             # Silent launcher for start.bat
├── vercel.json                 # Vercel deployment config
├── package.json
└── .gitignore
```

---

## ⚙️ Tech Stack

| Layer | Technologies |
|-------|-------------|
| **Backend** | Node.js, Express, Axios, Cheerio |
| **Scraping** | Two-phase priority crawl, retry with exponential backoff, rotating User-Agents |
| **Validation** | DNS MX (`dns` module), SMTP RCPT TO (`net` module), catch-all detection |
| **Translation** | google-translate-api-x (auto-detects non-English text) |
| **Export** | ExcelJS (color-coded, formatted `.xlsx`) |
| **Frontend** | Vanilla HTML/CSS/JS, Server-Sent Events (SSE via Fetch API) |
| **Design** | Dark mode, glassmorphism, Inter font, responsive |
| **Deploy** | Vercel Serverless / Local Node.js |

---

## 📋 API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/api/scrape-stream` | SSE stream — scrapes domains for contacts. Body: `{ domains, maxContacts, crawlMode }` |
| `POST` | `/api/validate-stream` | SSE stream — validates email addresses. Body: `{ emails }` |
| `POST` | `/api/export` | Returns `.xlsx` file from selected contacts. Body: `{ rows }` |

All streaming endpoints use **Server-Sent Events (SSE)** for real-time progress. GET fallback is supported for both scrape and validate endpoints.

---

## 📄 License

MIT License — free to use, modify, and distribute.

---

<p align="center">
  Built with ❤️ by <strong>MailHarvest</strong>
</p>
