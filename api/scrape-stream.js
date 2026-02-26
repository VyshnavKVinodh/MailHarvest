const { scrapeDomain } = require('../scraper');

module.exports = async function handler(req, res) {
    if (req.method !== 'GET') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    // Parse domains from query string
    const url = new URL(req.url, `http://${req.headers.host}`);
    let domains = url.searchParams.getAll('domain');
    if (domains.length === 0) {
        return res.status(400).json({ error: 'No domains provided.' });
    }

    const cleanDomains = domains
        .map(d => d.trim().replace(/^https?:\/\//, '').replace(/\/+$/, ''))
        .filter(d => d.length > 0);

    if (cleanDomains.length === 0) {
        return res.status(400).json({ error: 'No valid domains.' });
    }

    // SSE headers
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.status(200);

    function send(event, data) {
        res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
        // Flush if available
        if (typeof res.flush === 'function') res.flush();
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
};

module.exports.config = { maxDuration: 60 };
