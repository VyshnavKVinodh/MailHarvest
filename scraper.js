const axios = require('axios');
const cheerio = require('cheerio');
const { URL } = require('url');

// ── Configuration ──────────────────────────────────────────────────
const MAX_PAGES_PER_DOMAIN = 30; // Reduced for better batch performance
const REQUEST_TIMEOUT = 12000;
const DELAY_BETWEEN_REQUESTS = 400; // ms
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

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

// ── Page fetcher ───────────────────────────────────────────────────
async function fetchPage(url) {
  try {
    const response = await axios.get(url, {
      timeout: REQUEST_TIMEOUT,
      headers: {
        'User-Agent': USER_AGENT,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      maxRedirects: 5,
      maxContentLength: 5 * 1024 * 1024,
    });

    const contentType = response.headers['content-type'] || '';
    if (!contentType.includes('text/html') && !contentType.includes('application/xhtml')) {
      return null;
    }

    return response.data;
  } catch (error) {
    return null;
  }
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
    '.subtitle', '.occupation', '.job', '.function',
    '[class*="title"]', '[class*="role"]', '[class*="position"]',
    '[class*="designation"]', '[class*="job"]',
    '[itemprop="jobTitle"]', '[itemprop="role"]'
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
  if (!/^[A-Z]/.test(text)) return false;
  if (/\d{3,}/.test(text)) return false;
  if (text.split(' ').length > 5) return false;
  if (/[@#$%^&*()+=\[\]{}<>|\\\/]/.test(text)) return false;
  return true;
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
    'chairman', 'chairperson', 'dean', 'principal', 'editor', 'researcher'
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

// ── Main domain scraper ────────────────────────────────────────────
async function scrapeDomain(domain, onProgress) {
  domain = domain.replace(/^https?:\/\//, '').replace(/\/+$/, '').trim();
  const startUrl = `https://${domain}`;

  const visited = new Set();
  const toVisit = [startUrl];
  const allContacts = [];
  let pagesScraped = 0;

  // Try https first, fall back to http
  const html = await fetchPage(startUrl);
  if (!html) {
    const httpUrl = `http://${domain}`;
    const httpHtml = await fetchPage(httpUrl);
    if (httpHtml) {
      toVisit[0] = httpUrl;
    }
  }

  while (toVisit.length > 0 && pagesScraped < MAX_PAGES_PER_DOMAIN) {
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
    allContacts.push(...contacts);

    const newLinks = discoverLinks(pageHtml, url, domain);
    const prioritized = prioritizeUrls(newLinks.filter(l => !visited.has(l)));
    toVisit.push(...prioritized.filter(l => !toVisit.includes(l)));

    if (toVisit.length > 0) {
      await sleep(DELAY_BETWEEN_REQUESTS);
    }
  }

  // Deduplicate by email
  const emailMap = new Map();
  allContacts.forEach(contact => {
    const existing = emailMap.get(contact.email);
    if (!existing) {
      emailMap.set(contact.email, contact);
    } else {
      if (!existing.name && contact.name) existing.name = contact.name;
      if (!existing.designation && contact.designation) existing.designation = contact.designation;
    }
  });

  return {
    domain,
    pagesScraped,
    contacts: [...emailMap.values()]
  };
}

module.exports = { scrapeDomain };
