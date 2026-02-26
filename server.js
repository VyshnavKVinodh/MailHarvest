const express = require('express');
const cors = require('cors');
const path = require('path');
const ExcelJS = require('exceljs');
const { scrapeDomain } = require('./scraper');
const { validateEmail } = require('./validator');

const app = express();
const PORT = 3000;

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ── GET /api/scrape-stream (SSE) ───────────────────────────────
app.get('/api/scrape-stream', async (req, res) => {
    let domains = req.query.domain;
    if (!domains) return res.status(400).json({ error: 'No domains provided.' });
    if (!Array.isArray(domains)) domains = [domains];

    const cleanDomains = domains
        .map(d => d.trim().replace(/^https?:\/\//, '').replace(/\/+$/, ''))
        .filter(d => d.length > 0);

    if (cleanDomains.length === 0) return res.status(400).json({ error: 'No valid domains.' });

    res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
    });

    function send(event, data) {
        res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    }

    const allContacts = [];
    let totalPages = 0;

    for (const domain of cleanDomains) {
        send('domain-start', { domain });
        try {
            const result = await scrapeDomain(domain, (progress) => {
                send('domain-progress', {
                    domain,
                    pagesScraped: progress.pagesScraped,
                    contactsFound: progress.contactsFound,
                    currentUrl: progress.currentUrl,
                });
            });
            totalPages += result.pagesScraped;
            result.contacts.forEach(c => allContacts.push({ ...c, domain }));
            send('domain-done', {
                domain,
                pagesScraped: result.pagesScraped,
                contactsFound: result.contacts.length,
            });
        } catch (err) {
            send('domain-done', {
                domain, pagesScraped: 0, contactsFound: 0,
                error: `Failed to scrape ${domain}: ${err.message}`,
            });
        }
    }

    send('done', {
        totalDomains: cleanDomains.length,
        totalContacts: allContacts.length,
        totalPages,
        contacts: allContacts,
    });
    res.end();
});

// ── GET /api/validate-stream (SSE) ─────────────────────────────
app.get('/api/validate-stream', async (req, res) => {
    let emails = req.query.email;
    if (!emails) return res.status(400).json({ error: 'No emails provided.' });
    if (!Array.isArray(emails)) emails = [emails];

    const cleanEmails = [...new Set(emails.map(e => e.trim().toLowerCase()).filter(e => e))];
    if (cleanEmails.length === 0) return res.status(400).json({ error: 'No valid emails.' });

    res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
    });

    function send(event, data) {
        res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    }

    const results = [];
    for (let i = 0; i < cleanEmails.length; i++) {
        const email = cleanEmails[i];
        try {
            const result = await validateEmail(email);
            results.push(result);
            send('progress', {
                completed: i + 1,
                total: cleanEmails.length,
                current: email,
                result,
            });
        } catch (err) {
            const fallback = {
                email,
                status: 'valid',
                reason: `Validation error: ${err.message}. Domain may still be valid.`,
                suggestions: [],
            };
            results.push(fallback);
            send('progress', {
                completed: i + 1,
                total: cleanEmails.length,
                current: email,
                result: fallback,
            });
        }
    }

    send('done', { results });
    res.end();
});

// ── POST /api/export ───────────────────────────────────────────
app.post('/api/export', async (req, res) => {
    try {
        const { rows } = req.body;
        if (!rows || !Array.isArray(rows) || rows.length === 0) {
            return res.status(400).json({ error: 'No rows provided.' });
        }

        const workbook = new ExcelJS.Workbook();
        workbook.creator = 'MailHarvest';
        workbook.created = new Date();

        const sheet = workbook.addWorksheet('Contacts', {
            headerFooter: { firstHeader: 'MailHarvest — Scraped Contacts' }
        });

        sheet.columns = [
            { header: 'S.No', key: 'sno', width: 8 },
            { header: 'Name', key: 'name', width: 30 },
            { header: 'Designation', key: 'designation', width: 35 },
            { header: 'Email', key: 'email', width: 40 },
            { header: 'Validation', key: 'validation', width: 14 },
            { header: 'Validation Note', key: 'validationNote', width: 45 },
            { header: 'Domain', key: 'domain', width: 30 },
            { header: 'Source Page', key: 'source', width: 50 },
        ];

        const headerRow = sheet.getRow(1);
        headerRow.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 12 };
        headerRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF6C63FF' } };
        headerRow.alignment = { vertical: 'middle', horizontal: 'center' };
        headerRow.height = 28;

        rows.forEach((row, index) => {
            const dataRow = sheet.addRow({
                sno: index + 1,
                name: row.name || '',
                designation: row.designation || '',
                email: row.email || '',
                validation: (row.validationStatus || 'unchecked').toUpperCase(),
                validationNote: row.validationReason || '',
                domain: row.domain || '',
                source: row.source || '',
            });

            // Color-code validation status
            const valCell = dataRow.getCell('validation');
            if (row.validationStatus === 'valid') {
                valCell.font = { color: { argb: 'FF22C55E' }, bold: true };
            } else if (row.validationStatus === 'catchall') {
                valCell.font = { color: { argb: 'FFF59E0B' }, bold: true };
            } else if (row.validationStatus === 'invalid') {
                valCell.font = { color: { argb: 'FFF43F5E' }, bold: true };
            }

            if (index % 2 === 0) {
                dataRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF5F5FF' } };
            }
            dataRow.alignment = { vertical: 'middle' };
        });

        sheet.autoFilter = { from: 'A1', to: `H${rows.length + 1}` };

        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', `attachment; filename=mailharvest_${Date.now()}.xlsx`);
        await workbook.xlsx.write(res);
        res.end();
    } catch (error) {
        console.error('Export error:', error);
        res.status(500).json({ error: 'Failed to generate Excel file.' });
    }
});

// Serve pages
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/scraper', (req, res) => res.sendFile(path.join(__dirname, 'public', 'scraper.html')));

app.listen(PORT, () => {
    console.log('');
    console.log('  ╔═══════════════════════════════════════╗');
    console.log('  ║       MailHarvest is running!          ║');
    console.log('  ║       http://localhost:' + PORT + '            ║');
    console.log('  ╚═══════════════════════════════════════╝');
    console.log('');
    console.log('  Press Ctrl+C to stop the server.');
    console.log('');
});
