/* ============================================================
   MailHarvest — Email Validator Page Client Logic
   ============================================================ */

// ============ State ============
let emails = [];
let validationResults = {};
let selectedKeys = new Set();
let elapsedInterval = null;

// ============ DOM Elements ============
const emailInput = document.getElementById('emailInput');
const addEmailBtn = document.getElementById('addEmailBtn');
const bulkToggleBtn = document.getElementById('bulkToggleBtn');
const bulkHint = document.getElementById('bulkHint');
const bulkWrapper = document.getElementById('bulkWrapper');
const bulkTextarea = document.getElementById('bulkTextarea');
const addBulkBtn = document.getElementById('addBulkBtn');
const chipsContainer = document.getElementById('chipsContainer');
const chipsActions = document.getElementById('chipsActions');
const emailCount = document.getElementById('emailCount');
const clearAllBtn = document.getElementById('clearAllBtn');
const startValidateBtn = document.getElementById('startValidateBtn');

const inputSection = document.getElementById('inputSection');
const progressSection = document.getElementById('progressSection');
const phaseLabel = document.getElementById('phaseLabel');
const elapsedTime = document.getElementById('elapsedTime');
const validateProgressBar = document.getElementById('validateProgressBar');
const emailStatusList = document.getElementById('emailStatusList');

const resultsSection = document.getElementById('resultsSection');
const resultsBody = document.getElementById('resultsBody');
const headerCheckbox = document.getElementById('headerCheckbox');

const exportBtn = document.getElementById('exportBtn');
const selectAllBtn = document.getElementById('selectAllBtn');
const copyValidBtn = document.getElementById('copyValidBtn');
const newValidateBtn = document.getElementById('newValidateBtn');

const searchInput = document.getElementById('searchInput');
const statusFilter = document.getElementById('statusFilter');

const toastContainer = document.getElementById('toastContainer');

// ============ Email Validation Regex ============
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

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

// ============ Email Management ============
function addEmail(raw) {
  const email = raw.trim().toLowerCase();
  if (!email) return false;
  if (!EMAIL_REGEX.test(email)) {
    emailInput.classList.add('shake');
    setTimeout(() => emailInput.classList.remove('shake'), 400);
    return false;
  }
  if (emails.includes(email)) {
    showToast(`${email} already added`, 'info');
    return false;
  }
  emails.push(email);
  renderChips();
  return true;
}

function removeEmail(email) {
  emails = emails.filter(e => e !== email);
  renderChips();
}

function clearAllEmails() {
  emails = [];
  renderChips();
}

function renderChips() {
  // Show emails as compact list when there are many, chips when few
  if (emails.length <= 20) {
    chipsContainer.innerHTML = emails.map(e => `
      <div class="chip">
        ${escapeHtml(e)}
        <span class="remove-chip" data-email="${escapeHtml(e)}">&times;</span>
      </div>
    `).join('');
  } else {
    // Compact mode for many emails — show first 15 and a count
    const shown = emails.slice(0, 15);
    const remaining = emails.length - 15;
    chipsContainer.innerHTML = shown.map(e => `
      <div class="chip">
        ${escapeHtml(e)}
        <span class="remove-chip" data-email="${escapeHtml(e)}">&times;</span>
      </div>
    `).join('') + `<div class="chip chip-count">+${remaining} more</div>`;
  }

  if (emails.length > 0) {
    chipsActions.classList.remove('chips-initially-hidden');
  } else {
    chipsActions.classList.add('chips-initially-hidden');
  }
  emailCount.textContent = `${emails.length} email${emails.length !== 1 ? 's' : ''}`;
  startValidateBtn.disabled = emails.length === 0;

  // Attach remove events
  chipsContainer.querySelectorAll('.remove-chip').forEach(btn => {
    btn.addEventListener('click', () => removeEmail(btn.dataset.email));
  });
}

// ============ Input Event Handlers ============
addEmailBtn.addEventListener('click', () => {
  if (addEmail(emailInput.value)) emailInput.value = '';
});

emailInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    if (addEmail(emailInput.value)) emailInput.value = '';
  }
});

// Paste multi-line support on single input
emailInput.addEventListener('paste', (e) => {
  e.preventDefault();
  const text = (e.clipboardData || window.clipboardData).getData('text');
  const lines = text.split(/[\n\r\t,;]+/).map(l => l.trim()).filter(Boolean);
  if (lines.length > 1) {
    let addedCount = 0;
    lines.forEach(line => { if (addEmail(line)) addedCount++; });
    if (addedCount > 0) {
      showToast(`Added ${addedCount} email${addedCount > 1 ? 's' : ''}`, 'success');
      emailInput.value = '';
    }
  } else {
    emailInput.value = text;
  }
});

clearAllBtn.addEventListener('click', clearAllEmails);

// ============ Bulk Paste Toggle ============
let bulkOpen = false;
bulkToggleBtn.addEventListener('click', () => {
  bulkOpen = !bulkOpen;
  if (bulkOpen) {
    bulkWrapper.classList.remove('bulk-initially-hidden');
    bulkHint.classList.remove('bulk-initially-hidden');
  } else {
    bulkWrapper.classList.add('bulk-initially-hidden');
    bulkHint.classList.add('bulk-initially-hidden');
  }
  bulkToggleBtn.innerHTML = bulkOpen
    ? '<i class="fi fi-rr-cross-small"></i> Close Bulk Mode'
    : '<i class="fi fi-rr-list"></i> Bulk Paste Mode';
});

addBulkBtn.addEventListener('click', () => {
  const text = bulkTextarea.value;
  if (!text.trim()) return;
  const lines = text.split(/[\n\r\t,;]+/).map(l => l.trim()).filter(Boolean);
  let addedCount = 0;
  lines.forEach(line => { if (addEmail(line)) addedCount++; });
  if (addedCount > 0) {
    showToast(`Added ${addedCount} email${addedCount > 1 ? 's' : ''}`, 'success');
    bulkTextarea.value = '';
  } else {
    showToast('No new valid emails found', 'info');
  }
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

// ============ Validation Flow ============
startValidateBtn.addEventListener('click', startValidation);

async function startValidation() {
  validationResults = {};
  selectedKeys = new Set();
  headerCheckbox.checked = false;
  headerCheckbox.indeterminate = false;

  // Collapse input, show progress
  inputSection.classList.add('collapsed');
  progressSection.classList.add('visible');
  resultsSection.classList.remove('visible');

  // Init per-email status list
  emailStatusList.innerHTML = emails.map(e => `
    <div class="domain-status-item pending" id="status-${CSS.escape(e)}">
      <span class="status-icon"><i class="fi fi-rr-hourglass-end"></i></span>
      <span class="domain-name">${escapeHtml(e)}</span>
      <span class="domain-detail"></span>
    </div>
  `).join('');

  // Init live dashboard counters
  const totalEmails = emails.length;
  let checked = 0, validCount = 0, catchallCount = 0, riskyCount = 0, invalidCount = 0;

  const progressCheckedEl = document.getElementById('progressCheckedCount');
  const progressValidEl = document.getElementById('progressValidCount');
  const progressCatchallEl = document.getElementById('progressCatchallCount');
  const progressInvalidEl = document.getElementById('progressInvalidCount');

  progressCheckedEl.textContent = `0 / ${totalEmails}`;
  progressValidEl.textContent = '0';
  progressCatchallEl.textContent = '0';
  progressInvalidEl.textContent = '0';

  // Start elapsed timer
  let elapsed = 0;
  elapsedTime.textContent = 'Elapsed: 0s';
  elapsedInterval = setInterval(() => {
    elapsed++;
    const mins = Math.floor(elapsed / 60);
    const secs = elapsed % 60;
    elapsedTime.textContent = `Elapsed: ${mins > 0 ? mins + 'm ' : ''}${secs}s`;
  }, 1000);

  // Extract domains from emails for context
  const emailDomains = [...new Set(emails.map(e => e.split('@')[1]).filter(Boolean))];

  try {
    const response = await fetch('/api/validate-stream', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ emails, scrapedDomains: emailDomains })
    });

    await parseSSEStream(response, (event, data) => {
      if (event === 'progress') {
        checked++;
        validationResults[data.email.toLowerCase()] = data;

        // Update progress bar
        const progress = (checked / totalEmails) * 100;
        validateProgressBar.style.width = `${progress}%`;
        progressCheckedEl.textContent = `${checked} / ${totalEmails}`;

        // Update counts
        if (data.status === 'valid') validCount++;
        else if (data.status === 'catchall') catchallCount++;
        else if (data.status === 'risky') riskyCount++;
        else if (data.status === 'invalid') invalidCount++;

        progressValidEl.textContent = validCount;
        progressCatchallEl.textContent = catchallCount;
        progressInvalidEl.textContent = invalidCount;

        // Update per-email status
        const el = document.getElementById(`status-${CSS.escape(data.email.toLowerCase())}`);
        if (el) {
          if (data.status === 'valid') {
            el.className = 'domain-status-item done';
            el.querySelector('.status-icon').innerHTML = '<i class="fi fi-rr-check-circle"></i>';
            el.querySelector('.domain-detail').textContent = 'Valid';
          } else if (data.status === 'catchall') {
            el.className = 'domain-status-item active';
            el.querySelector('.status-icon').innerHTML = '<i class="fi fi-rr-triangle-warning"></i>';
            el.querySelector('.domain-detail').textContent = 'Catch-all';
          } else if (data.status === 'risky') {
            el.className = 'domain-status-item active';
            el.querySelector('.status-icon').innerHTML = '<i class="fi fi-rr-interrogation"></i>';
            el.querySelector('.domain-detail').textContent = 'Risky';
          } else {
            el.className = 'domain-status-item error';
            el.querySelector('.status-icon').innerHTML = '<i class="fi fi-rr-cross-circle"></i>';
            el.querySelector('.domain-detail').textContent = 'Invalid';
          }
          el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        }

        // Update phase label
        phaseLabel.textContent = `Checking: ${data.email}`;

      } else if (event === 'done') {
        onValidationComplete(validCount, catchallCount, riskyCount, invalidCount);
      }
    });
  } catch (err) {
    showToast('Validation failed: ' + err.message, 'error');
  }

  clearInterval(elapsedInterval);
}

function onValidationComplete(validCount, catchallCount, riskyCount, invalidCount) {
  // Hide progress spinner
  const spinner = document.getElementById('validateSpinner');
  if (spinner) spinner.style.display = 'none';
  phaseLabel.textContent = 'Validation Complete';
  validateProgressBar.style.width = '100%';

  // Show results
  resultsSection.classList.add('visible');

  // Update stats
  const total = validCount + catchallCount + riskyCount + invalidCount;
  document.getElementById('statTotal').textContent = total;
  document.getElementById('statValid').textContent = validCount;
  document.getElementById('statCatchall').textContent = catchallCount;
  document.getElementById('statInvalid').textContent = invalidCount;

  // Show and draw donut chart
  document.getElementById('donutRow').classList.remove('donut-initially-hidden');
  drawDonutChart(validCount, catchallCount, riskyCount, invalidCount);

  // Render table
  renderTable();

  showToast(`Validation complete: ${validCount} valid, ${catchallCount} catch-all, ${riskyCount} risky, ${invalidCount} invalid`, 'success');
}

// ============ Donut Chart ============
function drawDonutChart(valid, catchall, risky, invalid) {
  const donutRow = document.getElementById('donutRow');
  const canvas = document.getElementById('donutChart');
  const legend = document.getElementById('donutLegend');
  const total = valid + catchall + risky + invalid;

  if (total === 0) {
    donutRow.style.display = 'none';
    return;
  }

  donutRow.style.display = 'flex';
  const ctx = canvas.getContext('2d');
  const size = 180;
  const cx = size / 2;
  const cy = size / 2;
  const outerR = 80;
  const innerR = 52;
  const gap = 0.03; // small gap between segments

  ctx.clearRect(0, 0, size, size);

  const segments = [
    { value: valid, color: '#28A745', label: 'Valid' },
    { value: catchall, color: '#FFC107', label: 'Catch-all' },
    { value: risky, color: '#FF8C00', label: 'Risky' },
    { value: invalid, color: '#DC3545', label: 'Invalid' }
  ].filter(s => s.value > 0);

  let startAngle = -Math.PI / 2;

  segments.forEach(seg => {
    const sliceAngle = (seg.value / total) * 2 * Math.PI;
    const endAngle = startAngle + sliceAngle - gap;

    ctx.beginPath();
    ctx.arc(cx, cy, outerR, startAngle, endAngle);
    ctx.arc(cx, cy, innerR, endAngle, startAngle, true);
    ctx.closePath();
    ctx.fillStyle = seg.color;
    ctx.fill();

    startAngle += sliceAngle;
  });

  // Center text
  ctx.fillStyle = '#e8e8f0';
  ctx.font = 'bold 24px Inter, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(total, cx, cy - 8);
  ctx.font = '12px Inter, sans-serif';
  ctx.fillStyle = '#a0a0c0';
  ctx.fillText('Total', cx, cy + 12);

  // Legend
  legend.innerHTML = segments.map(s => {
    const pct = ((s.value / total) * 100).toFixed(1);
    return `<div class="donut-legend-item">
      <span class="donut-legend-dot" style="background:${s.color}"></span>
      <span>${s.label}: <strong>${s.value}</strong> (${pct}%)</span>
    </div>`;
  }).join('');
}

// ============ Table Rendering ============
function renderTable() {
  resultsBody.innerHTML = '';

  emails.forEach((email, idx) => {
    const vResult = validationResults[email] || null;
    if (!vResult) return; // skip if somehow not validated

    const status = vResult.status || 'unchecked';
    const isSelected = selectedKeys.has(email);

    const tr = document.createElement('tr');
    tr.dataset.email = email;
    tr.dataset.status = status;

    const suggestionsHtml = (vResult.suggestions && vResult.suggestions.length > 0)
      ? vResult.suggestions.map(s => {
          if (s.correctedEmail) {
            return `<span class="suggestion-email">${escapeHtml(s.correctedEmail)}</span>`;
          }
          return `<span>${escapeHtml(s.message || '')}</span>`;
        }).join(', ')
      : '—';

    tr.innerHTML = `
      <td><input type="checkbox" class="row-checkbox" ${isSelected ? 'checked' : ''} data-email="${escapeHtml(email)}"></td>
      <td>${idx + 1}</td>
      <td>${escapeHtml(email)}</td>
      <td><span class="status-badge ${status}">${statusLabel(status)}</span></td>
      <td class="reason-cell">${escapeHtml(vResult.reason || '—')}</td>
      <td>${suggestionsHtml}</td>
    `;

    resultsBody.appendChild(tr);
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

// ============ Selection ============
resultsBody.addEventListener('change', (e) => {
  if (e.target.classList.contains('row-checkbox')) {
    const email = e.target.dataset.email;
    if (e.target.checked) {
      selectedKeys.add(email);
    } else {
      selectedKeys.delete(email);
    }
    updateHeaderCheckbox();
  }
});

headerCheckbox.addEventListener('change', () => {
  if (headerCheckbox.checked) {
    const visibleRows = resultsBody.querySelectorAll('tr:not(.hidden)');
    visibleRows.forEach(row => {
      const email = row.dataset.email;
      if (email) {
        selectedKeys.add(email);
        const cb = row.querySelector('.row-checkbox');
        if (cb) cb.checked = true;
      }
    });
  } else {
    selectedKeys.clear();
    resultsBody.querySelectorAll('.row-checkbox').forEach(cb => cb.checked = false);
  }
});

selectAllBtn.addEventListener('click', () => {
  const validatedEmails = emails.filter(e => validationResults[e]);
  if (selectedKeys.size === validatedEmails.length) {
    // Deselect all
    selectedKeys.clear();
    resultsBody.querySelectorAll('.row-checkbox').forEach(cb => cb.checked = false);
    headerCheckbox.checked = false;
    headerCheckbox.indeterminate = false;
    selectAllBtn.innerHTML = '<i class="fi fi-rr-checkbox"></i> Select All';
  } else {
    // Select all
    validatedEmails.forEach(e => selectedKeys.add(e));
    resultsBody.querySelectorAll('.row-checkbox').forEach(cb => cb.checked = true);
    headerCheckbox.checked = true;
    headerCheckbox.indeterminate = false;
    selectAllBtn.innerHTML = '<i class="fi fi-rr-square"></i> Deselect All';
  }
});

function updateHeaderCheckbox() {
  const totalVisible = resultsBody.querySelectorAll('tr:not(.hidden)').length;
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
}

// Ctrl+A keyboard shortcut
document.addEventListener('keydown', (e) => {
  if (e.ctrlKey && e.key === 'a' && resultsSection.classList.contains('visible')) {
    if (document.activeElement.tagName !== 'INPUT' && document.activeElement.tagName !== 'TEXTAREA') {
      e.preventDefault();
      selectAllBtn.click();
    }
  }
});

// ============ Filtering ============
searchInput.addEventListener('input', applyFilters);
statusFilter.addEventListener('change', applyFilters);

function applyFilters() {
  const search = searchInput.value.toLowerCase().trim();
  const statusVal = statusFilter.value;

  const rows = resultsBody.querySelectorAll('tr');
  rows.forEach(row => {
    const email = row.dataset.email || '';
    const status = row.dataset.status || '';

    let show = true;

    if (search && !email.includes(search)) show = false;
    if (statusVal && status !== statusVal) show = false;

    row.classList.toggle('hidden', !show);
  });
}

// ============ Copy Valid Emails ============
copyValidBtn.addEventListener('click', () => {
  const validEmails = emails.filter(e => {
    const r = validationResults[e];
    return r && r.status === 'valid';
  });

  if (validEmails.length === 0) {
    showToast('No valid emails to copy', 'info');
    return;
  }

  navigator.clipboard.writeText(validEmails.join('\n')).then(() => {
    showToast(`Copied ${validEmails.length} valid email${validEmails.length > 1 ? 's' : ''} to clipboard`, 'success');
  }).catch(() => {
    showToast('Failed to copy to clipboard', 'error');
  });
});

// ============ Export ============
exportBtn.addEventListener('click', exportToExcel);

async function exportToExcel() {
  const rowsToExport = [];

  emails.forEach((email, idx) => {
    const vResult = validationResults[email];
    if (!vResult) return;

    // If there are selections, only export selected
    if (selectedKeys.size > 0 && !selectedKeys.has(email)) return;

    rowsToExport.push({
      name: '',
      designation: '',
      phone: '',
      email: email,
      validation: vResult.status || 'unchecked',
      validationNote: vResult.reason || '',
      domain: email.split('@')[1] || '',
      source: '',
      linkedinUrl: ''
    });
  });

  if (rowsToExport.length === 0) {
    showToast('No rows to export. Select some emails first.', 'info');
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
    a.download = 'MailHarvest_Validation.xlsx';
    document.body.appendChild(a);
    a.click();
    a.remove();
    window.URL.revokeObjectURL(url);

    showToast(`Exported ${rowsToExport.length} emails`, 'success');
  } catch (err) {
    showToast('Export failed: ' + err.message, 'error');
  }

  exportBtn.disabled = false;
  exportBtn.innerHTML = '<i class="fi fi-rr-download"></i> Export to Excel';
}

// ============ New Validation ============
newValidateBtn.addEventListener('click', () => {
  inputSection.classList.remove('collapsed');
  progressSection.classList.remove('visible');
  resultsSection.classList.remove('visible');
  validationResults = {};
  selectedKeys.clear();
  headerCheckbox.checked = false;
  headerCheckbox.indeterminate = false;
  validateProgressBar.style.width = '0%';
  const spinner = document.getElementById('validateSpinner');
  if (spinner) spinner.style.display = '';
  document.getElementById('donutRow').classList.add('donut-initially-hidden');
});
