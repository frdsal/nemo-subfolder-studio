/* Nemo Subfolder Studio Downloader v1.3.2 Download Modes
   Web-loadable bundle for bookmarklet loader.
   Host this file on HTTPS, then point the loader bookmarklet to its public URL. */
(() => {
  'use strict';

  const APP_VERSION = '1.3.2';
  const APP_KEY = '__nemoSubfolderStudioDownloaderV132__';
  const UI_ID = 'nemo_subfolder_studio_downloader_v132';
  const STYLE_ID = 'nemo_subfolder_studio_downloader_v132_style';
  const STORE_KEY = 'nemo.subfolderStudio.downloader.v132';
  const VIEW_PATH = '/reader/services/view.php';
  const READER_PATH = '/reader/index.php';

  const PATTERN_PRESETS = [
    { key: 'toc', label: 'Daftar isi', hint: 'DAFIS, DAFTARISI', patterns: ['DAFIS.pdf', 'DAFTARISI.pdf', 'DAFTAR_ISI.pdf'] },
    { key: 'overview', label: 'Tinjauan', hint: 'TINJAUAN, TMK', patterns: ['TINJAUAN.pdf', 'TINJAUAN_MATA_KULIAH.pdf', 'TMK.pdf'] },
    { key: 'm_plain', label: 'Modul M1-M12', hint: 'M1.pdf sampai M12.pdf', patterns: ['M{1-12}.pdf'] },
    { key: 'm_padded', label: 'Modul M01-M12', hint: 'M01.pdf sampai M12.pdf', patterns: ['M{01-12}.pdf'] },
    { key: 'modul_plain', label: 'MODUL1-MODUL12', hint: 'MODUL1.pdf sampai MODUL12.pdf', patterns: ['MODUL{1-12}.pdf'] },
    { key: 'modul_underscore', label: 'MODUL_1-MODUL_12', hint: 'MODUL_1.pdf sampai MODUL_12.pdf', patterns: ['MODUL_{1-12}.pdf'] }
  ];

  const DEFAULT_PATTERN_PRESET_KEYS = ['toc', 'overview', 'm_plain'];

  const DEFAULTS = {
    subfolder: '',
    patternPresetKeys: DEFAULT_PATTERN_PRESET_KEYS.slice(),
    customPatterns: '',
    patterns: 'DAFIS.pdf, DAFTARISI.pdf, DAFTAR_ISI.pdf, TINJAUAN.pdf, TINJAUAN_MATA_KULIAH.pdf, TMK.pdf, M{1-12}.pdf',
    manualDocs: '',
    useDirectProbe: true,
    initReaderBeforeProbe: true,
    usePageLinks: false,
    usePatterns: true,
    maxPage: 300,
    delayMs: 700,
    timeoutMs: 12000,
    compact: false,
    includeManifest: true,
    includeNativeText: true,
    outputFormat: 'pdf',
    outputBundle: 'zip',
    pdfSearchable: true
  };

  const state = {
    running: false,
    stopRequested: false,
    controller: null,
    config: { ...DEFAULTS },
    candidates: [],
    results: [],
    logs: [],
    ui: null,
    nodes: {},
    checkedAt: null,
    lastError: null,
    readerInitCache: new Map(),
    downloadStats: null,
    nativeTextCache: new Map(),
    pdfStats: null
  };

  if (window[APP_KEY] && typeof window[APP_KEY].show === 'function') {
    window[APP_KEY].show();
    return;
  }

  /** Loads saved user settings and migrates older pattern text into preset choices. */
  function loadConfig() {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      const config = raw ? { ...DEFAULTS, ...JSON.parse(raw) } : { ...DEFAULTS };
      return normalizePatternConfig(config);
    } catch {
      return normalizePatternConfig({ ...DEFAULTS });
    }
  }

  /** Persists current settings. */
  function saveConfig() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(state.config)); } catch { }
  }


  /** Returns safe preset keys from a config object. */
  function normalizePatternConfig(config) {
    const valid = new Set(PATTERN_PRESETS.map(item => item.key));
    let keys = Array.isArray(config.patternPresetKeys) ? config.patternPresetKeys.filter(key => valid.has(key)) : [];
    if (!keys.length && config.patterns) {
      const oldPatterns = String(config.patterns);
      keys = PATTERN_PRESETS.filter(item => item.patterns.some(pattern => oldPatterns.includes(pattern))).map(item => item.key);
    }
    if (!keys.length) keys = DEFAULT_PATTERN_PRESET_KEYS.slice();
    const normalized = { ...config, patternPresetKeys: keys };
    normalized.patterns = buildEffectivePatternString(normalized);
    return normalized;
  }

  /** Builds a comma-separated pattern string from checked presets plus optional custom patterns. */
  function buildEffectivePatternString(config = state.config) {
    const selected = new Set(Array.isArray(config.patternPresetKeys) ? config.patternPresetKeys : DEFAULT_PATTERN_PRESET_KEYS);
    const presetPatterns = PATTERN_PRESETS
      .filter(item => selected.has(item.key))
      .flatMap(item => item.patterns);
    const custom = String(config.customPatterns || '').split(/[\n,;]+/).map(s => s.trim()).filter(Boolean);
    return [...presetPatterns, ...custom].join(', ');
  }

  /** Returns the checked pattern preset keys from UI. */
  function checkedPatternPresetKeys() {
    const checks = state.nodes.patternPresetChecks || [];
    return checks.filter(input => input.checked).map(input => input.getAttribute('data-nss-pattern-key')).filter(Boolean);
  }

  /** Renders pattern preset checkboxes. */
  function renderPatternPresetOptions(config = state.config) {
    const selected = new Set(Array.isArray(config.patternPresetKeys) ? config.patternPresetKeys : DEFAULT_PATTERN_PRESET_KEYS);
    return PATTERN_PRESETS.map(item => `
      <label class="nss-preset">
        <input type="checkbox" data-nss-pattern-key="${escapeHtml(item.key)}" ${selected.has(item.key) ? 'checked' : ''}>
        <span><b>${escapeHtml(item.label)}</b><small>${escapeHtml(item.hint)}</small></span>
      </label>
    `).join('');
  }

  /** Adds one visible activity message. */
  function log(message) {
    const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    state.logs.unshift(`${time} - ${message}`);
    state.logs = state.logs.slice(0, 60);
    renderLogs();
  }

  /** Sleeps while respecting stop requests. */
  async function sleep(ms) {
    const end = Date.now() + Math.max(0, Number(ms) || 0);
    while (Date.now() < end) {
      if (state.stopRequested) throw new Error('Proses dihentikan.');
      await new Promise(resolve => setTimeout(resolve, Math.min(250, end - Date.now())));
    }
  }

  /** Normalizes the course subfolder. */
  function normalizeSubfolder(value) {
    let text = String(value || '').trim();
    if (!text) return '';
    try {
      if (/^https?:/i.test(text)) {
        const url = new URL(text);
        text = url.searchParams.get('subfolder') || text;
      }
    } catch { }
    try { text = decodeURIComponent(text); } catch { }
    text = text.replace(/\\/g, '/').replace(/^\/+/, '');
    if (text && !text.endsWith('/')) text += '/';
    return text;
  }

  /** Converts document name to a display PDF name. */
  function toDisplayDoc(docName) {
    const text = String(docName || '').trim();
    if (!text) return '';
    return /\.pdf$/i.test(text) ? text : `${text}.pdf`;
  }

  /** Converts display document name to the short service doc. */
  function toServiceDoc(docName) {
    return String(docName || '').trim().replace(/\.pdf$/i, '');
  }

  /** Returns candidate doc parameter variants for view.php. */
  function getServiceDocVariants(docName, preferred = null) {
    const display = toDisplayDoc(docName);
    const shortName = toServiceDoc(display);
    const original = String(docName || '').trim();
    const values = [preferred, shortName, display, original]
      .map(value => String(value || '').trim())
      .filter(Boolean);
    const seen = new Set();
    return values.filter(value => {
      const key = value.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  /** Creates a reader URL for user review. */
  function buildReaderUrl(docName) {
    const url = new URL(READER_PATH, location.origin);
    url.searchParams.set('subfolder', normalizeSubfolder(state.config.subfolder));
    url.searchParams.set('doc', toDisplayDoc(docName));
    return url.href;
  }

  /** Creates a reader URL for a specific subfolder without using page history. */
  function buildReaderUrlForSubfolder(subfolder, docName) {
    const url = new URL(READER_PATH, location.origin);
    url.searchParams.set('subfolder', normalizeSubfolder(subfolder));
    url.searchParams.set('doc', toDisplayDoc(docName));
    return url.href;
  }

  /** Creates an image URL for a specific page inside a specific subfolder. */
  function buildImageUrlForSubfolder(subfolder, docName, page, format = 'png', serviceDoc = null) {
    const url = new URL(VIEW_PATH, location.origin);
    url.searchParams.set('doc', serviceDoc || toServiceDoc(docName));
    url.searchParams.set('format', format);
    url.searchParams.set('subfolder', normalizeSubfolder(subfolder));
    url.searchParams.set('page', String(page));
    return url.href;
  }

  /** Creates an image URL for a specific page. */
  function buildImageUrl(docName, page, format = 'png', serviceDoc = null) {
    return buildImageUrlForSubfolder(state.config.subfolder, docName, page, format, serviceDoc);
  }

  /** Creates a JSON text URL for a specific page. */
  function buildTextUrl(docName, page, serviceDoc = null) {
    const url = new URL(VIEW_PATH, location.origin);
    url.searchParams.set('doc', serviceDoc || toServiceDoc(docName));
    url.searchParams.set('format', 'json');
    url.searchParams.set('subfolder', normalizeSubfolder(state.config.subfolder));
    url.searchParams.set('page', String(page));
    return url.href;
  }

  /** Expands a single range pattern. M{1-12} is not padded, M{01-12} is padded. */
  function expandOnePattern(pattern) {
    const text = String(pattern || '').trim();
    const match = text.match(/^(.*)\{(\d+)-(\d+)\}(.*)$/);
    if (!match) return text ? [text] : [];
    const [, prefix, startText, endText, suffix] = match;
    const start = Number(startText);
    const end = Number(endText);
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start || end - start > 300) return [];
    const shouldPad = /^0\d/.test(startText) || /^0\d/.test(endText);
    const pad = shouldPad ? Math.max(startText.length, endText.length) : 0;
    const out = [];
    for (let n = start; n <= end; n += 1) {
      out.push(`${prefix}${pad ? String(n).padStart(pad, '0') : String(n)}${suffix}`.trim());
    }
    return out;
  }

  /** Parses comma, semicolon, or newline separated document patterns. */
  function parsePatternDocs(input) {
    const out = [];
    for (const part of String(input || '').split(/[\n,;]+/).map(s => s.trim()).filter(Boolean)) {
      for (const expanded of expandOnePattern(part)) out.push(toDisplayDoc(expanded));
    }
    return uniqueDocs(out);
  }

  /** Adds a candidate with source labels. */
  function addCandidate(map, docName, source, detail = '') {
    const doc = toDisplayDoc(docName);
    if (!doc) return;
    const key = doc.toLowerCase();
    if (!map.has(key)) {
      map.set(key, { doc, sources: [], detail: [] });
    }
    const item = map.get(key);
    if (!item.sources.includes(source)) item.sources.push(source);
    if (detail && !item.detail.includes(detail)) item.detail.push(detail);
  }

  /** Deduplicates display document names. */
  function uniqueDocs(docs) {
    const seen = new Set();
    const out = [];
    for (const item of docs || []) {
      const doc = toDisplayDoc(item);
      const key = doc.toLowerCase();
      if (!doc || seen.has(key)) continue;
      seen.add(key);
      out.push(doc);
    }
    return out;
  }

  /** Extracts document names from reader URLs, service URLs, onclick strings, or query fragments. */
  function extractDocsFromText(value, targetSubfolder) {
    const text = String(value || '');
    const target = normalizeSubfolder(targetSubfolder).toLowerCase();
    const out = [];
    const seen = new Set();

    const push = (doc, subfolder = '') => {
      const sf = normalizeSubfolder(subfolder).toLowerCase();
      if (target && sf && sf !== target) return;
      const display = toDisplayDoc(doc);
      if (!display) return;
      const key = display.toLowerCase();
      if (!seen.has(key)) {
        seen.add(key);
        out.push(display);
      }
    };

    const tryUrl = raw => {
      try {
        const url = new URL(String(raw || '').trim(), location.href);
        const doc = url.searchParams.get('doc');
        if (!doc) return;
        push(doc, url.searchParams.get('subfolder') || '');
      } catch { }
    };

    tryUrl(text);
    const urls = text.match(/https?:\/\/[^\s"'<>]+|\/reader\/(?:index\.php|services\/view\.php)\?[^\s"'<>]+|reader\/(?:index\.php|services\/view\.php)\?[^\s"'<>]+/gi) || [];
    for (const raw of urls) tryUrl(raw);

    if (/(?:^|[?&\s])doc=/.test(text)) {
      try {
        const query = text.includes('?') ? text.slice(text.indexOf('?') + 1) : text;
        const params = new URLSearchParams(query.replace(/^[?&\s]+/, ''));
        const doc = params.get('doc');
        if (doc) push(doc, params.get('subfolder') || '');
      } catch { }
    }
    return out;
  }

  /** Parses manual entries: names, patterns, or URLs. */
  function parseManualDocs(input, subfolder) {
    const docs = [];
    for (const part of String(input || '').split(/[\n,;]+/).map(s => s.trim()).filter(Boolean)) {
      const fromText = extractDocsFromText(part, subfolder);
      if (fromText.length) docs.push(...fromText);
      else docs.push(...expandOnePattern(part).map(toDisplayDoc));
    }
    return uniqueDocs(docs);
  }

  /** Collects reader document links visible on the current page. */
  function collectDocsFromPageLinks(subfolder) {
    const target = normalizeSubfolder(subfolder).toLowerCase();
    if (!target) return [];
    const docs = [];
    const add = list => docs.push(...(list || []));

    add(extractDocsFromText(location.href, target));
    const nodes = Array.from(document.querySelectorAll('a[href], [onclick], [data-href], [data-url], [data-link], [data-doc]')).slice(0, 3000);
    for (const node of nodes) {
      if (!(node instanceof Element)) continue;
      if (node.closest(`#${UI_ID}`)) continue;
      if (node instanceof HTMLAnchorElement) {
        add(extractDocsFromText(node.href, target));
        add(extractDocsFromText(node.getAttribute('href') || '', target));
      }
      for (const attr of ['onclick', 'data-href', 'data-url', 'data-link']) {
        add(extractDocsFromText(node.getAttribute(attr) || '', target));
      }
      const dataDoc = node.getAttribute('data-doc');
      if (dataDoc) add(extractDocsFromText(`doc=${encodeURIComponent(dataDoc)}&subfolder=${encodeURIComponent(target)}`, target));
    }
    return uniqueDocs(docs);
  }

  /** Builds all candidates and records where each came from. */
  function buildCandidates() {
    const map = new Map();
    const subfolder = normalizeSubfolder(state.config.subfolder);

    const manual = parseManualDocs(state.config.manualDocs, subfolder);
    for (const doc of manual) addCandidate(map, doc, 'manual');

    if (state.config.usePatterns) {
      const patternDocs = parsePatternDocs(buildEffectivePatternString(state.config));
      for (const doc of patternDocs) addCandidate(map, doc, 'pola');
    }

    if (state.config.usePageLinks) {
      const linked = collectDocsFromPageLinks(subfolder);
      for (const doc of linked) addCandidate(map, doc, 'link halaman');
    }

    return Array.from(map.values()).sort((a, b) => {
      const ca = classifyDocument(a.doc);
      const cb = classifyDocument(b.doc);
      return (ca.order - cb.order) || a.doc.localeCompare(b.doc, undefined, { numeric: true, sensitivity: 'base' });
    });
  }

  /** Classifies a document into a user-friendly type. */
  function classifyDocument(docName) {
    const base = String(docName || '').replace(/\.pdf$/i, '').toUpperCase().replace(/[\s_-]+/g, '');
    if (/^(DAFIS|DAFTARISI|DAFTARISIMODUL|ISI)$/.test(base)) return { group: 'Daftar Isi', order: 0, label: 'Daftar Isi' };
    if (/^(TINJAUAN|TINJAUANMATAKULIAH|TMK|PETA|PETAKOMPETENSI)$/.test(base)) return { group: 'Tinjauan Mata Kuliah', order: 1, label: 'Tinjauan Mata Kuliah' };
    const moduleMatch = base.match(/^(?:M|MODUL)(\d{1,2})$/);
    if (moduleMatch) {
      const number = Number(moduleMatch[1]);
      return { group: `Modul ${number}`, order: 10 + number, label: `Modul ${number}` };
    }
    return { group: 'Tambahan', order: 900, label: String(docName || '').replace(/\.pdf$/i, '') || 'Dokumen' };
  }

  /** Reads dimensions from an image blob. */
  async function readImageDimensions(blob) {
    if (typeof createImageBitmap === 'function') {
      const bitmap = await createImageBitmap(blob);
      try { return { width: bitmap.width, height: bitmap.height }; }
      finally { if (typeof bitmap.close === 'function') bitmap.close(); }
    }
    const objectUrl = URL.createObjectURL(blob);
    try {
      const img = new Image();
      img.decoding = 'async';
      img.src = objectUrl;
      if (typeof img.decode === 'function') await img.decode();
      else await new Promise((resolve, reject) => { img.onload = resolve; img.onerror = reject; });
      return { width: img.naturalWidth, height: img.naturalHeight };
    } finally {
      URL.revokeObjectURL(objectUrl);
    }
  }

  /** Initializes the reader session for one document before direct PNG probing. */
  async function initializeReaderDocument(docName) {
    const subfolder = normalizeSubfolder(state.config.subfolder);
    const displayDoc = toDisplayDoc(docName);
    const key = `${subfolder.toLowerCase()}|${displayDoc.toLowerCase()}`;
    if (state.readerInitCache.has(key)) return state.readerInitCache.get(key);

    const timeout = Math.max(3000, Number(state.config.timeoutMs) || DEFAULTS.timeoutMs);
    const local = new AbortController();
    const timer = setTimeout(() => local.abort(), timeout);
    const output = {
      ok: false,
      mode: 'reader-init',
      subfolder,
      doc: displayDoc,
      url: buildReaderUrlForSubfolder(subfolder, displayDoc),
      status: null,
      contentType: null,
      sizeBytes: 0,
      note: ''
    };

    try {
      const signal = state.controller && typeof AbortSignal !== 'undefined' && typeof AbortSignal.any === 'function'
        ? AbortSignal.any([state.controller.signal, local.signal])
        : local.signal;
      const response = await fetch(output.url, { method: 'GET', credentials: 'include', cache: 'no-store', signal });
      output.status = response.status;
      output.contentType = response.headers.get('content-type') || '';
      const text = await response.text().catch(() => '');
      output.sizeBytes = text.length;
      output.ok = response.ok && !/SECURITY BREACH DETECTED|Akses gambar/i.test(text.slice(0, 800));
      output.note = output.ok ? 'OK' : `HTTP ${response.status}`;
      if (output.ok) await sleep(120);
    } catch (error) {
      output.note = error && error.name === 'AbortError' ? 'Dibatalkan atau timeout' : String(error && error.message || error);
    } finally {
      clearTimeout(timer);
    }

    state.readerInitCache.set(key, output);
    return output;
  }

  /** Fetches a URL and checks whether it is a valid PNG page. */
  async function fetchPngUrl(url, page, serviceDoc) {
    const timeout = Math.max(3000, Number(state.config.timeoutMs) || DEFAULTS.timeoutMs);
    const local = new AbortController();
    const timer = setTimeout(() => local.abort(), timeout);
    const result = {
      exists: false,
      page,
      status: null,
      contentType: null,
      sizeBytes: 0,
      width: null,
      height: null,
      url,
      serviceDocTried: serviceDoc,
      serviceDocUsed: null,
      note: ''
    };
    try {
      const signal = state.controller && typeof AbortSignal !== 'undefined' && typeof AbortSignal.any === 'function'
        ? AbortSignal.any([state.controller.signal, local.signal])
        : local.signal;
      const response = await fetch(url, { method: 'GET', credentials: 'include', cache: 'no-store', signal });
      result.status = response.status;
      result.contentType = response.headers.get('content-type') || '';
      if (!response.ok) {
        result.note = `HTTP ${response.status}`;
        return result;
      }
      const blob = await response.blob();
      result.sizeBytes = blob.size;
      if (!/^image\/png(?:;|$)/i.test(blob.type || result.contentType)) {
        result.note = 'Bukan PNG';
        return result;
      }
      if (blob.size < 512) {
        result.note = 'Terlalu kecil';
        return result;
      }
      const dims = await readImageDimensions(blob);
      result.width = dims.width;
      result.height = dims.height;
      result.exists = Boolean(dims.width >= 200 && dims.height >= 200);
      result.serviceDocUsed = result.exists ? serviceDoc : null;
      result.note = result.exists ? 'OK' : 'Gambar terlalu kecil';
      return result;
    } catch (error) {
      result.note = error && error.name === 'AbortError' ? 'Dibatalkan atau timeout' : String(error && error.message || error);
      return result;
    } finally {
      clearTimeout(timer);
    }
  }

  /** Probes one page by trying service doc variants. */
  async function probePngPage(docName, page, cache, preferredServiceDoc = null) {
    if (state.stopRequested) throw new Error('Proses dihentikan.');
    const variants = getServiceDocVariants(docName, preferredServiceDoc);
    const subfolderKey = normalizeSubfolder(state.config.subfolder).toLowerCase();
    const cacheKey = `${subfolderKey}|${toDisplayDoc(docName).toLowerCase()}|${String(preferredServiceDoc || '').toLowerCase()}|${page}`;
    if (cache && cache.has(cacheKey)) return cache.get(cacheKey);

    const initSession = state.config.initReaderBeforeProbe ? await initializeReaderDocument(docName) : null;
    let best = null;
    const tried = [];
    for (const serviceDoc of variants) {
      if (state.stopRequested) throw new Error('Proses dihentikan.');
      const url = buildImageUrl(docName, page, 'png', serviceDoc);
      const result = await fetchPngUrl(url, page, serviceDoc);
      tried.push({ serviceDoc, status: result.status, note: result.note, contentType: result.contentType });
      if (result.exists) {
        result.triedServiceDocs = tried;
        result.initSession = initSession;
        if (cache) cache.set(cacheKey, result);
        return result;
      }
      if (!best || (best.status === 403 && result.status !== 403) || (result.sizeBytes || 0) > (best.sizeBytes || 0)) best = result;
    }

    const result = best || {
      exists: false,
      page,
      status: null,
      contentType: null,
      sizeBytes: 0,
      width: null,
      height: null,
      url: buildImageUrl(docName, page, 'png', variants[0] || toServiceDoc(docName)),
      serviceDocTried: variants[0] || toServiceDoc(docName),
      serviceDocUsed: null,
      note: 'Tidak ditemukan'
    };
    result.triedServiceDocs = tried;
    result.initSession = initSession;
    if (cache) cache.set(cacheKey, result);
    return result;
  }

  /** Attempts to read text JSON metadata for page count hints. */
  async function tryReadJsonPage(docName, page, serviceDoc) {
    const url = buildTextUrl(docName, page, serviceDoc);
    const timeout = Math.max(3000, Number(state.config.timeoutMs) || DEFAULTS.timeoutMs);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      const response = await fetch(url, { credentials: 'include', cache: 'no-store', signal: controller.signal });
      if (!response.ok) return null;
      const text = await response.text();
      if (!text.trim()) return null;
      const data = JSON.parse(text);
      const first = Array.isArray(data) ? data[0] : data;
      if (!first || typeof first !== 'object') return null;
      const pages = Number(first.pages || first.totalPages);
      const number = Number(first.number || first.page);
      return {
        ok: true,
        pages: Number.isInteger(pages) && pages > 0 ? pages : null,
        number: Number.isInteger(number) ? number : null,
        sizeBytes: text.length
      };
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  /** Finds the last page through exponential and binary probing. */
  async function countPages(docName, firstProbe, cache) {
    const maxPage = Math.max(1, Math.min(2000, Number(state.config.maxPage) || DEFAULTS.maxPage));
    if (!firstProbe || !firstProbe.exists) return { pages: 0, capped: false, probes: 0, method: 'none' };

    const jsonHint = await tryReadJsonPage(docName, 1, firstProbe.serviceDocUsed);
    if (jsonHint && jsonHint.pages && jsonHint.pages <= maxPage) {
      return { pages: jsonHint.pages, capped: false, probes: 1, method: 'json', jsonHint };
    }

    let probes = 1;
    let lo = 1;
    let hi = 2;
    while (hi <= maxPage) {
      await sleep(Number(state.config.delayMs) || DEFAULTS.delayMs);
      const check = await probePngPage(docName, hi, cache, firstProbe.serviceDocUsed);
      probes += 1;
      if (!check.exists) break;
      lo = hi;
      hi *= 2;
    }

    if (hi > maxPage) {
      await sleep(Number(state.config.delayMs) || DEFAULTS.delayMs);
      const maxCheck = await probePngPage(docName, maxPage, cache, firstProbe.serviceDocUsed);
      probes += 1;
      if (maxCheck.exists) return { pages: maxPage, capped: true, probes, method: 'png' };
      hi = maxPage;
    }

    let left = lo + 1;
    let right = Math.max(lo, hi - 1);
    let best = lo;
    while (left <= right) {
      const mid = Math.floor((left + right) / 2);
      await sleep(Number(state.config.delayMs) || DEFAULTS.delayMs);
      const check = await probePngPage(docName, mid, cache, firstProbe.serviceDocUsed);
      probes += 1;
      if (check.exists) {
        best = mid;
        left = mid + 1;
      } else {
        right = mid - 1;
      }
    }
    return { pages: best, capped: false, probes, method: 'png' };
  }

  /** Scans a single candidate document. */
  async function scanCandidate(candidate, index, total, cache) {
    const docName = candidate.doc;
    setStatus(`Memeriksa ${docName} (${index + 1}/${total})`);
    const meta = classifyDocument(docName);
    const started = Date.now();
    const first = await probePngPage(docName, 1, cache);
    if (!first.exists) {
      return {
        selected: false,
        valid: false,
        doc: docName,
        serviceDoc: first.serviceDocUsed || toServiceDoc(docName),
        candidateSources: candidate.sources,
        candidateDetails: candidate.detail,
        triedServiceDocs: first.triedServiceDocs || [],
        initSession: first.initSession || null,
        label: meta.label,
        group: meta.group,
        order: meta.order,
        pages: 0,
        width: null,
        height: null,
        status: first.status,
        note: first.note || 'Tidak ditemukan',
        elapsedMs: Date.now() - started
      };
    }

    const count = await countPages(docName, first, cache);
    return {
      selected: true,
      valid: true,
      doc: docName,
      serviceDoc: first.serviceDocUsed || toServiceDoc(docName),
      candidateSources: candidate.sources,
      candidateDetails: candidate.detail,
      triedServiceDocs: first.triedServiceDocs || [],
      initSession: first.initSession || null,
      label: meta.label,
      group: meta.group,
      order: meta.order,
      pages: count.pages,
      capped: count.capped,
      width: first.width,
      height: first.height,
      status: first.status,
      note: count.capped ? `Mencapai batas ${state.config.maxPage}` : 'Tersedia',
      countMethod: count.method,
      jsonHint: count.jsonHint || null,
      probeCount: count.probes,
      readerUrl: buildReaderUrl(docName),
      elapsedMs: Date.now() - started
    };
  }


  /** Runs the scan. */
  async function runScan() {
    if (state.running) return;
    readConfigFromUi();
    saveConfig();

    const subfolder = normalizeSubfolder(state.config.subfolder);
    if (!subfolder) {
      alert('Isi subfolder terlebih dahulu. Contoh: EKSI441604/');
      return;
    }

    const candidates = buildCandidates();
    state.candidates = candidates;
    if (!candidates.length) {
      alert('Tidak ada kandidat dokumen. Isi pola, input manual, atau buka halaman yang berisi link dokumen.');
      return;
    }

    state.running = true;
    state.stopRequested = false;
    state.controller = new AbortController();
    state.results = [];
    state.checkedAt = new Date().toISOString();
    state.readerInitCache.clear();
    updateButtons();
    renderResults();

    log(`Mulai cek subfolder ${subfolder}.`);
    log(`${candidates.length} kandidat akan diprobe langsung${state.config.initReaderBeforeProbe ? ' dengan persiapan dokumen' : ''}.`);
    const sourceCounts = candidates.reduce((acc, item) => {
      for (const source of item.sources) acc[source] = (acc[source] || 0) + 1;
      return acc;
    }, {});
    log(`Sumber kandidat: ${Object.entries(sourceCounts).map(([k, v]) => `${k} ${v}`).join(', ') || 'tidak ada'}.`);

    const cache = new Map();
    try {
      for (let i = 0; i < candidates.length; i += 1) {
        if (state.stopRequested) break;
        const result = await scanCandidate(candidates[i], i, candidates.length, cache);
        state.results.push(result);
        state.results.sort((a, b) => (a.order - b.order) || a.doc.localeCompare(b.doc, undefined, { numeric: true, sensitivity: 'base' }));
        renderResults();
        if (result.valid) log(`${result.label}: ${result.pages} halaman (${result.doc}).`);
        else if (i < 8 || candidates[i].sources.includes('manual')) log(`${result.doc}: tidak cocok (${result.note}).`);
        await sleep(Number(state.config.delayMs) || DEFAULTS.delayMs);
      }
      const found = state.results.filter(r => r.valid).length;
      const pages = state.results.filter(r => r.valid).reduce((sum, r) => sum + Number(r.pages || 0), 0);
      setStatus(state.stopRequested ? `Dihentikan. Ditemukan ${found} dokumen, ${pages} halaman.` : `Selesai. Ditemukan ${found} dokumen, ${pages} halaman.`);
      log(`Selesai. ${found} dokumen valid, ${pages} halaman.`);
    } catch (error) {
      state.lastError = String(error && error.message || error);
      setStatus(`Berhenti: ${state.lastError}`, true);
      log(`Berhenti: ${state.lastError}`);
    } finally {
      state.running = false;
      state.stopRequested = false;
      state.controller = null;
      updateButtons();
      renderResults();
    }
  }

  /** Stops the active scan. */
  function stopScan() {
    if (!state.running) return;
    state.stopRequested = true;
    if (state.controller) state.controller.abort();
    setStatus('Menghentikan proses...');
  }

  /** Reads UI values into config. */
  function readConfigFromUi() {
    const n = state.nodes;
    state.config.subfolder = normalizeSubfolder(n.subfolder.value);
    state.config.patternPresetKeys = checkedPatternPresetKeys();
    state.config.customPatterns = n.customPatterns.value;
    state.config.patterns = buildEffectivePatternString(state.config);
    state.config.manualDocs = n.manualDocs.value;
    state.config.useDirectProbe = true;
    state.config.initReaderBeforeProbe = Boolean(n.initReaderBeforeProbe.checked);
    state.config.usePageLinks = Boolean(n.usePageLinks.checked);
    state.config.usePatterns = Boolean(n.usePatterns.checked);
    state.config.maxPage = Math.max(1, Math.min(2000, Number(n.maxPage.value) || DEFAULTS.maxPage));
    state.config.delayMs = Math.max(0, Math.min(10000, Number(n.delayMs.value) || DEFAULTS.delayMs));
    state.config.timeoutMs = Math.max(3000, Math.min(60000, Number(n.timeoutMs.value) || DEFAULTS.timeoutMs));
    if (n.outputFormatRadios) state.config.outputFormat = (n.outputFormatRadios.find(input => input.checked) || {}).value || DEFAULTS.outputFormat;
    if (n.outputBundleRadios) state.config.outputBundle = (n.outputBundleRadios.find(input => input.checked) || {}).value || DEFAULTS.outputBundle;
    if (state.config.outputFormat === 'png') state.config.outputBundle = 'zip';
    state.config.pdfSearchable = isPdfSearchableSelected();
    state.config.compact = state.ui.classList.contains('nss-compact');
  }

  /** Sets status text. */
  function setStatus(message, isError = false) {
    if (!state.nodes.status) return;
    state.nodes.status.textContent = message;
    state.nodes.status.classList.toggle('is-error', Boolean(isError));
  }

  /** Updates main buttons. */
  function updateButtons() {
    const n = state.nodes;
    if (!n.scanBtn) return;
    n.scanBtn.disabled = state.running;
    n.stopBtn.disabled = !state.running;
    n.exportBtn.disabled = !state.results.length;
    if (n.downloadModeBtn) n.downloadModeBtn.disabled = state.running || !selectedResults().length;
    n.clearBtn.disabled = state.running || !state.results.length;
  }

  /** Escapes HTML. */
  function escapeHtml(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  /** Renders result table. */
  function renderResults() {
    const body = state.nodes.resultBody;
    const summary = state.nodes.summary;
    if (!body || !summary) return;
    const valid = state.results.filter(r => r.valid);
    const invalid = state.results.filter(r => !r.valid);
    const pages = valid.reduce((sum, r) => sum + Number(r.pages || 0), 0);
    summary.innerHTML = `
      <div><strong>${valid.length}</strong><span>dokumen</span></div>
      <div><strong>${pages}</strong><span>halaman</span></div>
      <div><strong>${invalid.length}</strong><span>tidak cocok</span></div>
    `;

    if (!state.results.length) {
      body.innerHTML = `<tr><td colspan="7" class="nss-empty">Belum ada hasil. Isi subfolder lalu klik Cek Subfolder.</td></tr>`;
      updateButtons();
      return;
    }

    body.innerHTML = state.results.map((r, idx) => {
      const status = r.valid ? 'Tersedia' : 'Tidak ditemukan';
      const dim = r.width && r.height ? `${r.width}×${r.height}` : '-';
      const open = r.valid ? `<a href="${escapeHtml(r.readerUrl)}" target="_blank" rel="noopener">Buka</a>` : '';
      const zipBtn = r.valid ? `<button type="button" class="nss-mini" data-nss-zip-one="${idx}">ZIP PNG</button><button type="button" class="nss-mini" data-nss-pdf-one="${idx}">PDF</button><button type="button" class="nss-mini" data-nss-txt-one="${idx}">TXT</button><button type="button" class="nss-mini" data-nss-md-one="${idx}">MD</button>` : '';
      const sources = (r.candidateSources || []).join(', ') || '-';
      return `
        <tr class="${r.valid ? 'is-valid' : 'is-muted'}">
          <td>${r.valid ? `<input type="checkbox" data-nss-select="${idx}" ${r.selected ? 'checked' : ''}>` : ''}</td>
          <td><strong>${escapeHtml(r.label)}</strong><small>${escapeHtml(r.doc)}</small></td>
          <td>${escapeHtml(r.group)}</td>
          <td>${r.valid ? escapeHtml(r.pages) : '-'}</td>
          <td>${escapeHtml(dim)}</td>
          <td><small>${escapeHtml(sources)}</small></td>
          <td><span class="nss-pill ${r.valid ? 'ok' : 'bad'}">${escapeHtml(status)}</span>${open}${zipBtn}<small>${escapeHtml(r.note || '')}</small></td>
        </tr>
      `;
    }).join('');

    body.querySelectorAll('[data-nss-zip-one]').forEach(button => {
      button.addEventListener('click', event => {
        const index = Number(event.currentTarget.getAttribute('data-nss-zip-one'));
        if (state.results[index]) downloadOneDocument(state.results[index]);
      });
    });

    body.querySelectorAll('[data-nss-pdf-one]').forEach(button => {
      button.addEventListener('click', event => {
        const index = Number(event.currentTarget.getAttribute('data-nss-pdf-one'));
        if (state.results[index]) downloadPdfForDocument(state.results[index]);
      });
    });

    body.querySelectorAll('[data-nss-txt-one]').forEach(button => {
      button.addEventListener('click', event => {
        const index = Number(event.currentTarget.getAttribute('data-nss-txt-one'));
        if (state.results[index]) downloadTextForDocument(state.results[index], 'txt');
      });
    });

    body.querySelectorAll('[data-nss-md-one]').forEach(button => {
      button.addEventListener('click', event => {
        const index = Number(event.currentTarget.getAttribute('data-nss-md-one'));
        if (state.results[index]) downloadTextForDocument(state.results[index], 'md');
      });
    });

    body.querySelectorAll('[data-nss-select]').forEach(input => {
      input.addEventListener('change', event => {
        const index = Number(event.currentTarget.getAttribute('data-nss-select'));
        if (state.results[index]) state.results[index].selected = event.currentTarget.checked;
        updateButtons();
      });
    });
    updateButtons();
  }

  /** Renders logs. */
  function renderLogs() {
    if (state.nodes.logs) state.nodes.logs.textContent = state.logs.join('\n') || 'Belum ada aktivitas.';
  }


  /** Converts a string into a safe file or folder name. */
  function safeName(value, fallback = 'dokumen') {
    return String(value || '')
      .normalize('NFKC')
      .replace(/[\x00-\x1f\x7f<>:"/\\|?*]+/g, '-')
      .replace(/\s+/g, ' ')
      .replace(/[. ]+$/g, '')
      .trim()
      .slice(0, 140) || fallback;
  }

  /** Builds a readable folder name for a scan result. */
  function documentFolderName(result, orderIndex = 0) {
    const order = String(orderIndex + 1).padStart(2, '0');
    const label = safeName(result && result.label || result && result.doc || 'Dokumen');
    const doc = safeName(String(result && result.doc || '').replace(/\.pdf$/i, ''), 'dokumen');
    return `${order}_${label}_${doc}`.replace(/-+/g, '-');
  }

  /** Downloads a Blob with a browser-safe file name. */
  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = safeName(filename, 'nemo-download.zip');
    document.documentElement.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 20000);
  }

  /** Encodes text as UTF-8. */
  const textEncoder = new TextEncoder();

  /** Precomputed CRC table for ZIP creation. */
  const CRC_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let i = 0; i < 256; i += 1) {
      let c = i;
      for (let k = 0; k < 8; k += 1) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
      table[i] = c >>> 0;
    }
    return table;
  })();

  /** Calculates CRC32 for ZIP entries. */
  function crc32(bytes) {
    let c = 0xffffffff;
    for (let i = 0; i < bytes.length; i += 1) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }

  /** Writes a 16-bit little-endian value. */
  function u16(view, offset, value) { view.setUint16(offset, value, true); }

  /** Writes a 32-bit little-endian value. */
  function u32(view, offset, value) { view.setUint32(offset, value >>> 0, true); }

  /** Converts a Date into DOS time/date fields. */
  function dosDateTime(date = new Date()) {
    const year = Math.max(1980, Math.min(2107, date.getFullYear()));
    return {
      time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
      date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()
    };
  }

  /** Creates a basic ZIP file without compression. */
  async function createZip(files) {
    const localParts = [];
    const centralParts = [];
    let offset = 0;
    const now = dosDateTime(new Date());

    for (const file of files) {
      if (state.stopRequested) throw new Error('Proses dihentikan.');
      const path = String(file.name || 'file.bin').replace(/^\/+/, '');
      const nameBytes = textEncoder.encode(path);
      let data;
      if (file.blob instanceof Blob) data = new Uint8Array(await file.blob.arrayBuffer());
      else if (file.bytes instanceof Uint8Array) data = file.bytes;
      else data = textEncoder.encode(String(file.text ?? ''));

      const crc = crc32(data);
      const local = new ArrayBuffer(30 + nameBytes.length);
      const lv = new DataView(local);
      u32(lv, 0, 0x04034b50);
      u16(lv, 4, 20);
      u16(lv, 6, 0x0800);
      u16(lv, 8, 0);
      u16(lv, 10, now.time);
      u16(lv, 12, now.date);
      u32(lv, 14, crc);
      u32(lv, 18, data.length);
      u32(lv, 22, data.length);
      u16(lv, 26, nameBytes.length);
      u16(lv, 28, 0);
      new Uint8Array(local, 30).set(nameBytes);
      localParts.push(local, data);

      const central = new ArrayBuffer(46 + nameBytes.length);
      const cv = new DataView(central);
      u32(cv, 0, 0x02014b50);
      u16(cv, 4, 20);
      u16(cv, 6, 20);
      u16(cv, 8, 0x0800);
      u16(cv, 10, 0);
      u16(cv, 12, now.time);
      u16(cv, 14, now.date);
      u32(cv, 16, crc);
      u32(cv, 20, data.length);
      u32(cv, 24, data.length);
      u16(cv, 28, nameBytes.length);
      u16(cv, 30, 0);
      u16(cv, 32, 0);
      u16(cv, 34, 0);
      u16(cv, 36, 0);
      u32(cv, 38, 0);
      u32(cv, 42, offset);
      new Uint8Array(central, 46).set(nameBytes);
      centralParts.push(central);
      offset += local.byteLength + data.length;
    }

    const centralSize = centralParts.reduce((sum, part) => sum + part.byteLength, 0);
    const end = new ArrayBuffer(22);
    const ev = new DataView(end);
    u32(ev, 0, 0x06054b50);
    u16(ev, 4, 0);
    u16(ev, 6, 0);
    u16(ev, 8, files.length);
    u16(ev, 10, files.length);
    u32(ev, 12, centralSize);
    u32(ev, 16, offset);
    u16(ev, 20, 0);
    return new Blob([...localParts, ...centralParts, end], { type: 'application/zip' });
  }

  /** Fetches one PNG page for download. */
  async function fetchPagePngBlob(result, page) {
    if (state.stopRequested) throw new Error('Proses dihentikan.');
    const serviceDoc = result.serviceDoc || toServiceDoc(result.doc);
    const url = buildImageUrl(result.doc, page, 'png', serviceDoc);
    const timeout = Math.max(3000, Number(state.config.timeoutMs) || DEFAULTS.timeoutMs);
    const local = new AbortController();
    const timer = setTimeout(() => local.abort(), timeout);
    try {
      const signal = state.controller && typeof AbortSignal !== 'undefined' && typeof AbortSignal.any === 'function'
        ? AbortSignal.any([state.controller.signal, local.signal])
        : local.signal;
      const response = await fetch(url, { method: 'GET', credentials: 'include', cache: 'force-cache', signal });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const blob = await response.blob();
      if (!/^image\/png(?:;|$)/i.test(blob.type || response.headers.get('content-type') || '')) throw new Error('Bukan PNG');
      if (blob.size < 512) throw new Error('Gambar terlalu kecil');
      return { ok: true, page, blob, sizeBytes: blob.size, url };
    } catch (error) {
      return { ok: false, page, blob: null, sizeBytes: 0, url, note: String(error && error.message || error) };
    } finally {
      clearTimeout(timer);
    }
  }

  /** Builds ZIP entries for one scanned document. */
  async function collectPngEntriesForDocument(result, folderName, totalIndex, totalDocs) {
    const files = [];
    const failures = [];
    const pages = Math.max(0, Number(result.pages) || 0);
    await initializeReaderDocument(result.doc);

    for (let page = 1; page <= pages; page += 1) {
      if (state.stopRequested) throw new Error('Proses dihentikan.');
      setStatus(`Mengambil ${result.label} halaman ${page}/${pages} (${totalIndex + 1}/${totalDocs})`);
      const item = await fetchPagePngBlob(result, page);
      if (item.ok) {
        files.push({ name: `${folderName}/png/page-${String(page).padStart(3, '0')}.png`, blob: item.blob });
      } else {
        failures.push({ page, note: item.note || 'Gagal' });
        log(`${result.doc} halaman ${page}: gagal (${item.note || 'gagal'}).`);
      }
      if (Number(state.config.delayMs) > 0) await sleep(Number(state.config.delayMs));
    }

    const manifest = {
      doc: result.doc,
      label: result.label,
      group: result.group,
      serviceDoc: result.serviceDoc,
      pages,
      downloadedPages: files.filter(file => /\/png\/page-/.test(file.name)).length,
      failedPages: failures,
      width: result.width || null,
      height: result.height || null,
      createdAt: new Date().toISOString()
    };
    files.push({ name: `${folderName}/manifest.json`, text: JSON.stringify(manifest, null, 2) });
    return { files, manifest };
  }

  /** Returns selected valid scan results. */
  function selectedResults() {
    return state.results.filter(item => item.valid && item.selected && Number(item.pages) > 0);
  }

  /** Warns before large downloads. */
  function confirmLargeDownload(items) {
    const pages = items.reduce((sum, item) => sum + Number(item.pages || 0), 0);
    if (pages <= 250) return true;
    return confirm(`Anda akan mengambil ${pages} halaman. Proses bisa lama dan memakai memori browser. Lanjutkan?`);
  }

  /** Downloads PNG pages for one document as ZIP. */
  async function downloadOneDocument(result) {
    if (state.running || !result || !result.valid) return;
    if (!confirmLargeDownload([result])) return;
    state.running = true;
    state.stopRequested = false;
    state.controller = new AbortController();
    state.downloadStats = { mode: 'single', startedAt: new Date().toISOString(), doc: result.doc };
    updateButtons();
    try {
      const folder = documentFolderName(result, 0);
      log(`Mulai unduh ${result.doc}.`);
      const bundle = await collectPngEntriesForDocument(result, folder, 0, 1);
      if (!bundle.manifest.downloadedPages) throw new Error('Tidak ada halaman yang berhasil diambil.');
      const zip = await createZip(bundle.files);
      const safeSubfolder = safeName(normalizeSubfolder(state.config.subfolder).replace(/\/+$/g, ''), 'subfolder');
      const filename = `${safeSubfolder}-${safeName(result.doc.replace(/\.pdf$/i, ''))}-png.zip`;
      downloadBlob(zip, filename);
      setStatus(`ZIP ${result.label} selesai. ${bundle.manifest.downloadedPages}/${result.pages} halaman.`);
      log(`ZIP ${result.doc} selesai.`);
    } catch (error) {
      setStatus(`Unduh gagal: ${String(error && error.message || error)}`, true);
      log(`Unduh gagal: ${String(error && error.message || error)}`);
    } finally {
      state.running = false;
      state.stopRequested = false;
      state.controller = null;
      updateButtons();
    }
  }

  /** Downloads selected documents as one ZIP containing PNG folders. */
  async function downloadSelectedDocuments() {
    if (state.running) return;
    const items = selectedResults();
    if (!items.length) {
      alert('Pilih minimal satu dokumen valid.');
      return;
    }
    if (!confirmLargeDownload(items)) return;

    state.running = true;
    state.stopRequested = false;
    state.controller = new AbortController();
    state.downloadStats = { mode: 'selected', startedAt: new Date().toISOString(), docs: items.map(item => item.doc) };
    updateButtons();
    const allFiles = [];
    const manifests = [];
    try {
      log(`Mulai unduh ${items.length} dokumen terpilih.`);
      for (let i = 0; i < items.length; i += 1) {
        if (state.stopRequested) throw new Error('Proses dihentikan.');
        const result = items[i];
        const folder = documentFolderName(result, i);
        const bundle = await collectPngEntriesForDocument(result, folder, i, items.length);
        allFiles.push(...bundle.files);
        manifests.push(bundle.manifest);
      }
      allFiles.push({ name: 'manifest.json', text: JSON.stringify({
        app: 'Nemo Subfolder Studio Downloader',
        version: APP_VERSION,
        subfolder: normalizeSubfolder(state.config.subfolder),
        createdAt: new Date().toISOString(),
        documents: manifests,
        totals: {
          documents: manifests.length,
          pages: manifests.reduce((sum, item) => sum + Number(item.pages || 0), 0),
          downloadedPages: manifests.reduce((sum, item) => sum + Number(item.downloadedPages || 0), 0),
          failedPages: manifests.reduce((sum, item) => sum + (item.failedPages || []).length, 0)
        }
      }, null, 2) });
      const zip = await createZip(allFiles);
      const safeSubfolder = safeName(normalizeSubfolder(state.config.subfolder).replace(/\/+$/g, ''), 'subfolder');
      downloadBlob(zip, `${safeSubfolder}-png-terpilih.zip`);
      const totalPages = manifests.reduce((sum, item) => sum + Number(item.downloadedPages || 0), 0);
      setStatus(`ZIP terpilih selesai. ${manifests.length} dokumen, ${totalPages} halaman berhasil.`);
      log(`ZIP terpilih selesai: ${manifests.length} dokumen.`);
    } catch (error) {
      setStatus(`Unduh terpilih gagal: ${String(error && error.message || error)}`, true);
      log(`Unduh terpilih gagal: ${String(error && error.message || error)}`);
    } finally {
      state.running = false;
      state.stopRequested = false;
      state.controller = null;
      updateButtons();
    }
  }


  /** Decodes a few common HTML entities and strips markup from native text fragments. */
  function cleanTextFragment(value) {
    const raw = String(value ?? '');
    // Use template element when available to safely strip HTML (same approach as v2.11.1 M()).
    try {
      const tpl = document.createElement('template');
      tpl.innerHTML = raw.replace(/<br\s*\/?>/gi, '\n').replace(/<\/p\s*>/gi, '\n');
      return String(tpl.content.textContent || '')
        .replace(/[\u00A0\u2007\u202F]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    } catch {
      // Fallback: regex-based stripping.
      return raw
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ')
        .replace(/[\u00A0\u2007\u202F]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    }
  }

  /** Converts one FlowPaper text item into a normalized token. */
  function normalizeTextToken(item, index = 0) {
    if (Array.isArray(item)) {
      // Priority: FlowPaper's [top, left, width, height, font, "text"] 6-element format.
      if (item.length >= 6 && item.slice(0, 5).every(v => Number.isFinite(Number(v))) && typeof item[5] === 'string') {
        const text = cleanTextFragment(item[5]);
        if (!text) return null;
        return {
          index,
          top: Number(item[0]),
          left: Number(item[1]),
          width: Math.max(0, Number(item[2])),
          height: Math.max(1, Number(item[3])),
          font: Number(item[4]) || null,
          text
        };
      }
      // Fallback: find string in any position, collect numbers in order.
      const strIndex = item.findIndex(value => typeof value === 'string');
      if (strIndex < 0) return null;
      const text = cleanTextFragment(item[strIndex]);
      const numbers = item.filter(value => Number.isFinite(Number(value))).map(Number);
      if (!text || numbers.length < 4) return null;
      return {
        index,
        top: numbers[0],
        left: numbers[1],
        width: Math.max(0, numbers[2]),
        height: Math.max(1, numbers[3]),
        font: Number.isFinite(numbers[4]) ? numbers[4] : null,
        text
      };
    }
    if (item && typeof item === 'object') {
      const text = cleanTextFragment(item.text ?? item.data ?? item.value ?? item.t ?? '');
      const top = Number(item.top ?? item.y ?? item.t);
      const left = Number(item.left ?? item.x ?? item.l);
      const width = Number(item.width ?? item.w ?? 0);
      const height = Number(item.height ?? item.h ?? 1);
      if (!text || !Number.isFinite(top) || !Number.isFinite(left)) return null;
      return { index, top, left, width: Math.max(0, width), height: Math.max(1, height), font: Number(item.font ?? item.f) || null, text };
    }
    return null;
  }

  /** Parses FlowPaper native JSON into page text objects. */
  function parseNativeJsonPayload(raw, anchor = null) {
    if (!raw || !String(raw).trim()) return [];
    let data;
    try { data = JSON.parse(raw); } catch { return []; }
    const pages = Array.isArray(data) ? data : (Array.isArray(data.pages) ? data.pages : [data]);
    return pages.map(page => {
      if (!page || typeof page !== 'object') return null;
      const number = Number(page.number ?? page.page ?? page.pageNumber);
      const width = Number(page.width ?? page.w ?? 0);
      const height = Number(page.height ?? page.h ?? 0);
      const items = Array.isArray(page.text) ? page.text : (Array.isArray(page.texts) ? page.texts : []);
      const tokens = items.map(normalizeTextToken).filter(Boolean);
      if (!Number.isInteger(number) || number < 1 || !tokens.length) return null;
      return {
        page: number,
        anchor,
        width: width > 0 ? width : Math.max(...tokens.map(t => t.left + t.width), 1),
        height: height > 0 ? height : Math.max(...tokens.map(t => t.top + t.height), 1),
        tokens,
        tokenCount: tokens.length
      };
    }).filter(Boolean);
  }

  /** Fetches one native text anchor and returns parsed text pages. */
  async function fetchNativeTextAnchor(result, anchor) {
    const serviceDoc = result.serviceDoc || toServiceDoc(result.doc);
    const key = `${normalizeSubfolder(state.config.subfolder).toLowerCase()}|${String(serviceDoc).toLowerCase()}|json|${anchor}`;
    if (state.nativeTextCache.has(key)) return state.nativeTextCache.get(key);

    const timeout = Math.max(3000, Number(state.config.timeoutMs) || DEFAULTS.timeoutMs);
    const local = new AbortController();
    const timer = setTimeout(() => local.abort(), timeout);
    const url = buildTextUrl(result.doc, anchor, serviceDoc);
    let output = { ok: false, anchor, pages: [], status: null, sizeBytes: 0, note: '' };
    try {
      const signal = state.controller && typeof AbortSignal !== 'undefined' && typeof AbortSignal.any === 'function'
        ? AbortSignal.any([state.controller.signal, local.signal])
        : local.signal;
      const response = await fetch(url, { credentials: 'include', cache: 'force-cache', signal });
      output.status = response.status;
      if (!response.ok) {
        output.note = `HTTP ${response.status}`;
      } else {
        const raw = await response.text();
        output.sizeBytes = raw.length;
        output.pages = parseNativeJsonPayload(raw, anchor);
        output.ok = output.pages.length > 0;
        output.note = output.ok ? 'OK' : 'Kosong';
      }
    } catch (error) {
      output.note = error && error.name === 'AbortError' ? 'Dibatalkan atau timeout' : String(error && error.message || error);
    } finally {
      clearTimeout(timer);
    }
    state.nativeTextCache.set(key, output);
    return output;
  }

  /** Detects the offset used by FlowPaper JSON anchors for one document. */
  async function detectNativeTextOffset(result) {
    const pages = Math.max(1, Number(result.pages) || 1);
    const anchors = Array.from(new Set([1, 2, 3, 10, 11, 12, 20, 21, Math.min(pages + 10, Number(state.config.maxPage) || 300)].filter(n => Number.isInteger(n) && n > 0)));
    for (const anchor of anchors) {
      if (state.stopRequested) throw new Error('Proses dihentikan.');
      const probe = await fetchNativeTextAnchor(result, anchor);
      const page = probe.pages && probe.pages[0];
      if (page && Number.isInteger(page.page) && page.page >= 1 && page.page <= pages) {
        return { offset: anchor - page.page, sampleAnchor: anchor, samplePage: page.page, ok: true };
      }
      if (Number(state.config.delayMs) > 0) await sleep(Math.min(250, Number(state.config.delayMs)));
    }
    return { offset: 0, sampleAnchor: null, samplePage: null, ok: false };
  }

  /** Reads native text for all pages in a document. */
  async function collectNativeTextForDocument(result) {
    const pages = Math.max(0, Number(result.pages) || 0);
    const byPage = new Map();
    const offsetInfo = await detectNativeTextOffset(result);
    const fallbackOffsets = offsetInfo.ok ? [offsetInfo.offset] : [0, 10, 20, 30, 40];

    for (let page = 1; page <= pages; page += 1) {
      if (state.stopRequested) throw new Error('Proses dihentikan.');
      setStatus(`Membaca teks ${result.label} halaman ${page}/${pages}`);
      for (const offset of fallbackOffsets) {
        const anchor = page + offset;
        if (anchor < 1) continue;
        const payload = await fetchNativeTextAnchor(result, anchor);
        for (const textPage of payload.pages || []) {
          if (textPage.page >= 1 && textPage.page <= pages && !byPage.has(textPage.page)) byPage.set(textPage.page, textPage);
        }
        if (byPage.has(page)) break;
      }
      if (Number(state.config.delayMs) > 0) await sleep(Math.min(350, Number(state.config.delayMs)));
    }
    return { offsetInfo, pages: Array.from(byPage.values()).sort((a, b) => a.page - b.page) };
  }

  /** Groups native text tokens into readable lines. */
  function nativePageToLines(textPage) {
    if (!textPage || !Array.isArray(textPage.tokens)) return [];
    const tokens = textPage.tokens.slice().sort((a, b) => (a.top - b.top) || (a.left - b.left) || (a.index - b.index));
    const heights = tokens.map(t => t.height).filter(Number.isFinite).sort((a, b) => a - b);
    const medianHeight = heights.length ? heights[Math.floor(heights.length / 2)] : 12;
    const lines = [];
    for (const token of tokens) {
      let line = lines.find(row => Math.abs(row.top - token.top) <= Math.max(3, medianHeight * 0.55));
      if (!line) {
        line = { top: token.top, tokens: [] };
        lines.push(line);
      }
      line.tokens.push(token);
      line.top = Math.min(line.top, token.top);
    }
    return lines.sort((a, b) => a.top - b.top).map(line => {
      const parts = line.tokens.slice().sort((a, b) => a.left - b.left || a.index - b.index).map(t => t.text).filter(Boolean);
      return parts.join(' ').replace(/\s+([,.;:!?%)])/g, '$1').replace(/([(])\s+/g, '$1').replace(/\s+/g, ' ').trim();
    }).filter(Boolean);
  }

  /** Builds plain text for one document. */
  function buildPlainText(result, nativeBundle) {
    const pages = nativeBundle && nativeBundle.pages ? nativeBundle.pages : [];
    const out = [`${result.label} - ${result.doc}`, `Subfolder: ${normalizeSubfolder(state.config.subfolder)}`, `Halaman: ${result.pages || 0}`, ''];
    for (const page of pages) {
      out.push(`===== Halaman ${page.page} =====`);
      const lines = nativePageToLines(page);
      out.push(lines.join('\n') || '[Teks tidak tersedia]');
      out.push('');
    }
    if (!pages.length) out.push('[Teks asli tidak tersedia untuk dokumen ini.]');
    return out.join('\n').replace(/\n{4,}/g, '\n\n\n');
  }

  /** Builds Markdown for one document. */
  function buildMarkdown(result, nativeBundle) {
    const pages = nativeBundle && nativeBundle.pages ? nativeBundle.pages : [];
    const out = [`# ${result.label}`, '', `- Dokumen: ${result.doc}`, `- Subfolder: ${normalizeSubfolder(state.config.subfolder)}`, `- Halaman: ${result.pages || 0}`, ''];
    for (const page of pages) {
      out.push(`## Halaman ${page.page}`, '');
      const lines = nativePageToLines(page);
      out.push(lines.join('\n\n') || '_Teks tidak tersedia._');
      out.push('');
    }
    if (!pages.length) out.push('_Teks asli tidak tersedia untuk dokumen ini._');
    return out.join('\n').replace(/\n{4,}/g, '\n\n\n');
  }

  /** Converts a Blob into a Uint8Array. */
  async function blobToBytes(blob) {
    return new Uint8Array(await blob.arrayBuffer());
  }

  /** Concatenates Uint8Array values. */
  function concatBytes(chunks) {
    const total = chunks.reduce((sum, item) => sum + item.length, 0);
    const out = new Uint8Array(total);
    let offset = 0;
    for (const item of chunks) { out.set(item, offset); offset += item.length; }
    return out;
  }

  /** Converts bytes to uppercase hex. */
  function bytesToHex(bytes) {
    let out = '';
    for (const b of bytes) out += b.toString(16).padStart(2, '0').toUpperCase();
    return out;
  }

  /** Parses a PNG enough to embed it in a PDF without recompressing. */
  function parsePngForPdf(bytes) {
    const sig = [137, 80, 78, 71, 13, 10, 26, 10];
    for (let i = 0; i < sig.length; i += 1) if (bytes[i] !== sig[i]) throw new Error('PNG tidak valid.');
    const chunks = [];
    let offset = 8;
    let width = 0, height = 0, bitDepth = 0, colorType = 0;
    let palette = null;
    const idat = [];
    while (offset + 8 <= bytes.length) {
      const length = ((bytes[offset] << 24) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3]) >>> 0;
      const type = String.fromCharCode(bytes[offset + 4], bytes[offset + 5], bytes[offset + 6], bytes[offset + 7]);
      const dataStart = offset + 8;
      const dataEnd = dataStart + length;
      if (dataEnd + 4 > bytes.length) break;
      const data = bytes.slice(dataStart, dataEnd);
      chunks.push({ type, data });
      if (type === 'IHDR') {
        width = ((data[0] << 24) | (data[1] << 16) | (data[2] << 8) | data[3]) >>> 0;
        height = ((data[4] << 24) | (data[5] << 16) | (data[6] << 8) | data[7]) >>> 0;
        bitDepth = data[8];
        colorType = data[9];
      } else if (type === 'PLTE') {
        palette = data;
      } else if (type === 'IDAT') {
        idat.push(data);
      } else if (type === 'IEND') {
        break;
      }
      offset = dataEnd + 4;
    }
    if (!width || !height || !idat.length || bitDepth !== 8) throw new Error('PNG belum didukung untuk PDF.');
    let colors = 3;
    let colorSpace = '/DeviceRGB';
    if (colorType === 0) { colors = 1; colorSpace = '/DeviceGray'; }
    else if (colorType === 2) { colors = 3; colorSpace = '/DeviceRGB'; }
    else if (colorType === 3 && palette && palette.length >= 3) { colors = 1; colorSpace = `[/Indexed /DeviceRGB ${Math.floor(palette.length / 3) - 1} <${bytesToHex(palette)}>]`; }
    else throw new Error('PNG dengan alpha belum didukung untuk PDF.');
    return { width, height, bitDepth, colorType, colors, colorSpace, stream: concatBytes(idat) };
  }

  /** Converts an image blob to JPEG for PDF fallback. */
  async function convertImageBlobToJpegForPdf(blob) {
    const objectUrl = URL.createObjectURL(blob);
    try {
      const img = new Image();
      img.decoding = 'async';
      img.src = objectUrl;
      if (typeof img.decode === 'function') await img.decode();
      else await new Promise((resolve, reject) => { img.onload = resolve; img.onerror = reject; });
      const canvas = document.createElement('canvas');
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      const ctx = canvas.getContext('2d', { alpha: false });
      if (!ctx) throw new Error('Canvas PDF tidak tersedia.');
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0);
      const jpegBlob = await new Promise((resolve, reject) => canvas.toBlob(b => b ? resolve(b) : reject(new Error('JPEG PDF gagal dibuat.')), 'image/jpeg', 0.95));
      return { width: canvas.width, height: canvas.height, stream: await blobToBytes(jpegBlob), isJpeg: true };
    } finally {
      URL.revokeObjectURL(objectUrl);
    }
  }

  /** Formats a number for compact PDF content streams. */
  function pdfNum(value) {
    return Number(value).toFixed(3).replace(/\.000$/, '').replace(/(\.\d*?)0+$/, '$1');
  }

  /** Limits a value to a safe numeric range. */
  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  /** Escapes a PDF literal string using the same simple WinAnsi-safe path as Nemo bookmarklet. */
  function pdfString(value) {
    return String(value ?? '')
      .replace(/[‘’‚‛]/g, "'")
      .replace(/[“”„‟]/g, '"')
      .replace(/[–—−]/g, '-')
      .replace(/…/g, '...')
      .replace(/\u00A0/g, ' ')
      .normalize('NFKD')
      .replace(/\p{M}/gu, '')
      .replace(/[^\x20-\x7E]/g, '?')
      .replace(/[\\()]/g, m => '\\' + m)
      .replace(/[\r\n]+/g, ' ');
  }

  /** Returns true if a token looks like InDesign metadata or structural noise. */
  function isNoiseToken(token) {
    const text = String(token.text || '');
    // InDesign/FlowPaper metadata patterns.
    if (/^<[A-Za-z].*>$/.test(text)) return true;           // <FlattenTransparency:...>
    if (/^\$\$.*\$\$/.test(text)) return true;              // $$tag$$
    if (/^<!--.*-->$/.test(text)) return true;              // HTML comments
    if (text.length > 120) return true;                     // Very long single-token = metadata
    // Single characters that land at position 0,0 are usually invisible placeholders.
    if (text.length === 1 && token.left === 0 && token.top === 0) return true;
    return false;
  }

  /** Returns a valid text box from one FlowPaper token. */
  function pdfTokenBox(token) {
    if (!token) return null;
    const x0 = Number(token.left);
    const y0 = Number(token.top);
    const width = Number(token.width);
    const height = Number(token.height);
    if (![x0, y0, width, height].every(Number.isFinite) || height <= 0) return null;
    // Allow zero-width boxes: we'll estimate width from text length below.
    return { x0, y0, width: Math.max(0, width), height };
  }

  /**
   * Creates an invisible word-level text layer for one PDF page.
   * Follows Nemo bookmarklet v2.11.1: one text operator per word/token,
   * adjusted baseline, and horizontal scaling so selection boxes follow the image text.
   *
   * Improvements over v1.2.2:
   * - Skips InDesign metadata and noise tokens.
   * - Estimates box width when JSON returns 0 (avoids invisible/collapsed selection).
   * - PDF page size converted to points (0.75×pixels, capped at 14000pt) so files
   *   display at a sensible size in PDF viewers, matching v2.11.1 behaviour.
   */
  function pdfTextLayerCommands(textPage, pngWidth, pngHeight) {
    if (!textPage || !Array.isArray(textPage.tokens) || !textPage.tokens.length) return '';
    const coordWidth  = Math.max(1, Number(textPage.width)  || pngWidth);
    const coordHeight = Math.max(1, Number(textPage.height) || pngHeight);
    // Convert pixel dimensions to PDF points (72 pt/inch at 96 dpi = 0.75×), cap at 14 000 pt.
    const scale = Math.min(1, 14000 / Math.max(pngWidth * 0.75, pngHeight * 0.75));
    const pdfWidth  = pngWidth  * 0.75 * scale;
    const pdfHeight = pngHeight * 0.75 * scale;
    const sx = pdfWidth  / coordWidth;
    const sy = pdfHeight / coordHeight;
    const cap   = 0.718;
    const desc  = 0.207;
    const total = cap + desc;
    const parts = ['BT', '3 Tr', '/F1 8 Tf'];
    let count = 0;

    const tokens = textPage.tokens.slice().sort((a, b) => (a.top - b.top) || (a.left - b.left) || (a.index - b.index));
    for (const token of tokens) {
      if (isNoiseToken(token)) continue;
      const box = pdfTokenBox(token);
      if (!box || box.y0 >= coordHeight) continue;
      const text = pdfString(token.text).trim();
      if (!text || /^\?+$/.test(text)) continue;

      const pdfX   = clamp(box.x0 * sx, 0, pdfWidth);
      const pdfH   = clamp(box.height * sy, 2, 72);
      const fontSize = clamp(pdfH / total, 3, 78);
      // Estimate box width when JSON gives 0: use character count × font size × 0.49 (em factor).
      const charCount = Math.max(1, Array.from(text).length);
      const rawPdfW = box.width > 0 ? box.width * sx : charCount * fontSize * 0.49;
      const pdfW   = clamp(rawPdfW, 0.5, pdfWidth);
      const pdfYTop  = clamp(pdfHeight - (box.y0 * sy), 0, pdfHeight);
      const baseline = clamp(pdfYTop - cap * fontSize, 0, pdfHeight);
      const textScale = clamp(pdfW / Math.max(0.5, charCount * fontSize * 0.49) * 100, 18, 320);

      parts.push(`/F1 ${pdfNum(fontSize)} Tf`);
      parts.push(`${pdfNum(textScale)} Tz`);
      parts.push(`1 0 0 1 ${pdfNum(pdfX)} ${pdfNum(baseline)} Tm`);
      parts.push(`(${text}) Tj`);
      count += 1;
    }
    if (!count) return '';
    parts.push('ET');
    return `${parts.join('\n')}\n`;
  }

  /**
   * Returns the effective PDF page dimensions in points for a given PNG image.
   * Matches the wn() function in Nemo bookmarklet v2.11.1.
   */
  function pngToPdfPageSize(pngWidth, pngHeight) {
    const scale = Math.min(1, 14000 / Math.max(pngWidth * 0.75, pngHeight * 0.75, 1));
    return {
      width:  Number((pngWidth  * 0.75 * scale).toFixed(3)),
      height: Number((pngHeight * 0.75 * scale).toFixed(3))
    };
  }

  /** Builds PDF page records from downloaded images and optional text pages. */
  function makePdfPageRecords(imageItems, nativeBundle = null) {
    const textByPage = new Map((nativeBundle && nativeBundle.pages || []).map(page => [page.page, page]));
    return (imageItems || [])
      .filter(item => item && item.ok && item.blob)
      .map(item => ({ page: item.page, blob: item.blob, textPage: textByPage.get(item.page) || null }));
  }

  /** Builds a PDF from ordered page records. Text is included only when searchable is true. */
  async function createPdfFromPageRecords(pageRecords, options = {}) {
    const searchable = options.searchable !== false;
    const encoder = new TextEncoder();
    const objects = [null];
    const reserve = () => { objects.push(null); return objects.length - 1; };
    const setObj = (id, parts) => { objects[id] = Array.isArray(parts) ? parts : [String(parts)]; };
    const catalogId = reserve();
    const pagesId = reserve();
    const fontId = reserve();
    setObj(fontId, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');

    const pageIds = [];
    for (const record of pageRecords || []) {
      if (!record || !record.blob) continue;
      const imageId = reserve();
      const contentId = reserve();
      const pageId = reserve();
      pageIds.push(pageId);
      const bytes = await blobToBytes(record.blob);
      let image;
      let imageDict;
      try {
        image = parsePngForPdf(bytes);
        imageDict = `<< /Type /XObject /Subtype /Image /Width ${image.width} /Height ${image.height} /ColorSpace ${image.colorSpace} /BitsPerComponent 8 /Filter /FlateDecode /DecodeParms << /Predictor 15 /Colors ${image.colors} /BitsPerComponent 8 /Columns ${image.width} >> /Length ${image.stream.length} >>`;
      } catch {
        image = await convertImageBlobToJpegForPdf(record.blob);
        imageDict = `<< /Type /XObject /Subtype /Image /Width ${image.width} /Height ${image.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${image.stream.length} >>`;
      }
      setObj(imageId, [imageDict, '\nstream\n', image.stream, '\nendstream']);
      const pdfWidth = image.width;
      const pdfHeight = image.height;
      const pageSize = pngToPdfPageSize(pdfWidth, pdfHeight);
      const imageCmd = `q\n${pageSize.width} 0 0 ${pageSize.height} 0 0 cm\n/Im1 Do\nQ\n`;
      const textCmd = searchable ? pdfTextLayerCommands(record.textPage, pdfWidth, pdfHeight) : '';
      const contentBytes = encoder.encode(imageCmd + textCmd);
      setObj(contentId, [`<< /Length ${contentBytes.length} >>\nstream\n`, contentBytes, '\nendstream']);
      setObj(pageId, `<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${pageSize.width} ${pageSize.height}] /Resources << /XObject << /Im1 ${imageId} 0 R >> /Font << /F1 ${fontId} 0 R >> >> /Contents ${contentId} 0 R >>`);
    }
    setObj(pagesId, `<< /Type /Pages /Kids [${pageIds.map(id => `${id} 0 R`).join(' ')}] /Count ${pageIds.length} >>`);
    setObj(catalogId, `<< /Type /Catalog /Pages ${pagesId} 0 R >>`);

    const parts = [];
    const offsets = [0];
    let offset = 0;
    const pushPart = part => {
      parts.push(part);
      offset += typeof part === 'string' ? encoder.encode(part).length : part.length;
    };
    pushPart('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n');
    for (let id = 1; id < objects.length; id += 1) {
      offsets[id] = offset;
      pushPart(`${id} 0 obj\n`);
      for (const part of objects[id] || ['<<>>']) pushPart(part instanceof Uint8Array ? part : String(part));
      pushPart('\nendobj\n');
    }
    const xrefOffset = offset;
    pushPart(`xref\n0 ${objects.length}\n0000000000 65535 f \n`);
    for (let id = 1; id < objects.length; id += 1) pushPart(`${String(offsets[id]).padStart(10, '0')} 00000 n \n`);
    pushPart(`trailer << /Size ${objects.length} /Root ${catalogId} 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`);
    return new Blob(parts, { type: 'application/pdf' });
  }

  /** Builds a searchable PDF from PNG pages and native text when available. */
  async function createSearchablePdf(result, imageItems, nativeBundle, options = {}) {
    const records = makePdfPageRecords(imageItems, nativeBundle);
    return createPdfFromPageRecords(records, { searchable: options.searchable !== false });
  }

  /** Collects image pages only, without ZIP entry wrapping. */
  async function collectPngBlobsForDocument(result, totalIndex = 0, totalDocs = 1) {
    const pages = Math.max(0, Number(result.pages) || 0);
    await initializeReaderDocument(result.doc);
    const items = [];
    const failures = [];
    for (let page = 1; page <= pages; page += 1) {
      if (state.stopRequested) throw new Error('Proses dihentikan.');
      setStatus(`Mengambil gambar ${result.label} halaman ${page}/${pages} (${totalIndex + 1}/${totalDocs})`);
      const item = await fetchPagePngBlob(result, page);
      if (item.ok) items.push(item);
      else failures.push({ page, note: item.note || 'Gagal' });
      if (Number(state.config.delayMs) > 0) await sleep(Number(state.config.delayMs));
    }
    return { items, failures };
  }

  /** Downloads a PDF for one document. */
  async function downloadPdfForDocument(result, searchable = true) {
    if (state.running || !result || !result.valid) return;
    if (!confirmLargeDownload([result])) return;
    state.running = true;
    state.stopRequested = false;
    state.controller = new AbortController();
    updateButtons();
    try {
      log(`Mulai PDF ${result.doc}${searchable ? ' searchable' : ' gambar saja'}.`);
      const nativeBundle = searchable ? await collectNativeTextForDocument(result) : { pages: [], offsetInfo: null };
      const images = await collectPngBlobsForDocument(result, 0, 1);
      if (!images.items.length) throw new Error('Tidak ada halaman gambar yang berhasil diambil.');
      const pdf = await createSearchablePdf(result, images.items, nativeBundle, { searchable });
      const safeSubfolder = safeName(normalizeSubfolder(state.config.subfolder).replace(/\/+$/g, ''), 'subfolder');
      const suffix = searchable ? '' : '-gambar-saja';
      downloadBlob(pdf, `${safeSubfolder}-${safeName(result.doc.replace(/\.pdf$/i, ''))}${suffix}.pdf`);
      setStatus(`PDF ${result.label} selesai. ${images.items.length}/${result.pages} halaman.`);
      log(`PDF ${result.doc} selesai.${searchable ? ` Teks asli: ${nativeBundle.pages.length} halaman.` : ' Gambar saja.'}`);
    } catch (error) {
      setStatus(`PDF gagal: ${String(error && error.message || error)}`, true);
      log(`PDF gagal: ${String(error && error.message || error)}`);
    } finally {
      state.running = false;
      state.stopRequested = false;
      state.controller = null;
      updateButtons();
    }
  }

  /** Downloads TXT or Markdown for one document. */
  async function downloadTextForDocument(result, format = 'txt') {
    if (state.running || !result || !result.valid) return;
    state.running = true;
    state.stopRequested = false;
    state.controller = new AbortController();
    updateButtons();
    try {
      log(`Mulai ${format.toUpperCase()} ${result.doc}.`);
      const nativeBundle = await collectNativeTextForDocument(result);
      const content = format === 'md' ? buildMarkdown(result, nativeBundle) : buildPlainText(result, nativeBundle);
      const blob = new Blob([content], { type: format === 'md' ? 'text/markdown;charset=utf-8' : 'text/plain;charset=utf-8' });
      const safeSubfolder = safeName(normalizeSubfolder(state.config.subfolder).replace(/\/+$/g, ''), 'subfolder');
      const base = `${safeSubfolder}-${safeName(result.doc.replace(/\.pdf$/i, ''))}`;
      downloadBlob(blob, `${base}.${format === 'md' ? 'md' : 'txt'}`);
      setStatus(`${format.toUpperCase()} ${result.label} selesai. Teks asli: ${nativeBundle.pages.length}/${result.pages} halaman.`);
      log(`${format.toUpperCase()} ${result.doc} selesai.`);
    } catch (error) {
      setStatus(`${format.toUpperCase()} gagal: ${String(error && error.message || error)}`, true);
      log(`${format.toUpperCase()} gagal: ${String(error && error.message || error)}`);
    } finally {
      state.running = false;
      state.stopRequested = false;
      state.controller = null;
      updateButtons();
    }
  }

  /** Downloads selected documents as a ZIP of PDFs. */
  async function downloadPdfForSelectedDocuments(searchable = true) {
    if (state.running) return;
    const items = selectedResults();
    if (!items.length) return alert('Pilih minimal satu dokumen valid.');
    if (!confirmLargeDownload(items)) return;
    state.running = true;
    state.stopRequested = false;
    state.controller = new AbortController();
    updateButtons();
    const files = [];
    try {
      log(`Mulai ZIP PDF ${searchable ? 'searchable' : 'gambar saja'} untuk ${items.length} dokumen.`);
      for (let i = 0; i < items.length; i += 1) {
        const result = items[i];
        const folder = documentFolderName(result, i);
        const nativeBundle = searchable ? await collectNativeTextForDocument(result) : { pages: [], offsetInfo: null };
        const images = await collectPngBlobsForDocument(result, i, items.length);
        if (images.items.length) {
          const pdf = await createSearchablePdf(result, images.items, nativeBundle, { searchable });
          const suffix = searchable ? '' : '-gambar-saja';
          files.push({ name: `${folder}/${safeName(result.doc.replace(/\.pdf$/i, ''))}${suffix}.pdf`, blob: pdf });
        }
        files.push({ name: `${folder}/status.json`, text: JSON.stringify({ doc: result.doc, searchable, nativeTextPages: nativeBundle.pages.length, pages: result.pages, imagePages: images.items.length, failedImages: images.failures, offsetInfo: nativeBundle.offsetInfo || null }, null, 2) });
      }
      if (!files.some(file => /\.pdf$/i.test(file.name))) throw new Error('Tidak ada PDF yang berhasil dibuat.');
      const zip = await createZip(files);
      const safeSubfolder = safeName(normalizeSubfolder(state.config.subfolder).replace(/\/+$/g, ''), 'subfolder');
      downloadBlob(zip, `${safeSubfolder}-${searchable ? 'pdf-searchable' : 'pdf-gambar-saja'}-terpilih.zip`);
      setStatus(`ZIP PDF selesai. ${items.length} dokumen diproses.`);
      log('ZIP PDF selesai.');
    } catch (error) {
      setStatus(`ZIP PDF gagal: ${String(error && error.message || error)}`, true);
      log(`ZIP PDF gagal: ${String(error && error.message || error)}`);
    } finally {
      state.running = false;
      state.stopRequested = false;
      state.controller = null;
      updateButtons();
    }
  }

  /** Downloads selected documents as one combined PDF. */
  async function downloadCombinedPdfForSelectedDocuments(searchable = true) {
    if (state.running) return;
    const items = selectedResults();
    if (!items.length) return alert('Pilih minimal satu dokumen valid.');
    if (!confirmLargeDownload(items)) return;
    state.running = true;
    state.stopRequested = false;
    state.controller = new AbortController();
    updateButtons();
    const records = [];
    const manifest = [];
    try {
      log(`Mulai 1 PDF ${searchable ? 'searchable' : 'gambar saja'} untuk ${items.length} dokumen.`);
      for (let i = 0; i < items.length; i += 1) {
        const result = items[i];
        const nativeBundle = searchable ? await collectNativeTextForDocument(result) : { pages: [], offsetInfo: null };
        const textByPage = new Map((nativeBundle.pages || []).map(page => [page.page, page]));
        const images = await collectPngBlobsForDocument(result, i, items.length);
        for (const item of images.items) records.push({ page: item.page, blob: item.blob, textPage: textByPage.get(item.page) || null, doc: result.doc, label: result.label });
        manifest.push({ doc: result.doc, label: result.label, pages: result.pages, imagePages: images.items.length, failedImages: images.failures, nativeTextPages: nativeBundle.pages.length });
      }
      if (!records.length) throw new Error('Tidak ada halaman gambar yang berhasil diambil.');
      const pdf = await createPdfFromPageRecords(records, { searchable });
      const safeSubfolder = safeName(normalizeSubfolder(state.config.subfolder).replace(/\/+$/g, ''), 'subfolder');
      downloadBlob(pdf, `${safeSubfolder}-${searchable ? 'gabungan-searchable' : 'gabungan-gambar-saja'}.pdf`);
      const pages = records.length;
      setStatus(`PDF gabungan selesai. ${items.length} dokumen, ${pages} halaman.`);
      log(`PDF gabungan selesai. ${items.length} dokumen, ${pages} halaman.`);
      state.pdfStats = { mode: 'combined', searchable, documents: manifest, createdAt: new Date().toISOString() };
    } catch (error) {
      setStatus(`PDF gabungan gagal: ${String(error && error.message || error)}`, true);
      log(`PDF gabungan gagal: ${String(error && error.message || error)}`);
    } finally {
      state.running = false;
      state.stopRequested = false;
      state.controller = null;
      updateButtons();
    }
  }

  /** Downloads selected documents as a ZIP of TXT or Markdown files. */
  async function downloadTextForSelectedDocuments(format = 'txt') {
    if (state.running) return;
    const items = selectedResults();
    if (!items.length) return alert('Pilih minimal satu dokumen valid.');
    state.running = true;
    state.stopRequested = false;
    state.controller = new AbortController();
    updateButtons();
    const files = [];
    try {
      log(`Mulai ZIP ${format.toUpperCase()} ${items.length} dokumen.`);
      for (let i = 0; i < items.length; i += 1) {
        const result = items[i];
        const folder = documentFolderName(result, i);
        const nativeBundle = await collectNativeTextForDocument(result);
        const content = format === 'md' ? buildMarkdown(result, nativeBundle) : buildPlainText(result, nativeBundle);
        files.push({ name: `${folder}/${safeName(result.doc.replace(/\.pdf$/i, ''))}.${format === 'md' ? 'md' : 'txt'}`, text: content });
        files.push({ name: `${folder}/text-status.json`, text: JSON.stringify({ doc: result.doc, nativeTextPages: nativeBundle.pages.length, pages: result.pages, offsetInfo: nativeBundle.offsetInfo }, null, 2) });
      }
      const zip = await createZip(files);
      const safeSubfolder = safeName(normalizeSubfolder(state.config.subfolder).replace(/\/+$/g, ''), 'subfolder');
      downloadBlob(zip, `${safeSubfolder}-${format === 'md' ? 'markdown' : 'txt'}-terpilih.zip`);
      setStatus(`ZIP ${format.toUpperCase()} selesai. ${items.length} dokumen diproses.`);
      log(`ZIP ${format.toUpperCase()} selesai.`);
    } catch (error) {
      setStatus(`ZIP ${format.toUpperCase()} gagal: ${String(error && error.message || error)}`, true);
      log(`ZIP ${format.toUpperCase()} gagal: ${String(error && error.message || error)}`);
    } finally {
      state.running = false;
      state.stopRequested = false;
      state.controller = null;
      updateButtons();
    }
  }

  /** Downloads selected documents as one combined TXT or Markdown file. */
  async function downloadCombinedTextForSelectedDocuments(format = 'txt') {
    if (state.running) return;
    const items = selectedResults();
    if (!items.length) return alert('Pilih minimal satu dokumen valid.');
    state.running = true;
    state.stopRequested = false;
    state.controller = new AbortController();
    updateButtons();
    try {
      log(`Mulai 1 ${format.toUpperCase()} gabungan untuk ${items.length} dokumen.`);
      const parts = [];
      for (let i = 0; i < items.length; i += 1) {
        const result = items[i];
        const nativeBundle = await collectNativeTextForDocument(result);
        const content = format === 'md' ? buildMarkdown(result, nativeBundle) : buildPlainText(result, nativeBundle);
        if (format === 'md') {
          parts.push(content.replace(/^# /, `# ${i + 1}. `));
        } else {
          parts.push(content);
        }
        if (Number(state.config.delayMs) > 0) await sleep(Math.min(250, Number(state.config.delayMs)));
      }
      const combined = format === 'md' ? parts.join('\n\n---\n\n') : parts.join('\n\n==============================\n\n');
      const blob = new Blob([combined], { type: format === 'md' ? 'text/markdown;charset=utf-8' : 'text/plain;charset=utf-8' });
      const safeSubfolder = safeName(normalizeSubfolder(state.config.subfolder).replace(/\/+$/g, ''), 'subfolder');
      downloadBlob(blob, `${safeSubfolder}-gabungan.${format === 'md' ? 'md' : 'txt'}`);
      setStatus(`${format.toUpperCase()} gabungan selesai. ${items.length} dokumen diproses.`);
      log(`${format.toUpperCase()} gabungan selesai.`);
    } catch (error) {
      setStatus(`${format.toUpperCase()} gabungan gagal: ${String(error && error.message || error)}`, true);
      log(`${format.toUpperCase()} gabungan gagal: ${String(error && error.message || error)}`);
    } finally {
      state.running = false;
      state.stopRequested = false;
      state.controller = null;
      updateButtons();
    }
  }

  /** Runs the selected download mode. */
  async function runSelectedDownloadMode() {
    readConfigFromUi();
    saveConfig();
    const format = state.config.outputFormat || 'pdf';
    const bundle = format === 'png' ? 'zip' : (state.config.outputBundle || 'zip');
    const searchable = state.config.pdfSearchable !== false;
    if (format === 'png') return downloadSelectedDocuments();
    if (format === 'pdf' && bundle === 'zip') return downloadPdfForSelectedDocuments(searchable);
    if (format === 'pdf' && bundle === 'single') return downloadCombinedPdfForSelectedDocuments(searchable);
    if (format === 'txt' && bundle === 'zip') return downloadTextForSelectedDocuments('txt');
    if (format === 'txt' && bundle === 'single') return downloadCombinedTextForSelectedDocuments('txt');
    if (format === 'md' && bundle === 'zip') return downloadTextForSelectedDocuments('md');
    if (format === 'md' && bundle === 'single') return downloadCombinedTextForSelectedDocuments('md');
    alert('Mode unduhan belum dikenali.');
  }

  /** Updates the save mode summary and visibility. */
  function updateSaveModeUi() {
    const n = state.nodes;
    if (!n.outputFormatRadios) return;
    const format = (n.outputFormatRadios.find(input => input.checked) || {}).value || 'pdf';
    const bundle = format === 'png' ? 'zip' : ((n.outputBundleRadios || []).find(input => input.checked) || {}).value || 'zip';
    if (format === 'png') {
      for (const input of n.outputBundleRadios || []) input.checked = input.value === 'zip';
    }
    if (n.singleBundleOption) n.singleBundleOption.classList.toggle('is-disabled', format === 'png');
    if (n.pdfOptions) n.pdfOptions.hidden = format !== 'pdf';
    const labelFormat = format === 'png' ? 'Gambar PNG' : format === 'pdf' ? 'PDF' : format === 'txt' ? 'TXT' : 'Markdown';
    const labelBundle = bundle === 'single' ? '1 file gabungan' : 'ZIP per dokumen';
    const labelPdf = format === 'pdf' ? (isPdfSearchableSelected() ? ' · teks bisa dicari' : ' · gambar saja') : '';
    if (n.downloadPreview) n.downloadPreview.textContent = `Akan dibuat: ${labelFormat} · ${labelBundle}${labelPdf}`;
    updateButtons();
  }

  /** Returns the selected PDF text mode. */
  function isPdfSearchableSelected() {
    const radios = state.nodes.pdfSearchableRadios || [];
    const checked = radios.find(input => input.checked);
    return !checked || checked.value !== 'no';
  }

  /** Exports current scan as JSON. */
  function exportJson() {
    readConfigFromUi();
    const payload = {
      app: 'Nemo Subfolder Studio Downloader',
      version: APP_VERSION,
      exportedAt: new Date().toISOString(),
      origin: location.origin,
      pageUrl: location.href,
      config: state.config,
      checkedAt: state.checkedAt,
      candidateCount: state.candidates.length,
      candidates: state.candidates,
      summary: {
        documents: state.results.filter(r => r.valid).length,
        pages: state.results.filter(r => r.valid).reduce((sum, r) => sum + Number(r.pages || 0), 0),
        failedCandidates: state.results.filter(r => !r.valid).length
      },
      results: state.results,
      downloadStats: state.downloadStats,
      logs: state.logs
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const safeSubfolder = normalizeSubfolder(state.config.subfolder).replace(/[^a-z0-9_-]+/gi, '-').replace(/^-+|-+$/g, '') || 'subfolder';
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `nemo-subfolder-scan-${safeSubfolder}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
    document.documentElement.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 15000);
  }

  /** Clears result data. */
  function clearResults() {
    if (state.running) return;
    if (state.results.length && !confirm('Hapus hasil scan saat ini?')) return;
    state.candidates = [];
    state.results = [];
    state.checkedAt = null;
    setStatus('Hasil dikosongkan.');
    renderResults();
  }

  /** Infers subfolder from the active URL. */
  function inferSubfolderFromLocation() {
    try {
      const url = new URL(location.href);
      return normalizeSubfolder(url.searchParams.get('subfolder') || '');
    } catch { return ''; }
  }

  /** Builds UI. */
  function buildUi() {
    state.config = loadConfig();
    injectStyle();
    const old = document.getElementById(UI_ID);
    if (old) old.remove();

    const ui = document.createElement('section');
    ui.id = UI_ID;
    ui.dataset.nemoUi = 'true';
    ui.className = state.config.compact ? 'nss-compact' : '';
    ui.innerHTML = `
      <header class="nss-header">
        <div class="nss-brand">
          <strong>Nemo Capture Studio</strong>
          <span>Subfolder · v1.3.2</span>
        </div>
        <div class="nss-head-actions">
          <button type="button" data-nss="compact">${state.config.compact ? 'Detail' : 'Ringkas'}</button>
          <button type="button" data-nss="hide">Tutup</button>
        </div>
      </header>
      <div class="nss-content">
        <div class="nss-status-card">
          <div class="nss-status-title">Status</div>
          <div class="nss-status" data-nss="status">Siap. Isi subfolder lalu klik Cek.</div>
          <div class="nss-summary" data-nss="summary">
            <div><strong>0</strong><span>dokumen</span></div>
            <div><strong>0</strong><span>halaman</span></div>
            <div><strong>0</strong><span>gagal</span></div>
          </div>
        </div>

        <div class="nss-card nss-main">
          <div class="nss-step"><b>1</b><span>Mata kuliah</span></div>
          <label>Subfolder</label>
          <input data-nss="subfolder" placeholder="Contoh: EKSI441604/">
          <div class="nss-actions nss-primary-actions">
            <button type="button" class="primary" data-nss="scan">Cek</button>
            <button type="button" class="danger" data-nss="stop">Stop</button>
            <button type="button" data-nss="export">JSON</button>
          </div>
          <p class="nss-note">Isi kode subfolder. Nemo akan menyiapkan dokumen, memeriksa halaman, lalu menampilkan hasil yang bisa disimpan.</p>
        </div>

        <div class="nss-card nss-save-card">
          <div class="nss-step"><b>2</b><span>Simpan hasil</span></div>
          <div class="nss-mode-group">
            <div class="nss-mode-title">Format</div>
            <div class="nss-option-grid">
              <label class="nss-radio-card"><input type="radio" name="nss_output_format" value="png" data-nss-output-format><span>Gambar PNG</span></label>
              <label class="nss-radio-card"><input type="radio" name="nss_output_format" value="pdf" data-nss-output-format><span>PDF</span></label>
              <label class="nss-radio-card"><input type="radio" name="nss_output_format" value="txt" data-nss-output-format><span>TXT</span></label>
              <label class="nss-radio-card"><input type="radio" name="nss_output_format" value="md" data-nss-output-format><span>Markdown</span></label>
            </div>
          </div>
          <div class="nss-mode-group">
            <div class="nss-mode-title">Bentuk file</div>
            <div class="nss-option-grid two">
              <label class="nss-radio-card"><input type="radio" name="nss_output_bundle" value="zip" data-nss-output-bundle><span>ZIP per dokumen</span></label>
              <label class="nss-radio-card" data-nss="singleBundleOption"><input type="radio" name="nss_output_bundle" value="single" data-nss-output-bundle><span>1 file gabungan</span></label>
            </div>
          </div>
          <div class="nss-mode-group nss-pdf-options" data-nss="pdfOptions">
            <div class="nss-mode-title">Isi PDF</div>
            <div class="nss-option-grid two">
              <label class="nss-radio-card"><input type="radio" name="nss_pdf_searchable" value="yes" data-nss-pdf-searchable><span>Teks bisa dicari</span></label>
              <label class="nss-radio-card"><input type="radio" name="nss_pdf_searchable" value="no" data-nss-pdf-searchable><span>Gambar saja</span></label>
            </div>
          </div>
          <div class="nss-download-preview" data-nss="downloadPreview">Akan dibuat: PDF · ZIP per dokumen · teks bisa dicari</div>
          <div class="nss-actions nss-save-actions">
            <button type="button" class="primary" data-nss="downloadMode">Unduh Terpilih</button>
            <button type="button" data-nss="clear">Kosongkan</button>
          </div>
        </div>

        <details class="nss-card nss-advanced">
          <summary><span>Pencarian dokumen</span><em>opsional</em></summary>
          <div class="nss-checks">
            <label><input type="checkbox" data-nss="usePatterns"> Cari dari pola</label>
            <label><input type="checkbox" data-nss="initReaderBeforeProbe"> Siapkan dokumen dulu</label>
            <label><input type="checkbox" data-nss="usePageLinks"> Tambahkan link halaman ini</label>
          </div>
          <label>Pola dokumen</label>
          <div class="nss-pattern-presets">${renderPatternPresetOptions(state.config)}</div>
          <label>Pola tambahan manual</label>
          <textarea data-nss="customPatterns" placeholder="Contoh: BMP.pdf, MATERI{1-12}.pdf, MODUL-{01-12}.pdf"></textarea>
          <label>Link atau dokumen manual</label>
          <textarea data-nss="manualDocs" placeholder="Contoh: M3.pdf atau https://pustaka.ut.ac.id/reader/index.php?subfolder=EKSI441604/&doc=M3.pdf"></textarea>
        </details>

        <details class="nss-card nss-advanced">
          <summary><span>Pengaturan</span><em>lanjutan</em></summary>
          <div class="nss-grid">
            <div><label>Batas halaman</label><input type="number" data-nss="maxPage" min="1" max="2000"></div>
            <div><label>Jeda</label><input type="number" data-nss="delayMs" min="0" max="10000"></div>
            <div><label>Timeout</label><input type="number" data-nss="timeoutMs" min="3000" max="60000"></div>
          </div>
        </details>

        <div class="nss-card nss-results-card">
          <div class="nss-step"><b>3</b><span>Daftar dokumen</span></div>
          <div class="nss-table-wrap"><table><thead><tr><th></th><th>Dokumen</th><th>Jenis</th><th>Halaman</th><th>Ukuran</th><th>Sumber</th><th>Aksi</th></tr></thead><tbody data-nss="resultBody"><tr><td colspan="7" class="nss-empty">Belum ada hasil. Isi subfolder lalu klik Cek.</td></tr></tbody></table></div>
        </div>

        <details class="nss-logbox"><summary>Aktivitas</summary><pre data-nss="logs">Belum ada aktivitas.</pre></details>
      </div>
    `;
    document.documentElement.appendChild(ui);
    state.ui = ui;
    state.nodes = {
      subfolder: ui.querySelector('[data-nss="subfolder"]'),
      customPatterns: ui.querySelector('[data-nss="customPatterns"]'),
      patternPresetChecks: Array.from(ui.querySelectorAll('[data-nss-pattern-key]')),
      manualDocs: ui.querySelector('[data-nss="manualDocs"]'),
      usePatterns: ui.querySelector('[data-nss="usePatterns"]'),
      initReaderBeforeProbe: ui.querySelector('[data-nss="initReaderBeforeProbe"]'),
      usePageLinks: ui.querySelector('[data-nss="usePageLinks"]'),
      maxPage: ui.querySelector('[data-nss="maxPage"]'),
      delayMs: ui.querySelector('[data-nss="delayMs"]'),
      timeoutMs: ui.querySelector('[data-nss="timeoutMs"]'),
      scanBtn: ui.querySelector('[data-nss="scan"]'),
      stopBtn: ui.querySelector('[data-nss="stop"]'),
      exportBtn: ui.querySelector('[data-nss="export"]'),
      downloadModeBtn: ui.querySelector('[data-nss="downloadMode"]'),
      outputFormatRadios: Array.from(ui.querySelectorAll('[data-nss-output-format]')),
      outputBundleRadios: Array.from(ui.querySelectorAll('[data-nss-output-bundle]')),
      pdfSearchableRadios: Array.from(ui.querySelectorAll('[data-nss-pdf-searchable]')),
      pdfOptions: ui.querySelector('[data-nss="pdfOptions"]'),
      singleBundleOption: ui.querySelector('[data-nss="singleBundleOption"]'),
      downloadPreview: ui.querySelector('[data-nss="downloadPreview"]'),
      clearBtn: ui.querySelector('[data-nss="clear"]'),
      status: ui.querySelector('[data-nss="status"]'),
      summary: ui.querySelector('[data-nss="summary"]'),
      resultBody: ui.querySelector('[data-nss="resultBody"]'),
      logs: ui.querySelector('[data-nss="logs"]')
    };

    const n = state.nodes;
    n.subfolder.value = state.config.subfolder || inferSubfolderFromLocation();
    state.config = normalizePatternConfig(state.config);
    n.customPatterns.value = state.config.customPatterns || '';
    for (const input of n.patternPresetChecks) input.checked = state.config.patternPresetKeys.includes(input.getAttribute('data-nss-pattern-key'));
    n.manualDocs.value = state.config.manualDocs || '';
    n.usePatterns.checked = state.config.usePatterns !== false;
    n.initReaderBeforeProbe.checked = state.config.initReaderBeforeProbe !== false;
    n.usePageLinks.checked = Boolean(state.config.usePageLinks);
    n.maxPage.value = state.config.maxPage;
    n.delayMs.value = state.config.delayMs;
    n.timeoutMs.value = state.config.timeoutMs;
    for (const input of n.outputFormatRadios) input.checked = input.value === (state.config.outputFormat || DEFAULTS.outputFormat);
    for (const input of n.outputBundleRadios) input.checked = input.value === (state.config.outputBundle || DEFAULTS.outputBundle);
    for (const input of n.pdfSearchableRadios) input.checked = input.value === (state.config.pdfSearchable === false ? 'no' : 'yes');

    n.scanBtn.addEventListener('click', runScan);
    n.stopBtn.addEventListener('click', stopScan);
    n.exportBtn.addEventListener('click', exportJson);
    n.downloadModeBtn.addEventListener('click', runSelectedDownloadMode);
    n.clearBtn.addEventListener('click', clearResults);
    ui.querySelector('[data-nss="hide"]').addEventListener('click', () => ui.remove());
    ui.querySelector('[data-nss="compact"]').addEventListener('click', event => {
      ui.classList.toggle('nss-compact');
      event.currentTarget.textContent = ui.classList.contains('nss-compact') ? 'Detail' : 'Ringkas';
      readConfigFromUi();
      saveConfig();
    });

    for (const node of [n.subfolder, n.customPatterns, n.manualDocs, n.maxPage, n.delayMs, n.timeoutMs]) {
      node.addEventListener('change', () => { readConfigFromUi(); saveConfig(); });
      node.addEventListener('input', () => { readConfigFromUi(); saveConfig(); });
    }
    for (const node of [n.usePatterns, n.initReaderBeforeProbe, n.usePageLinks, ...n.patternPresetChecks]) node.addEventListener('change', () => { readConfigFromUi(); saveConfig(); });
    for (const node of [...n.outputFormatRadios, ...n.outputBundleRadios, ...n.pdfSearchableRadios]) node.addEventListener('change', () => { updateSaveModeUi(); readConfigFromUi(); saveConfig(); });
    updateSaveModeUi();

    renderResults();
    renderLogs();
    updateButtons();
  }

  /** Injects CSS. */
  function injectStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `
      #${UI_ID}{--nemo-bg:#0b1220;--nemo-panel:#111827;--nemo-card:#172033;--nemo-line:#2f3b52;--nemo-text:#eef2ff;--nemo-soft:#9aa8bd;--nemo-accent:#22d3ee;--nemo-blue:#2563eb;--nemo-good:#22c55e;--nemo-warn:#f59e0b;--nemo-bad:#ef4444;position:fixed;right:18px;bottom:18px;z-index:2147483647;width:min(430px,calc(100vw - 24px));max-height:min(760px,calc(100vh - 24px));display:flex;flex-direction:column;background:linear-gradient(180deg,rgba(15,23,42,.98),rgba(2,6,23,.98));color:var(--nemo-text);border:1px solid rgba(148,163,184,.28);border-radius:18px;box-shadow:0 22px 70px rgba(0,0,0,.48);font:12px/1.45 system-ui,-apple-system,Segoe UI,sans-serif;overflow:hidden;backdrop-filter:blur(10px)}
      #${UI_ID} *{box-sizing:border-box} #${UI_ID} button,#${UI_ID} input,#${UI_ID} textarea{font:inherit}
      #${UI_ID} .nss-header{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:14px 15px;background:linear-gradient(135deg,rgba(34,211,238,.16),rgba(37,99,235,.12));border-bottom:1px solid rgba(148,163,184,.20)}
      #${UI_ID} .nss-brand strong{display:block;font-size:15px;letter-spacing:.01em;color:#fff} #${UI_ID} .nss-brand span{display:block;margin-top:2px;color:var(--nemo-soft);font-size:11px}
      #${UI_ID} .nss-head-actions{display:flex;gap:7px} #${UI_ID} button{border:1px solid rgba(148,163,184,.30);background:rgba(15,23,42,.72);color:var(--nemo-text);border-radius:11px;padding:8px 10px;font-weight:800;cursor:pointer;transition:.15s ease;box-shadow:0 1px 0 rgba(255,255,255,.04) inset}
      #${UI_ID} button:hover:not(:disabled){border-color:rgba(34,211,238,.72);background:rgba(30,41,59,.92);transform:translateY(-1px)} #${UI_ID} button:disabled{opacity:.42;cursor:not-allowed;transform:none}
      #${UI_ID} button.primary{background:linear-gradient(135deg,#0891b2,#2563eb);color:#fff;border-color:rgba(34,211,238,.82);padding-inline:14px} #${UI_ID} button.danger{background:rgba(127,29,29,.44);border-color:rgba(248,113,113,.40);color:#fecaca}
      #${UI_ID} .nss-header button{padding:6px 9px;border-radius:999px;background:rgba(15,23,42,.46)}
      #${UI_ID} .nss-content{padding:12px;overflow:auto;max-height:calc(min(760px,calc(100vh - 24px)) - 55px);background:rgba(2,6,23,.40)}
      #${UI_ID} .nss-card,#${UI_ID} .nss-status-card,#${UI_ID} .nss-logbox{background:rgba(23,32,51,.92);border:1px solid rgba(148,163,184,.22);border-radius:16px;padding:12px;margin-bottom:10px;box-shadow:0 1px 0 rgba(255,255,255,.04) inset}
      #${UI_ID} .nss-step{display:flex;align-items:center;gap:8px;margin-bottom:10px;color:#e5edff;font-weight:900} #${UI_ID} .nss-step b{display:inline-grid;place-items:center;width:22px;height:22px;border-radius:999px;background:rgba(34,211,238,.16);border:1px solid rgba(34,211,238,.40);color:#67e8f9} #${UI_ID} .nss-step span{font-size:13px}
      #${UI_ID} label{display:block;font-weight:800;color:#dbeafe;margin:8px 0 5px} #${UI_ID} input,#${UI_ID} textarea{width:100%;border:1px solid rgba(148,163,184,.28);border-radius:12px;background:rgba(2,6,23,.62);color:#fff;padding:9px 10px;outline:none}
      #${UI_ID} input::placeholder,#${UI_ID} textarea::placeholder{color:#64748b} #${UI_ID} textarea{resize:vertical;min-height:66px}
      #${UI_ID} input:focus,#${UI_ID} textarea:focus{border-color:rgba(34,211,238,.88);box-shadow:0 0 0 3px rgba(34,211,238,.13)}
      #${UI_ID} .nss-actions{display:flex;flex-wrap:wrap;gap:8px;margin-top:11px} #${UI_ID} .nss-primary-actions button:first-child{min-width:92px} #${UI_ID} .nss-save-actions{display:grid;grid-template-columns:2fr 1fr;gap:8px} #${UI_ID} .nss-save-actions button{width:100%}
      #${UI_ID} .nss-mode-group{margin:10px 0} #${UI_ID} .nss-mode-title{margin:0 0 7px;color:#dbeafe;font-weight:900;font-size:12px} #${UI_ID} .nss-option-grid{display:grid;grid-template-columns:repeat(2,1fr);gap:7px} #${UI_ID} .nss-option-grid.two{grid-template-columns:repeat(2,1fr)} #${UI_ID} .nss-radio-card{display:flex;align-items:center;gap:8px;margin:0;padding:9px 10px;border:1px solid rgba(148,163,184,.20);border-radius:12px;background:rgba(2,6,23,.32);cursor:pointer;color:#e0f2fe;font-weight:900} #${UI_ID} .nss-radio-card:hover{border-color:rgba(34,211,238,.45);background:rgba(14,116,144,.12)} #${UI_ID} .nss-radio-card input{width:auto;accent-color:#22d3ee} #${UI_ID} .nss-radio-card.is-disabled{opacity:.45;pointer-events:none} #${UI_ID} .nss-download-preview{margin-top:9px;padding:9px 10px;border:1px solid rgba(34,211,238,.22);border-radius:12px;background:rgba(14,116,144,.12);color:#a5f3fc;font-weight:900}
      #${UI_ID} .nss-inline-actions{display:flex;gap:8px;margin:8px 0 10px} #${UI_ID} .nss-note{margin:10px 0 0;color:var(--nemo-soft);font-size:12px}
      #${UI_ID} .nss-status-title{color:var(--nemo-soft);font-size:11px;font-weight:900;text-transform:uppercase;letter-spacing:.08em;margin-bottom:6px} #${UI_ID} .nss-status{padding:0;color:#e2e8f0;font-weight:800} #${UI_ID} .nss-status.is-error{color:#fecaca}
      #${UI_ID} .nss-summary{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-top:10px} #${UI_ID} .nss-summary>div{background:rgba(2,6,23,.42);border:1px solid rgba(148,163,184,.16);border-radius:14px;padding:10px;text-align:center}
      #${UI_ID} .nss-summary strong{display:block;font-size:21px;color:#fff;line-height:1.1} #${UI_ID} .nss-summary span{display:block;color:var(--nemo-soft);font-size:11px;margin-top:2px}
      #${UI_ID} details.nss-advanced summary,#${UI_ID} .nss-logbox summary{cursor:pointer;list-style:none;display:flex;justify-content:space-between;align-items:center;font-weight:900;color:#dbeafe} #${UI_ID} details.nss-advanced summary::-webkit-details-marker,#${UI_ID} .nss-logbox summary::-webkit-details-marker{display:none} #${UI_ID} details.nss-advanced summary:after,#${UI_ID} .nss-logbox summary:after{content:'+';color:var(--nemo-accent);font-weight:900} #${UI_ID} details[open].nss-advanced summary:after,#${UI_ID} .nss-logbox[open] summary:after{content:'–'} #${UI_ID} details.nss-advanced summary em{font-style:normal;color:var(--nemo-soft);font-size:11px;font-weight:800}
      #${UI_ID} .nss-checks{display:grid;grid-template-columns:1fr;gap:8px;margin:10px 0} #${UI_ID} .nss-checks label{display:flex;align-items:center;gap:8px;margin:0;padding:8px 10px;border:1px solid rgba(148,163,184,.20);border-radius:12px;background:rgba(2,6,23,.36);font-weight:800;color:#dbeafe} #${UI_ID} .nss-checks input{width:auto;accent-color:#22d3ee}
      #${UI_ID} .nss-pattern-presets{display:grid;grid-template-columns:1fr;gap:7px;margin:6px 0 10px} #${UI_ID} .nss-preset{display:flex;align-items:flex-start;gap:9px;margin:0;padding:9px 10px;border:1px solid rgba(148,163,184,.20);border-radius:12px;background:rgba(2,6,23,.32);cursor:pointer} #${UI_ID} .nss-preset:hover{border-color:rgba(34,211,238,.45);background:rgba(14,116,144,.12)} #${UI_ID} .nss-preset input{width:auto;margin-top:3px;accent-color:#22d3ee} #${UI_ID} .nss-preset span{display:block} #${UI_ID} .nss-preset b{display:block;color:#e0f2fe;font-size:12px} #${UI_ID} .nss-preset small{display:block;color:var(--nemo-soft);font-size:11px;margin-top:1px}
      #${UI_ID} .nss-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-top:9px}
      #${UI_ID} .nss-linktests{display:grid;gap:6px;margin:8px 0 10px} #${UI_ID} .nss-linktest{border:1px solid rgba(148,163,184,.20);border-radius:12px;padding:8px 10px;background:rgba(2,6,23,.36)} #${UI_ID} .nss-linktest strong{display:block;font-size:12px;color:#fff} #${UI_ID} .nss-linktest span{display:block;color:var(--nemo-soft);font-size:11px;margin-top:2px} #${UI_ID} .nss-linktest.ok{border-color:rgba(34,197,94,.42);background:rgba(20,83,45,.25)} #${UI_ID} .nss-linktest.bad{border-color:rgba(248,113,113,.42);background:rgba(127,29,29,.25)} #${UI_ID} .nss-empty-mini{color:var(--nemo-soft);font-size:12px;border:1px dashed rgba(148,163,184,.25);border-radius:12px;padding:8px 10px;background:rgba(2,6,23,.25)}
      #${UI_ID} .nss-table-wrap{border:1px solid rgba(148,163,184,.20);border-radius:14px;overflow:auto;max-height:320px;background:rgba(2,6,23,.38)} #${UI_ID} table{border-collapse:collapse;width:100%;min-width:690px}
      #${UI_ID} th,#${UI_ID} td{padding:9px 10px;border-bottom:1px solid rgba(148,163,184,.14);text-align:left;vertical-align:top} #${UI_ID} th{position:sticky;top:0;background:#111827;color:#9fb0c8;font-size:11px;text-transform:uppercase;letter-spacing:.05em;z-index:1}
      #${UI_ID} td{color:#e5e7eb} #${UI_ID} td small{display:block;color:var(--nemo-soft);margin-top:2px;font-size:11px} #${UI_ID} tr.is-muted{opacity:.48} #${UI_ID} tr:hover{background:rgba(34,211,238,.05)} #${UI_ID} .nss-empty{text-align:center;color:var(--nemo-soft);padding:22px}
      #${UI_ID} .nss-pill{display:inline-block;border-radius:999px;padding:3px 8px;font-size:11px;font-weight:900;margin:0 7px 5px 0} #${UI_ID} .nss-pill.ok{background:rgba(34,197,94,.18);color:#86efac;border:1px solid rgba(34,197,94,.35)} #${UI_ID} .nss-pill.bad{background:rgba(239,68,68,.16);color:#fecaca;border:1px solid rgba(239,68,68,.35)}
      #${UI_ID} a{color:#67e8f9;font-weight:900;text-decoration:none;margin-right:8px} #${UI_ID} button.nss-mini{padding:4px 7px;border-radius:8px;font-size:11px;margin:2px 3px 2px 0;background:rgba(14,116,144,.22);border-color:rgba(34,211,238,.35);color:#a5f3fc}
      #${UI_ID} pre{white-space:pre-wrap;max-height:160px;overflow:auto;margin:8px 0 0;color:#cbd5e1;font:11px/1.45 ui-monospace,SFMono-Regular,Consolas,monospace;background:rgba(2,6,23,.35);border-radius:12px;padding:9px;border:1px solid rgba(148,163,184,.14)}
      #${UI_ID}.nss-compact{width:min(392px,calc(100vw - 24px))} #${UI_ID}.nss-compact .nss-advanced,#${UI_ID}.nss-compact .nss-note,#${UI_ID}.nss-compact .nss-logbox{display:none} #${UI_ID}.nss-compact .nss-table-wrap{max-height:220px}
      @media(max-width:640px){#${UI_ID}{right:10px;bottom:10px;width:calc(100vw - 20px);max-height:calc(100vh - 20px)}#${UI_ID} .nss-grid,#${UI_ID} .nss-summary,#${UI_ID} .nss-save-actions,#${UI_ID} .nss-option-grid{grid-template-columns:1fr}}
    `;
    document.head.appendChild(style);
  }

  /** Shows panel. */
  function show() { if (!document.getElementById(UI_ID)) buildUi(); }

  /** Hides panel. */
  function hide() { const ui = document.getElementById(UI_ID); if (ui) ui.remove(); }

  /** Destroys UI and public handle. */
  function destroy() {
    stopScan();
    hide();
    const style = document.getElementById(STYLE_ID);
    if (style) style.remove();
    delete window[APP_KEY];
  }

  window[APP_KEY] = {
    version: APP_VERSION,
    state,
    show,
    hide,
    destroy,
    scan: runScan,
    stop: stopScan,
    exportJson,
    downloadOneDocument,
    downloadSelectedDocuments,
    downloadPdfForDocument,
    downloadPdfForSelectedDocuments,
    downloadCombinedPdfForSelectedDocuments,
    downloadTextForDocument,
    downloadTextForSelectedDocuments,
    downloadCombinedTextForSelectedDocuments,
    runSelectedDownloadMode,
    collectNativeTextForDocument,
    createSearchablePdf,
    createPdfFromPageRecords,
    createZip,
    buildCandidates,
    parsePatternDocs,
    buildEffectivePatternString,
    normalizePatternConfig,
    parseManualDocs,
    extractDocsFromText,
    buildImageUrl,
    getServiceDocVariants,
    collectDocsFromPageLinks
  };

  buildUi();
})();
