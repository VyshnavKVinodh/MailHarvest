/* ============================================================
   MailHarvest — Client-Side Logic
   ============================================================ */

// ============ State ============
let domains = [];
let contacts = [];
let validationResults = {};
let selectedKeys = new Set();
let isAllSelected = false;
let elapsedInterval = null;
let crawlMode = 'quick';
let scrapedDomains = [];

// ============ DOM Elements ============
const domainInput = document.getElementById('domainInput');
const addDomainBtn = document.getElementById('addDomainBtn');
const chipsContainer = document.getElementById('chipsContainer');
const chipsActions = document.getElementById('chipsActions');
const domainCount = document.getElementById('domainCount');
const clearAllBtn = document.getElementById('clearAllBtn');
const limitToggle = document.getElementById('limitToggle');
const limitSelect = document.getElementById('limitSelect');
const modeQuick = document.getElementById('modeQuick');
const modeDeep = document.getElementById('modeDeep');
const startScrapeBtn = document.getElementById('startScrapeBtn');

const inputSection = document.getElementById('inputSection');
const progressSection = document.getElementById('progressSection');
const phaseLabel = document.getElementById('phaseLabel');
const elapsedTime = document.getElementById('elapsedTime');
const scrapeProgressBar = document.getElementById('scrapeProgressBar');
const domainStatusList = document.getElementById('domainStatusList');

const errorSection = document.getElementById('errorSection');
const errorList = document.getElementById('errorList');

const resultsSection = document.getElementById('resultsSection');
const statsGrid = document.getElementById('statsGrid');
const resultsBody = document.getElementById('resultsBody');
const headerCheckbox = document.getElementById('headerCheckbox');

const validateBtn = document.getElementById('validateBtn');
const exportBtn = document.getElementById('exportBtn');
const selectAllBtn = document.getElementById('selectAllBtn');
const newScrapeBtn = document.getElementById('newScrapeBtn');
const scrapeCompleteActions = document.getElementById('scrapeCompleteActions');
const jumpToResultsBtn = document.getElementById('jumpToResultsBtn');

const searchInput = document.getElementById('searchInput');
const domainFilter = document.getElementById('domainFilter');
const statusFilter = document.getElementById('statusFilter');

const validationSection = document.getElementById('validationSection');
const validationProgressBar = document.getElementById('validationProgressBar');
const validationProgressText = document.getElementById('validationProgressText');
const validCountEl = document.getElementById('validCount');
const catchallCountEl = document.getElementById('catchallCount');
const invalidCountEl = document.getElementById('invalidCount');

const toastContainer = document.getElementById('toastContainer');

// ============ Domain Input Validation ============
const DOMAIN_REGEX = /^[a-zA-Z0-9][a-zA-Z0-9.-]*\.[a-zA-Z]{2,}$/;

// ============ Toast Notifications ============
function showToast(message, type = 'info') {
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.textContent = message;
  toastContainer.appendChild(toast);
  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateX(20px)';
    setTimeout(() => toast.remove(), 300);
  }, 3500);
}

// ============ Domain Management ============
function addDomain(raw) {
  const domain = raw.trim().replace(/^https?:\/\//, '').replace(/\/+$/, '').replace(/^www\./, '').toLowerCase();
  if (!domain) return false;
  if (!DOMAIN_REGEX.test(domain)) {
    domainInput.classList.add('shake');
    setTimeout(() => domainInput.classList.remove('shake'), 400);
    return false;
  }
  if (domains.includes(domain)) {
    showToast(`${domain} already added`, 'info');
    return false;
  }
  domains.push(domain);
  renderChips();
  return true;
}

function removeDomain(domain) {
  domains = domains.filter(d => d !== domain);
  renderChips();
}

function clearAllDomains() {
  domains = [];
  renderChips();
}

function renderChips() {
  chipsContainer.innerHTML = domains.map(d => `
    <div class="chip">
      ${d}
      <span class="remove-chip" data-domain="${d}">&times;</span>
    </div>
  `).join('');

  chipsActions.style.display = domains.length > 0 ? 'flex' : 'none';
  domainCount.textContent = `${domains.length} domain${domains.length !== 1 ? 's' : ''}`;
  startScrapeBtn.disabled = domains.length === 0;

  // Attach remove events
  chipsContainer.querySelectorAll('.remove-chip').forEach(btn => {
    btn.addEventListener('click', () => removeDomain(btn.dataset.domain));
  });
}

// Add domain on Enter or button click
addDomainBtn.addEventListener('click', () => {
  if (addDomain(domainInput.value)) domainInput.value = '';
});

domainInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    if (addDomain(domainInput.value)) domainInput.value = '';
  }
});

// Paste multi-line support
domainInput.addEventListener('paste', (e) => {
  e.preventDefault();
  const text = (e.clipboardData || window.clipboardData).getData('text');
  const lines = text.split(/[\n\r\t,;]+/).map(l => l.trim()).filter(Boolean);
  if (lines.length > 1) {
    let addedCount = 0;
    lines.forEach(line => { if (addDomain(line)) addedCount++; });
    if (addedCount > 0) {
      showToast(`Added ${addedCount} domain${addedCount > 1 ? 's' : ''}`, 'success');
      domainInput.value = '';
    }
  } else {
    domainInput.value = text;
  }
});

clearAllBtn.addEventListener('click', clearAllDomains);

// ============ Options ============
limitToggle.addEventListener('change', () => {
  limitSelect.disabled = !limitToggle.checked;
});

modeQuick.addEventListener('click', () => {
  crawlMode = 'quick';
  modeQuick.classList.add('active');
  modeDeep.classList.remove('active');
  const label = document.getElementById('pageCountLabel');
  if (label) label.textContent = '30 priority pages';
});

modeDeep.addEventListener('click', () => {
  crawlMode = 'deep';
  modeDeep.classList.add('active');
  modeQuick.classList.remove('active');
  const label = document.getElementById('pageCountLabel');
  if (label) label.textContent = '200 pages deep crawl';
});

// ============ SSE Stream Parser ============
async function parseSSEStream(response, onEvent) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    let currentEvent = '';
    let currentData = '';

    for (const line of lines) {
      if (line.startsWith('event: ')) {
        currentEvent = line.substring(7).trim();
      } else if (line.startsWith('data: ')) {
        currentData = line.substring(6);
        try {
          const parsed = JSON.parse(currentData);
          onEvent(currentEvent, parsed);
        } catch { }
        currentEvent = '';
        currentData = '';
      }
    }
  }
}

// ============ Scraping Flow ============
startScrapeBtn.addEventListener('click', startScraping);

async function startScraping() {
  contacts = [];
  validationResults = {};
  selectedKeys = new Set();
  isAllSelected = false;
  scrapedDomains = [...domains];
  headerCheckbox.checked = false;
  headerCheckbox.indeterminate = false;

  // Collapse input, show progress
  inputSection.classList.add('collapsed');
  progressSection.classList.add('visible');
  progressSection.classList.remove('completed');
  resultsSection.classList.remove('visible');
  errorSection.classList.remove('visible');
  errorList.innerHTML = '';

  // Reset progress title and icon
  const progressTitle = document.getElementById('progressTitle');
  if (progressTitle) progressTitle.textContent = 'Scraping In Progress';
  const progressIcon = progressSection.querySelector('.card-header .icon');
  if (progressIcon) progressIcon.innerHTML = '<i class="fi fi-rr-hourglass-end"></i>';

  // Init domain status list
  domainStatusList.innerHTML = domains.map(d => `
    <div class="domain-status-item pending" id="status-${CSS.escape(d)}">
      <span class="status-icon"><i class="fi fi-rr-hourglass-end"></i></span>
      <span class="domain-name">${d}</span>
      <span class="domain-detail"></span>
    </div>
  `).join('');

  // Init live dashboard counters
  const totalDomains = domains.length;
  let domainsCompleted = 0;
  let liveContacts = 0;
  let livePages = 0;
  let doneEventReceived = false;
  const domainsCompletedEl = document.getElementById('domainsCompletedCount');
  const liveContactEl = document.getElementById('liveContactCount');
  const livePagesEl = document.getElementById('livePagesCount');
  domainsCompletedEl.textContent = `0 / ${totalDomains}`;
  liveContactEl.textContent = '0';
  livePagesEl.textContent = '0';

  // Start elapsed timer
  let elapsed = 0;
  elapsedTime.textContent = 'Elapsed: 0s';
  elapsedInterval = setInterval(() => {
    elapsed++;
    const mins = Math.floor(elapsed / 60);
    const secs = elapsed % 60;
    elapsedTime.textContent = `Elapsed: ${mins > 0 ? mins + 'm ' : ''}${secs}s`;
  }, 1000);

  const maxContacts = limitToggle.checked ? parseInt(limitSelect.value) : 0;
  let totalPagesScraped = 0;

  try {
    const response = await fetch('/api/scrape-stream', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ domains, maxContacts, crawlMode })
    });

    await parseSSEStream(response, (event, data) => {
      switch (event) {
        case 'domain-start': {
          const el = document.getElementById(`status-${CSS.escape(data.domain)}`);
          if (el) {
            el.className = 'domain-status-item active';
            el.querySelector('.status-icon').innerHTML = '<i class="fi fi-rr-refresh fi-spin"></i>';
            el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
          }
          break;
        }
        case 'domain-progress': {
          if (data.phase === 0) {
            phaseLabel.textContent = data.status || 'Testing domain reachability...';
          } else if (data.phase === 3) {
            phaseLabel.textContent = data.status || 'JS Rendering Fallback...';
          } else {
            phaseLabel.textContent = data.phase === 1 ? 'Phase 1: Priority Pages' : 'Phase 2: Scanning All Pages';
          }
          // Progress bar tracks domain completion (more meaningful than page count)
          const progress = Math.min(100, (domainsCompleted / totalDomains) * 100);
          scrapeProgressBar.style.width = `${progress}%`;

          const el = document.getElementById(`status-${CSS.escape(data.domain)}`);
          if (el) {
            if (data.phase === 0) {
              el.querySelector('.domain-detail').textContent = data.status || 'Checking...';
              // Show browser icon when retrying with JS rendering
              if (data.status && data.status.includes('JS rendering')) {
                el.querySelector('.status-icon').innerHTML = '<i class="fi fi-rr-browser fi-spin"></i>';
              }
            } else if (data.phase === 3) {
              el.querySelector('.status-icon').innerHTML = '<i class="fi fi-rr-browser fi-spin"></i>';
              el.querySelector('.domain-detail').textContent =
                data.status || `${data.contactCount} contacts • ${data.pagesScraped} pages (browser)`;
            } else {
              el.querySelector('.domain-detail').textContent =
                `${data.contactCount} contacts • ${data.pagesScraped} pages • Queue: ${data.queueSize}`;
            }
          }
          break;
        }
        case 'domain-done': {
          domainsCompleted++;
          const el = document.getElementById(`status-${CSS.escape(data.domain)}`);
          if (el) {
            if (data.error) {
              el.className = 'domain-status-item error';
              el.querySelector('.status-icon').innerHTML = '<i class="fi fi-rr-cross-circle"></i>';
              el.querySelector('.domain-detail').textContent = 'Unreachable';
              addError(`${data.domain} — unreachable`);
            } else {
              el.className = 'domain-status-item done';
              el.querySelector('.status-icon').innerHTML = '<i class="fi fi-rr-check-circle"></i>';
              el.querySelector('.domain-detail').textContent =
                `${data.contactCount} contacts • ${data.pagesScraped} pages`;
              totalPagesScraped += data.pagesScraped;
              liveContacts += data.contactCount || 0;
              livePages += data.pagesScraped || 0;
            }
            el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
          }
          // Accumulate contacts incrementally from each domain
          if (data.contacts && data.contacts.length > 0) {
            contacts.push(...data.contacts);
          }
          // Update live dashboard
          domainsCompletedEl.textContent = `${domainsCompleted} / ${totalDomains}`;
          liveContactEl.textContent = liveContacts;
          livePagesEl.textContent = livePages;
          scrapeProgressBar.style.width = `${Math.min(100, (domainsCompleted / totalDomains) * 100)}%`;
          break;
        }
        case 'done': {
          doneEventReceived = true;
          // Done is now a lightweight signal — contacts already accumulated from domain-done
          totalPagesScraped = data.totalPagesScraped || totalPagesScraped;
          onScrapingComplete(totalPagesScraped);
          break;
        }
      }
    });

    // ── Fallback: if the SSE stream ended but 'done' never fired ──
    if (!doneEventReceived) {
      // The stream closed without the done signal — show whatever we have
      if (contacts.length > 0) {
        showToast('Stream ended — showing accumulated results', 'info');
      }
      onScrapingComplete(totalPagesScraped);
    }
  } catch (err) {
    showToast('Scraping failed: ' + err.message, 'error');
    addError(err.message);
    // Even on error, show any partial results accumulated so far
    if (contacts.length > 0) {
      onScrapingComplete(totalPagesScraped);
    }
  }

  clearInterval(elapsedInterval);
  progressSection.querySelector('.spinner')?.remove();
}

function onScrapingComplete(totalPagesScraped) {
  // Hide progress spinner
  const spinner = document.getElementById('scrapeSpinner');
  if (spinner) spinner.style.display = 'none';
  phaseLabel.textContent = 'Scraping Complete';
  scrapeProgressBar.style.width = '100%';

  // Update progress section title and icon
  const progressTitle = document.getElementById('progressTitle');
  if (progressTitle) progressTitle.textContent = 'Scraping Complete ✓';
  const progressIcon = progressSection.querySelector('.card-header .icon');
  if (progressIcon) progressIcon.innerHTML = '<i class="fi fi-rr-check-circle"></i>';

  // Collapse progress section after a short delay so user sees "Complete"
  progressSection.classList.add('completed');

  // Show the 'View Results' button in progress section
  if (scrapeCompleteActions) scrapeCompleteActions.style.display = 'flex';

  // Show results
  resultsSection.classList.add('visible');

  // Update stats
  document.getElementById('statTotal').textContent = contacts.length;
  document.getElementById('statNames').textContent = contacts.filter(c => c.name).length;
  document.getElementById('statDesignations').textContent = contacts.filter(c => c.designation).length;
  document.getElementById('statPhones').textContent = contacts.filter(c => c.phone).length;
  document.getElementById('statPages').textContent = totalPagesScraped;

  // Populate domain filter
  const uniqueDomains = [...new Set(contacts.map(c => c.domain).filter(Boolean))];
  domainFilter.innerHTML = '<option value="">All Domains</option>' +
    uniqueDomains.map(d => `<option value="${d}">${d}</option>`).join('');

  // Render table
  renderTable();

  showToast(`Found ${contacts.length} contacts from ${totalPagesScraped} pages`, 'success');

  // Auto-scroll to results section after a brief delay
  setTimeout(() => {
    resultsSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, 400);
}

// ============ Table Rendering ============
function getContactKey(contact) {
  return contact.email || (contact.phone ? 'phone:' + contact.phone : '');
}

function renderTable() {
  resultsBody.innerHTML = '';

  contacts.forEach((contact, idx) => {
    const key = getContactKey(contact);
    const vResult = validationResults[contact.email?.toLowerCase()] || null;
    const status = vResult ? vResult.status : 'unchecked';
    const isSelected = selectedKeys.has(key);

    const tr = document.createElement('tr');
    tr.dataset.key = key;
    tr.dataset.email = (contact.email || '').toLowerCase();
    tr.dataset.name = (contact.name || '').toLowerCase();
    tr.dataset.designation = (contact.designation || '').toLowerCase();
    tr.dataset.domain = (contact.domain || '').toLowerCase();
    tr.dataset.phone = (contact.phone || '').toLowerCase();
    tr.dataset.status = status;

    tr.innerHTML = `
      <td><input type="checkbox" class="row-checkbox" ${isSelected ? 'checked' : ''} data-key="${key}"></td>
      <td>${idx + 1}</td>
      <td>${escapeHtml(contact.domain || '—')}</td>
      <td>${escapeHtml(contact.name || '—')}</td>
      <td>${escapeHtml(contact.designation || '—')}</td>
      <td>${escapeHtml(contact.email || '—')}</td>
      <td><span class="status-badge ${status}" data-email="${escapeHtml(contact.email || '')}">${statusLabel(status)}</span></td>
      <td>${escapeHtml(contact.phone || '—')}</td>
      <td>${contact.linkedinUrl ? `<a href="${escapeHtml(contact.linkedinUrl)}" target="_blank" class="linkedin-link" title="LinkedIn Profile"><i class="fi fi-rr-link-alt"></i> LinkedIn</a>` : '—'}</td>
    `;

    resultsBody.appendChild(tr);

    // Validation detail row (hidden by default)
    if (vResult && (vResult.reason || (vResult.suggestions && vResult.suggestions.length > 0))) {
      const detailTr = document.createElement('tr');
      detailTr.className = 'validation-detail';
      detailTr.dataset.detailFor = contact.email?.toLowerCase() || '';
      detailTr.innerHTML = `
        <td colspan="9">
          <div class="detail-content">
            <div class="detail-reason"><i class="fi fi-rr-document"></i> ${escapeHtml(vResult.reason || '')}</div>
            ${vResult.suggestions && vResult.suggestions.length > 0 ? `
              <div class="detail-suggestions">
                ${vResult.suggestions.map(s => `
                  <div class="suggestion-item">
                    ${s.type === 'rescrape' ?
                      `<span>${escapeHtml(s.message)}</span>
                       <button class="btn btn-secondary btn-sm rescrape-btn" data-domain="${escapeHtml(contact.domain || '')}"><i class="fi fi-rr-refresh"></i> Re-scrape</button>`
                      : `<span>${escapeHtml(s.message)}</span>
                         ${s.correctedEmail ? `<span class="suggestion-email">${escapeHtml(s.correctedEmail)}</span>` : ''}`
                    }
                  </div>
                `).join('')}
              </div>
            ` : ''}
          </div>
        </td>
      `;
      resultsBody.appendChild(detailTr);
    }
  });

  applyFilters();
}

function statusLabel(status) {
  switch (status) {
    case 'valid': return '<i class="fi fi-sr-check-circle"></i> Valid';
    case 'catchall': return '<i class="fi fi-rr-triangle-warning"></i> Catch-all';
    case 'risky': return '<i class="fi fi-rr-interrogation"></i> Risky';
    case 'invalid': return '<i class="fi fi-rr-cross-circle"></i> Invalid';
    default: return '<i class="fi fi-rr-hourglass-end"></i> Unchecked';
  }
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// ============ Status Badge Click → Toggle Detail Panel ============
resultsBody.addEventListener('click', (e) => {
  const badge = e.target.closest('.status-badge');
  if (badge) {
    const email = badge.dataset.email?.toLowerCase();
    if (!email) return;
    const detailRow = resultsBody.querySelector(`tr.validation-detail[data-detail-for="${CSS.escape(email)}"]`);
    if (detailRow) {
      detailRow.classList.toggle('visible');
    }
    return;
  }

  // Re-scrape button
  const rescrapeBtn = e.target.closest('.rescrape-btn');
  if (rescrapeBtn) {
    const domain = rescrapeBtn.dataset.domain;
    if (domain) {
      domains = [domain];
      renderChips();
      inputSection.classList.remove('collapsed');
      resultsSection.classList.remove('visible');
      progressSection.classList.remove('visible');
      showToast(`Ready to re-scrape ${domain}`, 'info');
    }
  }
});

// ============ Selection ============
resultsBody.addEventListener('change', (e) => {
  if (e.target.classList.contains('row-checkbox')) {
    const key = e.target.dataset.key;
    if (e.target.checked) {
      selectedKeys.add(key);
    } else {
      selectedKeys.delete(key);
    }
    updateHeaderCheckbox();
  }
});

headerCheckbox.addEventListener('change', () => {
  if (headerCheckbox.checked) {
    // Select all visible
    const visibleRows = resultsBody.querySelectorAll('tr:not(.hidden):not(.validation-detail)');
    visibleRows.forEach(row => {
      const key = row.dataset.key;
      if (key) {
        selectedKeys.add(key);
        const cb = row.querySelector('.row-checkbox');
        if (cb) cb.checked = true;
      }
    });
  } else {
    // Deselect all
    selectedKeys.clear();
    resultsBody.querySelectorAll('.row-checkbox').forEach(cb => cb.checked = false);
  }
  isAllSelected = headerCheckbox.checked;
  updateActionButtons();
});

selectAllBtn.addEventListener('click', () => {
  if (selectedKeys.size === contacts.length) {
    // Deselect all
    selectedKeys.clear();
    resultsBody.querySelectorAll('.row-checkbox').forEach(cb => cb.checked = false);
    headerCheckbox.checked = false;
    headerCheckbox.indeterminate = false;
    selectAllBtn.innerHTML = '<i class="fi fi-rr-checkbox"></i> Select All';
  } else {
    // Select all
    contacts.forEach(c => {
      const key = getContactKey(c);
      if (key) selectedKeys.add(key);
    });
    resultsBody.querySelectorAll('.row-checkbox').forEach(cb => cb.checked = true);
    headerCheckbox.checked = true;
    headerCheckbox.indeterminate = false;
    selectAllBtn.innerHTML = '<i class="fi fi-rr-square"></i> Deselect All';
  }
  updateActionButtons();
});

function updateHeaderCheckbox() {
  const totalVisible = resultsBody.querySelectorAll('tr:not(.hidden):not(.validation-detail)').length;
  if (selectedKeys.size === 0) {
    headerCheckbox.checked = false;
    headerCheckbox.indeterminate = false;
  } else if (selectedKeys.size >= totalVisible) {
    headerCheckbox.checked = true;
    headerCheckbox.indeterminate = false;
  } else {
    headerCheckbox.checked = false;
    headerCheckbox.indeterminate = true;
  }
  updateActionButtons();
}

// Update Validate / Export / Delete button labels based on selection
const deleteSelectedBtn = document.getElementById('deleteSelectedBtn');

function updateActionButtons() {
  const count = selectedKeys.size;
  if (count > 0) {
    validateBtn.innerHTML = `<i class="fi fi-rr-shield-check"></i> Validate ${count} Selected`;
    exportBtn.innerHTML = `<i class="fi fi-rr-download"></i> Export ${count} Selected`;
    if (deleteSelectedBtn) deleteSelectedBtn.style.display = '';
  } else {
    validateBtn.innerHTML = '<i class="fi fi-rr-shield-check"></i> Validate All';
    exportBtn.innerHTML = '<i class="fi fi-rr-download"></i> Export All';
    if (deleteSelectedBtn) deleteSelectedBtn.style.display = 'none';
  }
}

// ============ Delete Selected ============
if (deleteSelectedBtn) {
  deleteSelectedBtn.addEventListener('click', () => {
    if (selectedKeys.size === 0) return;
    const count = selectedKeys.size;
    contacts = contacts.filter(c => !selectedKeys.has(getContactKey(c)));
    selectedKeys.clear();
    headerCheckbox.checked = false;
    headerCheckbox.indeterminate = false;
    renderTable();
    updateActionButtons();

    // Update stats
    document.getElementById('statTotal').textContent = contacts.length;
    document.getElementById('statNames').textContent = contacts.filter(c => c.name).length;
    document.getElementById('statDesignations').textContent = contacts.filter(c => c.designation).length;
    document.getElementById('statPhones').textContent = contacts.filter(c => c.phone).length;

    showToast(`Removed ${count} contacts`, 'info');
  });
}

// Ctrl+A keyboard shortcut
document.addEventListener('keydown', (e) => {
  if (e.ctrlKey && e.key === 'a' && resultsSection.classList.contains('visible')) {
    // Check if focus is not in an input
    if (document.activeElement.tagName !== 'INPUT' && document.activeElement.tagName !== 'TEXTAREA') {
      e.preventDefault();
      selectAllBtn.click();
    }
  }
});

// ============ Filtering ============
searchInput.addEventListener('input', applyFilters);
domainFilter.addEventListener('change', applyFilters);
statusFilter.addEventListener('change', applyFilters);

function applyFilters() {
  const search = searchInput.value.toLowerCase().trim();
  const domainVal = domainFilter.value.toLowerCase();
  const statusVal = statusFilter.value;

  const rows = resultsBody.querySelectorAll('tr:not(.validation-detail)');
  rows.forEach(row => {
    const email = row.dataset.email || '';
    const name = row.dataset.name || '';
    const designation = row.dataset.designation || '';
    const domain = row.dataset.domain || '';
    const phone = row.dataset.phone || '';
    const status = row.dataset.status || 'unchecked';

    let show = true;

    // Search filter
    if (search) {
      const match = email.includes(search) || name.includes(search) ||
        designation.includes(search) || domain.includes(search) || phone.includes(search);
      if (!match) show = false;
    }

    // Domain filter
    if (domainVal && domain !== domainVal) show = false;

    // Status filter
    if (statusVal) {
      if (statusVal === 'has-name') { if (!name || name === '—') show = false; }
      else if (statusVal === 'has-designation') { if (!designation || designation === '—') show = false; }
      else if (statusVal === 'has-phone') { if (!phone || phone === '—') show = false; }
      else if (status !== statusVal) show = false;
    }

    row.classList.toggle('hidden', !show);

    // Also hide corresponding detail row
    const detailRow = row.nextElementSibling;
    if (detailRow && detailRow.classList.contains('validation-detail')) {
      if (!show) detailRow.classList.remove('visible');
    }
  });
}

// ============ Validation Flow ============
validateBtn.addEventListener('click', startValidation);

async function startValidation() {
  // Determine which contacts to validate: selected or all
  const contactsToValidate = selectedKeys.size > 0
    ? contacts.filter(c => selectedKeys.has(getContactKey(c)))
    : contacts;

  // Collect unique emails from the set
  const emails = [...new Set(contactsToValidate.map(c => c.email).filter(Boolean))];

  if (emails.length === 0) {
    showToast(selectedKeys.size > 0 ? 'No emails in selected contacts' : 'No emails to validate', 'info');
    return;
  }

  // Collect scrapedDomains from the relevant contacts
  const allScrapedDomains = [...new Set(contactsToValidate.map(c => c.domain).filter(Boolean))];

  const selLabel = selectedKeys.size > 0 ? ` (${emails.length} selected)` : '';

  validateBtn.disabled = true;
  validateBtn.innerHTML = `<i class="fi fi-rr-spinner fi-spin"></i> Validating${selLabel}...`;
  validationSection.style.display = 'block';

  let validCount = 0, catchallCount = 0, riskyCount = 0, invalidCount = 0;

  try {
    const response = await fetch('/api/validate-stream', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ emails, scrapedDomains: allScrapedDomains })
    });

    await parseSSEStream(response, (event, data) => {
      if (event === 'progress') {
        validationResults[data.email.toLowerCase()] = data;

        // Update progress bar
        const progress = ((data.index + 1) / data.total) * 100;
        validationProgressBar.style.width = `${progress}%`;
        validationProgressText.textContent = `${data.index + 1} / ${data.total}`;

        // Update counts
        if (data.status === 'valid') validCount++;
        else if (data.status === 'catchall') catchallCount++;
        else if (data.status === 'risky') riskyCount++;
        else if (data.status === 'invalid') invalidCount++;

        validCountEl.textContent = validCount;
        catchallCountEl.textContent = catchallCount;
        invalidCountEl.textContent = invalidCount;

        // Update table cell in real-time
        updateRowValidation(data.email.toLowerCase(), data);
      } else if (event === 'done') {
        // Final update
        renderTable();
      }
    });
  } catch (err) {
    showToast('Validation failed: ' + err.message, 'error');
  }

  validateBtn.disabled = false;
  updateActionButtons();
  showToast(`Validation complete: ${validCount} valid, ${catchallCount} catch-all, ${riskyCount} risky, ${invalidCount} invalid`, 'success');
}

function updateRowValidation(email, vResult) {
  const rows = resultsBody.querySelectorAll('tr:not(.validation-detail)');
  rows.forEach(row => {
    if (row.dataset.email === email) {
      row.dataset.status = vResult.status;
      const badge = row.querySelector('.status-badge');
      if (badge) {
        badge.className = `status-badge ${vResult.status}`;
        badge.innerHTML = statusLabel(vResult.status);
        badge.dataset.email = email;
      }
    }
  });
}

// ============ Export ============
exportBtn.addEventListener('click', exportToExcel);

async function exportToExcel() {
  const rowsToExport = [];

  contacts.forEach(contact => {
    const key = getContactKey(contact);
    if (selectedKeys.size > 0 && !selectedKeys.has(key)) return;

    const vResult = validationResults[contact.email?.toLowerCase()] || {};

    rowsToExport.push({
      name: contact.name || '',
      designation: contact.designation || '',
      phone: contact.phone || '',
      email: contact.email || '',
      validation: vResult.status || 'unchecked',
      validationNote: vResult.reason || '',
      domain: contact.domain || '',
      source: contact.source || '',
      linkedinUrl: contact.linkedinUrl || ''
    });
  });

  if (rowsToExport.length === 0) {
    showToast('No rows to export. Select some contacts first.', 'info');
    return;
  }

  exportBtn.disabled = true;
  exportBtn.innerHTML = '<i class="fi fi-rr-spinner fi-spin"></i> Exporting...';

  try {
    const response = await fetch('/api/export', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rows: rowsToExport })
    });

    if (!response.ok) throw new Error('Export failed');

    const blob = await response.blob();
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'MailHarvest_Contacts.xlsx';
    document.body.appendChild(a);
    a.click();
    a.remove();
    window.URL.revokeObjectURL(url);

    showToast(`Exported ${rowsToExport.length} contacts`, 'success');
  } catch (err) {
    showToast('Export failed: ' + err.message, 'error');
  }

  exportBtn.disabled = false;
  updateActionButtons();
}

// ============ New Scrape ============
newScrapeBtn.addEventListener('click', () => {
  inputSection.classList.remove('collapsed');
  progressSection.classList.remove('visible');
  progressSection.classList.remove('completed');
  resultsSection.classList.remove('visible');
  errorSection.classList.remove('visible');
  contacts = [];
  validationResults = {};
  selectedKeys.clear();
  headerCheckbox.checked = false;
  headerCheckbox.indeterminate = false;
  scrapeProgressBar.style.width = '0%';
  validationProgressBar.style.width = '0%';
  validationSection.style.display = 'none';
  const spinner = document.getElementById('scrapeSpinner');
  if (spinner) spinner.style.display = '';
  if (scrapeCompleteActions) scrapeCompleteActions.style.display = 'none';
  // Scroll back to top
  window.scrollTo({ top: 0, behavior: 'smooth' });
});

// ============ Error Helpers ============
function addError(message) {
  errorSection.classList.add('visible');
  const li = document.createElement('li');
  li.textContent = message;
  errorList.appendChild(li);
}

// ============ Jump to Results Button ============
if (jumpToResultsBtn) {
  jumpToResultsBtn.addEventListener('click', () => {
    resultsSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
}
