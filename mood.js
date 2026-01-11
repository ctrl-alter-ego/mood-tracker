(() => {
  'use strict';

  const STORAGE_KEY = 'moodTracker.v1';
  const SHADOW_KEY = 'moodTracker.v1.shadow';
  const SHADOW2_KEY = 'moodTracker.v1.shadow2';

  const METRICS = [
    { key: 'overall', label: 'Overall' },
    { key: 'physical', label: 'Physical health' },
    { key: 'mental', label: 'Mental health' },
    { key: 'sleep', label: 'Sleep quality' },
    { key: 'exercise', label: 'Exercise level' },
    { key: 'food', label: 'Food/drink quality' },
  ];

  const DEFAULT_STORE = {
    version: 1,
    createdAt: null,
    updatedAt: null,
    entries: {},
    ui: {
      metric: 'overall',
      range: 'week',
    },
  };

  const els = {
    todayLabel: document.getElementById('today-label'),
    todayStatus: document.getElementById('today-status'),
    todayRow: document.getElementById('today-row'),
    todayComment: document.getElementById('today-comment'),
    saveToday: document.getElementById('save-today'),
    fillYesterday: document.getElementById('fill-yesterday'),
    insights: document.getElementById('insights'),

    chart: document.getElementById('trend-chart'),
    chartTooltip: document.getElementById('chart-tooltip'),
    trendSummary: document.getElementById('trend-summary'),
    metricSelect: document.getElementById('metric-select'),
    segmentedBtns: Array.from(document.querySelectorAll('.segmented__btn')),

    historyDetails: document.getElementById('history-details'),
    editDate: document.getElementById('edit-date'),
    loadEditDate: document.getElementById('load-edit-date'),
    saveEditDate: document.getElementById('save-edit-date'),
    editRow: document.getElementById('edit-row'),
    editComment: document.getElementById('edit-comment'),
    recentTbody: document.getElementById('recent-tbody'),
    showMore: document.getElementById('show-more'),

    exportJson: document.getElementById('export-json'),
    importJson: document.getElementById('import-json'),
    backupStatus: document.getElementById('backup-status'),
    resetData: document.getElementById('reset-data'),
  };

  let store = loadStore();
  let recentLimit = 14;
  let activeEditDateKey = null;
  let saveTimer = null;

  init();

  function init() {
    store.createdAt ||= new Date().toISOString();
    store.updatedAt ||= new Date().toISOString();

    hydrateMetricSelect();
    setSegmented(store.ui.range);
    els.metricSelect.value = store.ui.metric;

    const todayKey = getTodayKey();
    els.todayLabel.textContent = formatPrettyDate(todayKey);

    renderEntryRow(els.todayRow, todayKey, 'today');
    renderComment(els.todayComment, todayKey);
    renderInsights(todayKey);
    refreshSaveStatus(todayKey);

    bindEvents();
    renderTrends();
    renderHistory();
    registerServiceWorker();
  }

  function bindEvents() {
    els.metricSelect.addEventListener('change', () => {
      store.ui.metric = els.metricSelect.value;
      persistStore(store);
      renderTrends();
    });

    els.segmentedBtns.forEach((btn) => {
      btn.addEventListener('click', () => {
        store.ui.range = btn.dataset.range;
        persistStore(store);
        setSegmented(store.ui.range);
        renderTrends();
      });
    });

    els.saveToday.addEventListener('click', () => {
      const todayKey = getTodayKey();
      const updated = readRowValues('today');
      upsertEntry(todayKey, updated);
      persistStore(store);
      refreshSaveStatus(todayKey, { showSavedNow: true });
      renderInsights(todayKey);
      renderTrends();
      renderHistory();
    });

    els.fillYesterday.addEventListener('click', () => {
      const todayKey = getTodayKey();
      const yesterdayKey = shiftDateKey(todayKey, -1);
      const yesterday = store.entries[yesterdayKey];
      if (!yesterday) {
        flashStatus('No entry for yesterday to copy.', 'warn');
        return;
      }
      writeRowValues('today', yesterday);
      writeComment('today', yesterday);
      scheduleAutosave(todayKey);
    });

    els.todayRow.addEventListener('change', (e) => {
      const t = e.target;
      if (!(t instanceof HTMLSelectElement)) return;
      if (!t.id?.startsWith('today-')) return;
      scheduleAutosave(getTodayKey());
    });

    els.todayComment.addEventListener('input', () => {
      scheduleAutosave(getTodayKey());
    });

    els.loadEditDate.addEventListener('click', () => {
      const key = els.editDate.value;
      if (!key) return;
      activeEditDateKey = key;
      renderEntryRow(els.editRow, key, 'edit');
      renderComment(els.editComment, key);
      els.saveEditDate.disabled = false;
    });

    els.saveEditDate.addEventListener('click', () => {
      if (!activeEditDateKey) return;
      const updated = readRowValues('edit');
      upsertEntry(activeEditDateKey, updated);
      persistStore(store);
      els.backupStatus.textContent = `Saved ${formatPrettyDate(activeEditDateKey)}.`;
      renderTrends();
      renderHistory();
      if (activeEditDateKey === todayKey) {
        refreshSaveStatus(todayKey, { showSavedNow: true });
        renderInsights(todayKey);
      }
    });

    els.showMore.addEventListener('click', () => {
      recentLimit = Math.min(365, recentLimit + 14);
      renderHistory();
    });

    els.exportJson.addEventListener('click', () => {
      const payload = {
        exportedAt: new Date().toISOString(),
        store,
      };
      downloadJson(payload, `mood-backup-${todayKey}.json`);
      els.backupStatus.textContent = 'Exported a JSON backup.';
    });

    els.importJson.addEventListener('change', async (e) => {
      const file = e.target.files?.[0];
      if (!file) return;
      try {
        const text = await file.text();
        const parsed = JSON.parse(text);
        const incoming = parsed?.store || parsed;
        const merged = mergeStores(store, incoming);
        store = merged;
        persistStore(store);
        els.backupStatus.textContent = 'Imported backup and merged entries.';
        hydrateMetricSelect();
        setSegmented(store.ui.range);
        els.metricSelect.value = store.ui.metric;
        const todayKeyNow = getTodayKey();
        renderEntryRow(els.todayRow, todayKeyNow, 'today');
        renderComment(els.todayComment, todayKeyNow);
        renderInsights(todayKeyNow);
        refreshSaveStatus(todayKeyNow);
        renderTrends();
        renderHistory();
      } catch {
        els.backupStatus.textContent = 'Import failed (invalid JSON).';
      } finally {
        e.target.value = '';
      }
    });

    els.resetData.addEventListener('click', () => {
      const ok = confirm('Delete all local mood entries in this browser? This cannot be undone.');
      if (!ok) return;
      localStorage.removeItem(STORAGE_KEY);
      localStorage.removeItem(SHADOW_KEY);
      localStorage.removeItem(SHADOW2_KEY);
      store = structuredClone(DEFAULT_STORE);
      store.createdAt = new Date().toISOString();
      store.updatedAt = new Date().toISOString();
      persistStore(store);
      activeEditDateKey = null;
      recentLimit = 14;

      const todayKeyNow = getTodayKey();
      renderEntryRow(els.todayRow, todayKeyNow, 'today');
      renderComment(els.todayComment, todayKeyNow);
      renderInsights(todayKeyNow);
      refreshSaveStatus(todayKeyNow, { showSavedNow: true });
      renderTrends();
      renderHistory();
      els.backupStatus.textContent = 'Deleted local data.';
    });

    window.addEventListener('storage', (evt) => {
      if (evt.key !== STORAGE_KEY) return;
      store = loadStore();
      const todayKeyNow = getTodayKey();
      els.todayLabel.textContent = formatPrettyDate(todayKeyNow);
      renderEntryRow(els.todayRow, todayKeyNow, 'today');
      renderComment(els.todayComment, todayKeyNow);
      renderInsights(todayKeyNow);
      refreshSaveStatus(todayKeyNow);
      renderTrends();
      renderHistory();
    });
  }

  function hydrateMetricSelect() {
    els.metricSelect.innerHTML = '';
    for (const m of METRICS) {
      const opt = document.createElement('option');
      opt.value = m.key;
      opt.textContent = m.label;
      els.metricSelect.appendChild(opt);
    }
  }

  function setSegmented(range) {
    els.segmentedBtns.forEach((btn) => {
      const active = btn.dataset.range === range;
      btn.setAttribute('aria-selected', active ? 'true' : 'false');
      btn.classList.toggle('segmented__btn--active', active);
    });
  }

  function renderEntryRow(targetRowEl, key, prefix) {
    targetRowEl.innerHTML = '';
    const entry = store.entries[key] || {};
    for (const m of METRICS) {
      const td = document.createElement('td');
      const select = document.createElement('select');
      select.id = `${prefix}-${m.key}`;
      select.className = 'mood-select';
      select.setAttribute('aria-label', m.label);

      const placeholder = document.createElement('option');
      placeholder.value = '';
      placeholder.textContent = '—';
      select.appendChild(placeholder);

      for (let i = 1; i <= 5; i++) {
        const opt = document.createElement('option');
        opt.value = String(i);
        opt.textContent = String(i);
        select.appendChild(opt);
      }

      select.value = entry?.[m.key] ? String(entry[m.key]) : '';
      td.appendChild(select);
      targetRowEl.appendChild(td);
    }
  }

  function readRowValues(prefix) {
    const next = {};
    for (const m of METRICS) {
      const el = document.getElementById(`${prefix}-${m.key}`);
      const raw = el?.value ?? '';
      next[m.key] = raw === '' ? null : clamp1to5(Number(raw));
    }
    const commentEl = document.getElementById(`${prefix}-comment`);
    const comment = commentEl?.value?.trim() || '';
    // Always include comment field (even if empty) so clearing it removes it from entry
    next.comment = comment || null;
    return next;
  }

  function writeRowValues(prefix, values) {
    for (const m of METRICS) {
      const el = document.getElementById(`${prefix}-${m.key}`);
      if (!el) continue;
      const v = values?.[m.key];
      el.value = typeof v === 'number' ? String(clamp1to5(v)) : '';
    }
  }

  function renderComment(textareaEl, key) {
    if (!textareaEl) return;
    const entry = store.entries[key] || {};
    // Handle both new entries with comment field and old entries without it
    textareaEl.value = (entry.comment && typeof entry.comment === 'string') ? entry.comment : '';
  }

  function writeComment(prefix, values) {
    const commentEl = document.getElementById(`${prefix}-comment`);
    if (!commentEl) return;
    // Handle both new entries with comment field and old entries without it
    const comment = (values?.comment && typeof values.comment === 'string') ? values.comment : '';
    commentEl.value = comment;
  }

  function scheduleAutosave(key) {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      const updated = readRowValues('today');
      upsertEntry(key, updated);
      persistStore(store);
      refreshSaveStatus(key, { showSavedNow: true });
      renderInsights(key);
      renderTrends();
      renderHistory();
    }, 350);
    els.todayStatus.textContent = 'Saving…';
  }

  function upsertEntry(key, updated) {
    const prev = store.entries[key] || {};
    const now = new Date().toISOString();
    const normalized = normalizeEntry({ ...prev, ...updated });
    const hasAny = METRICS.some((m) => typeof normalized[m.key] === 'number');
    if (!hasAny) {
      delete store.entries[key];
      store.updatedAt = now;
      return;
    }
    store.entries[key] = normalized;
    store.updatedAt = now;
  }

  function normalizeEntry(entry) {
    const normalized = {};
    for (const m of METRICS) {
      const v = entry?.[m.key];
      normalized[m.key] = typeof v === 'number' ? clamp1to5(v) : null;
    }
    // Comment is optional - preserve it if present and non-empty, otherwise omit it
    // This ensures backward compatibility with entries that don't have comments
    if (entry?.comment != null) {
      if (typeof entry.comment === 'string') {
        const trimmed = entry.comment.trim();
        if (trimmed) {
          normalized.comment = trimmed;
        }
      }
    }
    return normalized;
  }

  function refreshSaveStatus(key, opts = {}) {
    const entry = store.entries[key];
    if (!entry) {
      els.todayStatus.textContent = 'No entry yet.';
      return;
    }
    if (opts.showSavedNow) {
      flashStatus('Saved.', 'ok');
      return;
    }
    els.todayStatus.textContent = 'Saved.';
  }

  function flashStatus(text, kind) {
    els.todayStatus.textContent = text;
    els.todayStatus.classList.remove('mood-status--ok', 'mood-status--warn');
    if (kind === 'ok') els.todayStatus.classList.add('mood-status--ok');
    if (kind === 'warn') els.todayStatus.classList.add('mood-status--warn');
  }

  function renderInsights(key) {
    const entry = store.entries[key];
    if (!entry) {
      els.insights.innerHTML = '<p class="mood-note">Quick check-in: pick numbers for today, then trends update automatically.</p>';
      return;
    }

    const insights = [];
    const overall = entry.overall;
    if (typeof overall === 'number') {
      if (overall <= 2) insights.push('Overall looked low today. A smaller goal (like a short walk or early bedtime) can be enough.');
      if (overall === 3) insights.push('Overall looked neutral today. One small positive change might move tomorrow up.');
      if (overall >= 4) insights.push('Overall looked strong today. Keeping one habit consistent can help this trend stick.');
    }

    const nudges = [
      { key: 'sleep', low: 'Sleep looked low. If possible, try shifting bedtime earlier by 15–30 minutes.', high: 'Sleep looked solid. Protecting that routine can pay off.' },
      { key: 'exercise', low: 'Exercise looked low. Even 10 minutes counts; consistency beats intensity.', high: 'Exercise looked solid. A recovery day can still be a win.' },
      { key: 'food', low: 'Food/drink looked low. Hydration and one balanced meal can help reset things.', high: 'Food/drink looked solid. Keeping it simple often works best.' },
      { key: 'mental', low: 'Mental health looked low. Consider reducing commitments and taking short breaks.', high: 'Mental health looked solid. Noting what helped today can make it easier to repeat.' },
      { key: 'physical', low: 'Physical health looked low. Rest and gentle movement can be a good choice.', high: 'Physical health looked solid. Listening to any early fatigue signals can prevent setbacks.' },
    ];

    for (const n of nudges) {
      const v = entry[n.key];
      if (typeof v !== 'number') continue;
      if (v <= 2) insights.push(n.low);
      if (v >= 4) insights.push(n.high);
    }

    if (insights.length === 0) {
      els.insights.innerHTML = '<p class="mood-note">Saved. Trends will update as more days are logged.</p>';
      return;
    }

    els.insights.innerHTML = `<ul class="mood-list">${insights.slice(0, 4).map((t) => `<li>${escapeHtml(t)}</li>`).join('')}</ul>`;
  }

  function renderTrends() {
    const metricKey = store.ui.metric;
    const range = store.ui.range;
    const today = todayLocalDate();

    let points = [];
    let title = '';

    if (range === 'week') {
      title = 'Last 7 days';
      points = listDaysPoints(shiftLocalDate(today, -6), today, metricKey);
    } else if (range === 'month') {
      title = 'Last 30 days';
      points = listDaysPoints(shiftLocalDate(today, -29), today, metricKey);
    } else {
      title = `This year (${today.getFullYear()})`;
      points = listMonthsPoints(today.getFullYear(), metricKey);
    }

    drawChart(els.chart, points, { title, yMin: 1, yMax: 5 });
    renderTrendSummary(points, title);
  }

  function listDaysPoints(fromDate, toDate, metricKey) {
    const out = [];
    const cur = new Date(fromDate.getTime());
    while (cur <= toDate) {
      const key = dateKey(cur);
      const v = store.entries[key]?.[metricKey];
      out.push({
        key,
        label: shortDateLabel(key),
        value: typeof v === 'number' ? v : null,
      });
      cur.setDate(cur.getDate() + 1);
    }
    return out;
  }

  function listMonthsPoints(year, metricKey) {
    const out = [];
    for (let month = 0; month < 12; month++) {
      const monthStart = new Date(year, month, 1);
      const monthEnd = new Date(year, month + 1, 0);
      let total = 0;
      let count = 0;
      const cur = new Date(monthStart.getTime());
      while (cur <= monthEnd) {
        const key = dateKey(cur);
        const v = store.entries[key]?.[metricKey];
        if (typeof v === 'number') {
          total += v;
          count += 1;
        }
        cur.setDate(cur.getDate() + 1);
      }
      out.push({
        key: `${year}-${String(month + 1).padStart(2, '0')}`,
        label: monthStart.toLocaleString(undefined, { month: 'short' }),
        value: count ? total / count : null,
      });
    }
    return out;
  }

  function renderTrendSummary(points, title) {
    const vals = points.map((p) => p.value).filter((v) => typeof v === 'number');
    const count = vals.length;
    const total = vals.reduce((a, b) => a + b, 0);
    const avg = count ? total / count : null;
    const min = count ? Math.min(...vals) : null;
    const max = count ? Math.max(...vals) : null;

    const metricLabel = METRICS.find((m) => m.key === store.ui.metric)?.label ?? store.ui.metric;

    if (!count) {
      els.trendSummary.innerHTML = `<p class="mood-note">${escapeHtml(title)} • No data yet for ${escapeHtml(metricLabel)}.</p>`;
      return;
    }

    els.trendSummary.innerHTML =
      `<div class="mood-summary__grid">` +
      `<div class="mood-summary__item"><div class="mood-summary__k">Range</div><div class="mood-summary__v">${escapeHtml(title)}</div></div>` +
      `<div class="mood-summary__item"><div class="mood-summary__k">Metric</div><div class="mood-summary__v">${escapeHtml(metricLabel)}</div></div>` +
      `<div class="mood-summary__item"><div class="mood-summary__k">Logged</div><div class="mood-summary__v">${count}/${points.length}</div></div>` +
      `<div class="mood-summary__item"><div class="mood-summary__k">Average</div><div class="mood-summary__v">${avg.toFixed(2)}</div></div>` +
      `<div class="mood-summary__item"><div class="mood-summary__k">Low</div><div class="mood-summary__v">${min.toFixed(1)}</div></div>` +
      `<div class="mood-summary__item"><div class="mood-summary__k">High</div><div class="mood-summary__v">${max.toFixed(1)}</div></div>` +
      `</div>`;
  }

  function drawChart(svg, points, opts) {
    const width = 900;
    const height = 300;
    const pad = { l: 46, r: 16, t: 18, b: 38 };
    const innerW = width - pad.l - pad.r;
    const innerH = height - pad.t - pad.b;

    const yMin = opts?.yMin ?? 1;
    const yMax = opts?.yMax ?? 5;

    svg.innerHTML = '';
    svg.setAttribute('viewBox', `0 0 ${width} ${height}`);

    const g = el('g', { class: 'chart' });
    svg.appendChild(g);

    const bg = el('rect', { x: 0, y: 0, width, height, fill: 'transparent' });
    g.appendChild(bg);

    // grid + y labels
    for (let y = yMin; y <= yMax; y++) {
      const py = pad.t + ((yMax - y) / (yMax - yMin)) * innerH;
      g.appendChild(el('line', { x1: pad.l, y1: py, x2: width - pad.r, y2: py, class: 'chart__grid' }));
      g.appendChild(el('text', { x: pad.l - 10, y: py + 4, class: 'chart__ylabel', 'text-anchor': 'end' }, String(y)));
    }

    // x labels (sparse)
    const xEvery = points.length <= 8 ? 1 : points.length <= 14 ? 2 : points.length <= 31 ? 5 : 1;
    for (let i = 0; i < points.length; i += xEvery) {
      const p = points[i];
      const px = pad.l + (i / Math.max(1, points.length - 1)) * innerW;
      g.appendChild(el('text', { x: px, y: height - 14, class: 'chart__xlabel', 'text-anchor': 'middle' }, p.label));
    }

    const pts = points.map((p, i) => {
      const x = pad.l + (i / Math.max(1, points.length - 1)) * innerW;
      const y = p.value == null ? null : pad.t + ((yMax - p.value) / (yMax - yMin)) * innerH;
      return { ...p, x, y };
    });

    // line segments (break on null)
    let d = '';
    let penDown = false;
    for (const p of pts) {
      if (p.y == null) {
        penDown = false;
        continue;
      }
      d += `${penDown ? 'L' : 'M'} ${p.x.toFixed(2)} ${p.y.toFixed(2)} `;
      penDown = true;
    }
    if (d.trim()) g.appendChild(el('path', { d: d.trim(), class: 'chart__line' }));

    // points
    for (const p of pts) {
      if (p.y == null) continue;
      const c = el('circle', { cx: p.x, cy: p.y, r: 4, class: 'chart__dot', 'data-key': p.key });
      g.appendChild(c);
    }

    // hover interaction
    const interactiveDots = Array.from(svg.querySelectorAll('.chart__dot'));
    interactiveDots.forEach((dot) => {
      dot.addEventListener('mouseenter', (e) => {
        showTooltip(dot, pts);
        moveTooltip(e);
      });
      dot.addEventListener('mouseleave', hideTooltip);
      dot.addEventListener('mousemove', moveTooltip);
    });
    svg.addEventListener('mouseleave', hideTooltip);
  }

  function showTooltip(dot, pts) {
    const key = dot.getAttribute('data-key');
    const point = pts.find((p) => p.key === key);
    if (!point || point.value == null) return;
    const metricLabel = METRICS.find((m) => m.key === store.ui.metric)?.label ?? store.ui.metric;
    const dateLabel = store.ui.range === 'year' ? point.label : formatPrettyDate(point.key);
    els.chartTooltip.innerHTML = `<div class="mood-tooltip__k">${escapeHtml(dateLabel)}</div><div class="mood-tooltip__v">${escapeHtml(metricLabel)}: <strong>${point.value.toFixed(store.ui.range === 'year' ? 2 : 0)}</strong></div>`;
    els.chartTooltip.hidden = false;
  }

  function moveTooltip(e) {
    const rect = els.chart.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    els.chartTooltip.style.left = `${Math.max(8, Math.min(rect.width - 180, x + 12))}px`;
    els.chartTooltip.style.top = `${Math.max(8, Math.min(rect.height - 70, y - 10))}px`;
  }

  function hideTooltip() {
    els.chartTooltip.hidden = true;
  }

  function renderHistory() {
    const keys = Object.keys(store.entries).sort().reverse();

    // edit date defaults: yesterday if empty
    if (!els.editDate.value) {
      els.editDate.value = shiftDateKey(dateKey(todayLocalDate()), -1);
    }

    // recent table
    const slice = keys.slice(0, recentLimit);
    els.recentTbody.innerHTML = slice.length
      ? slice
          .map((k) => {
            const e = store.entries[k] || {};
            const vals = METRICS.map((m) => formatCell(e[m.key])).join('');
            return `<tr><th scope="row">${escapeHtml(k)}</th>${vals}</tr>`;
          })
          .join('')
      : `<tr><td colspan="7" class="mood-empty">No entries yet.</td></tr>`;

    els.showMore.disabled = slice.length >= keys.length || keys.length === 0;
    els.showMore.textContent = els.showMore.disabled ? 'All shown' : 'Show more';
  }

  function formatCell(v) {
    const s = typeof v === 'number' ? String(clamp1to5(v)) : '—';
    return `<td class="mood-cell">${escapeHtml(s)}</td>`;
  }

  function loadStore() {
    const primary = safeParse(localStorage.getItem(STORAGE_KEY));
    if (primary) return sanitizeStore(primary);

    const shadow = safeParse(localStorage.getItem(SHADOW_KEY));
    if (shadow) {
      // attempt recovery by restoring shadow as primary
      const recovered = sanitizeStore(shadow);
      localStorage.setItem(STORAGE_KEY, JSON.stringify(recovered));
      return recovered;
    }

    const shadow2 = safeParse(localStorage.getItem(SHADOW2_KEY));
    if (shadow2) {
      const recovered = sanitizeStore(shadow2);
      localStorage.setItem(STORAGE_KEY, JSON.stringify(recovered));
      return recovered;
    }

    return structuredClone(DEFAULT_STORE);
  }

  function persistStore(nextStore) {
    const toWrite = sanitizeStore(nextStore);
    toWrite.updatedAt = new Date().toISOString();

    const serialized = JSON.stringify(toWrite);
    const prev = localStorage.getItem(STORAGE_KEY);
    if (prev) {
      const prevShadow = localStorage.getItem(SHADOW_KEY);
      if (prevShadow) localStorage.setItem(SHADOW2_KEY, prevShadow);
      localStorage.setItem(SHADOW_KEY, prev);
    }
    localStorage.setItem(STORAGE_KEY, serialized);
  }

  function sanitizeStore(raw) {
    if (!raw || typeof raw !== 'object') return structuredClone(DEFAULT_STORE);
    const out = structuredClone(DEFAULT_STORE);
    out.version = 1;
    out.createdAt = typeof raw.createdAt === 'string' ? raw.createdAt : out.createdAt;
    out.updatedAt = typeof raw.updatedAt === 'string' ? raw.updatedAt : out.updatedAt;

    const entries = raw.entries && typeof raw.entries === 'object' ? raw.entries : {};
    out.entries = {};
    for (const [k, v] of Object.entries(entries)) {
      if (!isDateKey(k)) continue;
      out.entries[k] = normalizeEntry(v);
    }

    const ui = raw.ui && typeof raw.ui === 'object' ? raw.ui : {};
    out.ui.metric = METRICS.some((m) => m.key === ui.metric) ? ui.metric : out.ui.metric;
    out.ui.range = ['week', 'month', 'year'].includes(ui.range) ? ui.range : out.ui.range;
    return out;
  }

  function mergeStores(base, incoming) {
    const a = sanitizeStore(base);
    const b = sanitizeStore(incoming);
    const merged = sanitizeStore(a);

    merged.createdAt = a.createdAt || b.createdAt || new Date().toISOString();
    merged.updatedAt = new Date().toISOString();
    merged.ui = { ...a.ui, ...b.ui };
    merged.entries = { ...a.entries };
    for (const [k, v] of Object.entries(b.entries)) {
      merged.entries[k] = normalizeEntry(v);
    }
    return merged;
  }

  function safeParse(s) {
    if (!s) return null;
    try {
      return JSON.parse(s);
    } catch {
      return null;
    }
  }

  function todayLocalDate() {
    const d = new Date();
    return new Date(d.getFullYear(), d.getMonth(), d.getDate());
  }

  function getTodayKey() {
    return dateKey(todayLocalDate());
  }

  function shiftLocalDate(d, deltaDays) {
    const out = new Date(d.getTime());
    out.setDate(out.getDate() + deltaDays);
    return out;
  }

  function dateKey(d) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }

  function shiftDateKey(key, deltaDays) {
    const parts = key.split('-').map((x) => Number(x));
    const d = new Date(parts[0], parts[1] - 1, parts[2]);
    d.setDate(d.getDate() + deltaDays);
    return dateKey(d);
  }

  function isDateKey(k) {
    return /^\d{4}-\d{2}-\d{2}$/.test(k);
  }

  function clamp1to5(n) {
    if (!Number.isFinite(n)) return 1;
    return Math.max(1, Math.min(5, Math.round(n)));
  }

  function shortDateLabel(key) {
    const [y, m, d] = key.split('-').map((x) => Number(x));
    const dt = new Date(y, m - 1, d);
    return dt.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }

  function formatPrettyDate(key) {
    const [y, m, d] = key.split('-').map((x) => Number(x));
    const dt = new Date(y, m - 1, d);
    return dt.toLocaleDateString(undefined, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
  }

  function downloadJson(obj, filename) {
    const blob = new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  function el(tag, attrs = {}, text) {
    const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
    if (text != null) node.textContent = text;
    return node;
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => {
      switch (c) {
        case '&':
          return '&amp;';
        case '<':
          return '&lt;';
        case '>':
          return '&gt;';
        case '"':
          return '&quot;';
        case "'":
          return '&#39;';
        default:
          return c;
      }
    });
  }

  function registerServiceWorker() {
    if (!('serviceWorker' in navigator)) return;
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  }
})();
