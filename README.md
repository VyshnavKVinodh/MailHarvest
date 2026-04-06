# MailHarvest

**A powerful, self-hosted email scraper and validator for lead generation.** Crawl any website to extract emails, names, designations, and phone numbers — then validate every email against real mail servers.

> 100% local. No API keys. No usage limits. Your data never leaves your machine.

---

## Features

- **Smart Two-Phase Crawling** — Priority algorithm targets Contact, Team, About, and Leadership pages first (Phase 1), then scans remaining pages (Phase 2). Quick mode (30 pages) or Deep mode (200 pages).
- **6 Extraction Strategies** — Finds contacts via `mailto:` links, team/staff sections, profile cards, HTML tables, full-body text scan, and `tel:` links.
- **SMTP Email Validation** — Verifies every email by pinging the actual mail server (`RCPT TO`). Detects catch-all domains and provides diagnostic suggestions for invalid addresses.
- **Bulk Selection Operations** — Select individual contacts or entire sets, then validate, export, or delete only the selection. Dynamic button labels show the count of selected items.
- **Contact Enrichment** — Automatically extracts names, job titles/designations, phone numbers, and generates LinkedIn profile search links.
- **Multi-Language Support** — Detects non-Latin names and designations, translates them to English via Google Translate, and shows both original and translated text.
- **Styled Excel Export** — Exports to `.xlsx` with branded headers, color-coded validation status, alternating row colors, and auto-filters. Export all contacts or only selected ones.
- **Standalone Email Validator** — Paste or type any email list to bulk-validate without scraping. Real-time progress, donut chart summary, and Excel export.
- **Live Progress Dashboard** — Real-time counters for domains completed, contacts found, pages scraped, and per-email validation status.
- **Incremental Results** — Contacts stream in as each domain completes, not in one giant batch at the end. Scales reliably to 300+ domains.

---

## Quick Start

### Prerequisites

- [Node.js](https://nodejs.org/) v16 or later

### Installation

```bash
git clone https://github.com/VyshnavKVinodh/MailHarvest.git
cd MailHarvest
npm install
```

### Run

```bash
npm start
```

Then open [http://localhost:3000](http://localhost:3000) in your browser.

### Windows One-Click Launch

Double-click **`MailHarvest.vbs`** — it silently installs dependencies, starts the server, and opens the browser automatically. No terminal window required.

Alternatively, run **`start.bat`** for a console-visible launch.

---

## Pages

| Route | Description |
|-------|-------------|
| `/` | Landing page with feature overview |
| `/scraper` | Domain scraper — add domains, scrape contacts, validate, export |
| `/validator` | Standalone email validator — paste emails, bulk validate |

---

## How It Works

### Scraping Pipeline

1. **Domain Reachability Test** — Tries HTTPS/HTTP with and without `www.` to find a working URL before crawling.
2. **Homepage Processing** — Extracts contacts and discovers links from the homepage immediately.
3. **Priority Seeding** — Seeds the crawl queue with 60+ common paths (`/contact`, `/team`, `/faculty`, `/board`, etc.).
4. **Two-Phase BFS Crawl** — Phase 1 crawls high-priority pages (score 50–100), Phase 2 crawls all remaining discovered pages.
5. **Contact Extraction** — Runs 6 strategies per page: mailto links, team sections, profile cards, tables, body text, and tel links.
6. **Translation** — Non-Latin names/designations are translated to English with original text preserved.

### Results Table

After scraping, contacts are displayed in a selectable table with the following columns:

| Column | Description |
|--------|-------------|
| ✓ | Selection checkbox for bulk operations |
| S.No | Serial number |
| Domain | Source website domain |
| Name | Contact person's name |
| Designation | Job title or role |
| Email | Email address |
| Status | Validation status (Valid / Invalid / Catch-all / Risky / Unchecked) |
| Phone | Phone number |
| LinkedIn | Link to LinkedIn profile search |

### Bulk Selection Operations

Select contacts using checkboxes (individual rows, header checkbox for all, or Ctrl+A), then:

- **Validate Selected** — Runs SMTP validation only on selected contacts' emails
- **Export Selected** — Exports only selected contacts to Excel
- **Delete Selected** — Removes selected contacts from the results table
- When nothing is selected, Validate and Export operate on all contacts

### Validation Chain

SMTP verification is the **primary authority**. The other checks are diagnostics that populate suggestions:

1. **Syntax Check** *(prerequisite)* — Validates email format via regex.
2. **DNS/MX Lookup** *(prerequisite)* — Resolves MX records with fallback to public DNS (8.8.8.8, 1.1.1.1).
3. **SMTP Ping** *(primary)* — Connects to the mail server, issues `RCPT TO:<email>`, and checks if the mailbox exists. Also tests a random address to detect catch-all domains.
4. **Diagnostics** *(run after SMTP, populate suggestions)*:
   - **Typo Detection** — Matches against 25+ common typo domains (e.g., `gmial.com` → `gmail.com`).
   - **Self-Domain Trust** — Notes if the email domain matches the scraped website.
   - **Known Provider Check** — Identifies 80+ known providers (Gmail, Yahoo, Outlook, etc.).

### Validation Statuses

| Status | Meaning |
|--------|---------|
| ✅ **Valid** | SMTP confirmed the mailbox exists |
| ⚠️ **Catch-all** | Domain accepts all addresses — email may or may not exist |
| 🟠 **Risky** | Domain has DNS records but couldn't be SMTP verified |
| ❌ **Invalid** | SMTP rejected the recipient or domain doesn't exist |

---

## Project Structure

```
MailHarvest/
├── server.js              # Express server, API routes, Excel export
├── scraper.js             # Two-phase web crawler & contact extraction
├── validator.js           # Email validation (SMTP, DNS, typo detection)
├── package.json           # Dependencies
├── start.bat              # Windows batch launcher
├── MailHarvest.vbs        # Windows silent launcher (no console)
├── .gitignore
└── public/
    ├── index.html         # Landing page
    ├── scraper.html       # Scraper UI
    ├── scraper.js         # Scraper page client logic
    ├── validator.html     # Validator UI
    ├── validator-page.js  # Validator page client logic
    ├── style.css          # Shared styles (glassmorphism dark theme)
    └── favicon.svg        # App icon
```

---

## API Endpoints

### `POST /api/scrape-stream`
Server-Sent Events endpoint for scraping domains. Contacts are delivered incrementally with each `domain-done` event for reliability at scale.

**Body:**
```json
{
  "domains": ["example.com", "another.org"],
  "crawlMode": "quick",
  "maxContacts": 0
}
```

**Events:**
| Event | Payload |
|-------|---------|
| `domain-start` | `{ domain }` |
| `domain-progress` | `{ domain, phase, pagesScraped, queueSize, contactCount }` |
| `domain-done` | `{ domain, contactCount, pagesScraped, contacts[], error? }` |
| `done` | `{ totalPagesScraped, totalContacts }` |

---

### `POST /api/validate-stream`
Server-Sent Events endpoint for email validation.

**Body:**
```json
{
  "emails": ["john@example.com", "jane@company.org"],
  "scrapedDomains": ["example.com"]
}
```

**Events:** `progress`, `done`

---

### `POST /api/export`
Generates and downloads a styled Excel file.

**Body:**
```json
{
  "rows": [
    {
      "name": "John Doe",
      "designation": "Director",
      "phone": "+1234567890",
      "email": "john@example.com",
      "validation": "valid",
      "validationNote": "SMTP verified",
      "domain": "example.com",
      "source": "https://example.com/team",
      "linkedinUrl": ""
    }
  ]
}
```

---

## Dependencies

| Package | Purpose |
|---------|---------|
| [express](https://expressjs.com/) | Web server and API routing |
| [axios](https://axios-http.com/) | HTTP client for fetching web pages |
| [cheerio](https://cheerio.js.org/) | HTML parsing and DOM traversal |
| [exceljs](https://github.com/exceljs/exceljs) | Excel file generation |
| [cors](https://www.npmjs.com/package/cors) | Cross-origin resource sharing |
| [google-translate-api-x](https://www.npmjs.com/package/google-translate-api-x) | Non-Latin text translation |

---

## License

This project is for personal and educational use.
