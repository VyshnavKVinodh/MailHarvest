const axios = require('axios');
const cheerio = require('cheerio');
const https = require('https');
const { translate } = require('google-translate-api-x');
// Playwright is lazy-loaded — see launchBrowser()
// This prevents the entire scraper from crashing if Playwright isn't installed
let chromium = null;
let playwrightAvailable = false;
try {
  chromium = require('playwright').chromium;
  playwrightAvailable = true;
} catch (err) {
  console.log('[Scraper] Playwright not available — browser fallback disabled. Cheerio scraping will work normally.');
  console.log('[Scraper] To enable JS rendering fallback, run: npm install playwright && npx playwright install chromium');
}

// ============================================================
// CRITICAL: Two separate email regex patterns
// EMAIL_REGEX with /g for .match() extraction
// EMAIL_TEST_REGEX without /g for .test() validation
// NEVER use /g regex with .test() — lastIndex bug drops every other email
// ============================================================
const EMAIL_REGEX = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g;
const EMAIL_TEST_REGEX = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/;
const PHONE_REGEX = /(?:\+?\d{1,4}[\s\-.]?)?\(?\d{1,4}\)?[\s\-.]?\d{1,4}[\s\-.]?\d{1,9}/g;

// Junk email patterns
const JUNK_PREFIXES = ['noreply', 'no-reply', 'postmaster', 'webmaster', 'mailer-daemon', 'donotreply', 'do-not-reply', 'bounce', 'auto', 'daemon'];
const JUNK_DOMAINS = ['example.com', 'example.org', 'sentry.io', 'wixpress.com', 'w3.org', 'schema.org', 'wordpress.org', 'gravatar.com', 'placeholder.com'];
const JUNK_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.gif', '.svg', '.css', '.js', '.webp', '.ico', '.woff', '.woff2', '.ttf', '.eot', '.map'];

// Rotating user agents
const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Safari/605.1.15',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
];

// HTTPS agent that tolerates self-signed certs
const httpsAgent = new https.Agent({ rejectUnauthorized: false });

// Designation keywords (100+)
const DESIGNATION_KEYWORDS = [
  // English
  'director', 'manager', 'president', 'vice president', 'vp', 'ceo', 'cto', 'cfo', 'coo', 'cio',
  'chairman', 'chairperson', 'chair', 'founder', 'co-founder', 'partner', 'principal',
  'professor', 'associate professor', 'assistant professor', 'lecturer', 'instructor',
  'dean', 'provost', 'registrar', 'chancellor', 'rector',
  'head', 'chief', 'lead', 'senior', 'junior', 'executive',
  'coordinator', 'administrator', 'secretary', 'treasurer', 'officer',
  'analyst', 'consultant', 'advisor', 'adviser', 'specialist', 'expert',
  'engineer', 'architect', 'developer', 'designer', 'researcher',
  'editor', 'writer', 'journalist', 'reporter', 'correspondent',
  'doctor', 'physician', 'surgeon', 'nurse', 'therapist',
  'lawyer', 'attorney', 'counsel', 'advocate', 'solicitor',
  'accountant', 'auditor', 'controller', 'comptroller',
  'supervisor', 'superintendent', 'foreman', 'inspector',
  'ambassador', 'diplomat', 'minister', 'governor', 'mayor',
  'general manager', 'assistant manager', 'deputy director', 'associate director',
  'faculty', 'staff', 'member', 'fellow', 'scholar', 'assistant',
  'board member', 'trustee', 'governor', 'committee',
  // French
  'directeur', 'directrice', 'professeur', 'président', 'présidente', 'secrétaire',
  'responsable', 'coordonnateur', 'coordonnatrice', 'conseiller', 'conseillère',
  // Spanish
  'director', 'directora', 'profesor', 'profesora', 'presidente', 'presidenta',
  'secretario', 'secretaria', 'coordinador', 'coordinadora', 'gerente',
  // German
  'direktor', 'direktorin', 'geschäftsführer', 'geschäftsführerin',
  'professor', 'professorin', 'leiter', 'leiterin', 'vorsitzender', 'vorsitzende',
  'präsident', 'präsidentin', 'sekretär', 'sekretärin'
];

// Common contact page paths to probe (60+ paths from proven old scraper)
const COMMON_CONTACT_PATHS = [
  // Contact
  '/contact', '/contact-us', '/contactus', '/contact.html',
  '/reach-us', '/get-in-touch', '/connect',
  // About
  '/about', '/about-us', '/aboutus', '/about.html',
  '/who-we-are', '/company', '/corporate', '/overview',
  // Team / People
  '/team', '/our-team', '/ourteam', '/the-team', '/team.html',
  '/meet-the-team', '/meet-our-team', '/meet-us', '/our-people',
  '/people', '/our-people', '/staff', '/our-staff',
  '/staff-directory', '/people-directory', '/members',
  '/employees', '/personnel',
  // Leadership / Governance
  '/leadership', '/our-leadership', '/management',
  '/executives', '/board', '/board-of-directors',
  '/governance', '/advisory-board', '/principals', '/partners', '/founders',
  // Academic
  '/faculty', '/faculty-staff', '/faculty-and-staff', '/faculty-directory',
  '/professors', '/academics', '/department', '/departments',
  '/dean', '/provost', '/senate', '/council',
  // Org structure
  '/administration', '/administration/staff',
  '/offices', '/divisions', '/units', '/branches',
  '/schools', '/colleges', '/centers', '/institutes', '/programs',
  // Directory
  '/directory', '/people-directory', '/staff-directory',
  // Nested about pages
  '/about/team', '/about/people', '/about/leadership', '/about/contact',
  '/about/management', '/about/board', '/about/staff', '/about/our-team',
  '/about/directory',
  '/company/team', '/company/about',
  // Research / Press
  '/academics/faculty', '/academics/departments',
  '/research', '/research/team',
  '/press', '/media', '/newsroom',
  '/investors', '/investor-relations',
];

// Skip patterns for URLs
const SKIP_PATTERNS = [
  /\/blog\//i, /\/blog$/i, /\/news\//i, /\/article/i, /\/post\//i, /\/posts\//i,
  /\/product/i, /\/shop/i, /\/cart/i, /\/checkout/i, /\/store/i, /\/buy/i,
  /\/login/i, /\/signup/i, /\/register/i, /\/signin/i, /\/auth/i, /\/account/i,
  /\/privacy/i, /\/terms/i, /\/legal/i, /\/cookie/i, /\/gdpr/i, /\/disclaimer/i,
  /\/faq/i, /\/help/i, /\/support\/ticket/i,
  /\/tag\//i, /\/category\//i, /\/archive/i, /\/page\/\d+/i,
  /\/feed/i, /\/rss/i, /\/sitemap/i, /\/wp-content/i, /\/wp-admin/i, /\/wp-json/i,
  /\.pdf$/i, /\.doc$/i, /\.docx$/i, /\.xls$/i, /\.xlsx$/i, /\.ppt$/i, /\.pptx$/i,
  /\.zip$/i, /\.rar$/i, /\.tar$/i, /\.gz$/i,
  /\.jpg$/i, /\.jpeg$/i, /\.png$/i, /\.gif$/i, /\.svg$/i, /\.webp$/i,
  /\.mp3$/i, /\.mp4$/i, /\.avi$/i, /\.mov$/i, /\.wmv$/i,
  /\#/i, /javascript:/i, /mailto:/i, /tel:/i
];

/**
 * Score a URL for crawl priority
 * 100 = contact/about, 90 = team/people, 80 = board/governance, 70 = departments, 50 = about-sub, 10 = generic, -1 = skip
 */
function getUrlScore(url) {
  const lower = url.toLowerCase();

  // Check skip patterns
  for (const pattern of SKIP_PATTERNS) {
    if (pattern.test(lower)) return -1;
  }

  // Priority scoring
  if (/\/(contact|contact-us|contactus|about-us|aboutus)(\/?$|\.html)/i.test(lower)) return 100;
  if (/\/(about)(\/?$|\.html)/i.test(lower)) return 100;
  if (/\/(team|our-team|the-team|people|our-people|staff|our-staff|meet-the-team|meet-our-team)(\/?|\.html)/i.test(lower)) return 90;
  if (/\/(leadership|management|executives|our-leadership)(\/?|\.html)/i.test(lower)) return 90;
  if (/\/(board|board-of-directors|governance|trustees|directors)(\/?|\.html)/i.test(lower)) return 80;
  if (/\/(faculty|faculty-staff|faculty-and-staff|professors|academics\/faculty)(\/?|\.html)/i.test(lower)) return 80;
  if (/\/(departments|offices|divisions|units)(\/?|\.html)/i.test(lower)) return 70;
  if (/\/(directory|people-directory|staff-directory)(\/?|\.html)/i.test(lower)) return 70;
  if (/\/(about\/|who-we-are|company)/i.test(lower)) return 50;
  if (/\/(research|press|media|newsroom|investors)/i.test(lower)) return 50;
  if (/\/(administration)/i.test(lower)) return 50;

  return 10;
}

/**
 * Normalize URL — strip hash, tracking params, trailing slashes
 */
function normalizeUrl(url) {
  try {
    const u = new URL(url);
    u.hash = '';
    // Remove tracking params
    const trackingParams = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content',
      'fbclid', 'gclid', 'msclkid', 'mc_cid', 'mc_eid', 'ref', '_ga'];
    for (const p of trackingParams) {
      u.searchParams.delete(p);
    }
    let normalized = u.toString();
    // Strip trailing slash (but keep root path)
    if (normalized.endsWith('/') && u.pathname !== '/') {
      normalized = normalized.slice(0, -1);
    }
    return normalized;
  } catch {
    return url;
  }
}

/**
 * Check if email is junk
 */
function isJunkEmail(email) {
  const lower = email.toLowerCase();
  const [local, domain] = lower.split('@');

  if (JUNK_PREFIXES.some(p => local.startsWith(p))) return true;
  if (JUNK_DOMAINS.some(d => domain === d || domain.endsWith('.' + d))) return true;
  if (JUNK_EXTENSIONS.some(ext => lower.endsWith(ext))) return true;

  return false;
}

/**
 * Validate a possible name string
 */
function isPossibleName(text) {
  if (!text || typeof text !== 'string') return false;
  const cleaned = text.trim();
  if (cleaned.length < 2 || cleaned.length > 80) return false;
  if (cleaned.split(/\s+/).length > 6) return false;
  // No special characters (allow hyphens, apostrophes, dots, spaces, and non-Latin chars)
  if (/[<>{}[\]|\\\/=+*&^%$#!~`@;:?"(),\d]/.test(cleaned)) return false;
  // Must start with capital letter or non-Latin character
  if (/^[a-z]/.test(cleaned)) return false;
  // Non-Latin names are OK
  if (/[^\u0000-\u007F]/.test(cleaned)) return true;
  // Latin names must start with uppercase
  if (/^[A-Z]/.test(cleaned)) return true;
  return false;
}

/**
 * Check if text contains non-Latin characters
 */
function isNonLatin(text) {
  if (!text) return false;
  // Checks for CJK, Arabic, Hebrew, Cyrillic, Devanagari, Thai, etc.
  return /[\u0080-\u024F\u0400-\u04FF\u0500-\u052F\u0600-\u06FF\u0900-\u097F\u0E00-\u0E7F\u1100-\u11FF\u3000-\u9FFF\uAC00-\uD7AF]/.test(text);
}

/**
 * Extract designation from text
 */
function extractDesignation(text) {
  if (!text || typeof text !== 'string') return null;
  const lower = text.toLowerCase().trim();
  if (lower.length < 2 || lower.length > 200) return null;

  for (const keyword of DESIGNATION_KEYWORDS) {
    if (lower.includes(keyword)) {
      // Return the original text (preserving case) if it's short enough
      if (text.trim().length <= 100) return text.trim();
      // Otherwise extract a meaningful chunk around the keyword
      const idx = lower.indexOf(keyword);
      const start = Math.max(0, idx - 20);
      const end = Math.min(text.length, idx + keyword.length + 30);
      return text.substring(start, end).trim();
    }
  }
  return null;
}

/**
 * Clean and validate phone number
 */
function cleanPhone(phone) {
  if (!phone) return null;
  const digits = phone.replace(/[^\d+]/g, '');
  const pureDigits = digits.replace(/\+/g, '');
  if (pureDigits.length >= 7 && pureDigits.length <= 15) {
    return digits.startsWith('+') ? digits : phone.trim();
  }
  return null;
}

/**
 * Find phone number near an element
 */
function findPhoneNearElement($, element) {
  // Check up to 4 levels of parent hierarchy
  let current = $(element);
  for (let i = 0; i < 4; i++) {
    const parent = current.parent();
    if (parent.length === 0) break;
    const parentText = parent.text();
    const phones = parentText.match(PHONE_REGEX);
    if (phones) {
      for (const p of phones) {
        const cleaned = cleanPhone(p);
        if (cleaned) return cleaned;
      }
    }
    current = parent;
  }

  // Check siblings
  const siblings = $(element).siblings();
  for (let i = 0; i < siblings.length; i++) {
    const sibText = $(siblings[i]).text();
    const phones = sibText.match(PHONE_REGEX);
    if (phones) {
      for (const p of phones) {
        const cleaned = cleanPhone(p);
        if (cleaned) return cleaned;
      }
    }
  }

  // Check tel: links nearby
  const parent = $(element).closest('div, section, article, tr, li');
  if (parent.length) {
    const telLinks = parent.find('a[href^="tel:"]');
    if (telLinks.length) {
      const tel = telLinks.first().attr('href').replace('tel:', '');
      const cleaned = cleanPhone(tel);
      if (cleaned) return cleaned;
    }
  }

  return null;
}

/**
 * Find name near an element (in headings, .name, itemprop="name", etc.)
 */
function findNameNearElement($, element) {
  const parent = $(element).closest('div, section, article, tr, li, .card, .profile, .team-member, .vcard');
  if (!parent.length) return null;

  // Check heading tags
  const headings = parent.find('h1, h2, h3, h4, h5, h6');
  for (let i = 0; i < headings.length; i++) {
    const text = $(headings[i]).text().trim();
    if (isPossibleName(text)) return text;
  }

  // Check .name, [itemprop="name"] etc.
  const nameSelectors = ['.name', '[itemprop="name"]', '[class*="name"]', '.fn', '.p-name'];
  for (const sel of nameSelectors) {
    const nameEl = parent.find(sel);
    if (nameEl.length) {
      const text = nameEl.first().text().trim();
      if (isPossibleName(text)) return text;
    }
  }

  // Check strong/b tags
  const strongTags = parent.find('strong, b');
  for (let i = 0; i < strongTags.length; i++) {
    const text = $(strongTags[i]).text().trim();
    if (isPossibleName(text)) return text;
  }

  return null;
}

/**
 * Find designation near an element
 */
function findDesignationNearElement($, element) {
  const parent = $(element).closest('div, section, article, tr, li, .card, .profile, .team-member, .vcard');
  if (!parent.length) return null;

  const designationSelectors = ['.title', '.role', '.position', '.designation', '.job-title',
    '[itemprop="jobTitle"]', '[class*="title"]', '[class*="role"]', '[class*="position"]',
    '.subtitle', '.p-job-title', '.org'];

  for (const sel of designationSelectors) {
    const el = parent.find(sel);
    if (el.length) {
      const text = el.first().text().trim();
      const designation = extractDesignation(text);
      if (designation) return designation;
      // Even if no keyword match, if it's short and looks like a title
      if (text.length > 2 && text.length < 80) return text;
    }
  }

  // Check nearby text for designation keywords
  const parentText = parent.text();
  return extractDesignation(parentText);
}

/**
 * Generate LinkedIn search URL for a name
 */
function generateLinkedInUrl(name) {
  if (!name || !isPossibleName(name)) return null;
  const encoded = encodeURIComponent(name);
  return `https://www.linkedin.com/search/results/people/?keywords=${encoded}`;
}

/**
 * Fetch a page with retries and rotating user agents
 * Reduced timeout (10s) and retries (1) for faster failure detection
 */
async function fetchPage(url, retries = 1) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const ua = USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
      const response = await axios.get(url, {
        timeout: 10000,
        maxRedirects: 5,
        maxContentLength: 5 * 1024 * 1024,
        httpsAgent,
        headers: {
          'User-Agent': ua,
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9',
          'Accept-Encoding': 'gzip, deflate',
          'Connection': 'keep-alive',
        },
        // Default validateStatus (only 2xx) — matches old scraper behavior
      });

      // Only process HTML content
      const contentType = response.headers['content-type'] || '';
      if (!contentType.includes('text/html') && !contentType.includes('application/xhtml')) {
        return null;
      }

      return response.data;
    } catch (err) {
      if (attempt < retries) {
        await new Promise(r => setTimeout(r, 1000 * Math.pow(2, attempt)));
        continue;
      }
      return null;
    }
  }
  return null;
}

/**
 * Test if a domain is reachable and fetch homepage HTML.
 * Tries HTTPS first, then HTTP. Returns { url, html } or null.
 */
async function testDomainReachability(domain) {
  const urls = [`https://${domain}`, `https://www.${domain}`, `http://${domain}`, `http://www.${domain}`];
  
  for (const url of urls) {
    try {
      const ua = USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
      const response = await axios.get(url, {
        timeout: 10000,
        maxRedirects: 5,
        maxContentLength: 5 * 1024 * 1024,
        httpsAgent,
        headers: {
          'User-Agent': ua,
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9',
          'Connection': 'keep-alive',
        },
      });
      const contentType = response.headers['content-type'] || '';
      const isHtml = contentType.includes('text/html') || contentType.includes('application/xhtml');
      console.log(`[Scraper] Domain reachable: ${url} (status ${response.status})`);
      return { url, html: isHtml ? response.data : null };
    } catch (err) {
      console.log(`[Scraper] ${url} unreachable: ${err.code || err.message}`);
      continue;
    }
  }
  return null;
}

/**
 * Extract contacts from a page using 6 strategies
 */
function extractContacts($, pageUrl) {
  const contacts = [];
  const seenEmails = new Set();
  const seenPhones = new Set();

  function addContact(contact) {
    const email = contact.email ? contact.email.toLowerCase().trim() : null;
    const phone = contact.phone ? cleanPhone(contact.phone) : null;

    if (email && isJunkEmail(email)) return;
    if (!email && !phone) return;

    const key = email || (phone ? 'phone:' + phone : null);
    if (!key) return;

    if (email) {
      if (seenEmails.has(email)) return;
      seenEmails.add(email);
    }
    if (phone && !email) {
      if (seenPhones.has(phone)) return;
      seenPhones.add(phone);
    }

    contacts.push({
      email: email || '',
      name: contact.name || '',
      designation: contact.designation || '',
      phone: phone || '',
      source: pageUrl,
      linkedinUrl: contact.linkedinUrl || generateLinkedInUrl(contact.name) || ''
    });
  }

  // Strategy 1: mailto: links
  $('a[href^="mailto:"]').each((_, el) => {
    const href = $(el).attr('href') || '';
    const emailMatch = href.replace('mailto:', '').split('?')[0].trim();
    if (EMAIL_TEST_REGEX.test(emailMatch)) {
      const name = findNameNearElement($, el) || '';
      const designation = findDesignationNearElement($, el) || '';
      const phone = findPhoneNearElement($, el) || '';
      addContact({ email: emailMatch, name, designation, phone });
    }
  });

  // Strategy 2: Team/staff sections
  const teamSelectors = ['.team', '[class*="team"]', '.staff', '[class*="staff"]',
    '.people', '[class*="people"]', '.faculty', '[class*="faculty"]',
    '.leadership', '[class*="leadership"]', '.board', '[class*="board"]',
    '.members', '[class*="member"]', '.directory', '[class*="directory"]'];

  for (const sel of teamSelectors) {
    $(sel).find('*').each((_, el) => {
      const text = $(el).text();
      const emails = text.match(EMAIL_REGEX);
      if (emails) {
        for (const email of emails) {
          if (seenEmails.has(email.toLowerCase())) continue;
          const name = findNameNearElement($, el) || '';
          const designation = findDesignationNearElement($, el) || '';
          const phone = findPhoneNearElement($, el) || '';
          addContact({ email, name, designation, phone });
        }
      }
    });
  }

  // Strategy 3: Card/profile containers
  const cardSelectors = ['.card', '.profile', '.vcard', '.person', '.bio',
    '.contact-card', '.member', '.author', '.entry', 'article',
    '[class*="card"]', '[class*="profile"]', '[class*="person"]',
    '[class*="contact"]', '[class*="author"]', '[class*="bio"]',
    '[itemtype*="Person"]',
    '.grid-item', '.list-item', '[class*="grid-item"]'];

  for (const sel of cardSelectors) {
    $(sel).each((_, card) => {
      const cardText = $(card).text();
      const emails = cardText.match(EMAIL_REGEX);
      if (emails) {
        for (const email of emails) {
          if (seenEmails.has(email.toLowerCase())) continue;
          // Look for name in headings within the card
          let name = '';
          const headings = $(card).find('h1, h2, h3, h4, h5, h6');
          for (let i = 0; i < headings.length; i++) {
            const t = $(headings[i]).text().trim();
            if (isPossibleName(t)) { name = t; break; }
          }
          if (!name) name = findNameNearElement($, card) || '';
          const designation = findDesignationNearElement($, card) || '';
          const phone = findPhoneNearElement($, card) || '';
          addContact({ email, name, designation, phone });
        }
      }
    });
  }

  // Strategy 4: Tables
  $('table tr').each((_, row) => {
    const rowText = $(row).text();
    const emails = rowText.match(EMAIL_REGEX);
    if (emails) {
      const cells = $(row).find('td, th');
      for (const email of emails) {
        if (seenEmails.has(email.toLowerCase())) continue;
        let name = '';
        let designation = '';
        let phone = '';

        cells.each((_, cell) => {
          const cellText = $(cell).text().trim();
          if (!name && isPossibleName(cellText) && !EMAIL_TEST_REGEX.test(cellText)) {
            name = cellText;
          }
          if (!designation) {
            const d = extractDesignation(cellText);
            if (d && !EMAIL_TEST_REGEX.test(cellText)) designation = d;
          }
          if (!phone) {
            const phones = cellText.match(PHONE_REGEX);
            if (phones) phone = cleanPhone(phones[0]) || '';
          }
        });

        addContact({ email, name, designation, phone });
      }
    }
  });

  // Strategy 5: Full body text fallback
  const bodyText = $('body').text();
  const bodyEmails = bodyText.match(EMAIL_REGEX);
  if (bodyEmails) {
    for (const email of bodyEmails) {
      if (seenEmails.has(email.toLowerCase())) continue;
      if (isJunkEmail(email)) continue;
      addContact({ email, name: '', designation: '', phone: '' });
    }
  }

  // Strategy 6: tel: links — phone-only entries
  $('a[href^="tel:"]').each((_, el) => {
    const href = $(el).attr('href') || '';
    const phone = cleanPhone(href.replace('tel:', ''));
    if (!phone) return;
    if (seenPhones.has(phone)) return;

    // Look for name context nearby
    const name = findNameNearElement($, el) || '';
    const designation = findDesignationNearElement($, el) || '';

    // Only add if we haven't seen this phone in an email contact
    const alreadyHasPhone = contacts.some(c => c.phone === phone);
    if (!alreadyHasPhone) {
      addContact({ email: '', name, designation, phone });
    }
  });

  return contacts;
}

/**
 * Extract links from a page, filtering to same domain
 */
function extractLinks($, baseUrl, domain) {
  const links = new Set();
  $('a[href]').each((_, el) => {
    try {
      let href = $(el).attr('href');
      if (!href || href.startsWith('javascript:') || href.startsWith('mailto:') || href.startsWith('tel:')) return;
      // Resolve relative URLs
      const resolved = new URL(href, baseUrl);
      // Same domain check — proper subdomain matching (prevents evildomain.com matching domain.com)
      const host = resolved.hostname.toLowerCase();
      const dom = domain.toLowerCase();
      if (host !== dom && host !== 'www.' + dom && !host.endsWith('.' + dom)) return;
      const normalized = normalizeUrl(resolved.toString());
      if (normalized && getUrlScore(normalized) !== -1) links.add(normalized);
    } catch { }
  });
  return links;
}

/**
 * Translate non-Latin text to English
 */
async function translateContacts(contacts) {
  const toTranslate = [];

  for (const contact of contacts) {
    if (contact.name && isNonLatin(contact.name)) {
      toTranslate.push({ contact, field: 'name', text: contact.name });
    }
    if (contact.designation && isNonLatin(contact.designation)) {
      toTranslate.push({ contact, field: 'designation', text: contact.designation });
    }
  }

  if (toTranslate.length === 0) return contacts;

  try {
    // Batch translate
    const texts = toTranslate.map(t => t.text);
    const results = await translate(texts, { to: 'en' });
    const resultArray = Array.isArray(results) ? results : [results];

    for (let i = 0; i < toTranslate.length; i++) {
      const { contact, field, text } = toTranslate[i];
      const translated = resultArray[i]?.text;
      if (translated && translated !== text) {
        contact[field] = `${translated} (${text})`;
      }
    }
  } catch (err) {
    console.log('[Scraper] Translation failed:', err.message);
  }

  return contacts;
}

// ============================================================
// Playwright Browser Lifecycle Management
// ============================================================
let browserInstance = null;
let browserIdleTimer = null;
const BROWSER_IDLE_TIMEOUT = 5 * 60 * 1000; // 5 minutes

async function launchBrowser() {
  if (!playwrightAvailable || !chromium) {
    throw new Error('Playwright not available');
  }
  if (browserInstance && browserInstance.isConnected()) return browserInstance;
  console.log('[Scraper] Launching headless Chromium via Playwright...');
  browserInstance = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
  });
  console.log('[Scraper] Chromium launched successfully');
  resetBrowserIdleTimer();
  return browserInstance;
}

function resetBrowserIdleTimer() {
  if (browserIdleTimer) clearTimeout(browserIdleTimer);
  browserIdleTimer = setTimeout(async () => {
    await closeBrowser();
  }, BROWSER_IDLE_TIMEOUT);
}

async function closeBrowser() {
  if (browserIdleTimer) { clearTimeout(browserIdleTimer); browserIdleTimer = null; }
  if (browserInstance) {
    try {
      await browserInstance.close();
      console.log('[Scraper] Chromium browser closed');
    } catch (err) {
      console.log('[Scraper] Error closing browser:', err.message);
    }
    browserInstance = null;
  }
}

/**
 * Fetch a page using Playwright headless browser (renders JavaScript)
 * Used as fallback when Cheerio can't extract contacts from JS-heavy sites
 */
async function fetchPageWithBrowser(url, timeoutMs = 20000) {
  try {
    const browser = await launchBrowser();
    const context = await browser.newContext({
      userAgent: USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)],
      ignoreHTTPSErrors: true,
      viewport: { width: 1280, height: 800 }
    });
    const page = await context.newPage();

    try {
      // Navigate and wait for network to settle
      await page.goto(url, { waitUntil: 'networkidle', timeout: timeoutMs });

      // Scroll down to trigger lazy-loaded content
      await page.evaluate(async () => {
        const delay = ms => new Promise(r => setTimeout(r, ms));
        for (let i = 0; i < 5; i++) {
          window.scrollBy(0, window.innerHeight);
          await delay(300);
        }
        window.scrollTo(0, 0);
      });

      // Click any visible "Load More" / "Show All" buttons
      const loadMoreSelectors = [
        'button:has-text("Load More")', 'button:has-text("Show More")',
        'button:has-text("Show All")', 'button:has-text("View All")',
        'a:has-text("Load More")', 'a:has-text("Show More")',
        'a:has-text("Show All")', 'a:has-text("View All")',
        '[class*="load-more"]', '[class*="show-more"]', '[class*="view-all"]'
      ];

      for (const sel of loadMoreSelectors) {
        try {
          const btn = page.locator(sel).first();
          if (await btn.isVisible({ timeout: 500 })) {
            await btn.click();
            await page.waitForTimeout(1500); // Wait for content to load
            console.log(`[Scraper/Browser] Clicked "Load More" button: ${sel}`);
          }
        } catch { /* button not found or not clickable — fine */ }
      }

      // Wait a bit for any final renders
      await page.waitForTimeout(500);

      // Get fully rendered HTML
      const html = await page.content();
      resetBrowserIdleTimer();
      return html;
    } finally {
      await context.close();
    }
  } catch (err) {
    console.log(`[Scraper/Browser] Failed to fetch ${url}: ${err.message}`);
    return null;
  }
}

/**
 * Scrape a domain using Playwright browser rendering
 * This is the fallback path — only called when Cheerio finds < 2 contacts
 */
async function scrapeDomainWithBrowser(domain, baseUrl, options = {}) {
  const {
    crawlMode = 'quick',
    maxContacts = 0,
    onProgress = () => { }
  } = options;

  const baseDomain = domain.replace(/^www\./, '');
  const DELAY_BETWEEN_REQUESTS = 500; // Slower for browser — be polite
  const maxPages = Math.min(crawlMode === 'deep' ? 50 : 15, 50); // Fewer pages for browser mode

  const visitedUrls = new Set();
  const queuedUrls = new Set();
  const allContacts = new Map();
  const urlQueue = [];

  function enqueueUrl(url, score) {
    const normalized = normalizeUrl(url);
    if (queuedUrls.has(normalized)) return;
    if (getUrlScore(normalized) === -1) return;
    queuedUrls.add(normalized);
    urlQueue.push({ url: normalized, score: score || getUrlScore(normalized) });
  }

  function addContact(contact) {
    const email = contact.email ? contact.email.toLowerCase().trim() : '';
    const phone = contact.phone || '';
    const key = email || (phone ? 'phone:' + phone : '');
    if (!key) return;
    if (allContacts.has(key)) {
      const existing = allContacts.get(key);
      if (!existing.name && contact.name) existing.name = contact.name;
      if (!existing.designation && contact.designation) existing.designation = contact.designation;
      if (!existing.phone && contact.phone) existing.phone = contact.phone;
      if (!existing.linkedinUrl && contact.linkedinUrl) existing.linkedinUrl = contact.linkedinUrl;
    } else {
      allContacts.set(key, { ...contact });
    }
  }

  let pagesScraped = 0;
  let consecutiveFailures = 0;

  // Process homepage with browser
  onProgress({ phase: 3, pagesScraped: 0, queueSize: 0, contactCount: 0, status: 'Rendering homepage with browser...' });
  visitedUrls.add(baseUrl);
  queuedUrls.add(baseUrl);

  const homepageHtml = await fetchPageWithBrowser(baseUrl);
  if (homepageHtml) {
    pagesScraped++;
    try {
      const $ = cheerio.load(homepageHtml);
      const pageContacts = extractContacts($, baseUrl);
      for (const contact of pageContacts) {
        contact.domain = baseDomain;
        addContact(contact);
      }
      const homeLinks = extractLinks($, baseUrl, baseDomain);
      for (const link of homeLinks) {
        enqueueUrl(link);
      }
      console.log(`[Scraper/Browser] Homepage: ${pageContacts.length} contacts, ${homeLinks.size || 0} links`);
    } catch (err) {
      console.log(`[Scraper/Browser] Error processing homepage:`, err.message);
    }
  }

  // Seed with high-priority contact paths only
  const protocol = baseUrl.startsWith('https') ? 'https' : 'http';
  const seedBase = `${protocol}://${domain}`;
  const HIGH_PRIORITY_PATHS = [
    '/contact', '/contact-us', '/about', '/about-us', '/team', '/our-team',
    '/people', '/staff', '/leadership', '/faculty', '/directory',
    '/about/team', '/about/people', '/about/leadership', '/about/contact'
  ];
  for (const path of HIGH_PRIORITY_PATHS) {
    enqueueUrl(`${seedBase}${path}`, 90);
  }

  // Sort and crawl
  while (urlQueue.length > 0 && pagesScraped < maxPages) {
    urlQueue.sort((a, b) => b.score - a.score);

    if (consecutiveFailures >= 3) {
      console.log(`[Scraper/Browser] Circuit breaker on ${domain}`);
      break;
    }

    if (maxContacts > 0 && allContacts.size >= maxContacts) break;

    const { url } = urlQueue.shift();
    if (visitedUrls.has(url)) continue;
    visitedUrls.add(url);

    const html = await fetchPageWithBrowser(url);
    if (!html) {
      consecutiveFailures++;
      continue;
    }
    consecutiveFailures = 0;
    pagesScraped++;

    try {
      const $ = cheerio.load(html);
      const pageContacts = extractContacts($, url);
      for (const contact of pageContacts) {
        contact.domain = baseDomain;
        addContact(contact);
      }
      const links = extractLinks($, url, baseDomain);
      for (const link of links) {
        enqueueUrl(link);
      }

      onProgress({
        phase: 3,
        pagesScraped,
        queueSize: urlQueue.length,
        contactCount: allContacts.size,
        currentUrl: url,
        status: `Browser: ${pagesScraped} pages, ${allContacts.size} contacts`
      });
    } catch (err) {
      console.log(`[Scraper/Browser] Error processing ${url}:`, err.message);
    }

    if (urlQueue.length > 0) {
      await new Promise(r => setTimeout(r, DELAY_BETWEEN_REQUESTS));
    }
  }

  let contacts = Array.from(allContacts.values());

  for (const contact of contacts) {
    if (contact.name && !contact.linkedinUrl) {
      contact.linkedinUrl = generateLinkedInUrl(contact.name) || '';
    }
  }

  try {
    contacts = await translateContacts(contacts);
  } catch (err) {
    console.log('[Scraper/Browser] Translation failed:', err.message);
  }

  return { contacts, pagesScraped };
}

/**
 * Main scraping function
 * @param {string} domain - Domain to scrape
 * @param {object} options - { crawlMode, maxContacts, onProgress }
 * @returns {Promise<{contacts: Array, pagesScraped: number}>}
 */
async function scrapeDomain(domain, options = {}) {
  const {
    crawlMode = 'quick',
    maxContacts = 0,
    onProgress = () => { }
  } = options;

  const DELAY_BETWEEN_REQUESTS = 200; // ms — prevents rate-limiting
  const maxPages = crawlMode === 'deep' ? 200 : 30;
  const baseDomain = domain.replace(/^www\./, '');

  // ──────────────────────────────────────────────────────────
  // CRITICAL: Test domain reachability BEFORE queuing 60+ paths
  // Prevents long hang on inaccessible domains
  // ──────────────────────────────────────────────────────────
  onProgress({ phase: 0, pagesScraped: 0, queueSize: 0, contactCount: 0, status: 'Testing domain reachability...' });

  const reachResult = await testDomainReachability(domain);
  if (!reachResult) {
    console.log(`[Scraper] Domain ${domain} is unreachable — skipping entirely`);
    onProgress({ phase: 0, pagesScraped: 0, queueSize: 0, contactCount: 0, status: 'unreachable' });
    return { contacts: [], pagesScraped: 0, error: `Domain ${domain} is unreachable (DNS/network/geo-block). Check connectivity or try a different domain.` };
  }

  // Extract base URL and homepage HTML from reachability result
  const baseUrl = reachResult.url.replace(/\/$/, '');
  const homepageHtml = reachResult.html;
  console.log(`[Scraper] Using base URL: ${baseUrl}`);

  // Use Set for O(1) URL queue dedup — NOT Array.includes()
  const queuedUrls = new Set();
  const visitedUrls = new Set();
  const allContacts = new Map(); // composite key → contact

  // Priority queue: [{url, score}]
  const urlQueue = [];

  function enqueueUrl(url, score) {
    const normalized = normalizeUrl(url);
    if (queuedUrls.has(normalized)) return;
    if (getUrlScore(normalized) === -1) return;
    queuedUrls.add(normalized);
    urlQueue.push({ url: normalized, score: score || getUrlScore(normalized) });
  }

  function addContact(contact) {
    const email = contact.email ? contact.email.toLowerCase().trim() : '';
    const phone = contact.phone || '';
    const key = email || (phone ? 'phone:' + phone : '');
    if (!key) return;

    if (allContacts.has(key)) {
      const existing = allContacts.get(key);
      if (!existing.name && contact.name) existing.name = contact.name;
      if (!existing.designation && contact.designation) existing.designation = contact.designation;
      if (!existing.phone && contact.phone) existing.phone = contact.phone;
      if (!existing.linkedinUrl && contact.linkedinUrl) existing.linkedinUrl = contact.linkedinUrl;
    } else {
      allContacts.set(key, { ...contact });
    }
  }

  let pagesScraped = 0;
  let consecutiveFailures = 0;
  const MAX_CONSECUTIVE_FAILURES = 5;

  // ──────────────────────────────────────────────────────────
  // PHASE 0: Process homepage (already fetched during reachability)
  // This is critical — the old scraper always processed the homepage
  // ──────────────────────────────────────────────────────────
  visitedUrls.add(baseUrl);
  queuedUrls.add(baseUrl);
  // Also mark alternate protocol as visited
  const altUrl = baseUrl.startsWith('https') ? baseUrl.replace('https', 'http') : baseUrl.replace('http', 'https');
  visitedUrls.add(altUrl);
  queuedUrls.add(altUrl);

  if (homepageHtml) {
    pagesScraped++;
    try {
      const $ = cheerio.load(homepageHtml);
      const pageContacts = extractContacts($, baseUrl);
      for (const contact of pageContacts) {
        contact.domain = baseDomain;
        addContact(contact);
      }
      // Discover links from homepage — critical for finding team/contact pages
      const homeLinks = extractLinks($, baseUrl, baseDomain);
      for (const link of homeLinks) {
        enqueueUrl(link);
      }
      console.log(`[Scraper] Homepage: ${pageContacts.length} contacts, ${homeLinks.size || 0} links discovered`);
    } catch (err) {
      console.log(`[Scraper] Error processing homepage:`, err.message);
    }
  }

  onProgress({ phase: 1, pagesScraped, queueSize: urlQueue.length, contactCount: allContacts.size });

  // Seed with common contact paths using the confirmed protocol
  const protocol = baseUrl.startsWith('https') ? 'https' : 'http';
  const seedBase = `${protocol}://${domain}`;
  for (const path of COMMON_CONTACT_PATHS) {
    const url = `${seedBase}${path}`;
    const score = getUrlScore(url);
    if (score > 0) enqueueUrl(url, score);
  }

  // Sort queue by score descending
  function sortQueue() {
    urlQueue.sort((a, b) => b.score - a.score);
  }

  // ──────────────────────────────────────────────────────────
  // PHASE 1 & 2: Crawl priority pages, then remaining pages
  // ──────────────────────────────────────────────────────────
  let phase = 1;

  while (urlQueue.length > 0 && pagesScraped < maxPages) {
    sortQueue();

    // Circuit breaker
    if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
      console.log(`[Scraper] Circuit breaker: ${consecutiveFailures} consecutive failures on ${domain} — stopping`);
      break;
    }

    // Phase transition
    if (phase === 1 && urlQueue[0].score < 50) {
      phase = 2;
      onProgress({ phase: 2, pagesScraped, queueSize: urlQueue.length, contactCount: allContacts.size });
    }

    // Contact limit
    if (maxContacts > 0 && allContacts.size >= maxContacts) break;

    const { url } = urlQueue.shift();
    if (visitedUrls.has(url)) continue;
    visitedUrls.add(url);

    const html = await fetchPage(url);
    if (!html) {
      consecutiveFailures++;
      continue;
    }

    consecutiveFailures = 0;
    pagesScraped++;

    try {
      const $ = cheerio.load(html);

      const pageContacts = extractContacts($, url);
      for (const contact of pageContacts) {
        contact.domain = baseDomain;
        addContact(contact);
      }

      // Discover and enqueue new links from every crawled page
      const links = extractLinks($, url, baseDomain);
      for (const link of links) {
        enqueueUrl(link);
      }

      onProgress({
        phase,
        pagesScraped,
        queueSize: urlQueue.length,
        contactCount: allContacts.size,
        currentUrl: url
      });
    } catch (err) {
      console.log(`[Scraper] Error processing ${url}:`, err.message);
    }

    // Delay between requests — prevents rate limiting
    if (urlQueue.length > 0) {
      await new Promise(r => setTimeout(r, DELAY_BETWEEN_REQUESTS));
    }
  }

  // Convert contacts map to array
  let contacts = Array.from(allContacts.values());

  // ──────────────────────────────────────────────────────────
  // PLAYWRIGHT FALLBACK: If Cheerio found < 2 contacts,
  // retry with headless browser for JS-rendered pages
  // ──────────────────────────────────────────────────────────
  if (contacts.length < 2 && playwrightAvailable) {
    console.log(`[Scraper] Only ${contacts.length} contact(s) found via Cheerio on ${domain} — retrying with Playwright browser`);
    onProgress({ phase: 0, pagesScraped, queueSize: 0, contactCount: contacts.length, status: 'Retrying with JS rendering...' });

    try {
      const browserResult = await scrapeDomainWithBrowser(domain, baseUrl, {
        crawlMode,
        maxContacts,
        onProgress
      });

      if (browserResult.contacts.length > 0) {
        // Merge browser contacts with any Cheerio contacts (dedup by key)
        const mergedMap = new Map();
        for (const c of contacts) {
          const key = (c.email ? c.email.toLowerCase() : '') || (c.phone ? 'phone:' + c.phone : '');
          if (key) mergedMap.set(key, c);
        }
        for (const c of browserResult.contacts) {
          const key = (c.email ? c.email.toLowerCase() : '') || (c.phone ? 'phone:' + c.phone : '');
          if (key && !mergedMap.has(key)) mergedMap.set(key, c);
        }
        contacts = Array.from(mergedMap.values());
        pagesScraped += browserResult.pagesScraped;
        console.log(`[Scraper] Browser fallback found ${browserResult.contacts.length} contacts, merged total: ${contacts.length}`);
      } else {
        console.log(`[Scraper] Browser fallback also found 0 contacts on ${domain} — moving on`);
      }
    } catch (err) {
      console.log(`[Scraper] Browser fallback failed for ${domain}: ${err.message} — moving on`);
    }
  } else if (contacts.length < 2 && !playwrightAvailable) {
    console.log(`[Scraper] Only ${contacts.length} contact(s) on ${domain} — Playwright not available, skipping browser fallback`);
  }

  // Generate LinkedIn URLs for contacts with valid names
  for (const contact of contacts) {
    if (contact.name && !contact.linkedinUrl) {
      contact.linkedinUrl = generateLinkedInUrl(contact.name) || '';
    }
  }

  // Translate non-English contacts
  try {
    contacts = await translateContacts(contacts);
  } catch (err) {
    console.log('[Scraper] Translation batch failed:', err.message);
  }

  return { contacts, pagesScraped };
}

module.exports = { scrapeDomain, closeBrowser };
