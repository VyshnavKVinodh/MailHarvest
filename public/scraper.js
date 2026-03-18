/* ═══════════════════════════════════════════════════════════════════
   MAILHARVEST — Scraper Page Logic (scraper.js)
   SSE scraping + email validation + export
   ═══════════════════════════════════════════════════════════════════ */
(function () {
    'use strict';

    const state = {
        domains: [],
        contacts: [],           // { email, name, designation, phone, linkedinUrl, domain, source }
        filteredContacts: [],
        selectedKeys: new Set(),  // composite key: email or 'phone:<phone>'
        validationResults: {},   // email → { status, reason, suggestions }
        isLoading: false,
        isValidating: false,
    };

    const $ = (s) => document.querySelector(s);
    const domainInput = $('#domainInput');
    const addDomainBtn = $('#addDomainBtn');
    const domainChips = $('#domainChips');
    const scrapeBtn = $('#scrapeBtn');
    const progressSection = $('#progressSection');
    const progressText = $('#progressText');
    const progressBar = $('#progressBar');
    const progressStats = $('#progressStats');
    const domainProgressList = $('#domainProgressList');
    const resultsSection = $('#resultsSection');
    const resultCount = $('#resultCount');
    const selectAllBtn = $('#selectAllBtn');
    const deselectAllBtn = $('#deselectAllBtn');
    const validateBtn = $('#validateBtn');
    const exportBtn = $('#exportBtn');
    const selectedCount = $('#selectedCount');
    const statsGrid = $('#statsGrid');
    const filterInput = $('#filterInput');
    const domainFilter = $('#domainFilter');
    const statusFilter = $('#statusFilter');
    const resultsBody = $('#resultsBody');
    const headerCheckbox = $('#headerCheckbox');
    const noResults = $('#noResults');
    const errorSection = $('#errorSection');
    const errorList = $('#errorList');
    const validationProgress = $('#validationProgress');
    const validationText = $('#validationText');
    const validationBar = $('#validationBar');
    const validationSummary = $('#validationSummary');
    const validationPanel = $('#validationPanel');
    const limitToggle = $('#limitToggle');
    const limitSelect = $('#limitSelect');
    const limitSelectWrapper = $('#limitSelectWrapper');
    const domainMeta = $('#domainMeta');
    const domainCountEl = $('#domainCount');
    const clearAllBtn = $('#clearAllBtn');
    const elapsedTimeEl = $('#elapsedTime');
    const inputSection = $('#inputSection');
    const crawlModeSelector = $('#crawlModeSelector');
    const crawlModeHint = $('#crawlModeHint');

    let currentCrawlMode = 'quick';

    // Helper: composite key for a contact (email takes priority, else phone)
    function contactKey(c) {
        return c.email || ('phone:' + (c.phone || ''));
    }

    // ── Domain management ─────────────────────────────────────────
    function addDomain(rawValue) {
        const value = (rawValue || domainInput.value).trim().replace(/^https?:\/\//, '').replace(/\/+$/, '');
        if (!value) return false;
        if (state.domains.includes(value)) { if (!rawValue) shake(domainInput); return false; }
        if (!/^[a-zA-Z0-9][a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}$/.test(value)) { if (!rawValue) shake(domainInput); return false; }
        state.domains.push(value);
        if (!rawValue) domainInput.value = '';
        return true;
    }

    // Handle pasting multiple domains (e.g. from an Excel column)
    domainInput.addEventListener('paste', (e) => {
        const pastedText = (e.clipboardData || window.clipboardData).getData('text');
        // Split by newlines, carriage returns, or tabs (Excel column/row separators)
        const lines = pastedText.split(/[\r\n\t]+/).map(s => s.trim()).filter(s => s.length > 0);
        if (lines.length > 1) {
            e.preventDefault();
            let addedCount = 0;
            lines.forEach(line => {
                if (addDomain(line)) addedCount++;
            });
            domainInput.value = '';
            renderChips();
            updateScrapeBtn();
            domainInput.focus();
        }
        // If only one value pasted, let default behavior handle it
    });

    function removeDomain(d) {
        state.domains = state.domains.filter(x => x !== d);
        renderChips();
        updateScrapeBtn();
    }

    function renderChips() {
        domainChips.innerHTML = state.domains.map(d => `
      <span class="chip"><span>${d}</span><button class="chip-remove" data-d="${d}">&times;</button></span>
    `).join('');
        domainChips.querySelectorAll('.chip-remove').forEach(b => b.addEventListener('click', () => removeDomain(b.dataset.d)));
        // Update domain count and show/hide meta
        const count = state.domains.length;
        if (count > 0) {
            domainMeta.classList.remove('hidden');
            domainCountEl.textContent = `${count} domain${count !== 1 ? 's' : ''} added`;
        } else {
            domainMeta.classList.add('hidden');
        }
    }

    function updateScrapeBtn() { scrapeBtn.disabled = state.domains.length === 0 || state.isLoading; }

    function clearAllDomains() {
        state.domains = [];
        renderChips();
        updateScrapeBtn();
        domainInput.focus();
    }

    function shake(el) {
        el.style.animation = 'none'; el.offsetHeight;
        el.style.animation = 'shake 0.4s ease';
        setTimeout(() => el.style.animation = '', 400);
    }

    // ── SSE via Fetch (supports POST — works on Vercel) ─────────
    function parseSSEStream(reader, handlers) {
        const decoder = new TextDecoder();
        let buffer = '';
        function processBuffer() {
            const parts = buffer.split('\n\n');
            buffer = parts.pop(); // keep incomplete chunk
            for (const part of parts) {
                if (!part.trim()) continue;
                let event = 'message', data = '';
                for (const line of part.split('\n')) {
                    if (line.startsWith('event: ')) event = line.slice(7);
                    else if (line.startsWith('data: ')) data = line.slice(6);
                }
                if (data && handlers[event]) {
                    try { handlers[event](JSON.parse(data)); } catch { }
                }
            }
        }
        return reader.read().then(function pump({ done, value }) {
            if (done) { processBuffer(); return; }
            buffer += decoder.decode(value, { stream: true });
            processBuffer();
            return reader.read().then(pump);
        });
    }

    // ── SSE Scraping ──────────────────────────────────────────────
    async function startScraping() {
        if (state.domains.length === 0 || state.isLoading) return;
        state.isLoading = true;
        state.contacts = [];
        state.selectedKeys.clear();
        state.validationResults = {};
        updateScrapeBtn();

        progressSection.classList.remove('hidden');
        resultsSection.classList.add('hidden');
        errorSection.classList.add('hidden');
        validationSummary.classList.add('hidden');

        const totalDomains = state.domains.length;
        let completedDomains = 0;
        const errors = [];
        const domainStatus = {};
        const domainInfo = {};
        state.domains.forEach(d => { domainStatus[d] = 'pending'; });
        renderDomainProgress(domainStatus, domainInfo);
        progressText.textContent = `Scraping ${totalDomains} domain${totalDomains > 1 ? 's' : ''}...`;
        progressBar.style.width = '2%';

        // Collapse input and start elapsed timer
        inputSection.classList.add('collapsed');
        let elapsedSeconds = 0;
        const elapsedTimer = setInterval(() => {
            elapsedSeconds++;
            const mins = Math.floor(elapsedSeconds / 60);
            const secs = elapsedSeconds % 60;
            elapsedTimeEl.textContent = mins > 0 ? `Elapsed: ${mins}m ${secs}s` : `Elapsed: ${secs}s`;
        }, 1000);

        function cleanup() {
            state.isLoading = false;
            updateScrapeBtn();
            inputSection.classList.remove('collapsed');
            clearInterval(elapsedTimer);
        }

        try {
            const response = await fetch('/api/scrape-stream', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    domains: state.domains,
                    maxContacts: limitToggle.checked ? parseInt(limitSelect.value) : 0,
                    crawlMode: currentCrawlMode,
                }),
            });
            if (!response.ok) throw new Error('Server error: ' + response.status);

            const reader = response.body.getReader();
            await parseSSEStream(reader, {
                'domain-start': (data) => {
                    domainStatus[data.domain] = 'active';
                    domainInfo[data.domain] = { pages: 0, contacts: 0 };
                    renderDomainProgress(domainStatus, domainInfo);
                    progressText.textContent = `Scraping ${data.domain}...`;
                },
                'domain-progress': (data) => {
                    domainInfo[data.domain] = { pages: data.pagesScraped, contacts: data.contactsFound };
                    renderDomainProgress(domainStatus, domainInfo);
                    let pg = 0, ct = 0;
                    Object.values(domainInfo).forEach(v => { pg += v.pages; ct += v.contacts; });
                    const phaseLabel = data.phase === 1 ? '⚡ Priority' : '🌐 Full Site';
                    const queueInfo = data.queueSize > 0 ? ` · Queue: ${data.queueSize}` : '';
                    progressStats.innerHTML = `
                    <span>Phase: <span class="stat-value">${phaseLabel}</span></span>
                    <span>Domains: <span class="stat-value">${completedDomains}/${totalDomains}</span></span>
                    <span>Pages: <span class="stat-value">${pg}</span></span>
                    <span>Contacts: <span class="stat-value">${ct}</span>${queueInfo}</span>`;
                },
                'domain-done': (data) => {
                    completedDomains++;
                    domainStatus[data.domain] = data.error ? 'error' : 'done';
                    if (data.error) errors.push(data.error);
                    domainInfo[data.domain] = { pages: data.pagesScraped, contacts: data.contactsFound };
                    renderDomainProgress(domainStatus, domainInfo);
                    progressBar.style.width = Math.round((completedDomains / totalDomains) * 100) + '%';
                    progressText.textContent = `Scraped ${completedDomains} of ${totalDomains} domains...`;
                },
                'done': (data) => {
                    state.contacts = data.contacts || [];
                    state.filteredContacts = [...state.contacts];
                    if (errors.length > 0) {
                        errorSection.classList.remove('hidden');
                        errorList.innerHTML = errors.map(er => `<li>${esc(er)}</li>`).join('');
                    }
                    renderStats(data);
                    renderDomainFilterOptions();
                    state.contacts.forEach(c => state.selectedKeys.add(contactKey(c)));
                    renderTable();
                    progressSection.classList.add('hidden');
                    resultsSection.classList.remove('hidden');
                    resultsSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
                    cleanup();
                    showToast(`✓ Found ${state.contacts.length} contact${state.contacts.length !== 1 ? 's' : ''} from ${totalDomains} domain${totalDomains !== 1 ? 's' : ''}`);
                },
            });
        } catch (err) {
            cleanup();
            progressSection.classList.add('hidden');
            errorSection.classList.remove('hidden');
            errorList.innerHTML = `<li>Failed to start scraping: ${esc(err.message)}</li>`;
        }
    }

    // ── Domain Progress ───────────────────────────────────────────
    function renderDomainProgress(statuses, info) {
        const icons = {
            pending: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/></svg>',
            active: '<div class="spinner" style="width:16px;height:16px;border-width:2px"></div>',
            done: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M20 6 9 17l-5-5"/></svg>',
            error: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>',
        };
        domainProgressList.innerHTML = Object.entries(statuses).map(([domain, status]) => {
            const di = info[domain] || { pages: 0, contacts: 0 };
            let st = status === 'pending' ? 'Waiting...' : status === 'active' ? `${di.pages} pgs · ${di.contacts} contacts` : status === 'done' ? `${di.pages} pgs · ${di.contacts} contacts ✓` : 'Failed';
            return `<div class="domain-progress-item"><div class="dp-icon ${status}">${icons[status]}</div><span class="dp-domain">${esc(domain)}</span><span class="dp-status">${st}</span></div>`;
        }).join('');
    }

    // ── Stats ─────────────────────────────────────────────────────
    function renderStats(data) {
        const t = state.contacts.length;
        const wn = state.contacts.filter(c => c.name).length;
        const wd = state.contacts.filter(c => c.designation).length;
        const wp = state.contacts.filter(c => c.phone).length;
        resultCount.textContent = `${t} contact${t !== 1 ? 's' : ''}`;
        statsGrid.innerHTML = `
      <div class="stat-card violet"><div class="stat-label">Total Contacts</div><div class="stat-number">${t}</div></div>
      <div class="stat-card teal"><div class="stat-label">With Names</div><div class="stat-number">${wn}</div></div>
      <div class="stat-card amber"><div class="stat-label">With Designations</div><div class="stat-number">${wd}</div></div>
      <div class="stat-card green"><div class="stat-label">With Phone</div><div class="stat-number">${wp}</div></div>
      <div class="stat-card blue"><div class="stat-label">Pages Scraped</div><div class="stat-number">${data.totalPages || 0}</div></div>`;
    }

    function renderDomainFilterOptions() {
        const domains = [...new Set(state.contacts.map(c => c.domain))];
        domainFilter.innerHTML = '<option value="">All Domains</option>' + domains.map(d => `<option value="${d}">${d}</option>`).join('');
    }

    // ── Table ─────────────────────────────────────────────────────
    function renderTable() {
        applyFilters();
        if (state.filteredContacts.length === 0) {
            resultsBody.innerHTML = '';
            noResults.classList.remove('hidden');
            document.querySelector('.table-wrapper').classList.add('hidden');
            return;
        }
        noResults.classList.add('hidden');
        document.querySelector('.table-wrapper').classList.remove('hidden');

        resultsBody.innerHTML = state.filteredContacts.map((c, i) => {
            const key = contactKey(c);
            const sel = state.selectedKeys.has(key);
            const vr = c.email ? state.validationResults[c.email] : null;
            const statusBadge = c.email ? getStatusBadge(vr) : '<span style="color:var(--text-muted)">—</span>';
            const linkedinCell = c.linkedinUrl
                ? `<a href="${escA(c.linkedinUrl)}" target="_blank" rel="noopener" title="Find ${escA(c.name)} on LinkedIn" class="linkedin-link">🔗 LinkedIn</a>`
                : '<span style="color:var(--text-muted)">—</span>';
            return `
        <tr class="${sel ? 'selected' : ''}" data-key="${escA(key)}" style="animation:rowIn .3s ease-out ${Math.min(i * 0.015, 0.8)}s both">
          <td class="th-check"><label class="checkbox-wrapper"><input type="checkbox" ${sel ? 'checked' : ''} data-key="${escA(key)}"><span class="checkmark"></span></label></td>
          <td>${i + 1}</td>
          <td class="name-cell" title="${escA(c.name)}">${esc(c.name) || '<span style="color:var(--text-muted)">—</span>'}</td>
          <td class="designation-cell" title="${escA(c.designation)}">${esc(c.designation) || '<span style="color:var(--text-muted)">—</span>'}</td>
          <td class="phone-cell">${c.phone ? esc(c.phone) : '<span style="color:var(--text-muted)">—</span>'}</td>
          <td class="email-cell">${c.email ? esc(c.email) : '<span style="color:var(--text-muted)">—</span>'}</td>
          <td class="status-cell">${statusBadge}</td>
          <td>${esc(c.domain)}</td>
          <td class="source-cell"><a href="${escA(c.source || '')}" target="_blank" rel="noopener" title="${escA(c.source || '')}">${esc(getSourcePath(c.source))}</a></td>
          <td class="linkedin-cell">${linkedinCell}</td>
        </tr>`;
        }).join('');

        resultsBody.querySelectorAll('input[type="checkbox"]').forEach(cb => {
            cb.addEventListener('change', () => toggleRow(cb.dataset.key, cb.checked));
        });
        resultsBody.querySelectorAll('tr').forEach(row => {
            row.addEventListener('click', (e) => {
                if (e.target.tagName === 'A' || e.target.tagName === 'INPUT' || e.target.closest('label')) return;
                // If clicking the status badge, show validation details
                if (e.target.closest('.status-badge')) {
                    const key = row.dataset.key;
                    // Only show validation panel for email-based contacts
                    if (!key.startsWith('phone:')) showValidationPanel(key);
                    return;
                }
                const cb = row.querySelector('input[type="checkbox"]');
                cb.checked = !cb.checked;
                toggleRow(row.dataset.key, cb.checked);
            });
        });
        updateSelectionUI();
    }

    function getStatusBadge(vr) {
        if (!vr) return '<span class="status-badge unchecked" title="Click Validate Emails to check">○ Unchecked</span>';
        if (vr.status === 'valid') return '<span class="status-badge valid" title="' + escA(vr.reason) + '">✓ Valid</span>';
        if (vr.status === 'catchall') return '<span class="status-badge catchall" title="' + escA(vr.reason) + '">⚠ Catch-All</span>';
        return '<span class="status-badge invalid" title="Click for details">✗ Invalid</span>';
    }

    function applyFilters() {
        const search = filterInput.value.toLowerCase().trim();
        const dom = domainFilter.value;
        const st = statusFilter.value;
        state.filteredContacts = state.contacts.filter(c => {
            const md = !dom || c.domain === dom;
            const ms = !search || (c.email && c.email.toLowerCase().includes(search)) || (c.name && c.name.toLowerCase().includes(search)) || (c.designation && c.designation.toLowerCase().includes(search)) || c.domain.toLowerCase().includes(search) || (c.phone && c.phone.includes(search));
            let mst = true;
            if (st === 'has-name') mst = !!c.name;
            else if (st === 'has-designation') mst = !!c.designation;
            else if (st === 'has-phone') mst = !!c.phone;
            else if (st) {
                const vr = c.email ? state.validationResults[c.email] : null;
                if (st === 'unchecked') mst = !vr;
                else mst = vr && vr.status === st;
            }
            return md && ms && mst;
        });
    }

    // ── Selection ─────────────────────────────────────────────────
    function toggleRow(key, checked) {
        if (checked) state.selectedKeys.add(key); else state.selectedKeys.delete(key);
        const row = resultsBody.querySelector(`tr[data-key="${CSS.escape(key)}"]`);
        if (row) row.classList.toggle('selected', checked);
        updateSelectionUI();
    }

    function selectAll() {
        state.filteredContacts.forEach(c => state.selectedKeys.add(contactKey(c)));
        resultsBody.querySelectorAll('input[type="checkbox"]').forEach(cb => cb.checked = true);
        resultsBody.querySelectorAll('tr').forEach(r => r.classList.add('selected'));
        updateSelectionUI();
    }

    function deselectAll() {
        state.filteredContacts.forEach(c => state.selectedKeys.delete(contactKey(c)));
        resultsBody.querySelectorAll('input[type="checkbox"]').forEach(cb => cb.checked = false);
        resultsBody.querySelectorAll('tr').forEach(r => r.classList.remove('selected'));
        updateSelectionUI();
    }

    function updateSelectionUI() {
        const count = state.selectedKeys.size;
        selectedCount.textContent = `(${count})`;
        exportBtn.disabled = count === 0;
        const tv = state.filteredContacts.length;
        const sv = state.filteredContacts.filter(c => state.selectedKeys.has(contactKey(c))).length;
        headerCheckbox.checked = tv > 0 && sv === tv;
        headerCheckbox.indeterminate = sv > 0 && sv < tv;
    }

    // ── Validation (SSE via Fetch) ────────────────────────────────
    async function startValidation() {
        if (state.isValidating || state.contacts.length === 0) return;
        state.isValidating = true;
        validateBtn.disabled = true;
        validateBtn.innerHTML = '<div class="spinner" style="width:18px;height:18px;border-width:2px"></div> Validating...';

        validationProgress.classList.remove('hidden');
        validationSummary.classList.add('hidden');
        validationBar.style.width = '0%';

        // Only validate contacts that have an email
        const emails = state.contacts.filter(c => c.email).map(c => c.email);

        function resetBtn(label) {
            state.isValidating = false;
            validateBtn.disabled = false;
            validateBtn.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="m9 12 2 2 4-4"/></svg> ' + label;
        }

        try {
            const response = await fetch('/api/validate-stream', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ emails }),
            });
            if (!response.ok) throw new Error('Server error: ' + response.status);

            const reader = response.body.getReader();
            await parseSSEStream(reader, {
                'progress': (data) => {
                    state.validationResults[data.result.email] = data.result;
                    const pct = Math.round((data.completed / data.total) * 100);
                    validationBar.style.width = pct + '%';
                    validationText.textContent = `Checking ${data.current} (${data.completed}/${data.total})`;
                    updateRowStatus(data.result.email);
                },
                'done': () => {
                    validationProgress.classList.add('hidden');
                    showValidationSummary();
                    renderTable();
                    resetBtn('Re-Validate');
                },
            });
        } catch (err) {
            validationProgress.classList.add('hidden');
            if (Object.keys(state.validationResults).length > 0) {
                showValidationSummary();
                renderTable();
            }
            resetBtn('Validate Emails');
        }
    }

    function updateRowStatus(email) {
        // Find row by email — need to look through all rows
        const rows = resultsBody.querySelectorAll('tr');
        rows.forEach(row => {
            const key = row.dataset.key;
            if (key === email) {
                const vr = state.validationResults[email];
                const cell = row.querySelector('.status-cell');
                if (cell) cell.innerHTML = getStatusBadge(vr);
            }
        });
    }

    function showValidationSummary() {
        const results = Object.values(state.validationResults);
        const valid = results.filter(r => r.status === 'valid').length;
        const catchall = results.filter(r => r.status === 'catchall').length;
        const invalid = results.filter(r => r.status === 'invalid').length;
        $('#vsValid').textContent = valid;
        $('#vsCatchall').textContent = catchall;
        $('#vsInvalid').textContent = invalid;
        validationSummary.classList.remove('hidden');
    }

    // ── Validation Detail Panel ───────────────────────────────────
    function showValidationPanel(email) {
        const vr = state.validationResults[email];
        if (!vr) return;
        const contact = state.contacts.find(c => c.email === email);

        $('#vpEmail').textContent = email;
        const statusClass = vr.status === 'valid' ? 'valid' : vr.status === 'catchall' ? 'catchall' : 'invalid';
        $('#vpStatus').innerHTML = `<span class="status-badge ${statusClass}" style="font-size:0.9rem;padding:0.35rem 0.85rem">${getStatusLabel(vr.status)}</span>`;
        $('#vpReason').textContent = vr.reason;

        let sugHtml = '';
        if (vr.suggestions && vr.suggestions.length > 0) {
            sugHtml = '<h4>💡 Suggestions</h4><ul class="suggestion-list">';
            vr.suggestions.forEach(s => {
                sugHtml += `<li class="suggestion-item">
          <span class="sug-tag sug-${s.type}">${s.type}</span>
          <span>${esc(s.message)}</span>
          ${s.corrected ? `<span class="sug-corrected">→ <strong>${esc(s.corrected)}</strong></span>` : ''}
          ${s.type === 'rescrape' && contact ? `<button class="btn btn-ghost btn-sm sug-rescrape" data-domain="${escA(contact.domain)}">Re-scrape ${esc(contact.domain)}</button>` : ''}
        </li>`;
            });
            sugHtml += '</ul>';
        }
        $('#vpSuggestions').innerHTML = sugHtml;

        // Attach re-scrape handlers
        validationPanel.querySelectorAll('.sug-rescrape').forEach(btn => {
            btn.addEventListener('click', () => {
                const d = btn.dataset.domain;
                if (!state.domains.includes(d)) state.domains.push(d);
                renderChips();
                updateScrapeBtn();
                validationPanel.classList.add('hidden');
                document.getElementById('inputSection').scrollIntoView({ behavior: 'smooth' });
            });
        });

        validationPanel.classList.remove('hidden');
        validationPanel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }

    function getStatusLabel(s) {
        if (s === 'valid') return '✓ Valid';
        if (s === 'catchall') return '⚠ Catch-All';
        return '✗ Invalid';
    }

    // ── Export ────────────────────────────────────────────────────
    async function exportToExcel() {
        if (state.selectedKeys.size === 0) return;
        const selectedRows = state.contacts.filter(c => state.selectedKeys.has(contactKey(c))).map(c => ({
            ...c,
            validationStatus: c.email ? (state.validationResults[c.email]?.status || 'unchecked') : '',
            validationReason: c.email ? (state.validationResults[c.email]?.reason || '') : '',
        }));
        exportBtn.disabled = true;
        const orig = exportBtn.innerHTML;
        exportBtn.innerHTML = '<div class="spinner" style="width:18px;height:18px;border-width:2px"></div> Generating...';
        try {
            const res = await fetch('/api/export', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ rows: selectedRows }),
            });
            if (!res.ok) throw new Error('Export failed');
            const blob = await res.blob();
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `mailharvest_${new Date().toISOString().slice(0, 10)}.xlsx`;
            document.body.appendChild(a); a.click(); document.body.removeChild(a);
            URL.revokeObjectURL(url);
        } catch (err) { alert('Export failed: ' + err.message); }
        finally { exportBtn.disabled = false; exportBtn.innerHTML = orig; }
    }

    // ── Helpers ───────────────────────────────────────────────────
    function esc(s) { if (!s) return ''; const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }
    function escA(s) { if (!s) return ''; return s.replace(/"/g, '&quot;').replace(/'/g, '&#39;'); }
    function getSourcePath(url) {
        if (!url) return '—';
        try { return new URL(url).pathname || '/'; } catch { return url; }
    }
    function showToast(msg) {
        const toast = document.createElement('div');
        toast.className = 'toast';
        toast.textContent = msg;
        document.body.appendChild(toast);
        requestAnimationFrame(() => toast.classList.add('show'));
        setTimeout(() => { toast.classList.remove('show'); setTimeout(() => toast.remove(), 400); }, 4000);
    }

    // ── Events ────────────────────────────────────────────────────
    function addDomainFromInput() {
        if (addDomain()) { domainInput.value = ''; renderChips(); updateScrapeBtn(); domainInput.focus(); }
    }
    addDomainBtn.addEventListener('click', addDomainFromInput);
    domainInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); addDomainFromInput(); } });
    scrapeBtn.addEventListener('click', startScraping);
    clearAllBtn.addEventListener('click', clearAllDomains);
    selectAllBtn.addEventListener('click', selectAll);
    deselectAllBtn.addEventListener('click', deselectAll);
    validateBtn.addEventListener('click', startValidation);
    exportBtn.addEventListener('click', exportToExcel);
    headerCheckbox.addEventListener('change', () => { headerCheckbox.checked ? selectAll() : deselectAll(); });
    filterInput.addEventListener('input', () => renderTable());
    domainFilter.addEventListener('change', () => renderTable());
    statusFilter.addEventListener('change', () => renderTable());
    $('#vpClose').addEventListener('click', () => validationPanel.classList.add('hidden'));

    // Contact limit toggle
    limitToggle.addEventListener('change', () => {
        if (limitToggle.checked) {
            limitSelectWrapper.classList.remove('hidden');
        } else {
            limitSelectWrapper.classList.add('hidden');
        }
    });

    // Crawl mode selector
    crawlModeSelector.querySelectorAll('.crawl-mode-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            crawlModeSelector.querySelectorAll('.crawl-mode-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            currentCrawlMode = btn.dataset.mode;
            crawlModeHint.textContent = currentCrawlMode === 'deep' ? '200 pages · thorough' : '30 priority pages';
        });
    });

    document.addEventListener('keydown', (e) => {
        if (e.ctrlKey && e.key === 'a' && !resultsSection.classList.contains('hidden')) {
            const t = document.activeElement.tagName;
            if (t !== 'INPUT' && t !== 'TEXTAREA') { e.preventDefault(); selectAll(); }
        }
    });

    const style = document.createElement('style');
    style.textContent = `@keyframes shake{0%,100%{transform:translateX(0)}25%{transform:translateX(-6px)}50%{transform:translateX(6px)}75%{transform:translateX(-3px)}}`;
    document.head.appendChild(style);
})();
