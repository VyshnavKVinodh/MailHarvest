const dns = require('dns');
const net = require('net');

// ── Common email domain typos → corrections ─────────────────────
const DOMAIN_TYPOS = {
    'gmial.com': 'gmail.com', 'gmai.com': 'gmail.com', 'gamil.com': 'gmail.com',
    'gmaill.com': 'gmail.com', 'gnail.com': 'gmail.com', 'gmil.com': 'gmail.com',
    'gmail.co': 'gmail.com', 'gmail.cm': 'gmail.com', 'gmail.om': 'gmail.com',
    'gmail.con': 'gmail.com', 'gmail.cim': 'gmail.com', 'gmail.vom': 'gmail.com',
    'gmal.com': 'gmail.com', 'gmale.com': 'gmail.com', 'gemail.com': 'gmail.com',
    'yahooo.com': 'yahoo.com', 'yaho.com': 'yahoo.com', 'yaoo.com': 'yahoo.com',
    'yhoo.com': 'yahoo.com', 'yahoo.co': 'yahoo.com', 'yahoo.con': 'yahoo.com',
    'yhaoo.com': 'yahoo.com', 'yahoo.cm': 'yahoo.com',
    'hotmal.com': 'hotmail.com', 'hotmai.com': 'hotmail.com', 'hotmial.com': 'hotmail.com',
    'hotamil.com': 'hotmail.com', 'hotmaill.com': 'hotmail.com', 'hotmail.co': 'hotmail.com',
    'hotmail.con': 'hotmail.com',
    'outloo.com': 'outlook.com', 'outlok.com': 'outlook.com', 'outllok.com': 'outlook.com',
    'outlook.co': 'outlook.com', 'outlook.con': 'outlook.com',
    'protonmai.com': 'protonmail.com', 'protonmal.com': 'protonmail.com',
    'iclod.com': 'icloud.com', 'icoud.com': 'icloud.com', 'icloud.co': 'icloud.com',
    'rediffmal.com': 'rediffmail.com', 'redifmail.com': 'rediffmail.com',
};

// Well-known valid email domains (skip SMTP for these)
const KNOWN_VALID_DOMAINS = new Set([
    'gmail.com', 'yahoo.com', 'hotmail.com', 'outlook.com', 'aol.com',
    'icloud.com', 'mail.com', 'protonmail.com', 'zoho.com', 'yandex.com',
    'live.com', 'msn.com', 'me.com', 'mac.com', 'yahoo.co.in',
    'rediffmail.com', 'yahoo.co.uk', 'googlemail.com',
]);

// Known catch-all providers (accept any address)
const KNOWN_CATCHALL_DOMAINS = new Set([
    // These are detected dynamically, but some are pre-flagged
]);

// ── DNS MX Lookup ──────────────────────────────────────────────
function lookupMX(domain) {
    return new Promise((resolve) => {
        dns.resolveMx(domain, (err, addresses) => {
            if (err || !addresses || addresses.length === 0) {
                resolve(null);
            } else {
                // Sort by priority (lowest = highest priority)
                addresses.sort((a, b) => a.priority - b.priority);
                resolve(addresses);
            }
        });
    });
}

// ── SMTP Verification ──────────────────────────────────────────
function smtpVerify(email, mxHost, timeoutMs = 8000) {
    return new Promise((resolve) => {
        const timer = setTimeout(() => {
            socket.destroy();
            resolve({ valid: null, catchAll: null, error: 'timeout' });
        }, timeoutMs);

        const socket = net.createConnection(25, mxHost);
        let step = 0;
        let response = '';
        let result = { valid: null, catchAll: null };

        socket.setEncoding('utf8');

        socket.on('data', (data) => {
            response += data;

            if (step === 0 && response.includes('220')) {
                // Server greeting received
                step = 1;
                socket.write('EHLO mailharvest.local\r\n');
                response = '';
            } else if (step === 1 && (response.includes('250') || response.includes('220'))) {
                // EHLO accepted
                step = 2;
                socket.write('MAIL FROM:<verify@mailharvest.local>\r\n');
                response = '';
            } else if (step === 2 && response.includes('250')) {
                // MAIL FROM accepted
                step = 3;
                socket.write(`RCPT TO:<${email}>\r\n`);
                response = '';
            } else if (step === 3) {
                // RCPT TO response
                if (response.includes('250')) {
                    result.valid = true;
                } else if (response.includes('550') || response.includes('551') ||
                    response.includes('552') || response.includes('553') ||
                    response.includes('554') || response.includes('511') ||
                    response.includes('512') || response.includes('521') ||
                    response.includes('523')) {
                    result.valid = false;
                } else if (response.includes('450') || response.includes('451') ||
                    response.includes('452')) {
                    // Temporary rejection — treat as unknown
                    result.valid = null;
                } else {
                    result.valid = null;
                }

                // Now test catch-all with a random address
                step = 4;
                const randomAddr = `mailharvest_test_${Date.now()}@${email.split('@')[1]}`;
                socket.write(`RCPT TO:<${randomAddr}>\r\n`);
                response = '';
            } else if (step === 4) {
                // Catch-all test response
                if (response.includes('250')) {
                    result.catchAll = true;
                } else {
                    result.catchAll = false;
                }

                step = 5;
                socket.write('QUIT\r\n');
                clearTimeout(timer);
                socket.destroy();
                resolve(result);
            }
        });

        socket.on('error', () => {
            clearTimeout(timer);
            resolve({ valid: null, catchAll: null, error: 'connection_failed' });
        });

        socket.on('timeout', () => {
            clearTimeout(timer);
            socket.destroy();
            resolve({ valid: null, catchAll: null, error: 'timeout' });
        });
    });
}

// ── Syntax Check ───────────────────────────────────────────────
function isValidSyntax(email) {
    const re = /^[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}$/;
    return re.test(email);
}

// ── Suggest fixes for an invalid email ─────────────────────────
function suggestFixes(email) {
    const suggestions = [];
    const [local, domain] = email.split('@');

    if (!local || !domain) {
        suggestions.push({ type: 'format', message: 'Email is missing @ or domain part.' });
        return suggestions;
    }

    // Check domain typos
    const lower = domain.toLowerCase();
    if (DOMAIN_TYPOS[lower]) {
        suggestions.push({
            type: 'typo',
            message: `Domain "${domain}" looks like a typo. Did you mean "${DOMAIN_TYPOS[lower]}"?`,
            corrected: `${local}@${DOMAIN_TYPOS[lower]}`
        });
    }

    // Check for missing TLD
    if (!domain.includes('.') || domain.endsWith('.')) {
        suggestions.push({ type: 'format', message: 'Domain is missing a valid TLD (e.g., .com, .org).' });
    }

    // Check for double dots
    if (email.includes('..')) {
        suggestions.push({
            type: 'typo',
            message: 'Email contains consecutive dots (..) which is invalid.',
            corrected: email.replace(/\.{2,}/g, '.')
        });
    }

    // Check for spaces
    if (email.includes(' ')) {
        suggestions.push({
            type: 'format',
            message: 'Email contains spaces which are not allowed.',
            corrected: email.replace(/\s+/g, '')
        });
    }

    // If domain has no MX, suggest similar known domains
    const domainParts = lower.split('.');
    const baseDomain = domainParts[0];
    const similarDomains = findSimilarDomains(baseDomain);
    if (similarDomains.length > 0 && !KNOWN_VALID_DOMAINS.has(lower) && !DOMAIN_TYPOS[lower]) {
        similarDomains.forEach(sd => {
            suggestions.push({
                type: 'similar',
                message: `Did you mean "${sd}"?`,
                corrected: `${local}@${sd}`
            });
        });
    }

    // Suggest re-scraping
    if (suggestions.length === 0) {
        suggestions.push({
            type: 'rescrape',
            message: 'This email could not be verified. The source page may have changed or the email was extracted incorrectly. Consider re-scraping the source domain.'
        });
    }

    return suggestions;
}

// ── Find similar known domains ─────────────────────────────────
function findSimilarDomains(baseDomain) {
    const knownBases = {
        'gmail': 'gmail.com', 'yahoo': 'yahoo.com', 'hotmail': 'hotmail.com',
        'outlook': 'outlook.com', 'protonmail': 'protonmail.com', 'icloud': 'icloud.com',
        'aol': 'aol.com', 'zoho': 'zoho.com', 'mail': 'mail.com',
        'yandex': 'yandex.com', 'rediffmail': 'rediffmail.com',
    };

    const results = [];
    for (const [base, full] of Object.entries(knownBases)) {
        if (base !== baseDomain && levenshtein(base, baseDomain) <= 2) {
            results.push(full);
        }
    }
    return results.slice(0, 3);
}

// Simple Levenshtein distance
function levenshtein(a, b) {
    const m = a.length, n = b.length;
    const dp = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));
    for (let i = 0; i <= m; i++) dp[i][0] = i;
    for (let j = 0; j <= n; j++) dp[0][j] = j;
    for (let i = 1; i <= m; i++) {
        for (let j = 1; j <= n; j++) {
            dp[i][j] = Math.min(
                dp[i - 1][j] + 1,
                dp[i][j - 1] + 1,
                dp[i - 1][j - 1] + (a[i - 1] !== b[j - 1] ? 1 : 0)
            );
        }
    }
    return dp[m][n];
}

// ── Main validation function ───────────────────────────────────
async function validateEmail(email) {
    email = email.toLowerCase().trim();

    // Step 1: Syntax check
    if (!isValidSyntax(email)) {
        return {
            email,
            status: 'invalid',
            reason: 'Invalid email format.',
            suggestions: suggestFixes(email),
        };
    }

    const domain = email.split('@')[1];

    // Step 2: Check for known typo domains
    if (DOMAIN_TYPOS[domain]) {
        return {
            email,
            status: 'invalid',
            reason: `Domain "${domain}" appears to be a typo.`,
            suggestions: suggestFixes(email),
        };
    }

    // Step 3: DNS MX lookup
    const mxRecords = await lookupMX(domain);
    if (!mxRecords) {
        return {
            email,
            status: 'invalid',
            reason: `Domain "${domain}" has no mail servers (no MX records).`,
            suggestions: suggestFixes(email),
        };
    }

    // Step 4: For known valid public domains, skip SMTP (they block it anyway)
    if (KNOWN_VALID_DOMAINS.has(domain)) {
        return {
            email,
            status: 'valid',
            reason: `Domain "${domain}" is a known valid email provider. Syntax and domain verified.`,
            suggestions: [],
        };
    }

    // Step 5: SMTP verification
    const mxHost = mxRecords[0].exchange;
    const smtpResult = await smtpVerify(email, mxHost);

    if (smtpResult.error) {
        // Could not connect — treat as unverifiable but domain exists
        return {
            email,
            status: 'valid',
            reason: `Domain has valid MX records but SMTP verification was not possible (${smtpResult.error}). Domain is legitimate.`,
            suggestions: [],
        };
    }

    if (smtpResult.catchAll) {
        return {
            email,
            status: 'catchall',
            reason: `Domain "${domain}" is a catch-all domain — it accepts emails to any address. The specific mailbox cannot be verified.`,
            suggestions: [],
        };
    }

    if (smtpResult.valid === true) {
        return {
            email,
            status: 'valid',
            reason: 'Email address exists and is deliverable.',
            suggestions: [],
        };
    }

    if (smtpResult.valid === false) {
        return {
            email,
            status: 'invalid',
            reason: 'The mail server rejected this address — the mailbox does not exist.',
            suggestions: suggestFixes(email),
        };
    }

    // Indeterminate
    return {
        email,
        status: 'valid',
        reason: 'Domain has valid MX records. Individual mailbox verification was inconclusive.',
        suggestions: [],
    };
}

// ── Batch validation ───────────────────────────────────────────
async function validateEmails(emails, onProgress) {
    const results = [];
    for (let i = 0; i < emails.length; i++) {
        const result = await validateEmail(emails[i]);
        results.push(result);
        if (onProgress) {
            onProgress({ completed: i + 1, total: emails.length, current: emails[i], result });
        }
    }
    return results;
}

module.exports = { validateEmail, validateEmails };
