const axios = require('axios');
const cheerio = require('cheerio');
const { URL } = require('url');
const https = require('https');
const { translate } = require('google-translate-api-x');

// ── Configuration ──────────────────────────────────────────────────
const QUICK_MAX_PAGES = 30;
const DEEP_MAX_PAGES = 200;
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

// ── Phone regex ────────────────────────────────────────────────────
// Matches international formats: +1 (555) 123-4567, +91-9876543210, (555) 123-4567, 555.123.4567, etc.
const PHONE_REGEX = /(?:\+?\d{1,4}[\s.-]?)?(?:\(?\d{1,5}\)?[\s.-]?)?\d[\d\s.-]{5,}\d/g;

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
    // Strip common tracking/session params
    url.searchParams.delete('utm_source');
    url.searchParams.delete('utm_medium');
    url.searchParams.delete('utm_campaign');
    url.searchParams.delete('utm_content');
    url.searchParams.delete('utm_term');
    url.searchParams.delete('fbclid');
    url.searchParams.delete('gclid');
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
  const retryCodes = ['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', 'EPIPE', 'EHOSTUNREACH'];
  if (error.code && retryCodes.includes(error.code)) return true;
  if (error.response) {
    const status = error.response.status;
    return status === 429 || status === 503 || status === 502 || status === 504;
  }
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

// ── Phone extraction ───────────────────────────────────────────────
function cleanPhone(raw) {
  // Strip all non-digit/non-plus characters, keep leading +
  const digits = raw.replace(/[^\d+]/g, '');
  // Must have at least 7 digits to be a valid phone
  const digitCount = digits.replace(/\D/g, '').length;
  if (digitCount < 7 || digitCount > 15) return null;
  return digits;
}

function extractPhones(text) {
  const matches = text.match(PHONE_REGEX) || [];
  const cleaned = matches.map(cleanPhone).filter(Boolean);
  return [...new Set(cleaned)];
}

// ── LinkedIn profile search URL builder ────────────────────────────
function buildLinkedInSearchUrl(name) {
  if (!name || !isPossibleName(name)) return '';
  // Strip any translation annotations like "Translated (Original)"
  const cleanName = name.replace(/\s*\(.*\)\s*$/, '').trim();
  if (!cleanName || cleanName.length < 2) return '';
  return `https://www.linkedin.com/search/results/people/?keywords=${encodeURIComponent(cleanName)}`;
}

// ── Find phone number near an element ──────────────────────────────
function findPhoneInContext($, $el) {
  // Check the element itself first
  let text = $el.text();
  let phones = extractPhones(text);
  if (phones.length > 0) return phones[0];

  // Check parent hierarchy (up to 4 levels)
  let $context = $el.parent();
  for (let i = 0; i < 4; i++) {
    if ($context.length === 0) break;
    // Look for tel: links
    const $tel = $context.find('a[href^="tel:"]').first();
    if ($tel.length) {
      const telHref = $tel.attr('href').replace('tel:', '').trim();
      const cleaned = cleanPhone(telHref);
      if (cleaned) return cleaned;
    }
    // Look for phone in text
    text = $context.text();
    phones = extractPhones(text);
    if (phones.length > 0) return phones[0];
    $context = $context.parent();
  }

  // Check siblings
  const $siblings = $el.siblings();
  let sibPhone = null;
  $siblings.each((_, sib) => {
    if (sibPhone) return;
    const sibText = $(sib).text();
    const sp = extractPhones(sibText);
    if (sp.length > 0) sibPhone = sp[0];
    // Also check for tel: links in siblings
    const $telSib = $(sib).find('a[href^="tel:"]').first();
    if (!sibPhone && $telSib.length) {
      const cleaned = cleanPhone($telSib.attr('href').replace('tel:', ''));
      if (cleaned) sibPhone = cleaned;
    }
  });
  return sibPhone || '';
}

// ── Find phone number inside a card ────────────────────────────────
function findPhoneInCard($, $card) {
  // Check tel: links first
  const $tel = $card.find('a[href^="tel:"]').first();
  if ($tel.length) {
    const telHref = $tel.attr('href').replace('tel:', '').trim();
    const cleaned = cleanPhone(telHref);
    if (cleaned) return cleaned;
  }
  // Fallback: extract from card text
  const text = $card.text();
  const phones = extractPhones(text);
  return phones.length > 0 ? phones[0] : '';
}

// ── Contact extraction (email + name + designation + phone) ────────
function extractContacts(html, pageUrl) {
  const $ = cheerio.load(html);
  const contacts = [];
  const foundEmails = new Set();
  const foundPhones = new Set(); // Track phones to avoid duplication in phone-only pass

  // Strategy 1: mailto links
  $('a[href^="mailto:"]').each((_, el) => {
    const mailto = $(el).attr('href');
    const email = mailto.replace('mailto:', '').split('?')[0].toLowerCase().trim();
    if (!email || isJunkEmail(email) || !EMAIL_REGEX.test(email) || foundEmails.has(email)) return;
    foundEmails.add(email);
    const context = findContextAroundElement($, $(el));
    const phone = findPhoneInContext($, $(el));
    if (phone) foundPhones.add(phone);
    contacts.push({ email, name: context.name || '', designation: context.designation || '', phone: phone || '', source: pageUrl });
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
          const phone = findPhoneInContext($, $(el));
          if (phone) foundPhones.add(phone);
          contacts.push({ email, name: context.name || '', designation: context.designation || '', phone: phone || '', source: pageUrl });
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
          const phone = findPhoneInCard($, $(card));
          if (phone) foundPhones.add(phone);
          contacts.push({ email, name: context.name || '', designation: context.designation || '', phone: phone || '', source: pageUrl });
        });
      });
    } catch { /* skip */ }
  });

  // Strategy 4: Tables with emails
  $('table').each((_, table) => {
    $(table).find('tr').each((_, row) => {
      const rowText = $(row).text();
      const emailsInRow = extractEmails(rowText);
      const phonesInRow = extractPhones(rowText);
      const rowPhone = phonesInRow.length > 0 ? phonesInRow[0] : '';
      emailsInRow.forEach(email => {
        if (foundEmails.has(email)) return;
        foundEmails.add(email);
        if (rowPhone) foundPhones.add(rowPhone);
        const cells = [];
        $(row).find('td, th').each((_, cell) => { cells.push($(cell).text().trim()); });
        const nameCell = cells.find(c => !EMAIL_REGEX.test(c) && c.length > 1 && c.length < 60 && /^[A-Z]/.test(c));
        const desigCell = cells.find(c => c !== nameCell && !EMAIL_REGEX.test(c) && c.length > 1 && c.length < 100);
        contacts.push({ email, name: nameCell || '', designation: desigCell || '', phone: rowPhone, source: pageUrl });
      });
      // Phone-only rows: table rows with phone + name but no email
      if (emailsInRow.length === 0 && rowPhone && !foundPhones.has(rowPhone)) {
        foundPhones.add(rowPhone);
        const cells = [];
        $(row).find('td, th').each((_, cell) => { cells.push($(cell).text().trim()); });
        const nameCell = cells.find(c => c.length > 1 && c.length < 60 && /^[A-Z]/.test(c) && isPossibleName(c));
        if (nameCell) {
          const desigCell = cells.find(c => c !== nameCell && c.length > 1 && c.length < 100);
          contacts.push({ email: '', name: nameCell || '', designation: desigCell || '', phone: rowPhone, source: pageUrl });
        }
      }
    });
  });

  // Strategy 5: Full body fallback for emails
  const bodyText = $('body').text();
  const allEmails = extractEmails(bodyText);
  allEmails.forEach(email => {
    if (foundEmails.has(email)) return;
    foundEmails.add(email);
    contacts.push({ email, name: '', designation: '', phone: '', source: pageUrl });
  });

  // Strategy 6: tel: links — phone-only entries with nearby name/designation
  $('a[href^="tel:"]').each((_, el) => {
    const telHref = $(el).attr('href').replace('tel:', '').trim();
    const phone = cleanPhone(telHref);
    if (!phone || foundPhones.has(phone)) return;
    foundPhones.add(phone);
    const context = findContextAroundElement($, $(el));
    // Only create phone-only entry if we found a valid name nearby
    if (context.name && isPossibleName(context.name)) {
      contacts.push({ email: '', name: context.name || '', designation: context.designation || '', phone, source: pageUrl });
    }
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
  if (/[@#$%^&*()+=\[\]{}<>|\\/]/.test(text)) return false;
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

// ══════════════════════════════════════════════════════════════════════
// ██  PRIORITY SCORING & SMART LINK CLASSIFICATION
// ══════════════════════════════════════════════════════════════════════

/**
 * Score a URL by how likely it is to contain admin/leadership contacts.
 * Returns a number: higher = more likely to have contacts.
 *   100  = Direct contact / about pages
 *   90   = Team / people / staff pages
 *   80   = Board / governance / directory
 *   70   = Departments / offices / divisions
 *   50   = About sub-pages, research, press
 *   10   = Generic same-domain pages
 *   -1   = Skip entirely (blog, product, cart, auth, legal, careers)
 */
function scoreUrl(url) {
  let pathname;
  try { pathname = new URL(url).pathname.toLowerCase(); } catch { return 10; }

  // ── SKIP patterns (return -1) ──────────────────────────────────
  const skipPatterns = [
    /\/blog\b/i, /\/post\b/i, /\/article\b/i, /\/news\/\d{4}/i,
    /\/\d{4}\/\d{2}\//i,                        // date-slug blog posts
    /\/product[s]?\b/i, /\/shop\b/i, /\/store\b/i, /\/cart\b/i,
    /\/checkout\b/i, /\/buy\b/i, /\/pricing\b/i,
    /\/login\b/i, /\/register\b/i, /\/signup\b/i, /\/sign-up\b/i,
    /\/forgot[-]?password/i, /\/reset[-]?password/i, /\/account\b/i,
    /\/terms\b/i, /\/privacy\b/i, /\/cookie[-]?policy/i, /\/gdpr\b/i,
    /\/legal\b/i, /\/disclaimer\b/i, /\/refund\b/i,
    /\/careers?\b/i, /\/jobs?\b/i, /\/apply\b/i, /\/vacancies\b/i,
    /\/recruitment\b/i, /\/hiring\b/i, /\/openings\b/i,
    /\/faq\b/i, /\/help\b/i, /\/support\b/i, /\/ticket\b/i,
    /\/forum\b/i, /\/community\b/i, /\/comments?\b/i,
    /\/tag\b/i, /\/category\b/i, /\/archive\b/i,
    /\/feed\b/i, /\/rss\b/i, /\/sitemap\b/i, /\/robots\b/i,
    /\/wp-admin\b/i, /\/wp-content\b/i, /\/wp-includes\b/i,
    /\/cdn[-]?cgi\b/i,
  ];
  if (skipPatterns.some(p => p.test(pathname))) return -1;

  // ── Also skip paginated / filtered query strings ───────────────
  try {
    const u = new URL(url);
    const params = u.searchParams;
    if (params.has('page') || params.has('p') || params.has('sort') || params.has('order') ||
        params.has('category') || params.has('tag') || params.has('filter') ||
        params.has('search') || params.has('q') || params.has('s')) {
      return -1;
    }
  } catch { /* continue */ }

  // ── Score 100: Direct contact / about ──────────────────────────
  const score100 = [
    /^\/contact\b/i, /^\/contact[-_]?us\b/i, /^\/about[-_]?us\b/i,
    /^\/about\/?$/i, /^\/who[-_]?we[-_]?are\b/i, /^\/reach[-_]?us\b/i,
    /^\/get[-_]?in[-_]?touch\b/i, /^\/connect\b/i,
  ];
  if (score100.some(p => p.test(pathname))) return 100;

  // ── Score 90: Team / people / staff ────────────────────────────
  const score90 = [
    /\/team\b/i, /\/our[-_]?team\b/i, /\/meet[-_]?the[-_]?team\b/i,
    /\/staff\b/i, /\/people\b/i, /\/members\b/i, /\/employees\b/i,
    /\/personnel\b/i, /\/meet[-_]?us\b/i, /\/our[-_]?people\b/i,
    /\/staff[-_]?directory\b/i, /\/people[-_]?directory\b/i,
  ];
  if (score90.some(p => p.test(pathname))) return 90;

  // ── Score 80: Board / governance / directory / faculty ─────────
  const score80 = [
    /\/leadership\b/i, /\/management\b/i, /\/board\b/i,
    /\/board[-_]?of[-_]?directors\b/i, /\/governance\b/i,
    /\/directory\b/i, /\/faculty\b/i, /\/faculty[-_]?directory\b/i,
    /\/administration\b/i, /\/executives\b/i, /\/principals?\b/i,
    /\/partners?\b/i, /\/founders?\b/i, /\/advisors?\b/i,
    /\/advisory[-_]?board\b/i, /\/senate\b/i, /\/council\b/i,
    /\/professors\b/i, /\/dean\b/i, /\/provost\b/i,
  ];
  if (score80.some(p => p.test(pathname))) return 80;

  // ── Score 70: Departments / offices / divisions ────────────────
  const score70 = [
    /\/departments?\b/i, /\/offices?\b/i, /\/divisions?\b/i,
    /\/units?\b/i, /\/sections?\b/i, /\/branches?\b/i,
    /\/academics?\b/i, /\/schools?\b/i, /\/colleges?\b/i,
    /\/centers?\b/i, /\/institutes?\b/i, /\/programs?\b/i,
  ];
  if (score70.some(p => p.test(pathname))) return 70;

  // ── Score 50: About sub-pages, research, press, media ──────────
  const score50 = [
    /^\/about\/.+/i,    // any sub-page under /about/
    /\/research\b/i, /\/labs?\b/i, /\/researchers?\b/i,
    /\/press\b/i, /\/media\b/i, /\/newsroom\b/i,
    /\/investor\b/i, /\/ir\b/i,
    /\/company\b/i, /\/corporate\b/i, /\/overview\b/i,
  ];
  if (score50.some(p => p.test(pathname))) return 50;

  // ── Score 10: Everything else on the domain ────────────────────
  return 10;
}

/**
 * Sort URLs by score (descending), then alphabetically for ties.
 * Filters out skip URLs (score === -1).
 */
function sortByPriority(urls) {
  const scored = urls.map(url => ({ url, score: scoreUrl(url) }));
  // Remove skip URLs
  const valid = scored.filter(s => s.score >= 0);
  // Sort by score descending, then URL alphabetically
  valid.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.url.localeCompare(b.url);
  });
  return valid.map(s => s.url);
}

// ── Expanded common contact paths to always probe ──────────────────
function getCommonContactPaths(baseUrl) {
  const paths = [
    // Contact
    '/contact', '/contact-us', '/contactus', '/reach-us', '/get-in-touch', '/connect',
    // About
    '/about', '/about-us', '/aboutus', '/who-we-are', '/company', '/corporate', '/overview',
    // Team / People
    '/team', '/our-team', '/ourteam', '/meet-the-team', '/meet-us', '/our-people',
    '/staff', '/staff-directory', '/people', '/people-directory', '/members',
    '/employees', '/personnel',
    // Leadership / Governance
    '/leadership', '/management', '/executives', '/board', '/board-of-directors',
    '/governance', '/advisory-board', '/principals', '/partners', '/founders',
    // Academic
    '/faculty', '/faculty-directory', '/professors', '/academics', '/department',
    '/departments', '/dean', '/provost', '/senate', '/council',
    // Org structure
    '/administration', '/offices', '/divisions', '/units', '/branches',
    '/schools', '/colleges', '/centers', '/institutes', '/programs',
    // Nested about pages
    '/about/team', '/about/people', '/about/leadership', '/about/contact',
    '/about/management', '/about/board', '/about/staff', '/about/our-team',
    // Research / Press
    '/research', '/press', '/media', '/newsroom', '/investor-relations',
  ];
  return paths.map(p => {
    try { return new URL(p, baseUrl).href; } catch { return null; }
  }).filter(Boolean);
}

// ── Non-English detection ──────────────────────────────────────────
function isNonEnglish(text) {
  if (!text || text.length < 2) return false;
  return /[\u0400-\u04FF\u0600-\u06FF\u0900-\u097F\u3040-\u30FF\u4E00-\u9FFF\uAC00-\uD7AF\u00C0-\u024F\u1E00-\u1EFF]/.test(text)
    && !/^[a-zA-Z0-9\s.,\-'"@()&;:!/]+$/.test(text);
}

// ── Batch translate non-English contacts ───────────────────────────
async function translateContacts(contacts) {
  const toTranslate = [];
  const indexMap = [];

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
    const results = await translate(toTranslate, { to: 'en' });
    const translations = Array.isArray(results) ? results : [results];

    translations.forEach((res, i) => {
      const { ci, field } = indexMap[i];
      const translated = res.text || res;
      if (translated && typeof translated === 'string' && translated.length > 0) {
        contacts[ci][field] = `${translated} (${contacts[ci][field]})`;
      }
    });
  } catch (err) {
    // Translation failed silently — keep originals
  }

  return contacts;
}

// ══════════════════════════════════════════════════════════════════════
// ██  MAIN DOMAIN SCRAPER — TWO-PHASE PRIORITY CRAWL
// ══════════════════════════════════════════════════════════════════════

async function scrapeDomain(domain, onProgress, options = {}) {
  domain = domain.replace(/^https?:\/\//, '').replace(/\/+$/, '').trim();

  const crawlMode = options.crawlMode || 'quick';
  const maxPages = options.maxPages || (crawlMode === 'deep' ? DEEP_MAX_PAGES : QUICK_MAX_PAGES);
  const maxContacts = options.maxContacts || 0; // 0 = unlimited

  const visited = new Set();
  const allContacts = [];
  const contactMap = new Map(); // deduplicate by composite key (email or phone)
  let pagesScraped = 0;
  let currentPhase = 1;

  // Helper: generate dedup key for a contact
  function contactKey(c) {
    if (c.email) return c.email;
    if (c.phone) return 'phone:' + c.phone;
    return null; // skip entries with neither
  }

  // Helper: check if we've hit our contact limit
  function isContactLimitReached() {
    return maxContacts > 0 && allContacts.length >= maxContacts;
  }

  // Helper: process a page for contacts
  function processPage(html, url) {
    const contacts = extractContacts(html, url);
    contacts.forEach(c => {
      const key = contactKey(c);
      if (!key) return; // skip contacts with neither email nor phone
      if (!contactMap.has(key)) {
        contactMap.set(key, c);
        allContacts.push(c);
      } else {
        // Merge: if existing entry lacks phone/name/designation, fill from new contact
        const existing = contactMap.get(key);
        if (!existing.phone && c.phone) existing.phone = c.phone;
        if (!existing.name && c.name) existing.name = c.name;
        if (!existing.designation && c.designation) existing.designation = c.designation;
      }
    });
  }

  // Helper: send progress
  function emitProgress(currentUrl, queueSize) {
    if (onProgress) {
      onProgress({
        domain,
        pagesScraped,
        currentUrl,
        contactsFound: allContacts.length,
        queueSize: queueSize || 0,
        phase: currentPhase,
      });
    }
  }

  // ── Resolve the start URL (https → http fallback) ──────────────
  let startUrl = `https://${domain}`;
  let startHtml = await fetchPage(startUrl);
  if (!startHtml) {
    startUrl = `http://${domain}`;
    startHtml = await fetchPage(startUrl);
  }

  if (!startHtml) {
    return { domain, pagesScraped: 0, contacts: [] };
  }

  // ── Process the homepage ───────────────────────────────────────
  visited.add(startUrl);
  // Also mark the alternate protocol as visited
  const altUrl = startUrl.startsWith('https') ? startUrl.replace('https', 'http') : startUrl.replace('http', 'https');
  visited.add(altUrl);
  pagesScraped++;

  processPage(startHtml, startUrl);
  emitProgress(startUrl, 0);

  if (isContactLimitReached()) {
    const limited = allContacts.slice(0, maxContacts);
    await translateContacts(limited);
    return { domain, pagesScraped, contacts: limited };
  }

  // ── Discover all seed URLs ─────────────────────────────────────
  const homeLinks = discoverLinks(startHtml, startUrl, domain);
  const commonPaths = getCommonContactPaths(startUrl);
  const allSeedUrls = [...new Set([...commonPaths, ...homeLinks])].filter(l => !visited.has(l));

  // Score and sort all URLs
  const sortedUrls = sortByPriority(allSeedUrls);

  // Split into Phase 1 (score ≥ 50) and Phase 2 (score < 50, i.e. == 10)
  const phase1Queue = [];
  const phase2Queue = [];

  sortedUrls.forEach(url => {
    const score = scoreUrl(url);
    if (score >= 50) {
      phase1Queue.push(url);
    } else if (score >= 0) {
      phase2Queue.push(url);
    }
    // score === -1 is filtered out by sortByPriority already
  });

  // ══════════════════════════════════════════════════════════════════
  // PHASE 1: Priority sweep — contact/team/leadership pages first
  // ══════════════════════════════════════════════════════════════════
  currentPhase = 1;

  while (phase1Queue.length > 0 && pagesScraped < maxPages && !isContactLimitReached()) {
    const url = phase1Queue.shift();
    if (visited.has(url)) continue;
    visited.add(url);

    emitProgress(url, phase1Queue.length + phase2Queue.length);

    const pageHtml = await fetchPage(url);
    if (!pageHtml) continue;

    pagesScraped++;
    processPage(pageHtml, url);

    // Discover new links from this page and classify them
    const newLinks = discoverLinks(pageHtml, url, domain).filter(l => !visited.has(l));
    const scoredNew = sortByPriority(newLinks);

    scoredNew.forEach(newUrl => {
      const s = scoreUrl(newUrl);
      if (s >= 50 && !phase1Queue.includes(newUrl)) {
        phase1Queue.push(newUrl);
      } else if (s >= 0 && !phase2Queue.includes(newUrl)) {
        phase2Queue.push(newUrl);
      }
    });

    if (phase1Queue.length > 0) {
      await sleep(DELAY_BETWEEN_REQUESTS);
    }
  }

  // ══════════════════════════════════════════════════════════════════
  // PHASE 2: Full-site BFS — traverse remaining pages
  // ══════════════════════════════════════════════════════════════════
  currentPhase = 2;

  while (phase2Queue.length > 0 && pagesScraped < maxPages && !isContactLimitReached()) {
    const url = phase2Queue.shift();
    if (visited.has(url)) continue;
    visited.add(url);

    emitProgress(url, phase2Queue.length);

    const pageHtml = await fetchPage(url);
    if (!pageHtml) continue;

    pagesScraped++;
    processPage(pageHtml, url);

    // Discover new links — any high-priority ones found late get pushed to front
    const newLinks = discoverLinks(pageHtml, url, domain).filter(l => !visited.has(l));
    const scoredNew = sortByPriority(newLinks);

    scoredNew.forEach(newUrl => {
      const s = scoreUrl(newUrl);
      if (s >= 50) {
        // High-priority page found late — push to front of queue
        if (!phase2Queue.includes(newUrl)) {
          phase2Queue.unshift(newUrl);
        }
      } else if (s >= 0 && !phase2Queue.includes(newUrl)) {
        phase2Queue.push(newUrl);
      }
    });

    if (phase2Queue.length > 0) {
      await sleep(DELAY_BETWEEN_REQUESTS);
    }
  }

  // ── Finalize ───────────────────────────────────────────────────
  const finalContacts = maxContacts > 0 ? allContacts.slice(0, maxContacts) : allContacts;

  // Translate non-English names and designations
  await translateContacts(finalContacts);

  // Generate LinkedIn search URLs for contacts with valid names
  finalContacts.forEach(c => {
    c.linkedinUrl = buildLinkedInSearchUrl(c.name);
  });

  return {
    domain,
    pagesScraped,
    contacts: finalContacts
  };
}

module.exports = { scrapeDomain };
