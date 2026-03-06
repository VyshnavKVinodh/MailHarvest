const axios = require('axios');
const cheerio = require('cheerio');
const { URL } = require('url');
const https = require('https');
const { translate } = require('google-translate-api-x');

// ── Configuration ──────────────────────────────────────────────────
const DEFAULT_MAX_PAGES = 30;
const REQUEST_TIMEOUT = 15000;
const DELAY_BETWEEN_REQUESTS = 200; // ms — lower for better batch throughput
const MAX_RETRIES = 2;
const RETRY_BASE_DELAY = 1000; // ms

// HTTPS agent that tolerates self-signed / expired certs
const httpsAgent = new https.Agent({ rejectUnauthorized: false });

// ── User-Agent pool ────────────────────────────────────────────────
const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_3) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Safari/605.1.15',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:123.0) Gecko/20100101 Firefox/123.0',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0',
];

function randomUA() {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

// ── Email regex ────────────────────────────────────────────────────
const EMAIL_REGEX = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g;

// Common non-personal emails to filter out
const JUNK_EMAIL_PATTERNS = [
  /^noreply@/i, /^no-reply@/i, /^donotreply@/i,
  /^mailer-daemon@/i, /^postmaster@/i, /^webmaster@/i,
  /\.png$/i, /\.jpg$/i, /\.gif$/i, /\.svg$/i, /\.css$/i, /\.js$/i,
  /^.*@example\.com$/i, /^.*@sentry\.io$/i, /^.*@wixpress\.com$/i,
  /^.*@w3\.org$/i
];

// ── Helpers ────────────────────────────────────────────────────────
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function normalizeUrl(href, baseUrl) {
  try {
    const url = new URL(href, baseUrl);
    url.hash = '';
    let normalized = url.href.replace(/\/+$/, '');
    return normalized;
  } catch {
    return null;
  }
}

function isSameDomain(url, domain) {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.replace(/^www\./, '');
    const target = domain.replace(/^www\./, '');
    return host === target || host.endsWith('.' + target);
  } catch {
    return false;
  }
}

function isValidPageUrl(url) {
  const skipExtensions = ['.pdf', '.zip', '.rar', '.exe', '.dmg', '.mp3', '.mp4',
    '.avi', '.mov', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
    '.png', '.jpg', '.jpeg', '.gif', '.svg', '.ico', '.webp', '.bmp',
    '.css', '.js', '.json', '.xml', '.woff', '.woff2', '.ttf', '.eot'];
  const lower = url.toLowerCase();
  return !skipExtensions.some(ext => lower.endsWith(ext));
}

function isJunkEmail(email) {
  return JUNK_EMAIL_PATTERNS.some(pattern => pattern.test(email));
}

// ── Retryable errors ──────────────────────────────────────────────
function isRetryable(error) {
  if (!error) return false;
  // Network / connection errors
  const retryCodes = ['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', 'EPIPE', 'EHOSTUNREACH'];
  if (error.code && retryCodes.includes(error.code)) return true;
  // HTTP status codes worth retrying
  if (error.response) {
    const status = error.response.status;
    return status === 429 || status === 503 || status === 502 || status === 504;
  }
  // Timeout
  if (error.code === 'ECONNABORTED') return true;
  return false;
}

// ── Page fetcher with retry ───────────────────────────────────────
async function fetchPage(url, retries = MAX_RETRIES) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const response = await axios.get(url, {
        timeout: REQUEST_TIMEOUT,
        headers: {
          'User-Agent': randomUA(),
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9',
          'Accept-Encoding': 'gzip, deflate',
          'Connection': 'keep-alive',
        },
        maxRedirects: 5,
        maxContentLength: 5 * 1024 * 1024,
        httpsAgent,
      });

      const contentType = response.headers['content-type'] || '';
      if (!contentType.includes('text/html') && !contentType.includes('application/xhtml')) {
        return null;
      }

      return response.data;
    } catch (error) {
      if (attempt < retries && isRetryable(error)) {
        const delay = RETRY_BASE_DELAY * Math.pow(2, attempt);
        await sleep(delay);
        continue;
      }
      return null;
    }
  }
  return null;
}

// ── Link discovery ─────────────────────────────────────────────────
function discoverLinks(html, baseUrl, domain) {
  const $ = cheerio.load(html);
  const links = new Set();

  $('a[href]').each((_, el) => {
    const href = $(el).attr('href');
    if (!href || href.startsWith('#') || href.startsWith('mailto:') || href.startsWith('tel:') || href.startsWith('javascript:')) {
      return;
    }
    const normalized = normalizeUrl(href, baseUrl);
    if (normalized && isSameDomain(normalized, domain) && isValidPageUrl(normalized)) {
      links.add(normalized);
    }
  });

  return [...links];
}

// ── Email extraction ───────────────────────────────────────────────
function extractEmails(text) {
  const matches = text.match(EMAIL_REGEX) || [];
  const unique = [...new Set(matches.map(e => e.toLowerCase()))];
  return unique.filter(e => !isJunkEmail(e));
}

// ── Contact extraction (email + name + designation) ────────────────
function extractContacts(html, pageUrl) {
  const $ = cheerio.load(html);
  const contacts = [];
  const foundEmails = new Set();

  // Strategy 1: mailto links
  $('a[href^="mailto:"]').each((_, el) => {
    const mailto = $(el).attr('href');
    const email = mailto.replace('mailto:', '').split('?')[0].toLowerCase().trim();
    if (!email || isJunkEmail(email) || !EMAIL_REGEX.test(email) || foundEmails.has(email)) return;
    foundEmails.add(email);
    const context = findContextAroundElement($, $(el));
    contacts.push({ email, name: context.name || '', designation: context.designation || '', source: pageUrl });
  });

  // Strategy 2: Team/staff sections
  const teamSelectors = [
    '.team', '.staff', '.people', '.leadership', '.management',
    '.about-team', '.our-team', '.team-members', '.team-section',
    '#team', '#staff', '#people', '#leadership',
    '[class*="team"]', '[class*="staff"]', '[class*="member"]',
    '[class*="people"]', '[class*="employee"]', '[class*="director"]'
  ];

  teamSelectors.forEach(selector => {
    try {
      $(selector).find('*').each((_, el) => {
        const text = $(el).text();
        const emailsInEl = extractEmails(text);
        emailsInEl.forEach(email => {
          if (foundEmails.has(email)) return;
          foundEmails.add(email);
          const context = findContextAroundElement($, $(el));
          contacts.push({ email, name: context.name || '', designation: context.designation || '', source: pageUrl });
        });
      });
    } catch { /* skip */ }
  });

  // Strategy 3: Card/profile containers
  const cardSelectors = [
    '.card', '.profile', '.vcard', '.contact-card', '.member',
    '.person', '.bio', '.author', 'article', '.entry',
    '[class*="card"]', '[class*="profile"]', '[class*="person"]',
    '[class*="contact"]', '[class*="author"]', '[class*="bio"]',
    '[itemtype*="Person"]'
  ];

  cardSelectors.forEach(selector => {
    try {
      $(selector).each((_, card) => {
        const cardText = $(card).text();
        const emailsInCard = extractEmails(cardText);
        emailsInCard.forEach(email => {
          if (foundEmails.has(email)) return;
          foundEmails.add(email);
          const context = findContextInCard($, $(card));
          contacts.push({ email, name: context.name || '', designation: context.designation || '', source: pageUrl });
        });
      });
    } catch { /* skip */ }
  });

  // Strategy 4: Tables with emails
  $('table').each((_, table) => {
    $(table).find('tr').each((_, row) => {
      const rowText = $(row).text();
      const emailsInRow = extractEmails(rowText);
      emailsInRow.forEach(email => {
        if (foundEmails.has(email)) return;
        foundEmails.add(email);
        const cells = [];
        $(row).find('td, th').each((_, cell) => { cells.push($(cell).text().trim()); });
        const nameCell = cells.find(c => !EMAIL_REGEX.test(c) && c.length > 1 && c.length < 60 && /^[A-Z]/.test(c));
        const desigCell = cells.find(c => c !== nameCell && !EMAIL_REGEX.test(c) && c.length > 1 && c.length < 100);
        contacts.push({ email, name: nameCell || '', designation: desigCell || '', source: pageUrl });
      });
    });
  });

  // Strategy 5: Full body fallback
  const bodyText = $('body').text();
  const allEmails = extractEmails(bodyText);
  allEmails.forEach(email => {
    if (foundEmails.has(email)) return;
    foundEmails.add(email);
    contacts.push({ email, name: '', designation: '', source: pageUrl });
  });

  return contacts;
}

// ── Context finder: near element ───────────────────────────────────
function findContextAroundElement($, $el) {
  const result = { name: '', designation: '' };

  let $context = $el.parent();
  for (let i = 0; i < 4; i++) {
    if ($context.length === 0) break;
    const found = findContextInCard($, $context);
    if (found.name || found.designation) return found;
    $context = $context.parent();
  }

  const $siblings = $el.siblings();
  $siblings.each((_, sib) => {
    const text = $(sib).text().trim();
    if (!result.name && isPossibleName(text)) result.name = cleanText(text);
    else if (!result.designation && isPossibleDesignation(text)) result.designation = cleanText(text);
  });

  return result;
}

// ── Context finder: inside card ────────────────────────────────────
function findContextInCard($, $card) {
  const result = { name: '', designation: '' };

  const nameSelectors = [
    'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
    '.name', '.title-name', '.person-name', '.member-name',
    '.author-name', '.full-name', '.fn',
    '[class*="name"]', '[itemprop="name"]'
  ];

  const desigSelectors = [
    '.title', '.role', '.position', '.job-title', '.designation',
    '.subtitle', '.occupation', '.job', '.function', '.description',
    '[class*="title"]', '[class*="role"]', '[class*="position"]',
    '[class*="designation"]', '[class*="job"]', '[class*="desc"]',
    '[class*="function"]', '[class*="occupation"]',
    '[itemprop="jobTitle"]', '[itemprop="role"]',
    'p', 'span', 'small'
  ];

  for (const sel of nameSelectors) {
    try {
      const $name = $card.find(sel).first();
      if ($name.length) {
        const text = $name.text().trim();
        if (isPossibleName(text)) { result.name = cleanText(text); break; }
      }
    } catch { /* skip */ }
  }

  for (const sel of desigSelectors) {
    try {
      const $desig = $card.find(sel).first();
      if ($desig.length) {
        const text = $desig.text().trim();
        if (text.length > 1 && text.length < 100) { result.designation = cleanText(text); break; }
      }
    } catch { /* skip */ }
  }

  if (!result.name) {
    $card.find('h1, h2, h3, h4, h5, h6').each((_, heading) => {
      const text = $(heading).text().trim();
      if (!result.name && isPossibleName(text)) result.name = cleanText(text);
    });
  }

  return result;
}

// ── Heuristic checks ───────────────────────────────────────────────
function isPossibleName(text) {
  if (!text || text.length < 2 || text.length > 60) return false;
  if (/\d{3,}/.test(text)) return false;
  if (text.split(' ').length > 5) return false;
  if (/[@#$%^&*()+=\[\]{}<>|\\\/]/.test(text)) return false;
  // Allow non-Latin scripts (Cyrillic, CJK, Arabic, Devanagari, etc.)
  if (/^[A-Z\u00C0-\u024F]/.test(text)) return true;
  if (/[\u0400-\u04FF\u0600-\u06FF\u0900-\u097F\u3040-\u30FF\u4E00-\u9FFF\uAC00-\uD7AF]/.test(text)) return true;
  return false;
}

function isPossibleDesignation(text) {
  if (!text || text.length < 2 || text.length > 100) return false;
  const designationKeywords = [
    'director', 'manager', 'officer', 'president', 'vp', 'vice president',
    'head', 'lead', 'chief', 'ceo', 'cto', 'cfo', 'coo', 'cmo', 'cio',
    'founder', 'co-founder', 'partner', 'associate', 'analyst', 'engineer',
    'developer', 'designer', 'architect', 'consultant', 'advisor', 'specialist',
    'coordinator', 'executive', 'administrator', 'secretary', 'professor',
    'doctor', 'dr.', 'attorney', 'lawyer', 'accountant', 'supervisor',
    'chairman', 'chairperson', 'dean', 'principal', 'editor', 'researcher',
    'sales', 'marketing', 'finance', 'operations', 'human resources', 'hr',
    'compliance', 'legal', 'strategy', 'procurement', 'logistics',
    'senior', 'junior', 'assistant', 'deputy', 'general', 'regional',
    'representative', 'correspondent', 'ambassador', 'counsel', 'auditor',
    'technician', 'nurse', 'pharmacist', 'surgeon', 'therapist', 'scientist',
    'chef', 'instructor', 'trainer', 'planner', 'broker', 'agent',
    'captain', 'colonel', 'commander', 'lieutenant', 'sergeant',
    'directeur', 'gérant', 'responsable', 'directora', 'gerente', 'jefe',
    'direktor', 'leiter', 'geschäftsführer', 'direttore', 'presidente'
  ];
  const lower = text.toLowerCase();
  return designationKeywords.some(kw => lower.includes(kw));
}

function cleanText(text) {
  return text.replace(/\s+/g, ' ').trim().substring(0, 120);
}

// ── Priority pages ─────────────────────────────────────────────────
function prioritizeUrls(urls) {
  const priorityPatterns = [
    /about/i, /team/i, /staff/i, /people/i, /contact/i,
    /leadership/i, /management/i, /directory/i, /faculty/i,
    /who-we-are/i, /our-team/i, /meet/i, /members/i
  ];

  const priority = [];
  const rest = [];

  urls.forEach(url => {
    if (priorityPatterns.some(p => p.test(url))) priority.push(url);
    else rest.push(url);
  });

  return [...priority, ...rest];
}

// ── Non-English detection ──────────────────────────────────────────
function isNonEnglish(text) {
  if (!text || text.length < 2) return false;
  // Check for non-ASCII-Latin characters (Cyrillic, CJK, Arabic, Devanagari, etc.)
  return /[\u0400-\u04FF\u0600-\u06FF\u0900-\u097F\u3040-\u30FF\u4E00-\u9FFF\uAC00-\uD7AF\u00C0-\u024F\u1E00-\u1EFF]/.test(text)
    && !/^[a-zA-Z0-9\s.,\-'"@()&;:!/]+$/.test(text);
}

// ── Batch translate non-English contacts ───────────────────────────
async function translateContacts(contacts) {
  const toTranslate = [];
  const indexMap = []; // maps toTranslate index → { contactIdx, field }

  contacts.forEach((c, ci) => {
    if (c.name && isNonEnglish(c.name)) {
      indexMap.push({ ci, field: 'name' });
      toTranslate.push(c.name);
    }
    if (c.designation && isNonEnglish(c.designation)) {
      indexMap.push({ ci, field: 'designation' });
      toTranslate.push(c.designation);
    }
  });

  if (toTranslate.length === 0) return contacts;

  try {
    // Batch translate all at once for efficiency
    const results = await translate(toTranslate, { to: 'en' });
    const translations = Array.isArray(results) ? results : [results];

    translations.forEach((res, i) => {
      const { ci, field } = indexMap[i];
      const translated = res.text || res;
      if (translated && typeof translated === 'string' && translated.length > 0) {
        // Store original in parentheses for reference
        contacts[ci][field] = `${translated} (${contacts[ci][field]})`;
      }
    });
  } catch (err) {
    // Translation failed silently — keep originals
  }

  return contacts;
}

// ── Main domain scraper ────────────────────────────────────────────
async function scrapeDomain(domain, onProgress, options = {}) {
  domain = domain.replace(/^https?:\/\//, '').replace(/\/+$/, '').trim();

  const maxPages = options.maxPages || DEFAULT_MAX_PAGES;
  const maxContacts = options.maxContacts || 0; // 0 = unlimited

  const visited = new Set();
  const toVisit = [];
  const allContacts = [];
  const emailMap = new Map(); // deduplicate as we go
  let pagesScraped = 0;

  // ── Resolve the start URL (https → http fallback) ──────────────
  let startUrl = `https://${domain}`;
  let startHtml = await fetchPage(startUrl);
  if (!startHtml) {
    startUrl = `http://${domain}`;
    startHtml = await fetchPage(startUrl);
  }

  if (!startHtml) {
    // Could not reach the site at all
    return { domain, pagesScraped: 0, contacts: [] };
  }

  // Process the homepage directly (don't re-fetch)
  visited.add(startUrl);
  pagesScraped++;

  const homeContacts = extractContacts(startHtml, startUrl);
  homeContacts.forEach(c => {
    if (!emailMap.has(c.email)) {
      emailMap.set(c.email, c);
      allContacts.push(c);
    }
  });

  if (onProgress) {
    onProgress({ domain, pagesScraped, currentUrl: startUrl, contactsFound: allContacts.length, queueSize: 0 });
  }

  // Check contact limit after homepage
  if (maxContacts > 0 && allContacts.length >= maxContacts) {
    const limited = allContacts.slice(0, maxContacts);
    await translateContacts(limited);
    return { domain, pagesScraped, contacts: limited };
  }

  // Discover links from homepage and queue them
  const homeLinks = discoverLinks(startHtml, startUrl, domain);
  const prioritized = prioritizeUrls(homeLinks.filter(l => !visited.has(l)));
  toVisit.push(...prioritized);

  // ── Crawl remaining pages ──────────────────────────────────────
  while (toVisit.length > 0 && pagesScraped < maxPages) {
    // Check contact limit before each page
    if (maxContacts > 0 && allContacts.length >= maxContacts) break;

    const url = toVisit.shift();
    if (visited.has(url)) continue;
    visited.add(url);

    if (onProgress) {
      onProgress({
        domain,
        pagesScraped,
        currentUrl: url,
        contactsFound: allContacts.length,
        queueSize: toVisit.length
      });
    }

    const pageHtml = await fetchPage(url);
    if (!pageHtml) continue;

    pagesScraped++;

    const contacts = extractContacts(pageHtml, url);
    contacts.forEach(c => {
      if (!emailMap.has(c.email)) {
        emailMap.set(c.email, c);
        allContacts.push(c);
      }
    });

    const newLinks = discoverLinks(pageHtml, url, domain);
    const newPrioritized = prioritizeUrls(newLinks.filter(l => !visited.has(l)));
    toVisit.push(...newPrioritized.filter(l => !toVisit.includes(l)));

    if (toVisit.length > 0) {
      await sleep(DELAY_BETWEEN_REQUESTS);
    }
  }

  // Apply contact limit on final output
  const finalContacts = maxContacts > 0 ? allContacts.slice(0, maxContacts) : allContacts;

  // Translate non-English names and designations
  await translateContacts(finalContacts);

  return {
    domain,
    pagesScraped,
    contacts: finalContacts
  };
}

module.exports = { scrapeDomain };
