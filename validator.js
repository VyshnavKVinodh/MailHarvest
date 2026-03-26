const dns = require('dns');
const net = require('net');

// ============================================================
// Email validation regex — NON-GLOBAL for .test() calls
// ============================================================
const EMAIL_SYNTAX_REGEX = /^[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}$/;

// Fallback DNS resolver (essential for unreliable ISP/residential/serverless DNS)
const fallbackResolver = new dns.Resolver();
fallbackResolver.setServers(['8.8.8.8', '1.1.1.1', '8.8.4.4']);

// Common typo domains (25+)
const TYPO_DOMAINS = {
  'gmial.com': 'gmail.com',
  'gmai.com': 'gmail.com',
  'gamil.com': 'gmail.com',
  'gmal.com': 'gmail.com',
  'gmil.com': 'gmail.com',
  'gnail.com': 'gmail.com',
  'gmail.co': 'gmail.com',
  'gmaill.com': 'gmail.com',
  'gmaiil.com': 'gmail.com',
  'yahooo.com': 'yahoo.com',
  'yaho.com': 'yahoo.com',
  'yaoo.com': 'yahoo.com',
  'yhoo.com': 'yahoo.com',
  'yahoo.co': 'yahoo.com',
  'hotmal.com': 'hotmail.com',
  'hotmai.com': 'hotmail.com',
  'hotmial.com': 'hotmail.com',
  'hotamil.com': 'hotmail.com',
  'hitmail.com': 'hotmail.com',
  'hotmail.co': 'hotmail.com',
  'outlok.com': 'outlook.com',
  'outloo.com': 'outlook.com',
  'outlokk.com': 'outlook.com',
  'outlook.co': 'outlook.com',
  'protonmal.com': 'protonmail.com',
  'protonmaill.com': 'protonmail.com',
  'iclod.com': 'icloud.com',
  'icoud.com': 'icloud.com',
  'yandx.com': 'yandex.com',
  'yandex.co': 'yandex.com',
  'live.co': 'live.com',
  'msn.co': 'msn.com'
};

// Known valid email providers (50+)
const KNOWN_VALID_DOMAINS = new Set([
  'gmail.com', 'googlemail.com', 'google.com',
  'yahoo.com', 'yahoo.co.uk', 'yahoo.co.in', 'yahoo.fr', 'yahoo.de', 'yahoo.co.jp', 'yahoo.com.br', 'yahoo.ca', 'yahoo.com.au',
  'hotmail.com', 'hotmail.co.uk', 'hotmail.fr', 'hotmail.de', 'hotmail.it', 'hotmail.es',
  'outlook.com', 'outlook.co.uk', 'outlook.fr', 'outlook.de', 'outlook.jp',
  'live.com', 'live.co.uk', 'live.fr', 'live.de',
  'msn.com',
  'aol.com',
  'icloud.com', 'me.com', 'mac.com',
  'protonmail.com', 'proton.me', 'pm.me',
  'zoho.com', 'zohomail.com',
  'gmx.com', 'gmx.de', 'gmx.net', 'gmx.at',
  'mail.com', 'email.com',
  'yandex.com', 'yandex.ru', 'ya.ru',
  'mail.ru', 'inbox.ru', 'list.ru', 'bk.ru',
  'qq.com', '163.com', '126.com', 'sina.com',
  'naver.com', 'hanmail.net', 'daum.net',
  'rediffmail.com',
  'tutanota.com', 'tuta.io',
  'fastmail.com', 'fastmail.fm',
  'att.net', 'sbcglobal.net',
  'comcast.net', 'xfinity.com',
  'verizon.net',
  'cox.net',
  'charter.net', 'spectrum.net',
  'earthlink.net',
  'optonline.net',
  'frontier.com', 'frontiernet.net',
  'windstream.net',
  'centurylink.net',
  'btinternet.com', 'bt.com',
  'virginmedia.com', 'ntlworld.com',
  'sky.com',
  'web.de', 'freenet.de', 't-online.de',
  'orange.fr', 'wanadoo.fr', 'free.fr', 'sfr.fr', 'laposte.net',
  'libero.it', 'virgilio.it', 'tin.it',
  'terra.com.br', 'uol.com.br', 'bol.com.br',
  'shaw.ca', 'rogers.com', 'bell.net', 'telus.net',
  'bigpond.com', 'optusnet.com.au'
]);

/**
 * Levenshtein distance between two strings
 */
function levenshtein(a, b) {
  const matrix = [];
  for (let i = 0; i <= b.length; i++) matrix[i] = [i];
  for (let j = 0; j <= a.length; j++) matrix[0][j] = j;

  for (let i = 1; i <= b.length; i++) {
    for (let j = 1; j <= a.length; j++) {
      if (b.charAt(i - 1) === a.charAt(j - 1)) {
        matrix[i][j] = matrix[i - 1][j - 1];
      } else {
        matrix[i][j] = Math.min(
          matrix[i - 1][j - 1] + 1,
          matrix[i][j - 1] + 1,
          matrix[i - 1][j] + 1
        );
      }
    }
  }
  return matrix[b.length][a.length];
}

/**
 * Generate suggestions for invalid emails
 */
function generateSuggestions(email) {
  const suggestions = [];
  const [local, domain] = email.split('@');

  if (!domain) {
    suggestions.push({ type: 'format', message: 'Email is missing @ symbol or domain' });
    return suggestions;
  }

  // Check typo domains
  if (TYPO_DOMAINS[domain]) {
    suggestions.push({
      type: 'typo',
      message: `Did you mean ${local}@${TYPO_DOMAINS[domain]}?`,
      correctedEmail: `${local}@${TYPO_DOMAINS[domain]}`
    });
  }

  // Check double dots
  if (email.includes('..')) {
    const fixed = email.replace(/\.{2,}/g, '.');
    suggestions.push({ type: 'format', message: `Contains double dots. Did you mean ${fixed}?`, correctedEmail: fixed });
  }

  // Check spaces
  if (email.includes(' ')) {
    const fixed = email.replace(/\s/g, '');
    suggestions.push({ type: 'format', message: `Contains spaces. Did you mean ${fixed}?`, correctedEmail: fixed });
  }

  // Check missing TLD
  if (domain && !domain.includes('.')) {
    suggestions.push({ type: 'format', message: `Domain "${domain}" appears to be missing a TLD (e.g., .com)` });
  }

  // Similar domain suggestions using Levenshtein
  const knownDomains = Array.from(KNOWN_VALID_DOMAINS);
  for (const known of knownDomains) {
    const dist = levenshtein(domain, known);
    if (dist > 0 && dist <= 2) {
      suggestions.push({
        type: 'similar',
        message: `Similar to known domain: ${local}@${known}`,
        correctedEmail: `${local}@${known}`
      });
    }
  }

  // Fallback re-scrape suggestion
  if (suggestions.length === 0) {
    suggestions.push({ type: 'rescrape', message: 'Try re-scraping the domain to verify this email' });
  }

  return suggestions;
}

/**
 * DNS MX lookup with fallback resolver
 */
function resolveMx(domain) {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => resolve(null), 5000);

    // Try system DNS first
    dns.resolveMx(domain, (err, addresses) => {
      if (!err && addresses && addresses.length > 0) {
        clearTimeout(timeout);
        resolve(addresses);
        return;
      }

      // Fallback to public DNS
      fallbackResolver.resolveMx(domain, (err2, addresses2) => {
        clearTimeout(timeout);
        if (!err2 && addresses2 && addresses2.length > 0) {
          resolve(addresses2);
        } else {
          resolve(null);
        }
      });
    });
  });
}

/**
 * DNS A record lookup with fallback
 */
function resolveA(domain) {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => resolve(null), 5000);

    dns.resolve4(domain, (err, addresses) => {
      if (!err && addresses && addresses.length > 0) {
        clearTimeout(timeout);
        resolve(addresses);
        return;
      }

      fallbackResolver.resolve4(domain, (err2, addresses2) => {
        clearTimeout(timeout);
        if (!err2 && addresses2 && addresses2.length > 0) {
          resolve(addresses2);
        } else {
          resolve(null);
        }
      });
    });
  });
}

/**
 * SMTP verification
 */
function verifySmtp(email, mxHost) {
  return new Promise((resolve) => {
    // CRITICAL: Declare socket BEFORE the timeout
    let socket;
    let resolved = false;
    let responseData = '';

    const smtpTimeout = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        // CRITICAL: Check if socket exists before destroying
        if (socket) {
          try { socket.destroy(); } catch { }
        }
        // Timeout = treat as valid (domain has MX, is legitimate)
        resolve({ valid: true, catchAll: false, error: 'SMTP timeout - treated as valid' });
      }
    }, 8000);

    try {
      socket = net.createConnection(25, mxHost);

      socket.setEncoding('utf8');
      socket.setTimeout(8000);

      let step = 0;
      const randomUser = 'test' + Math.random().toString(36).substring(2, 10);

      socket.on('data', (data) => {
        responseData += data;

        if (step === 0 && data.includes('220')) {
          step = 1;
          socket.write('EHLO mailharvest.local\r\n');
        } else if (step === 1 && (data.includes('250') || data.includes('220'))) {
          step = 2;
          socket.write(`MAIL FROM:<verify@mailharvest.local>\r\n`);
        } else if (step === 2 && data.includes('250')) {
          step = 3;
          socket.write(`RCPT TO:<${email}>\r\n`);
        } else if (step === 3) {
          const accepted = data.includes('250') || data.includes('251');
          step = 4;
          // Test catch-all with random address
          socket.write(`RCPT TO:<${randomUser}@${email.split('@')[1]}>\r\n`);

          if (!accepted) {
            if (!resolved) {
              resolved = true;
              clearTimeout(smtpTimeout);
              try { socket.write('QUIT\r\n'); socket.destroy(); } catch { }
              resolve({ valid: false, catchAll: false, error: `SMTP rejected: ${data.trim().substring(0, 100)}` });
            }
          }
        } else if (step === 4) {
          const catchAll = data.includes('250') || data.includes('251');
          if (!resolved) {
            resolved = true;
            clearTimeout(smtpTimeout);
            try { socket.write('QUIT\r\n'); socket.destroy(); } catch { }
            resolve({ valid: true, catchAll, error: null });
          }
        }
      });

      socket.on('error', () => {
        if (!resolved) {
          resolved = true;
          clearTimeout(smtpTimeout);
          // Connection error = treat as valid (domain has MX)
          resolve({ valid: true, catchAll: false, error: 'SMTP connection failed - treated as valid' });
        }
      });

      socket.on('timeout', () => {
        if (!resolved) {
          resolved = true;
          clearTimeout(smtpTimeout);
          if (socket) { try { socket.destroy(); } catch { } }
          resolve({ valid: true, catchAll: false, error: 'SMTP timeout - treated as valid' });
        }
      });

    } catch (err) {
      if (!resolved) {
        resolved = true;
        clearTimeout(smtpTimeout);
        resolve({ valid: true, catchAll: false, error: 'SMTP error - treated as valid' });
      }
    }
  });
}

/**
 * Validate a single email — SMTP ping is the primary authority.
 * Syntax + DNS are prerequisites; typo / self-domain / known-provider
 * run AFTER the ping and populate suggestions explaining the result.
 *
 * @param {string} email - Email to validate
 * @param {string[]} scrapedDomains - Domains that were scraped (for self-domain trust)
 */
async function validateEmail(email, scrapedDomains = []) {
  const result = {
    email,
    status: 'invalid',
    reason: '',
    suggestions: [],
    details: {}
  };

  console.log(`[Validator] Checking: ${email}`);

  // ── Prerequisite 1: Syntax check (need valid format to ping) ──────────
  if (!EMAIL_SYNTAX_REGEX.test(email)) {
    result.reason = 'Invalid email syntax';
    result.suggestions = generateSuggestions(email);
    console.log(`  ✗ Failed syntax check`);
    return result;
  }
  result.details.syntax = true;
  console.log(`  ✓ Syntax valid`);

  const [local, domain] = email.toLowerCase().split('@');

  // ── Prerequisite 2: DNS MX lookup (need MX host to ping) ──────────────
  const mxRecords = await resolveMx(domain);
  let mxHost = null;
  let hasARecord = false;

  if (mxRecords && mxRecords.length > 0) {
    const sortedMx = mxRecords.sort((a, b) => a.priority - b.priority);
    mxHost = sortedMx[0].exchange;
    result.details.mxRecords = mxRecords.length;
    console.log(`  ✓ MX found: ${mxRecords.length} record(s)`);
  } else {
    // Try A record fallback
    const aRecords = await resolveA(domain);
    if (aRecords) {
      hasARecord = true;
      result.details.aRecord = true;
      console.log(`  ✓ A record found (no MX) — cannot SMTP verify`);
    } else {
      // No MX, no A — domain doesn't exist, no point continuing
      result.status = 'invalid';
      result.reason = 'Domain has no MX or A records — likely does not exist';
      result.suggestions = generateSuggestions(email);
      console.log(`  ✗ No MX records, no A records`);
      return result;
    }
  }

  // ── PRIMARY CHECK: SMTP Verification (the actual ping) ────────────────
  let smtpResult = null;

  if (mxHost) {
    console.log(`  → SMTP ping against ${mxHost}...`);
    smtpResult = await verifySmtp(email, mxHost);
    result.details.smtp = smtpResult;
    console.log(`  SMTP result: valid=${smtpResult.valid}, catchAll=${smtpResult.catchAll}, error=${smtpResult.error}`);
  } else {
    console.log(`  → No MX host available — skipping SMTP ping`);
  }

  // ── DIAGNOSTIC CHECKS (run always, populate suggestions) ──────────────

  // Diagnostic 1: Typo domain detection
  const typoSuggestion = TYPO_DOMAINS[domain];
  if (typoSuggestion) {
    result.details.typoCheck = false;
    result.suggestions.push({
      type: 'typo',
      message: `Domain looks like a typo: ${domain} → ${typoSuggestion}. Did you mean ${local}@${typoSuggestion}?`,
      correctedEmail: `${local}@${typoSuggestion}`
    });
    console.log(`  ⚠ Typo domain detected: ${domain} → ${typoSuggestion}`);
  } else {
    result.details.typoCheck = true;
    console.log(`  ✓ No typo detected`);
  }

  // Diagnostic 2: Self-domain trust
  const cleanedScrapedDomains = scrapedDomains.map(d => d.replace(/^www\./, '').toLowerCase());
  const emailDomain = domain.toLowerCase();
  const isSelfDomain = cleanedScrapedDomains.some(sd => {
    return emailDomain === sd || emailDomain.endsWith('.' + sd) || sd.endsWith('.' + emailDomain);
  });
  result.details.selfDomain = isSelfDomain;

  if (isSelfDomain) {
    console.log(`  ✓ Self-domain trust: ${emailDomain} matches scraped domain`);
  } else {
    console.log(`  → Not a self-domain`);
  }

  // Diagnostic 3: Known valid provider
  const isKnownProvider = KNOWN_VALID_DOMAINS.has(domain);
  result.details.knownProvider = isKnownProvider;

  if (isKnownProvider) {
    console.log(`  ✓ Known valid provider: ${domain}`);
  } else {
    console.log(`  → Not a known provider`);
  }

  // ── FINAL VERDICT: SMTP result drives the status ──────────────────────

  if (smtpResult) {
    // We got an SMTP answer — it is the authority
    if (!smtpResult.valid) {
      result.status = 'invalid';
      result.reason = smtpResult.error || 'SMTP rejected the recipient — mailbox does not exist';

      // Add diagnostic context to explain the rejection
      if (isSelfDomain) {
        result.suggestions.push({
          type: 'warning',
          message: 'This email\'s domain matches the scraped website, but the mail server rejected the mailbox. The address may be outdated or misspelled.'
        });
      }
      if (isKnownProvider) {
        result.suggestions.push({
          type: 'info',
          message: `${domain} is a known provider — the username "${local}" likely does not exist.`
        });
      }
      // Add general suggestions (deduped)
      const generalSuggestions = generateSuggestions(email);
      for (const gs of generalSuggestions) {
        if (!result.suggestions.some(s => s.correctedEmail && s.correctedEmail === gs.correctedEmail)) {
          result.suggestions.push(gs);
        }
      }
      return result;
    }

    if (smtpResult.catchAll) {
      result.status = 'catchall';
      result.reason = 'Domain accepts all addresses (catch-all) — email may or may not exist';
      if (isSelfDomain) {
        result.suggestions.push({
          type: 'info',
          message: 'Domain matches scraped website — likely legitimate despite catch-all'
        });
      }
      return result;
    }

    // SMTP accepted the recipient
    result.status = 'valid';
    result.reason = 'Email verified via SMTP — mailbox exists';
    if (isSelfDomain) {
      result.suggestions.push({
        type: 'info',
        message: 'Additionally confirmed: domain matches scraped website'
      });
    }
    return result;
  }

  // ── FALLBACK: No SMTP result (A record only, no MX) ──────────────────
  // Use diagnostic checks to make a best-effort determination
  if (isSelfDomain) {
    result.status = 'valid';
    result.reason = 'Could not SMTP verify (no MX records), but domain matches scraped website';
    result.suggestions.push({
      type: 'info',
      message: 'Validated by self-domain trust — SMTP verification was not possible'
    });
    return result;
  }

  if (isKnownProvider) {
    result.status = 'valid';
    result.reason = 'Could not SMTP verify (no MX records), but domain is a known valid provider';
    return result;
  }

  // Domain exists (A record) but we can't verify and have no trust signals
  result.status = 'risky';
  result.reason = 'Domain exists (A record) but has no MX records and could not be SMTP verified';
  result.suggestions.push(...generateSuggestions(email));
  return result;
}

/**
 * Validate multiple emails with progress callback
 * @param {string[]} emails
 * @param {function} onProgress - Called with (result, index, total)
 * @param {string[]} scrapedDomains
 */
async function validateEmails(emails, onProgress = () => { }, scrapedDomains = []) {
  const results = [];

  for (let i = 0; i < emails.length; i++) {
    try {
      const result = await validateEmail(emails[i], scrapedDomains);
      results.push(result);
      onProgress(result, i, emails.length);
    } catch (err) {
      // On error: treat as valid, don't crash
      const result = {
        email: emails[i],
        status: 'valid',
        reason: `Validation error: ${err.message} — treated as valid`,
        suggestions: [],
        details: { error: err.message }
      };
      results.push(result);
      onProgress(result, i, emails.length);
    }
  }

  return results;
}

module.exports = { validateEmail, validateEmails };
