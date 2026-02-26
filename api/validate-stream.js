const { validateEmail } = require('../validator');

module.exports = async function handler(req, res) {
    if (req.method !== 'GET') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    // Parse emails from query string
    const url = new URL(req.url, `http://${req.headers.host}`);
    let emails = url.searchParams.getAll('email');
    if (emails.length === 0) {
        return res.status(400).json({ error: 'No emails provided.' });
    }

    const cleanEmails = [...new Set(emails.map(e => e.trim().toLowerCase()).filter(e => e))];
    if (cleanEmails.length === 0) {
        return res.status(400).json({ error: 'No valid emails.' });
    }

    // SSE headers
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.status(200);

    function send(event, data) {
        res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
        if (typeof res.flush === 'function') res.flush();
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
};

module.exports.config = { maxDuration: 60 };
