const express = require('express');
const cors = require('cors');
const path = require('path');
const ExcelJS = require('exceljs');
const { scrapeDomain, closeBrowser } = require('./scraper');
const { validateEmail } = require('./validator');

const app = express();
const PORT = 3000;

app.use(cors());
app.use(express.json({ limit: '50mb' }));

// Static files
app.use(express.static(path.join(__dirname, 'public')));

// Routes
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/scraper', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'scraper.html'));
});

app.get('/validator', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'validator.html'));
});

// ============================================================
// POST /api/scrape-stream — SSE scraping endpoint
// ============================================================
app.post('/api/scrape-stream', async (req, res) => {
  // SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');

  const { domains = [], maxContacts = 0, crawlMode = 'quick' } = req.body;

  function sendEvent(event, data) {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    if (res.flush) res.flush();
  }

  const allContacts = [];
  let totalPagesScraped = 0;

  for (const rawDomain of domains) {
    // Clean domain: strip protocol, trailing slashes, whitespace
    const domain = rawDomain.trim()
      .replace(/^https?:\/\//, '')
      .replace(/\/+$/, '')
      .replace(/^www\./, '');

    if (!domain) continue;

    sendEvent('domain-start', { domain });

    try {
      const result = await scrapeDomain(domain, {
        crawlMode,
        maxContacts: maxContacts || 0,
        onProgress: (progress) => {
          sendEvent('domain-progress', {
            domain,
            phase: progress.phase,
            pagesScraped: progress.pagesScraped,
            queueSize: progress.queueSize,
            contactCount: progress.contactCount,
            currentUrl: progress.currentUrl,
            status: progress.status || ''
          });
        }
      });

      // Check if domain returned an error (e.g., unreachable)
      if (result.error) {
        sendEvent('domain-done', {
          domain,
          contactCount: 0,
          pagesScraped: 0,
          contacts: [],
          error: result.error
        });
      } else {
        allContacts.push(...result.contacts);
        totalPagesScraped += result.pagesScraped;

        // Send contacts with each domain-done (incremental, small batches)
        sendEvent('domain-done', {
          domain,
          contactCount: result.contacts.length,
          pagesScraped: result.pagesScraped,
          contacts: result.contacts
        });
      }
    } catch (err) {
      sendEvent('domain-done', {
        domain,
        contactCount: 0,
        pagesScraped: 0,
        contacts: [],
        error: err.message
      });
    }
  }

  // Lightweight done signal — no giant contacts payload
  sendEvent('done', {
    totalPagesScraped,
    totalContacts: allContacts.length
  });

  // Clean up Playwright browser if it was used
  await closeBrowser();

  res.end();
});

// ============================================================
// POST /api/validate-stream — SSE validation endpoint
// ============================================================
app.post('/api/validate-stream', async (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');

  const { emails = [], scrapedDomains = [] } = req.body;

  // Deduplicate emails
  const uniqueEmails = [...new Set(emails.map(e => e.toLowerCase().trim()).filter(Boolean))];

  function sendEvent(event, data) {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    if (res.flush) res.flush();
  }

  const results = [];

  for (let i = 0; i < uniqueEmails.length; i++) {
    try {
      const result = await validateEmail(uniqueEmails[i], scrapedDomains);
      results.push(result);
      sendEvent('progress', {
        ...result,
        index: i,
        total: uniqueEmails.length
      });
    } catch (err) {
      // On validation error: return "valid" with error note
      const result = {
        email: uniqueEmails[i],
        status: 'valid',
        reason: `Validation error: ${err.message} — treated as valid`,
        suggestions: [],
        details: { error: err.message }
      };
      results.push(result);
      sendEvent('progress', {
        ...result,
        index: i,
        total: uniqueEmails.length
      });
    }
  }

  sendEvent('done', { results });
  res.end();
});

// ============================================================
// POST /api/export — Excel download
// ============================================================
app.post('/api/export', async (req, res) => {
  const { rows = [] } = req.body;

  try {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Contacts');

    // Column definitions
    sheet.columns = [
      { header: 'S.No', key: 'sno', width: 8 },
      { header: 'Name', key: 'name', width: 25 },
      { header: 'Designation', key: 'designation', width: 30 },
      { header: 'Phone', key: 'phone', width: 20 },
      { header: 'Email', key: 'email', width: 35 },
      { header: 'Validation', key: 'validation', width: 15 },
      { header: 'Validation Note', key: 'validationNote', width: 40 },
      { header: 'Domain', key: 'domain', width: 25 },
      { header: 'Source Page', key: 'source', width: 45 },
      { header: 'LinkedIn', key: 'linkedin', width: 50 }
    ];

    // Header styling — purple
    const headerRow = sheet.getRow(1);
    headerRow.eachCell((cell) => {
      cell.fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: 'FF6C63FF' }
      };
      cell.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 12 };
      cell.alignment = { vertical: 'middle', horizontal: 'center' };
      cell.border = {
        bottom: { style: 'thin', color: { argb: 'FF4A42D4' } }
      };
    });
    headerRow.height = 30;

    // Add data rows
    rows.forEach((row, idx) => {
      const dataRow = sheet.addRow({
        sno: idx + 1,
        name: row.name || '',
        designation: row.designation || '',
        phone: row.phone || '',
        email: row.email || '',
        validation: row.validation || 'unchecked',
        validationNote: row.validationNote || '',
        domain: row.domain || '',
        source: row.source || '',
        linkedin: row.linkedinUrl || row.linkedin || ''
      });

      // Alternating row colors
      const bgColor = idx % 2 === 0 ? 'FFF8F8FF' : 'FFFFFFFF';
      dataRow.eachCell((cell) => {
        cell.fill = {
          type: 'pattern',
          pattern: 'solid',
          fgColor: { argb: bgColor }
        };
        cell.alignment = { vertical: 'middle' };
      });

      // Color-coded validation cell
      const validationCell = dataRow.getCell('validation');
      const status = (row.validation || '').toLowerCase();
      if (status === 'valid') {
        validationCell.font = { color: { argb: 'FF28A745' }, bold: true };
        validationCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE8F5E9' } };
      } else if (status === 'catchall') {
        validationCell.font = { color: { argb: 'FFFFC107' }, bold: true };
        validationCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFF8E1' } };
      } else if (status === 'invalid') {
        validationCell.font = { color: { argb: 'FFDC3545' }, bold: true };
        validationCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFCE4EC' } };
      }
    });

    // Auto filter
    sheet.autoFilter = {
      from: { row: 1, column: 1 },
      to: { row: rows.length + 1, column: 10 }
    };

    // Write and send
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename=MailHarvest_Contacts.xlsx');

    await workbook.xlsx.write(res);
    res.end();
  } catch (err) {
    console.error('[Export] Error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Start server
app.listen(PORT, () => {
  console.log(`\n  MailHarvest server running at http://localhost:${PORT}`);
  console.log(`  Scraper UI: http://localhost:${PORT}/scraper`);
  console.log(`  Validator UI: http://localhost:${PORT}/validator\n`);
});
