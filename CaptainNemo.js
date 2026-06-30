(() => {
  'use strict';

  const APP_VERSION = '1.4.6';
  const APP_KEY = '__nemoSubfolderStudioDownloaderV146__';
  const UI_ID = 'nemo_subfolder_studio_downloader_v146';
  const STYLE_ID = 'nemo_subfolder_studio_downloader_v146_style';
  const STORE_KEY = 'nemo.subfolderStudio.downloader.v146';
  const VIEW_PATH = '/reader/services/view.php';
  const READER_PATH = '/reader/index.php';

  const PATTERN_PRESETS = [
    { key: 'toc', label: 'DAFIS', hint: 'Daftar isi', patterns: ['DAFIS.pdf'] },
    { key: 'overview', label: 'TINJAUAN', hint: 'Tinjauan mata kuliah', patterns: ['TINJAUAN.pdf'] },
    { key: 'm_plain', label: 'M1-M12', hint: 'Modul 1 sampai 12', patterns: ['M{1-12}.pdf'] }
  ];

  const DEFAULT_PATTERN_PRESET_KEYS = ['toc', 'overview', 'm_plain'];

  const DEFAULTS = {
    subfolder: '',
    patternPresetKeys: DEFAULT_PATTERN_PRESET_KEYS.slice(),
    customPatterns: '',
    patterns: 'DAFIS.pdf, TINJAUAN.pdf, M{1-12}.pdf',
    useDirectProbe: true,
    initReaderBeforeProbe: true,
    usePageLinks: false,
    usePatterns: true,
    maxPage: 300,
    delayMs: 700,
    speedMode: 'balanced',
    timeoutMs: 12000,
    compact: false,
    minimized: false,
    includeManifest: true,
    includeNativeText: true,
    outputFormat: 'pdf',
    outputBundle: 'zip',
    pdfSearchable: true,
    includeCover: true,
    includeMetadata: true,
    includeIdentityPage: true,
    metadata: null,
    rbvUrl: ''
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
    pdfStats: null,
    pageMetaCache: new Map(),
    pageBlobCache: new Map(),
    courseMetadata: null,
    resolvedCourse: null,
    coverBlobCache: new Map()
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


  /** Returns the selected speed profile. */
  function getSpeedProfile() {
    const mode = String(state.config.speedMode || DEFAULTS.speedMode || 'balanced');
    if (mode === 'safe') return { mode, label: 'Aman', concurrency: 1, probeDelayMs: Math.max(250, Math.min(1200, Number(state.config.delayMs) || DEFAULTS.delayMs)), downloadDelayMs: Math.max(250, Math.min(1200, Number(state.config.delayMs) || DEFAULTS.delayMs)) };
    if (mode === 'fast') return { mode, label: 'Cepat', concurrency: 5, probeDelayMs: 60, downloadDelayMs: 60 };
    return { mode: 'balanced', label: 'Seimbang', concurrency: 3, probeDelayMs: 160, downloadDelayMs: 120 };
  }

  /** Short delay for page-count probing. */
  async function probeDelay() {
    const profile = getSpeedProfile();
    if (profile.probeDelayMs > 0) await sleep(profile.probeDelayMs);
  }

  /** Short delay for batched downloads. */
  async function downloadDelay() {
    const profile = getSpeedProfile();
    if (profile.downloadDelayMs > 0) await sleep(profile.downloadDelayMs);
  }

  /** Runs async jobs with a small concurrency limit. */
  async function runConcurrent(items, worker, concurrency = 1) {
    const list = Array.from(items || []);
    const results = new Array(list.length);
    let cursor = 0;
    const limit = Math.max(1, Math.min(8, Number(concurrency) || 1));
    async function next() {
      while (cursor < list.length) {
        if (state.stopRequested) throw new Error('Proses dihentikan.');
        const index = cursor;
        cursor += 1;
        results[index] = await worker(list[index], index);
      }
    }
    await Promise.all(Array.from({ length: Math.min(limit, list.length) }, next));
    return results;
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


  /** Normalizes academic or access codes into uppercase alphanumeric text. */
  function normCourseCode(value) {
    return String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  }

  /** Reads the edition number from strings such as "Edisi 4". */
  function parseEditionNumber(value) {
    const match = String(value || '').match(/edisi\s*(\d+)/i) || String(value || '').match(/\b(\d{1,2})\b/);
    const number = match ? Number(match[1]) : null;
    return Number.isInteger(number) && number > 0 ? number : null;
  }

  /** Splits an access code into course and edition parts when possible. */
  function splitAccessCode(value) {
    const clean = normCourseCode(value);
    const match = clean.match(/^([A-Z]{2,}\d{4})(\d{2})$/);
    if (!match) return { courseCode: clean, editionCode: '', editionNumber: 1, fulltextCode: clean };
    const ed = Number(match[2]);
    return { courseCode: match[1], editionCode: match[2], editionNumber: ed || null, fulltextCode: clean };
  }

  /** Resolves academic code and edition into the access/subfolder code used by the reader. */
  function resolveCourseCodes(metadata = null, userInput = '') {
    const meta = metadata && typeof metadata === 'object' ? metadata : {};
    const recommended = meta.recommendedForNemo || {};
    const course = meta.course || {};
    const md = meta.metadata || {};
    const rawInput = normalizeSubfolder(userInput).replace(/\/+$/g, '');
    const inputCode = normCourseCode(rawInput);
    const metaCourse = normCourseCode(recommended.courseCode || course.code || recommended.titleCode || '');
    const fulltextFromPage = normCourseCode(recommended.fulltextCode || recommended.moduleCode || course.modulParam || '');
    const title = recommended.title || course.title || '';
    const editionNumber = Number(recommended.editionNumber || parseEditionNumber(recommended.edition || md.edition || '')) || null;

    let courseCode = metaCourse;
    let fulltextCode = fulltextFromPage;
    let source = fulltextCode ? 'fulltext-link' : 'input';
    let confidence = fulltextCode ? 'high' : 'low';

    if (!courseCode && fulltextCode) {
      const parts = splitAccessCode(fulltextCode);
      courseCode = parts.courseCode;
    }
    if (!courseCode && inputCode) {
      const parts = splitAccessCode(inputCode);
      courseCode = parts.courseCode;
    }
    if (!fulltextCode && courseCode) {
      const ed = editionNumber || 1;
      fulltextCode = ed <= 1 ? courseCode : `${courseCode}${String(ed).padStart(2, '0')}`;
      source = editionNumber ? 'course-code-and-edition' : 'course-code';
      confidence = editionNumber ? 'medium' : 'low';
    }
    if (inputCode && (!fulltextCode || inputCode.length > (courseCode || '').length)) {
      fulltextCode = inputCode;
      const parts = splitAccessCode(inputCode);
      courseCode = courseCode || parts.courseCode;
      source = 'user-input';
      confidence = 'medium';
    }
    const effectiveEdition = editionNumber || splitAccessCode(fulltextCode).editionNumber || 1;
    const editionCode = effectiveEdition <= 1 ? '' : String(effectiveEdition).padStart(2, '0');
    return {
      courseCode: courseCode || inputCode || '',
      title,
      editionNumber: effectiveEdition,
      editionCode,
      fulltextCode: fulltextCode || courseCode || inputCode || '',
      subfolder: fulltextCode ? `${fulltextCode}/` : '',
      source,
      confidence
    };
  }

  /** Resolves user input into the reader subfolder, applying edition suffix rules when metadata is present. */
  function resolveInputSubfolder(value) {
    const direct = normalizeSubfolder(value);
    const inputCode = normCourseCode(direct.replace(/\/+$/g, ''));
    const meta = state.courseMetadata || state.config.metadata || null;
    if (!meta || !inputCode) return direct;
    const resolved = resolveCourseCodes(meta, inputCode);
    if (resolved.fulltextCode && (inputCode === resolved.courseCode || inputCode === resolved.fulltextCode)) return `${resolved.fulltextCode}/`;
    return direct;
  }

  /** Finds a probable course title heading on an RBV page or fetched RBV document. */
  function readCourseTitleFromPage(root = document) {
    const headings = Array.from(root.querySelectorAll('.av-special-heading-tag,h1,h2,h3')).map(node => (node.textContent || '').trim()).filter(Boolean);
    const docTitle = root === document ? document.title : ((root.querySelector('title') && root.querySelector('title').textContent) || '');
    const raw = headings.find(text => /\b[A-Z]{2,}\d{4}\b/.test(text)) || headings[0] || docTitle || '';
    const match = raw.match(/\b([A-Z]{2,}\d{4})\b\s*[–-]?\s*(.*?)(?:\s*\((Edisi\s*\d+)\))?\s*$/i);
    if (!match) return { rawTitle: raw, code: '', title: raw, edition: '' };
    return { rawTitle: raw, code: normCourseCode(match[1]), title: (match[2] || '').trim(), edition: (match[3] || '').trim() };
  }

  /** Returns a high-resolution image URL candidate by removing WordPress thumbnail suffixes. */
  function fullImageUrlCandidate(url) {
    try {
      const u = new URL(url, location.href);
      u.hash = '';
      const path = u.pathname.replace(/-\d+x\d+(?=\.(?:jpe?g|png|webp)$)/i, '');
      u.pathname = path;
      return u.href;
    } catch { return ''; }
  }

  /** Returns true when an image clearly belongs to site chrome, menus, flags, or social icons. */
  function isNonCourseImageCandidate(value) {
    const text = String(value || '').toLowerCase();
    return /(?:logo|instagram|facebook|twitter|x\s*perpustakaan|glyph|gtranslate|flags?\/24|\/plugins\/|digital-library|perpustakaan\s+ut|cyber|whatsapp|youtube|linkedin|telegram)/i.test(text);
  }

  /** Resolves a URL against an RBV page URL. */
  function absoluteFrom(value, baseUrl = location.href) {
    try { return new URL(String(value || ''), baseUrl).href; } catch { return ''; }
  }

  /** Returns a safe RBV page URL from user input or current location. */
  function normalizeRbvPageUrl(value) {
    const raw = String(value || '').trim();
    if (!raw) return '';
    try {
      const url = new URL(raw, location.href);
      if (url.origin !== location.origin) return '';
      if (!/^\/lib\//i.test(url.pathname)) return '';
      url.hash = '';
      return url.href;
    } catch {
      return '';
    }
  }

  /** Infers an RBV page URL from the active page. */
  function inferRbvUrlFromLocation() {
    return normalizeRbvPageUrl(location.href);
  }

  /** Extracts cover metadata from the active RBV page. */
  function readCoverFromPage(courseCode, root = document, baseUrl = location.href) {
    const code = normCourseCode(courseCode);
    const candidates = Array.from(root.querySelectorAll('img[src]')).map((img, index) => {
      const src = absoluteFrom(img.getAttribute('src') || '', baseUrl);
      const href = img.closest('a[href]') ? absoluteFrom(img.closest('a[href]').getAttribute('href') || '', baseUrl) : '';
      const title = img.getAttribute('title') || '';
      const alt = img.getAttribute('alt') || '';
      const filename = (() => { try { return decodeURIComponent(new URL(src).pathname.split('/').pop() || ''); } catch { return ''; } })();
      const haystack = [src, href, filename, title, alt].join(' ');
      const matchesCode = Boolean(code && haystack.toUpperCase().includes(code));
      const siteChrome = isNonCourseImageCandidate(haystack);
      let score = 0;
      if (matchesCode) score += 40;
      if (/wp-content\/uploads/i.test(src)) score += 8;
      if (href && /\.(?:jpe?g|png|webp)$/i.test(href)) score += 12;
      if (siteChrome && !matchesCode) score -= 60;
      const w = img.naturalWidth || img.width || 0;
      const h = img.naturalHeight || img.height || 0;
      if (w >= 120 && h >= 160 && h >= w * 1.1) score += 12;
      score += Math.min(10, Math.round((w + h) / 120));
      return { index, src, href, filename, title, alt, width: w || null, height: h || null, score, matchesCode, siteChrome };
    }).filter(item => item.matchesCode || !item.siteChrome || item.score > 0).sort((a, b) => b.score - a.score);
    const display = candidates[0] || null;
    const bestUrl = display ? (display.href && /\.(?:jpe?g|png|webp)$/i.test(display.href) ? display.href : fullImageUrlCandidate(display.src) || display.src) : '';
    return {
      display,
      bestUrl,
      bestFilename: (() => { try { return decodeURIComponent(new URL(bestUrl).pathname.split('/').pop() || 'cover'); } catch { return 'cover'; } })(),
      displayCandidates: candidates.slice(0, 12)
    };
  }

  /** Returns the main RBV content column, avoiding header, menu, footer, and sidebar text. */
  function findRbvMainScope(root = document) {
    const title = root.querySelector('.av-special-heading-tag,h1,h2,h3');
    if (!title) return root;
    return title.closest('.flex_column') || title.closest('.flex_cell_inner') || title.parentElement || root;
  }

  /** Cleans author text accidentally mixed with page navigation or library opening hours. */
  function sanitizeAuthorText(value) {
    let text = String(value || '').replace(/\s+/g, ' ').trim();
    if (!text) return '';
    text = text.replace(/^Menu\s*,?\s*/i, '');
    text = text.replace(/\b(Sirkulasi|Senin[-–]Kamis|Jumat|Sabtu|Minggu|Layanan|Jam\s+Buka|Perpustakaan)\b.*$/i, '').trim();
    text = text.replace(/\s*[;:]+\s*$/g, '').trim();
    return text;
  }

  /** Extracts author names only from the main course content column. */
  function extractRbvAuthors(scope) {
    const bad = /Untuk menggunakan|FULLTEXT|ISBN|Edisi|SKS|Halaman|DDC|Universitas Terbuka|elearning|Perpustakaan|Sirkulasi|Senin[-–]Kamis|Jam Buka/i;
    const parts = [];
    const nodes = Array.from(scope.querySelectorAll('.avia_textblock p strong, .avia_textblock strong')).slice(0, 24);
    for (const node of nodes) {
      const cleaned = sanitizeAuthorText(node.textContent || '');
      if (!cleaned || bad.test(cleaned)) continue;
      for (const piece of cleaned.split(/\s*,\s*/).map(item => item.trim()).filter(Boolean)) {
        const name = piece.replace(/\s*[.;:]+$/g, '').trim();
        if (!name || bad.test(name) || name.length < 3 || name.length > 80) continue;
        if (!parts.some(existing => existing.toLowerCase() === name.toLowerCase())) parts.push(name);
      }
    }
    return parts.slice(0, 8);
  }

  /** Extracts RBV cover and metadata from the active page. */
  function extractRbvMetadataFromPage(root = document, pageUrl = location.href) {
    const titleInfo = readCourseTitleFromPage(root);
    const fulltextLink = Array.from(root.querySelectorAll('a[href]')).map((a, index) => {
      const href = absoluteFrom(a.getAttribute('href') || '', pageUrl);
      if (!/\/reader\/index\.php\?/i.test(href) || !/[?&]modul=/i.test(href)) return null;
      let modul = '';
      try { modul = new URL(href).searchParams.get('modul') || ''; } catch { }
      return { index, text: (a.textContent || '').trim(), href, code: normCourseCode(modul) };
    }).filter(Boolean)[0] || null;
    const mainScope = findRbvMainScope(root);
    const listItems = Array.from(mainScope.querySelectorAll('.avia_textblock li, li')).map(li => (li.textContent || '').replace(/\s+/g, ' ').trim()).filter(Boolean);
    const metaLine = listItems.find(text => /Edisi\s*\d+.*SKS.*Modul/i.test(text)) || '';
    const physicalDescription = listItems.find(text => /Halaman/i.test(text) && /cm/i.test(text)) || '';
    const isbnPrint = (listItems.find(text => /^ISBN\s+/i.test(text) && !/\(E\)/i.test(text)) || '').replace(/^ISBN\s*/i, '').trim();
    const isbnElectronic = (listItems.find(text => /^ISBN\s*\(E\)/i.test(text)) || '').replace(/^ISBN\s*\(E\)\s*/i, '').trim();
    const publisherText = listItems.find(text => /Universitas\s+Terbuka/i.test(text) && /\d{4}/.test(text)) || '';
    const ddcText = listItems.find(text => /DDC/i.test(text)) || '';
    const authors = extractRbvAuthors(mainScope);
    const descParagraphs = Array.from(mainScope.querySelectorAll('.avia_textblock p,p')).map(p => (p.textContent || '').replace(/\s+/g, ' ').trim()).filter(text => text.length > 90 && !/Untuk menggunakan layanan|Sirkulasi|Senin[-–]Kamis|Menu/i.test(text));
    const description = descParagraphs.sort((a, b) => b.length - a.length)[0] || '';
    const editionMatch = metaLine.match(/Edisi\s*(\d+)/i) || titleInfo.edition.match(/Edisi\s*(\d+)/i);
    const editionNumber = editionMatch ? Number(editionMatch[1]) : null;
    const sksMatch = metaLine.match(/(\d+)\s*SKS/i);
    const moduleMatch = metaLine.match(/(\d+)\s*Modul/i);
    const bibPageMatch = physicalDescription.match(/(\d+)\s*Halaman/i);
    const yearMatch = publisherText.match(/\b(20\d{2}|19\d{2})\b/);
    const ddcMatch = ddcText.match(/DDC\s*(?:\[[^\]]+\])?\s*([0-9.]+)/i);
    const course = {
      code: titleInfo.code || (fulltextLink ? splitAccessCode(fulltextLink.code).courseCode : ''),
      title: titleInfo.title || '',
      rawTitle: titleInfo.rawTitle || '',
      fulltextUrl: fulltextLink ? fulltextLink.href : '',
      fulltextText: fulltextLink ? fulltextLink.text : '',
      modulParam: fulltextLink ? fulltextLink.code : ''
    };
    const cover = readCoverFromPage(course.code, root, pageUrl);
    const metadata = {
      authors: authors.length ? authors : [],
      edition: editionNumber ? `Edisi ${editionNumber}` : titleInfo.edition,
      editionNumber,
      sks: sksMatch ? Number(sksMatch[1]) : null,
      modules: moduleMatch ? Number(moduleMatch[1]) : null,
      bibliographicPages: bibPageMatch ? Number(bibPageMatch[1]) : null,
      physicalDescription,
      isbnPrint,
      isbnElectronic,
      publisherText,
      publisher: publisherText ? 'Universitas Terbuka' : '',
      city: publisherText.split(':')[0] || '',
      year: yearMatch ? yearMatch[1] : '',
      ddc: ddcMatch ? ddcMatch[1] : '',
      listItems,
      description
    };
    const resolved = resolveCourseCodes({ course, metadata, recommendedForNemo: { fulltextCode: course.modulParam, courseCode: course.code, editionNumber } }, course.modulParam || course.code);
    return {
      app: 'Nemo RBV Cover Metadata',
      version: APP_VERSION,
      analyzedAt: new Date().toISOString(),
      pageUrl,
      origin: location.origin,
      course,
      cover,
      metadata,
      recommendedForNemo: {
        includeCover: Boolean(cover.bestUrl),
        coverUrl: cover.bestUrl,
        coverFilename: cover.bestFilename,
        includeMetadataPage: true,
        courseCode: resolved.courseCode,
        editionNumber: resolved.editionNumber,
        editionCode: resolved.editionCode,
        fulltextCode: resolved.fulltextCode,
        subfolder: resolved.subfolder,
        moduleCode: resolved.fulltextCode,
        title: course.title,
        authors: metadata.authors,
        edition: metadata.edition,
        sks: metadata.sks,
        moduleCount: metadata.modules,
        bibliographicPages: metadata.bibliographicPages,
        isbnPrint: metadata.isbnPrint,
        isbnElectronic: metadata.isbnElectronic,
        year: metadata.year,
        ddc: metadata.ddc,
        description: metadata.description
      }
    };
  }

  /** Stores metadata and updates resolver state. */
  function setCourseMetadata(metadata, source = 'manual') {
    state.courseMetadata = metadata && typeof metadata === 'object' ? metadata : null;
    state.config.metadata = state.courseMetadata;
    state.resolvedCourse = state.courseMetadata ? resolveCourseCodes(state.courseMetadata, state.config.subfolder) : null;
    renderCourseMetadata();
    log(state.courseMetadata ? `Metadata RBV dimuat (${source}).` : 'Metadata RBV dikosongkan.');
    saveConfig();
  }

  /** Returns the active metadata payload. */
  function getActiveMetadata() {
    return state.courseMetadata || state.config.metadata || null;
  }

  /** Builds a concise human-readable metadata summary. */
  function buildMetadataSummaryText() {
    const meta = getActiveMetadata();
    if (!meta) return 'Belum ada metadata RBV.';
    const r = resolveCourseCodes(meta, state.config.subfolder);
    const m = meta.metadata || {};
    const rec = meta.recommendedForNemo || {};
    const title = rec.title || (meta.course && meta.course.title) || r.title || '-';
    const authors = (rec.authors || m.authors || []).join(', ') || '-';
    const edition = rec.edition || m.edition || (r.editionNumber ? `Edisi ${r.editionNumber}` : '-');
    return `${r.courseCode || '-'} · ${title} · ${edition}\nKode akses: ${r.fulltextCode || '-'}${r.subfolder ? '/' : ''}\nPenulis: ${authors}`;
  }

  /** Renders metadata summary in the UI. */
  function renderCourseMetadata() {
    const node = state.nodes && state.nodes.metadataSummary;
    if (node) node.textContent = buildMetadataSummaryText();
    const resolved = getActiveMetadata() ? resolveCourseCodes(getActiveMetadata(), state.config.subfolder) : null;
    state.resolvedCourse = resolved;
  }

  /** Applies metadata-derived access code to the subfolder field. */
  function applyMetadataSubfolder() {
    const meta = getActiveMetadata();
    if (!meta) return alert('Metadata belum tersedia. Ambil dari halaman RBV atau tempel JSON metadata lebih dulu.');
    const resolved = resolveCourseCodes(meta, state.config.subfolder);
    if (!resolved.subfolder) return alert('Kode akses tidak bisa ditentukan dari metadata.');
    if (state.nodes.subfolder) state.nodes.subfolder.value = resolved.subfolder;
    readConfigFromUi();
    saveConfig();
    renderCourseMetadata();
    setStatus(`Kode akses dipakai: ${resolved.subfolder}`);
  }

  /** Loads metadata from the current RBV page. */
  function importMetadataFromPage() {
    try {
      const meta = extractRbvMetadataFromPage(document, location.href);
      setCourseMetadata(meta, 'halaman aktif');
      if (state.nodes.rbvUrl) state.nodes.rbvUrl.value = normalizeRbvPageUrl(location.href) || state.nodes.rbvUrl.value;
      if (meta && meta.recommendedForNemo && meta.recommendedForNemo.subfolder && state.nodes.subfolder) state.nodes.subfolder.value = meta.recommendedForNemo.subfolder;
      readConfigFromUi();
      saveConfig();
    } catch (error) {
      alert(`Gagal membaca metadata: ${String(error && error.message || error)}`);
    }
  }

  /** Fetches and loads metadata from an RBV page URL without opening that page. */
  async function importMetadataFromRbvUrl() {
    if (state.running) return;
    readConfigFromUi();
    const rbvUrl = normalizeRbvPageUrl(state.config.rbvUrl || (state.nodes.rbvUrl && state.nodes.rbvUrl.value) || inferRbvUrlFromLocation());
    if (!rbvUrl) {
      alert('Isi tautan RBV yang valid. Contoh: https://pustaka.ut.ac.id/lib/ekma4314-akuntansi-manajemen-edisi-4/');
      return;
    }
    state.running = true;
    state.stopRequested = false;
    state.controller = new AbortController();
    updateButtons();
    setStatus('Mengambil metadata dari tautan RBV...');
    log('Mengambil metadata RBV dari tautan.');
    try {
      const response = await fetch(rbvUrl, { method: 'GET', credentials: 'include', cache: 'no-store', signal: state.controller.signal });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const html = await response.text();
      const doc = new DOMParser().parseFromString(html, 'text/html');
      const meta = extractRbvMetadataFromPage(doc, rbvUrl);
      if (!meta || !(meta.course && (meta.course.code || meta.course.modulParam))) throw new Error('Metadata RBV tidak terbaca dari tautan.');
      state.config.rbvUrl = rbvUrl;
      if (state.nodes.rbvUrl) state.nodes.rbvUrl.value = rbvUrl;
      setCourseMetadata(meta, 'tautan RBV');
      if (meta.recommendedForNemo && meta.recommendedForNemo.subfolder && state.nodes.subfolder) {
        state.nodes.subfolder.value = meta.recommendedForNemo.subfolder;
      }
      readConfigFromUi();
      saveConfig();
      setStatus('Metadata dari tautan RBV berhasil dimuat.');
      log('Metadata RBV berhasil dimuat dari tautan.');
    } catch (error) {
      setStatus(`Metadata RBV gagal: ${String(error && error.message || error)}`, true);
      log(`Metadata RBV gagal: ${String(error && error.message || error)}`);
    } finally {
      state.running = false;
      state.stopRequested = false;
      state.controller = null;
      updateButtons();
    }
  }

  /** Imports metadata JSON exported by the RBV metadata analyzer. */
  function importMetadataJson() {
    const raw = state.nodes.metadataJson ? state.nodes.metadataJson.value.trim() : '';
    if (!raw) return alert('Tempel JSON metadata terlebih dahulu.');
    try {
      const meta = JSON.parse(raw);
      setCourseMetadata(meta, 'JSON');
      if (!normalizeSubfolder(state.nodes.subfolder ? state.nodes.subfolder.value : state.config.subfolder) && meta.recommendedForNemo && meta.recommendedForNemo.subfolder) applyMetadataSubfolder();
    } catch (error) {
      alert(`JSON metadata tidak valid: ${String(error && error.message || error)}`);
    }
  }

  /** Builds metadata JSON and README files for ZIP outputs. */
  async function buildMetadataFiles(prefix = '00_Metadata/') {
    if (!state.config.includeMetadata && !state.config.includeCover) return [];
    const meta = getActiveMetadata();
    if (!meta) return [];
    const files = [];
    const resolved = resolveCourseCodes(meta, state.config.subfolder);
    const payload = { ...meta, resolvedForNemo: resolved, exportedAt: new Date().toISOString() };
    if (state.config.includeMetadata) {
      files.push({ name: `${prefix}metadata.json`, text: JSON.stringify(payload, null, 2) });
      files.push({ name: `${prefix}README.md`, text: buildMetadataReadme(meta, resolved) });
    }
    if (state.config.includeCover) {
      const cover = await fetchCoverBlob(meta).catch(() => null);
      if (cover && cover.blob) files.push({ name: `${prefix}${safeName(cover.filename || 'cover.jpg', 'cover.jpg')}`, blob: cover.blob });
    }
    return files;
  }

  /** Builds README text from course metadata. */
  function buildMetadataReadme(meta, resolved = null) {
    const rec = meta.recommendedForNemo || {};
    const m = meta.metadata || {};
    const course = meta.course || {};
    const r = resolved || resolveCourseCodes(meta, state.config.subfolder);
    const title = rec.title || course.title || '';
    const authors = (rec.authors || m.authors || []).join(', ');
    const lines = [
      `# ${r.courseCode || ''}${title ? ' - ' + title : ''}`.trim(),
      '',
      authors ? `Penulis: ${authors}` : '',
      rec.edition || m.edition || r.editionNumber ? `Edisi: ${rec.edition || m.edition || ('Edisi ' + r.editionNumber)}` : '',
      rec.sks || m.sks ? `SKS: ${rec.sks || m.sks}` : '',
      rec.moduleCount || m.modules ? `Jumlah modul: ${rec.moduleCount || m.modules}` : '',
      rec.bibliographicPages || m.bibliographicPages ? `Halaman bibliografi: ${rec.bibliographicPages || m.bibliographicPages}` : '',
      rec.isbnPrint || m.isbnPrint ? `ISBN: ${rec.isbnPrint || m.isbnPrint}` : '',
      rec.isbnElectronic || m.isbnElectronic ? `ISBN (E): ${rec.isbnElectronic || m.isbnElectronic}` : '',
      rec.year || m.year ? `Tahun: ${rec.year || m.year}` : '',
      rec.ddc || m.ddc ? `DDC: ${rec.ddc || m.ddc}` : '',
      rec.coverUrl ? `Cover: ${rec.coverUrl}` : '',
      rec.fulltextCode || r.fulltextCode ? `Kode akses: ${rec.fulltextCode || r.fulltextCode}` : '',
      '',
      '## Deskripsi',
      '',
      rec.description || m.description || ''
    ].filter(line => line !== null && line !== undefined);
    return lines.join('\n').replace(/\n{4,}/g, '\n\n\n');
  }

  /** Builds ordered cover URL candidates from analyzer metadata and page image metadata. */
  function coverUrlCandidatesFromMetadata(meta = null) {
    const data = meta || getActiveMetadata();
    const rec = data && data.recommendedForNemo || {};
    const cover = data && data.cover || {};
    const course = data && data.course || {};
    const code = normCourseCode(rec.courseCode || course.code || '');
    const push = (list, url, reason = '', source = null) => {
      const value = absoluteFrom(url || '', data && data.pageUrl || location.href);
      if (!value || !/\.(?:jpe?g|png|webp)(?:$|[?#])/i.test(value)) return;
      const text = [value, reason, source && source.title, source && source.alt, source && source.filename].join(' ');
      if (isNonCourseImageCandidate(text) && !(code && text.toUpperCase().includes(code))) return;
      list.push({ url: value, reason, source });
    };
    const list = [];
    push(list, rec.coverUrl, 'metadata cover');
    push(list, cover.bestUrl, 'best cover');
    push(list, cover.best && cover.best.src, 'best candidate');
    push(list, cover.display && cover.display.href, 'display href', cover.display);
    push(list, cover.display && fullImageUrlCandidate(cover.display.src), 'display full image', cover.display);
    push(list, cover.display && cover.display.src, 'display image', cover.display);
    for (const item of cover.displayCandidates || cover.candidates || []) {
      push(list, item.href, 'candidate href', item);
      push(list, fullImageUrlCandidate(item.src), 'candidate full image', item);
      push(list, item.src, 'candidate image', item);
    }
    const seen = new Set();
    return list.filter(item => {
      const key = item.url.replace(/[?#].*$/, '').toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  /** Fetches the selected cover image as a blob, trying safe fallbacks if the best URL fails. */
  async function fetchCoverBlob(meta = null) {
    const data = meta || getActiveMetadata();
    const candidates = coverUrlCandidatesFromMetadata(data);
    let lastError = null;
    for (const candidate of candidates) {
      const url = candidate.url;
      if (state.coverBlobCache.has(url)) return state.coverBlobCache.get(url);
      try {
        const response = await fetch(url, { credentials: 'include', cache: 'force-cache' });
        if (!response.ok) throw new Error(`Cover HTTP ${response.status}`);
        const blob = await response.blob();
        if (!/^image\//i.test(blob.type || response.headers.get('content-type') || '')) throw new Error('Cover bukan gambar');
        if (blob.size < 1024) throw new Error('Cover terlalu kecil');
        const filename = (() => { try { return decodeURIComponent(new URL(url).pathname.split('/').pop() || 'cover.jpg'); } catch { return 'cover.jpg'; } })();
        const out = { url, filename, blob, source: candidate.reason || '' };
        state.coverBlobCache.set(url, out);
        return out;
      } catch (error) {
        lastError = error;
      }
    }
    if (lastError) throw lastError;
    return null;
  }

  /** Returns a metadata heading for text exports. */
  function metadataTextBlock(format = 'txt') {
    const meta = getActiveMetadata();
    if (!state.config.includeMetadata || !meta) return '';
    const r = resolveCourseCodes(meta, state.config.subfolder);
    const m = meta.metadata || {};
    const rec = meta.recommendedForNemo || {};
    const title = rec.title || (meta.course && meta.course.title) || '';
    const authors = (rec.authors || m.authors || []).join(', ');
    if (format === 'md') return buildMetadataReadme(meta, r) + '\n\n---\n\n';
    return [
      `${r.courseCode || ''}${title ? ' - ' + title : ''}`.trim(),
      authors ? `Penulis: ${authors}` : '',
      rec.edition || m.edition ? `Edisi: ${rec.edition || m.edition}` : '',
      r.fulltextCode ? `Kode akses: ${r.fulltextCode}` : '',
      rec.description || m.description ? `Deskripsi: ${rec.description || m.description}` : '',
      ''
    ].filter(Boolean).join('\n') + '\n';
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

    // Manual document/link input was removed from the UI in v1.3.3.
    // Keep discovery focused on checked document patterns plus optional custom patterns.

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

  /** Extracts useful page-count hints from reader HTML. */
  function parseReaderPageHints(html) {
    const text = String(html || '');
    const hints = [];
    const add = (value, source) => {
      const n = Number(value);
      if (Number.isInteger(n) && n > 0 && n <= 2000) hints.push({ pages: n, source });
    };
    const patterns = [
      /(?:totalPages|total_pages|pageCount|page_count|numPages|num_pages|pages)\s*[:=]\s*["']?(\d{1,4})/gi,
      /["'](?:totalPages|total_pages|pageCount|page_count|numPages|num_pages|pages)["']\s*:\s*["']?(\d{1,4})/gi,
      /(?:Jumlah\s*Halaman|Total\s*Halaman|Halaman)\D{0,24}(\d{1,4})/gi,
      /\/\s*(\d{1,4})\s*(?:halaman|pages?)/gi
    ];
    for (const pattern of patterns) {
      let match;
      while ((match = pattern.exec(text))) add(match[1], pattern.source.slice(0, 24));
    }
    const values = hints.map(h => h.pages).sort((a, b) => a - b);
    const unique = Array.from(new Set(values));
    const best = unique.length ? unique[unique.length - 1] : null;
    return { pages: best, candidates: unique.slice(-8), found: unique.length > 0 };
  }

  /** Picks the first reliable page count from known hints. */
  function firstPageCountHint(...hints) {
    for (const hint of hints) {
      const pages = Number(hint && hint.pages);
      if (Number.isInteger(pages) && pages > 0 && pages <= Math.max(1, Math.min(2000, Number(state.config.maxPage) || DEFAULTS.maxPage))) return pages;
    }
    return null;
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
      note: '',
      pageHints: null
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
      output.pageHints = parseReaderPageHints(text);
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

  /** Checks a PNG page with a small request for fast page counting. */
  async function fetchPngUrlLight(url, page, serviceDoc) {
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
      const response = await fetch(url, { method: 'GET', credentials: 'include', cache: 'no-store', headers: { Range: 'bytes=0-2047' }, signal });
      result.status = response.status;
      result.contentType = response.headers.get('content-type') || '';
      if (!response.ok && response.status !== 206) {
        result.note = `HTTP ${response.status}`;
        return result;
      }
      const blob = await response.blob();
      result.sizeBytes = blob.size;
      const typeLooksPng = /^image\/png(?:;|$)/i.test(blob.type || result.contentType);
      let signatureLooksPng = false;
      try {
        const head = new Uint8Array(await blob.slice(0, 8).arrayBuffer());
        signatureLooksPng = head.length >= 8 && head[0] === 137 && head[1] === 80 && head[2] === 78 && head[3] === 71;
      } catch { }
      result.exists = Boolean(typeLooksPng || signatureLooksPng);
      result.serviceDocUsed = result.exists ? serviceDoc : null;
      result.note = result.exists ? 'OK' : 'Bukan PNG';
      return result;
    } catch (error) {
      result.note = error && error.name === 'AbortError' ? 'Dibatalkan atau timeout' : String(error && error.message || error);
      return result;
    } finally {
      clearTimeout(timer);
    }
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

  /** Fast existence probe for page counting; avoids image decoding. */
  async function probePngPageLight(docName, page, cache, preferredServiceDoc = null) {
    if (state.stopRequested) throw new Error('Proses dihentikan.');
    const variants = getServiceDocVariants(docName, preferredServiceDoc);
    const subfolderKey = normalizeSubfolder(state.config.subfolder).toLowerCase();
    const cacheKey = `light|${subfolderKey}|${toDisplayDoc(docName).toLowerCase()}|${String(preferredServiceDoc || '').toLowerCase()}|${page}`;
    if (cache && cache.has(cacheKey)) return cache.get(cacheKey);

    const initSession = state.config.initReaderBeforeProbe ? await initializeReaderDocument(docName) : null;
    let best = null;
    const tried = [];
    for (const serviceDoc of variants) {
      if (state.stopRequested) throw new Error('Proses dihentikan.');
      const url = buildImageUrl(docName, page, 'png', serviceDoc);
      const result = await fetchPngUrlLight(url, page, serviceDoc);
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
      const list = Array.isArray(data) ? data : (Array.isArray(data.pages) ? data.pages : [data]);
      for (const item of list) {
        if (!item || typeof item !== 'object') continue;
        const pages = Number(item.pages || item.totalPages || item.pageCount || item.numPages);
        const number = Number(item.number || item.page || item.pageNumber);
        if (Number.isInteger(pages) && pages > 0) {
          return {
            ok: true,
            pages,
            number: Number.isInteger(number) ? number : null,
            sizeBytes: text.length,
            anchor: page
          };
        }
      }
      return null;
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  /** Tries several native text anchors to find a page-count hint faster. */
  async function tryReadJsonPageCount(docName, serviceDoc) {
    const anchors = [1, 2, 3, 10, 11, 12, 20, 21, 30, 40, 50];
    for (const anchor of anchors) {
      if (state.stopRequested) throw new Error('Proses dihentikan.');
      const hint = await tryReadJsonPage(docName, anchor, serviceDoc);
      if (hint && hint.pages) return hint;
      await probeDelay();
    }
    return null;
  }

  /** Validates a page-count hint with full PNG decoding at the boundary. */
  async function validatePageCountHint(docName, pages, cache, serviceDoc) {
    const maxPage = Math.max(1, Math.min(2000, Number(state.config.maxPage) || DEFAULTS.maxPage));
    const n = Number(pages);
    if (!Number.isInteger(n) || n < 1 || n > maxPage) return { ok: false, pages: n, probes: 0, reason: 'hint-di-luar-batas' };
    const last = await probePngPage(docName, n, cache, serviceDoc);
    let probes = 1;
    if (!last.exists) return { ok: false, pages: n, probes, reason: 'halaman-akhir-tidak-ada', last };
    if (n >= maxPage) return { ok: true, pages: n, probes, capped: true, reason: 'batas-maksimum' };
    await probeDelay();
    const next = await probePngPage(docName, n + 1, cache, serviceDoc);
    probes += 1;
    if (next.exists) return { ok: false, pages: n, probes, reason: 'halaman-berikutnya-masih-ada', next };
    return { ok: true, pages: n, probes, capped: false, reason: 'tervalidasi' };
  }

  /** Finds the last page accurately. Hints are used only after boundary validation. */
  async function countPages(docName, firstProbe, cache) {
    const maxPage = Math.max(1, Math.min(2000, Number(state.config.maxPage) || DEFAULTS.maxPage));
    if (!firstProbe || !firstProbe.exists) return { pages: 0, capped: false, probes: 0, method: 'none' };

    let probes = 1;
    const hints = [];

    const jsonHint = await tryReadJsonPageCount(docName, firstProbe.serviceDocUsed);
    if (jsonHint && jsonHint.pages) hints.push({ source: 'json', pages: jsonHint.pages, detail: jsonHint });

    const readerPages = firstPageCountHint(firstProbe.initSession && firstProbe.initSession.pageHints);
    if (readerPages) hints.push({ source: 'reader', pages: readerPages, detail: firstProbe.initSession.pageHints });

    const seenHints = new Set();
    for (const hint of hints) {
      const key = `${hint.source}|${hint.pages}`;
      if (seenHints.has(key)) continue;
      seenHints.add(key);
      const validation = await validatePageCountHint(docName, hint.pages, cache, firstProbe.serviceDocUsed);
      probes += validation.probes || 0;
      if (validation.ok) {
        return {
          pages: validation.pages,
          capped: Boolean(validation.capped),
          probes,
          method: `${hint.source}-validated`,
          jsonHint: hint.source === 'json' ? hint.detail : null,
          readerHint: hint.source === 'reader' ? hint.detail : null,
          validation
        };
      }
    }

    let lo = 1;
    let hi = 2;
    while (hi <= maxPage) {
      await probeDelay();
      const check = await probePngPage(docName, hi, cache, firstProbe.serviceDocUsed);
      probes += 1;
      if (!check.exists) break;
      lo = hi;
      hi *= 2;
    }

    if (hi > maxPage) {
      await probeDelay();
      const maxCheck = await probePngPage(docName, maxPage, cache, firstProbe.serviceDocUsed);
      probes += 1;
      if (maxCheck.exists) return { pages: maxPage, capped: true, probes, method: 'png-full' };
      hi = maxPage;
    }

    let left = lo + 1;
    let right = Math.max(lo, hi - 1);
    let best = lo;
    while (left <= right) {
      const mid = Math.floor((left + right) / 2);
      await probeDelay();
      const check = await probePngPage(docName, mid, cache, firstProbe.serviceDocUsed);
      probes += 1;
      if (check.exists) {
        best = mid;
        left = mid + 1;
      } else {
        right = mid - 1;
      }
    }
    return { pages: best, capped: false, probes, method: 'png-full' };
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


  /** Parses one pasted reader or service link into document identity. */
  function parseReaderLink(value) {
    const raw = String(value || '').trim();
    if (!raw) return null;
    try {
      const url = new URL(raw, location.href);
      const doc = url.searchParams.get('doc');
      const subfolder = url.searchParams.get('subfolder');
      if (!doc) return null;
      return {
        href: url.href,
        doc: toDisplayDoc(doc),
        serviceDoc: toServiceDoc(doc),
        subfolder: normalizeSubfolder(subfolder || state.config.subfolder),
        path: url.pathname
      };
    } catch {
      return null;
    }
  }

  /** Runs the scan. */
  async function runScan() {
    if (state.running) return;
    readConfigFromUi();
    saveConfig();

    const subfolder = normalizeSubfolder(state.config.subfolder);
    if (!subfolder) {
      alert('Isi kode akses / subfolder terlebih dahulu. Contoh: EKSI441604/ atau EKMA431404/');
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
    state.config.subfolder = resolveInputSubfolder(n.subfolder.value);
    state.config.rbvUrl = normalizeRbvPageUrl(n.rbvUrl ? n.rbvUrl.value : '') || String(n.rbvUrl ? n.rbvUrl.value : '').trim();
    state.config.patternPresetKeys = checkedPatternPresetKeys();
    state.config.customPatterns = n.customPatterns ? n.customPatterns.value : '';
    state.config.patterns = buildEffectivePatternString(state.config);
    state.config.useDirectProbe = true;
    state.config.initReaderBeforeProbe = n.initReaderBeforeProbe ? Boolean(n.initReaderBeforeProbe.checked) : true;
    state.config.usePageLinks = false;
    state.config.usePatterns = true;
    state.config.maxPage = Math.max(1, Math.min(2000, Number(n.maxPage.value) || DEFAULTS.maxPage));
    state.config.delayMs = Math.max(0, Math.min(10000, Number(n.delayMs.value) || DEFAULTS.delayMs));
    state.config.timeoutMs = Math.max(3000, Math.min(60000, Number(n.timeoutMs.value) || DEFAULTS.timeoutMs));
    if (n.speedModeRadios) state.config.speedMode = (n.speedModeRadios.find(input => input.checked) || {}).value || DEFAULTS.speedMode;
    if (n.outputFormatRadios) state.config.outputFormat = (n.outputFormatRadios.find(input => input.checked) || {}).value || DEFAULTS.outputFormat;
    if (n.outputBundleRadios) state.config.outputBundle = (n.outputBundleRadios.find(input => input.checked) || {}).value || DEFAULTS.outputBundle;
    if (state.config.outputFormat === 'png') state.config.outputBundle = 'zip';
    state.config.pdfSearchable = isPdfSearchableSelected();
    state.config.includeCover = n.includeCover ? Boolean(n.includeCover.checked) : true;
    state.config.includeMetadata = n.includeMetadata ? Boolean(n.includeMetadata.checked) : true;
    state.config.includeIdentityPage = n.includeIdentityPage ? Boolean(n.includeIdentityPage.checked) : true;
    state.config.compact = state.ui.classList.contains('nss-compact');
    state.config.minimized = state.ui.classList.contains('nss-minimized');
  }


  /** Updates the minimized bubble label. */
  function updateMiniBubble() {
    const node = state.nodes && state.nodes.miniBubbleText;
    if (!node) return;
    const valid = state.results.filter(item => item.valid).length;
    const pages = state.results.filter(item => item.valid).reduce((sum, item) => sum + Number(item.pages || 0), 0);
    if (state.running) node.textContent = 'Nemo bekerja';
    else if (valid) node.textContent = `Nemo · ${valid} dokumen · ${pages} halaman`;
    else node.textContent = 'Nemo';
  }

  /** Minimizes the Nemo panel into a small floating bubble. */
  function minimizeUi() {
    if (!state.ui) return;
    state.ui.classList.add('nss-minimized');
    state.config.minimized = true;
    updateMiniBubble();
    saveConfig();
  }

  /** Restores the full Nemo panel from the minimized bubble. */
  function restoreUi() {
    if (!state.ui) {
      buildUi();
      return;
    }
    state.ui.classList.remove('nss-minimized');
    state.config.minimized = false;
    updateMiniBubble();
    saveConfig();
  }

  /** Sets status text. */
  function setStatus(message, isError = false) {
    if (!state.nodes.status) return;
    state.nodes.status.textContent = message;
    state.nodes.status.classList.toggle('is-error', Boolean(isError));
    updateMiniBubble();
  }

  /** Updates main buttons. */
  function updateButtons() {
    const n = state.nodes;
    if (!n.scanBtn) return;
    n.scanBtn.disabled = state.running;
    n.stopBtn.disabled = !state.running;
    n.exportBtn.disabled = !state.results.length;
    if (n.downloadModeBtn) n.downloadModeBtn.disabled = state.running || !selectedResults().length;
    if (n.zipSelectedBtn) n.zipSelectedBtn.disabled = state.running || !selectedResults().length;
    if (n.pdfSelectedBtn) n.pdfSelectedBtn.disabled = state.running || !selectedResults().length;
    if (n.txtSelectedBtn) n.txtSelectedBtn.disabled = state.running || !selectedResults().length;
    if (n.mdSelectedBtn) n.mdSelectedBtn.disabled = state.running || !selectedResults().length;
    n.clearBtn.disabled = state.running || !state.results.length;
    if (state.ui) state.ui.classList.toggle('nss-running', Boolean(state.running));
    updateMiniBubble();
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
    updateMiniBubble();
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
    const pageNumbers = Array.from({ length: pages }, (_, index) => index + 1);
    const profile = getSpeedProfile();

    const items = await runConcurrent(pageNumbers, async (page) => {
      if (state.stopRequested) throw new Error('Proses dihentikan.');
      setStatus(`Mengambil ${result.label} halaman ${page}/${pages} (${totalIndex + 1}/${totalDocs}) · ${profile.label}`);
      const item = await fetchPagePngBlob(result, page);
      await downloadDelay();
      return item;
    }, profile.concurrency);

    for (const item of items) {
      if (!item) continue;
      if (item.ok) {
        files.push({ name: `${folderName}/png/page-${String(item.page).padStart(3, '0')}.png`, blob: item.blob });
      } else {
        failures.push({ page: item.page, note: item.note || 'Gagal' });
        log(`${result.doc} halaman ${item.page}: gagal (${item.note || 'gagal'}).`);
      }
    }
    files.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));

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
      speedMode: profile.mode,
      concurrency: profile.concurrency,
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
      bundle.files.unshift(...await buildMetadataFiles('00_Metadata/'));
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
      allFiles.unshift(...await buildMetadataFiles('00_Metadata/'));
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
    const out = [];
    const metaBlock = metadataTextBlock('txt');
    if (metaBlock) out.push(metaBlock.trim(), '');
    out.push(`${result.label} - ${result.doc}`, `Subfolder: ${normalizeSubfolder(state.config.subfolder)}`, `Halaman: ${result.pages || 0}`, '');
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
    const out = [];
    const metaBlock = metadataTextBlock('md');
    if (metaBlock) out.push(metaBlock.trim(), '');
    out.push(`# ${result.label}`, '', `- Dokumen: ${result.doc}`, `- Subfolder: ${normalizeSubfolder(state.config.subfolder)}`, `- Halaman: ${result.pages || 0}`, '');
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


  /** Wraps a text line for simple PDF front matter pages. */
  function wrapPlainLine(text, max = 78) {
    const words = String(text || '').split(/\s+/).filter(Boolean);
    const lines = [];
    let line = '';
    for (const word of words) {
      if ((line + ' ' + word).trim().length > max && line) {
        lines.push(line);
        line = word;
      } else {
        line = (line + ' ' + word).trim();
      }
    }
    if (line) lines.push(line);
    return lines;
  }

  /** Builds PDF front matter options from active metadata. */
  async function buildPdfFrontMatter(mode = 'combined', items = [], options = {}) {
    const wantsCover = state.config.includeCover !== false;
    const wantsMetadataPage = state.config.includeIdentityPage !== false;
    if (!wantsCover && !wantsMetadataPage) return null;
    const meta = getActiveMetadata();
    if (!meta) {
      log('Cover dan metadata dilewati karena metadata belum dimuat.');
      return null;
    }
    const cover = wantsCover ? await fetchCoverBlob(meta).catch(() => null) : null;
    if (!wantsMetadataPage && !(cover && cover.blob)) return null;
    return {
      mode,
      items,
      metadata: meta,
      includeCoverPage: Boolean(wantsCover && cover && cover.blob),
      includeMetadataPage: Boolean(wantsMetadataPage),
      coverBlob: cover ? cover.blob : null,
      coverFilename: cover ? cover.filename : ''
    };
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

    const buildPdfImageXObject = async (blob) => {
      const bytes = await blobToBytes(blob);
      try {
        const image = parsePngForPdf(bytes);
        return {
          image,
          dict: `<< /Type /XObject /Subtype /Image /Width ${image.width} /Height ${image.height} /ColorSpace ${image.colorSpace} /BitsPerComponent 8 /Filter /FlateDecode /DecodeParms << /Predictor 15 /Colors ${image.colors} /BitsPerComponent 8 /Columns ${image.width} >> /Length ${image.stream.length} >>`
        };
      } catch {
        const image = await convertImageBlobToJpegForPdf(blob);
        return {
          image,
          dict: `<< /Type /XObject /Subtype /Image /Width ${image.width} /Height ${image.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${image.stream.length} >>`
        };
      }
    };

    const addCoverPage = async (frontMatter, size) => {
      if (!frontMatter || !frontMatter.includeCoverPage || !frontMatter.coverBlob) return;
      const pageW = size.width;
      const pageH = size.height;
      const pageId = reserve();
      const imageId = reserve();
      const contentId = reserve();
      try {
        const { image, dict } = await buildPdfImageXObject(frontMatter.coverBlob);
        setObj(imageId, [dict, '\nstream\n', image.stream, '\nendstream']);
        // Full-page cover: fill the whole A4 page while preserving aspect ratio.
        // Content outside the MediaBox is clipped by the PDF viewer.
        const ratio = Math.max(pageW / image.width, pageH / image.height);
        const w = image.width * ratio;
        const h = image.height * ratio;
        const x = (pageW - w) / 2;
        const y = (pageH - h) / 2;
        const commands = [`q\n${pdfNum(w)} 0 0 ${pdfNum(h)} ${pdfNum(x)} ${pdfNum(y)} cm\n/Cover1 Do\nQ`];
        const contentBytes = encoder.encode(commands.join('\n') + '\n');
        setObj(contentId, [`<< /Length ${contentBytes.length} >>\nstream\n`, contentBytes, '\nendstream']);
        setObj(pageId, `<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${pageW} ${pageH}] /Resources << /XObject << /Cover1 ${imageId} 0 R >> >> /Contents ${contentId} 0 R >>`);
        pageIds.push(pageId);
      } catch (error) {
        log(`Cover PDF dilewati: ${String(error && error.message || error)}`);
      }
    };

    const textValue = value => String(value ?? '').replace(/\s+/g, ' ').trim();
    const joinNames = value => Array.isArray(value) ? value.map(textValue).filter(Boolean).join(', ') : textValue(value);
    const firstFilled = (...values) => values.map(textValue).find(Boolean) || '';
    const validListLine = value => {
      const line = textValue(value);
      if (!line) return '';
      if (/^(?:Edisi\s*\/\s*SKS\s*\/\s*Modul|ISBN|ISBN\s*\(E\)|Kelas\s+DDC\s*\[[^\]]+\])\s*$/i.test(line)) return '';
      return line;
    };

    const addMetadataPage = async (frontMatter, size) => {
      if (!frontMatter || !frontMatter.includeMetadataPage || !frontMatter.metadata) return;
      const meta = frontMatter.metadata;
      const rec = meta.recommendedForNemo || {};
      const md = meta.metadata || {};
      const course = meta.course || {};
      const resolved = resolveCourseCodes(meta, state.config.subfolder);
      const pageW = size.width;
      const pageH = size.height;
      const marginX = 54;
      const titleText = firstFilled(rec.title, course.title);
      const title = [resolved.courseCode || '', titleText].filter(Boolean).join(' - ');
      const authors = joinNames(rec.authors || md.authors || []);
      const edition = firstFilled(rec.edition, md.edition, resolved.editionNumber ? `Edisi ${resolved.editionNumber}` : '');
      const sks = firstFilled(rec.sks, md.sks);
      const modules = firstFilled(rec.moduleCount, md.modules);
      const physical = firstFilled(md.physicalDescription, rec.bibliographicPages || md.bibliographicPages ? `${rec.bibliographicPages || md.bibliographicPages} halaman` : '');
      const publisher = firstFilled(md.publisherText, md.publisher, rec.year || md.year);
      const description = firstFilled(rec.description, md.description);
      const fields = [
        ['Kode mata kuliah', resolved.courseCode],
        ['Judul', titleText],
        ['Penulis', authors],
        ['Edisi', edition],
        ['SKS', sks],
        ['Jumlah modul', modules],
        ['Halaman', physical],
        ['ISBN', firstFilled(rec.isbnPrint, md.isbnPrint)],
        ['ISBN elektronik', firstFilled(rec.isbnElectronic, md.isbnElectronic)],
        ['Penerbit', publisher],
        ['Tahun', firstFilled(rec.year, md.year)],
        ['DDC', firstFilled(rec.ddc, md.ddc)],
        ['Kode akses', resolved.fulltextCode]
      ].filter(([, value]) => textValue(value));
      const bibliography = Array.isArray(md.listItems) ? md.listItems.map(validListLine).filter(Boolean) : [];

      let pageId = null;
      let contentId = null;
      let commands = [];
      let y = 0;

      const beginPage = (continuation = false) => {
        pageId = reserve();
        contentId = reserve();
        commands = [];
        y = 790;
        const mainTitle = continuation ? `${title || 'Metadata'} (lanjutan)` : (title || 'Metadata Mata Kuliah');
        commands.push('BT', '/F1 18 Tf', '0 Tr', `1 0 0 1 ${marginX} ${pdfNum(y)} Tm`, `(${pdfString(mainTitle)}) Tj`, 'ET');
        y -= 28;
      };

      const commitPage = () => {
        if (!pageId || !contentId) return;
        const contentBytes = encoder.encode(commands.join('\n') + '\n');
        setObj(contentId, [`<< /Length ${contentBytes.length} >>\nstream\n`, contentBytes, '\nendstream']);
        setObj(pageId, `<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${pageW} ${pageH}] /Resources << /Font << /F1 ${fontId} 0 R >> >> /Contents ${contentId} 0 R >>`);
        pageIds.push(pageId);
      };

      const ensureSpace = (needed = 18) => {
        if (y - needed >= 56) return;
        commitPage();
        beginPage(true);
      };

      const addHeading = label => {
        ensureSpace(28);
        y -= 6;
        commands.push('BT', '/F1 13 Tf', `1 0 0 1 ${marginX} ${pdfNum(y)} Tm`, `(${pdfString(label)}) Tj`, 'ET');
        y -= 18;
      };

      const addWrapped = (text, fontSize = 10, maxChars = 82, indent = 0, lineGap = 14) => {
        for (const line of wrapPlainLine(text, maxChars)) {
          ensureSpace(lineGap + 2);
          commands.push('BT', `/F1 ${pdfNum(fontSize)} Tf`, `1 0 0 1 ${pdfNum(marginX + indent)} ${pdfNum(y)} Tm`, `(${pdfString(line)}) Tj`, 'ET');
          y -= lineGap;
        }
      };

      const addField = (label, value) => {
        const val = textValue(value);
        if (!val) return;
        const prefix = `${label}: `;
        const lines = wrapPlainLine(prefix + val, 72);
        lines.forEach((line, idx) => {
          ensureSpace(16);
          const indent = idx === 0 ? 0 : 18;
          commands.push('BT', '/F1 10 Tf', `1 0 0 1 ${pdfNum(marginX + indent)} ${pdfNum(y)} Tm`, `(${pdfString(line)}) Tj`, 'ET');
          y -= 15;
        });
      };

      beginPage(false);
      addHeading('Identitas Mata Kuliah');
      for (const [label, value] of fields) addField(label, value);

      if (bibliography.length) {
        addHeading('Bibliografi');
        for (const line of bibliography.slice(0, 12)) addWrapped(`• ${line}`, 10, 82, 0, 14);
      }

      if (description) {
        addHeading('Deskripsi');
        addWrapped(description, 10, 88, 0, 14);
      }

      commitPage();
    };

    /** Resolves the page size (in PDF points) that front-matter pages should use,
     *  matched against the first available content page so cover/metadata pages
     *  never mismatch the size of the scanned content pages. Falls back to A4
     *  when there is no content page to measure (e.g. metadata-only PDF). */
    const resolveReferencePageSize = async () => {
      for (const record of pageRecords || []) {
        if (!record || !record.blob) continue;
        try {
          const { image } = await buildPdfImageXObject(record.blob);
          return pngToPdfPageSize(image.width, image.height);
        } catch { continue; }
      }
      return { width: 595.28, height: 841.89 };
    };

    if (options.frontMatter) {
      const referenceSize = await resolveReferencePageSize();
      await addCoverPage(options.frontMatter, referenceSize);
      await addMetadataPage(options.frontMatter, referenceSize);
    }

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
    return createPdfFromPageRecords(records, { searchable: options.searchable !== false, frontMatter: options.frontMatter || null });
  }

  /** Collects image pages only, without ZIP entry wrapping. */
  async function collectPngBlobsForDocument(result, totalIndex = 0, totalDocs = 1) {
    const pages = Math.max(0, Number(result.pages) || 0);
    await initializeReaderDocument(result.doc);
    const profile = getSpeedProfile();
    const pageNumbers = Array.from({ length: pages }, (_, index) => index + 1);
    const rawItems = await runConcurrent(pageNumbers, async (page) => {
      if (state.stopRequested) throw new Error('Proses dihentikan.');
      setStatus(`Mengambil gambar ${result.label} halaman ${page}/${pages} (${totalIndex + 1}/${totalDocs}) · ${profile.label}`);
      const item = await fetchPagePngBlob(result, page);
      await downloadDelay();
      return item;
    }, profile.concurrency);
    const items = [];
    const failures = [];
    for (const item of rawItems) {
      if (!item) continue;
      if (item.ok) items.push(item);
      else failures.push({ page: item.page, note: item.note || 'Gagal' });
    }
    items.sort((a, b) => a.page - b.page);
    failures.sort((a, b) => a.page - b.page);
    return { items, failures, speedMode: profile.mode, concurrency: profile.concurrency };
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
      const pdf = await createSearchablePdf(result, images.items, nativeBundle, { searchable, frontMatter: await buildPdfFrontMatter('single', [result], { searchable }) });
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
          const pdf = await createSearchablePdf(result, images.items, nativeBundle, { searchable, frontMatter: await buildPdfFrontMatter('single', [result], { searchable }) });
          const suffix = searchable ? '' : '-gambar-saja';
          files.push({ name: `${folder}/${safeName(result.doc.replace(/\.pdf$/i, ''))}${suffix}.pdf`, blob: pdf });
        }
        files.push({ name: `${folder}/status.json`, text: JSON.stringify({ doc: result.doc, searchable, nativeTextPages: nativeBundle.pages.length, pages: result.pages, imagePages: images.items.length, failedImages: images.failures, offsetInfo: nativeBundle.offsetInfo || null }, null, 2) });
      }
      files.unshift(...await buildMetadataFiles('00_Metadata/'));
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
      const pdf = await createPdfFromPageRecords(records, { searchable, frontMatter: await buildPdfFrontMatter('combined', items, { searchable }) });
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
      files.unshift(...await buildMetadataFiles('00_Metadata/'));
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
      const intro = metadataTextBlock(format).trim();
      const combinedBody = format === 'md' ? parts.join('\n\n---\n\n') : parts.join('\n\n==============================\n\n');
      const combined = intro ? `${intro}\n\n${combinedBody}` : combinedBody;
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
      courseMetadata: getActiveMetadata(),
      resolvedCourse: getActiveMetadata() ? resolveCourseCodes(getActiveMetadata(), state.config.subfolder) : null,
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
    ui.className = [state.config.compact ? 'nss-compact' : '', state.config.minimized ? 'nss-minimized' : ''].filter(Boolean).join(' ');
    ui.innerHTML = `
      <header class="nss-header">
        <div class="nss-brand">
          <strong>Nemo Capture Studio</strong>
          <span>Metadata · v1.4.0</span>
        </div>
        <div class="nss-head-actions">
          <button type="button" data-nss="minimize">Mini</button>
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
          <label>Kode akses / subfolder</label>
          <input data-nss="subfolder" placeholder="Contoh: EKSI441604/ atau EKMA431404/">
          <label>Pola dokumen awal</label>
          <div class="nss-pattern-presets nss-pattern-front">${renderPatternPresetOptions(state.config)}</div>
          <p class="nss-note">Fokus awal: DAFIS, TINJAUAN, dan M1 sampai M12. Tambahkan pola khusus di Pengaturan pencarian bila perlu.</p>
          <div class="nss-actions nss-primary-actions">
            <button type="button" class="primary" data-nss="scan">Cek</button>
            <button type="button" class="danger" data-nss="stop">Stop</button>
            <button type="button" data-nss="export">JSON</button>
          </div>
        </div>

        <div class="nss-card nss-metadata-card">
          <div class="nss-step"><b>i</b><span>Cover dan metadata</span></div>
          <pre class="nss-meta-summary" data-nss="metadataSummary">Belum ada metadata RBV.</pre>
          <label>Tautan RBV</label>
          <input data-nss="rbvUrl" placeholder="https://pustaka.ut.ac.id/lib/...">
          <div class="nss-actions">
            <button type="button" data-nss="readMetadataUrl">Ambil dari tautan</button>
            <button type="button" data-nss="readMetadata">Ambil dari halaman aktif</button>
            <button type="button" data-nss="applyMetadataSubfolder">Pakai kode akses</button>
            <button type="button" data-nss="clearMetadata">Hapus metadata</button>
          </div>
          <div class="nss-checks nss-metadata-checks">
            <label><input type="checkbox" data-nss="includeCover"> Sertakan cover full-page di PDF dan ZIP</label>
            <label><input type="checkbox" data-nss="includeMetadata"> Simpan metadata dan README</label>
            <label><input type="checkbox" data-nss="includeIdentityPage"> Halaman metadata rapi setelah cover</label>
          </div>
          <details class="nss-metadata-json">
            <summary>Import JSON metadata</summary>
            <textarea data-nss="metadataJson" placeholder="Tempel JSON dari Nemo RBV Cover Metadata Analyzer bila tidak berada di halaman RBV."></textarea>
            <div class="nss-inline-actions"><button type="button" data-nss="importMetadataJson">Import JSON</button></div>
          </details>
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
          <summary><span>Pengaturan pencarian</span><em>opsional</em></summary>
          <div class="nss-checks">
            <label><input type="checkbox" data-nss="initReaderBeforeProbe"> Siapkan dokumen dulu</label>
          </div>
          <label>Pola tambahan</label>
          <textarea data-nss="customPatterns" placeholder="Contoh: DAFIS.pdf, TINJAUAN.pdf, M{01-12}.pdf, MODUL{1-12}.pdf"></textarea>
          <p class="nss-note">Gunakan hanya jika mata kuliah memakai nama dokumen di luar DAFIS, TINJAUAN, dan M1-M12.</p>
        </details>

        <details class="nss-card nss-advanced">
          <summary><span>Pengaturan</span><em>lanjutan</em></summary>
          <div class="nss-grid">
            <div><label>Batas halaman</label><input type="number" data-nss="maxPage" min="1" max="2000"></div>
            <div><label>Jeda</label><input type="number" data-nss="delayMs" min="0" max="10000"></div>
            <div><label>Timeout</label><input type="number" data-nss="timeoutMs" min="3000" max="60000"></div>
          </div>
          <label>Kecepatan</label>
          <div class="nss-option-grid three nss-speed-options">
            <label class="nss-radio-card"><input type="radio" name="nss_speed_mode" value="safe" data-nss-speed-mode><span>Aman</span></label>
            <label class="nss-radio-card"><input type="radio" name="nss_speed_mode" value="balanced" data-nss-speed-mode><span>Seimbang</span></label>
            <label class="nss-radio-card"><input type="radio" name="nss_speed_mode" value="fast" data-nss-speed-mode><span>Cepat</span></label>
          </div>
          <p class="nss-note">Seimbang memakai beberapa unduhan sekaligus. Aman lebih pelan. Cepat lebih agresif.</p>
        </details>

        <div class="nss-card nss-results-card">
          <div class="nss-step"><b>3</b><span>Daftar dokumen</span></div>
          <div class="nss-table-wrap"><table><thead><tr><th></th><th>Dokumen</th><th>Jenis</th><th>Halaman</th><th>Ukuran</th><th>Sumber</th><th>Aksi</th></tr></thead><tbody data-nss="resultBody"><tr><td colspan="7" class="nss-empty">Belum ada hasil. Isi subfolder lalu klik Cek.</td></tr></tbody></table></div>
        </div>

        <details class="nss-logbox"><summary>Aktivitas</summary><pre data-nss="logs">Belum ada aktivitas.</pre></details>
      </div>
      <button type="button" class="nss-mini-bubble" data-nss="restore" title="Buka Nemo"><span class="nss-mini-dot"></span><span data-nss="miniBubbleText">Nemo</span></button>
    `;
    document.documentElement.appendChild(ui);
    state.ui = ui;
    state.nodes = {
      subfolder: ui.querySelector('[data-nss="subfolder"]'),
      customPatterns: ui.querySelector('[data-nss="customPatterns"]'),
      metadataSummary: ui.querySelector('[data-nss="metadataSummary"]'),
      rbvUrl: ui.querySelector('[data-nss="rbvUrl"]'),
      readMetadataUrlBtn: ui.querySelector('[data-nss="readMetadataUrl"]'),
      readMetadataBtn: ui.querySelector('[data-nss="readMetadata"]'),
      applyMetadataSubfolderBtn: ui.querySelector('[data-nss="applyMetadataSubfolder"]'),
      clearMetadataBtn: ui.querySelector('[data-nss="clearMetadata"]'),
      includeCover: ui.querySelector('[data-nss="includeCover"]'),
      includeMetadata: ui.querySelector('[data-nss="includeMetadata"]'),
      includeIdentityPage: ui.querySelector('[data-nss="includeIdentityPage"]'),
      metadataJson: ui.querySelector('[data-nss="metadataJson"]'),
      importMetadataJsonBtn: ui.querySelector('[data-nss="importMetadataJson"]'),
      patternPresetChecks: Array.from(ui.querySelectorAll('[data-nss-pattern-key]')),
      usePatterns: null,
      initReaderBeforeProbe: ui.querySelector('[data-nss="initReaderBeforeProbe"]'),
      usePageLinks: null,
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
      zipSelectedBtn: null,
      pdfSelectedBtn: null,
      txtSelectedBtn: null,
      mdSelectedBtn: null,
      speedModeRadios: Array.from(ui.querySelectorAll('[data-nss-speed-mode]')),
      clearBtn: ui.querySelector('[data-nss="clear"]'),
      status: ui.querySelector('[data-nss="status"]'),
      summary: ui.querySelector('[data-nss="summary"]'),
      resultBody: ui.querySelector('[data-nss="resultBody"]'),
      logs: ui.querySelector('[data-nss="logs"]'),
      minimizeBtn: ui.querySelector('[data-nss="minimize"]'),
      restoreBtn: ui.querySelector('[data-nss="restore"]'),
      miniBubbleText: ui.querySelector('[data-nss="miniBubbleText"]')
    };

    const n = state.nodes;
    n.subfolder.value = state.config.subfolder || inferSubfolderFromLocation();
    if (n.rbvUrl) n.rbvUrl.value = state.config.rbvUrl || inferRbvUrlFromLocation();
    state.config = normalizePatternConfig(state.config);
    state.courseMetadata = state.config.metadata || null;
    state.resolvedCourse = state.courseMetadata ? resolveCourseCodes(state.courseMetadata, state.config.subfolder) : null;
    n.customPatterns.value = state.config.customPatterns || '';
    for (const input of n.patternPresetChecks) input.checked = state.config.patternPresetKeys.includes(input.getAttribute('data-nss-pattern-key'));
    n.initReaderBeforeProbe.checked = state.config.initReaderBeforeProbe !== false;
    state.config.usePatterns = true;
    state.config.usePageLinks = false;
    n.maxPage.value = state.config.maxPage;
    n.delayMs.value = state.config.delayMs;
    n.timeoutMs.value = state.config.timeoutMs;
    if (n.speedModeRadios) for (const input of n.speedModeRadios) input.checked = input.value === (state.config.speedMode || DEFAULTS.speedMode);
    for (const input of n.outputFormatRadios) input.checked = input.value === (state.config.outputFormat || DEFAULTS.outputFormat);
    for (const input of n.outputBundleRadios) input.checked = input.value === (state.config.outputBundle || DEFAULTS.outputBundle);
    for (const input of n.pdfSearchableRadios) input.checked = input.value === (state.config.pdfSearchable === false ? 'no' : 'yes');
    if (n.includeCover) n.includeCover.checked = state.config.includeCover !== false;
    if (n.includeMetadata) n.includeMetadata.checked = state.config.includeMetadata !== false;
    if (n.includeIdentityPage) n.includeIdentityPage.checked = state.config.includeIdentityPage !== false;
    renderCourseMetadata();

    n.scanBtn.addEventListener('click', runScan);
    n.stopBtn.addEventListener('click', stopScan);
    n.exportBtn.addEventListener('click', exportJson);
    n.downloadModeBtn.addEventListener('click', runSelectedDownloadMode);
    n.clearBtn.addEventListener('click', clearResults);
    if (n.readMetadataUrlBtn) n.readMetadataUrlBtn.addEventListener('click', importMetadataFromRbvUrl);
    if (n.readMetadataBtn) n.readMetadataBtn.addEventListener('click', importMetadataFromPage);
    if (n.applyMetadataSubfolderBtn) n.applyMetadataSubfolderBtn.addEventListener('click', applyMetadataSubfolder);
    if (n.clearMetadataBtn) n.clearMetadataBtn.addEventListener('click', () => setCourseMetadata(null, 'hapus'));
    if (n.importMetadataJsonBtn) n.importMetadataJsonBtn.addEventListener('click', importMetadataJson);
    ui.querySelector('[data-nss="hide"]').addEventListener('click', () => ui.remove());
    if (n.minimizeBtn) n.minimizeBtn.addEventListener('click', minimizeUi);
    if (n.restoreBtn) n.restoreBtn.addEventListener('click', restoreUi);
    ui.querySelector('[data-nss="compact"]').addEventListener('click', event => {
      ui.classList.toggle('nss-compact');
      event.currentTarget.textContent = ui.classList.contains('nss-compact') ? 'Detail' : 'Ringkas';
      readConfigFromUi();
      saveConfig();
    });

    for (const node of [n.subfolder, n.rbvUrl, n.customPatterns, n.maxPage, n.delayMs, n.timeoutMs].filter(Boolean)) {
      node.addEventListener('change', () => { readConfigFromUi(); saveConfig(); });
      node.addEventListener('input', () => { readConfigFromUi(); saveConfig(); });
    }
    for (const node of [n.initReaderBeforeProbe, n.includeCover, n.includeMetadata, n.includeIdentityPage, ...n.patternPresetChecks].filter(Boolean)) node.addEventListener('change', () => { readConfigFromUi(); saveConfig(); renderCourseMetadata(); });
    if (n.speedModeRadios) for (const node of n.speedModeRadios) node.addEventListener('change', () => { readConfigFromUi(); saveConfig(); });
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
      #${UI_ID} .nss-mode-group{margin:10px 0} #${UI_ID} .nss-mode-title{margin:0 0 7px;color:#dbeafe;font-weight:900;font-size:12px} #${UI_ID} .nss-option-grid{display:grid;grid-template-columns:repeat(2,1fr);gap:7px} #${UI_ID} .nss-option-grid.two{grid-template-columns:repeat(2,1fr)} #${UI_ID} .nss-option-grid.three{grid-template-columns:repeat(3,1fr)} #${UI_ID} .nss-radio-card{display:flex;align-items:center;gap:8px;margin:0;padding:9px 10px;border:1px solid rgba(148,163,184,.20);border-radius:12px;background:rgba(2,6,23,.32);cursor:pointer;color:#e0f2fe;font-weight:900} #${UI_ID} .nss-radio-card:hover{border-color:rgba(34,211,238,.45);background:rgba(14,116,144,.12)} #${UI_ID} .nss-radio-card input{width:auto;accent-color:#22d3ee} #${UI_ID} .nss-radio-card.is-disabled{opacity:.45;pointer-events:none} #${UI_ID} .nss-download-preview{margin-top:9px;padding:9px 10px;border:1px solid rgba(34,211,238,.22);border-radius:12px;background:rgba(14,116,144,.12);color:#a5f3fc;font-weight:900}
      #${UI_ID} .nss-inline-actions{display:flex;gap:8px;margin:8px 0 10px} #${UI_ID} .nss-note{margin:10px 0 0;color:var(--nemo-soft);font-size:12px}
      #${UI_ID} .nss-status-title{color:var(--nemo-soft);font-size:11px;font-weight:900;text-transform:uppercase;letter-spacing:.08em;margin-bottom:6px} #${UI_ID} .nss-status{padding:0;color:#e2e8f0;font-weight:800} #${UI_ID} .nss-status.is-error{color:#fecaca}
      #${UI_ID} .nss-summary{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-top:10px} #${UI_ID} .nss-summary>div{background:rgba(2,6,23,.42);border:1px solid rgba(148,163,184,.16);border-radius:14px;padding:10px;text-align:center}
      #${UI_ID} .nss-summary strong{display:block;font-size:21px;color:#fff;line-height:1.1} #${UI_ID} .nss-summary span{display:block;color:var(--nemo-soft);font-size:11px;margin-top:2px}
      #${UI_ID} details.nss-advanced summary,#${UI_ID} .nss-logbox summary{cursor:pointer;list-style:none;display:flex;justify-content:space-between;align-items:center;font-weight:900;color:#dbeafe} #${UI_ID} details.nss-advanced summary::-webkit-details-marker,#${UI_ID} .nss-logbox summary::-webkit-details-marker{display:none} #${UI_ID} details.nss-advanced summary:after,#${UI_ID} .nss-logbox summary:after{content:'+';color:var(--nemo-accent);font-weight:900} #${UI_ID} details[open].nss-advanced summary:after,#${UI_ID} .nss-logbox[open] summary:after{content:'–'} #${UI_ID} details.nss-advanced summary em{font-style:normal;color:var(--nemo-soft);font-size:11px;font-weight:800}
      #${UI_ID} .nss-checks{display:grid;grid-template-columns:1fr;gap:8px;margin:10px 0} #${UI_ID} .nss-checks label{display:flex;align-items:center;gap:8px;margin:0;padding:8px 10px;border:1px solid rgba(148,163,184,.20);border-radius:12px;background:rgba(2,6,23,.36);font-weight:800;color:#dbeafe} #${UI_ID} .nss-checks input{width:auto;accent-color:#22d3ee}
      #${UI_ID} .nss-metadata-checks{grid-template-columns:1fr} #${UI_ID} .nss-meta-summary{white-space:pre-wrap;margin:8px 0 10px;color:#dbeafe;font:12px/1.45 system-ui,-apple-system,Segoe UI,sans-serif;background:rgba(2,6,23,.38);border:1px solid rgba(148,163,184,.18);border-radius:12px;padding:10px} #${UI_ID} .nss-metadata-json summary{cursor:pointer;color:#67e8f9;font-weight:900;margin-top:8px} #${UI_ID} .nss-metadata-json textarea{margin-top:8px;min-height:90px}
      #${UI_ID} .nss-pattern-presets{display:grid;grid-template-columns:1fr;gap:7px;margin:6px 0 10px} #${UI_ID} .nss-preset{display:flex;align-items:flex-start;gap:9px;margin:0;padding:9px 10px;border:1px solid rgba(148,163,184,.20);border-radius:12px;background:rgba(2,6,23,.32);cursor:pointer} #${UI_ID} .nss-preset:hover{border-color:rgba(34,211,238,.45);background:rgba(14,116,144,.12)} #${UI_ID} .nss-preset input{width:auto;margin-top:3px;accent-color:#22d3ee} #${UI_ID} .nss-preset span{display:block} #${UI_ID} .nss-preset b{display:block;color:#e0f2fe;font-size:12px} #${UI_ID} .nss-preset small{display:block;color:var(--nemo-soft);font-size:11px;margin-top:1px}
      #${UI_ID} .nss-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-top:9px}
      #${UI_ID} .nss-linktests{display:grid;gap:6px;margin:8px 0 10px} #${UI_ID} .nss-linktest{border:1px solid rgba(148,163,184,.20);border-radius:12px;padding:8px 10px;background:rgba(2,6,23,.36)} #${UI_ID} .nss-linktest strong{display:block;font-size:12px;color:#fff} #${UI_ID} .nss-linktest span{display:block;color:var(--nemo-soft);font-size:11px;margin-top:2px} #${UI_ID} .nss-linktest.ok{border-color:rgba(34,197,94,.42);background:rgba(20,83,45,.25)} #${UI_ID} .nss-linktest.bad{border-color:rgba(248,113,113,.42);background:rgba(127,29,29,.25)} #${UI_ID} .nss-empty-mini{color:var(--nemo-soft);font-size:12px;border:1px dashed rgba(148,163,184,.25);border-radius:12px;padding:8px 10px;background:rgba(2,6,23,.25)}
      #${UI_ID} .nss-table-wrap{border:1px solid rgba(148,163,184,.20);border-radius:14px;overflow:auto;max-height:320px;background:rgba(2,6,23,.38)} #${UI_ID} table{border-collapse:collapse;width:100%;min-width:690px}
      #${UI_ID} th,#${UI_ID} td{padding:9px 10px;border-bottom:1px solid rgba(148,163,184,.14);text-align:left;vertical-align:top} #${UI_ID} th{position:sticky;top:0;background:#111827;color:#9fb0c8;font-size:11px;text-transform:uppercase;letter-spacing:.05em;z-index:1}
      #${UI_ID} td{color:#e5e7eb} #${UI_ID} td small{display:block;color:var(--nemo-soft);margin-top:2px;font-size:11px} #${UI_ID} tr.is-muted{opacity:.48} #${UI_ID} tr:hover{background:rgba(34,211,238,.05)} #${UI_ID} .nss-empty{text-align:center;color:var(--nemo-soft);padding:22px}
      #${UI_ID} .nss-pill{display:inline-block;border-radius:999px;padding:3px 8px;font-size:11px;font-weight:900;margin:0 7px 5px 0} #${UI_ID} .nss-pill.ok{background:rgba(34,197,94,.18);color:#86efac;border:1px solid rgba(34,197,94,.35)} #${UI_ID} .nss-pill.bad{background:rgba(239,68,68,.16);color:#fecaca;border:1px solid rgba(239,68,68,.35)}
      #${UI_ID} a{color:#67e8f9;font-weight:900;text-decoration:none;margin-right:8px} #${UI_ID} button.nss-mini{padding:4px 7px;border-radius:8px;font-size:11px;margin:2px 3px 2px 0;background:rgba(14,116,144,.22);border-color:rgba(34,211,238,.35);color:#a5f3fc}
      #${UI_ID} pre{white-space:pre-wrap;max-height:160px;overflow:auto;margin:8px 0 0;color:#cbd5e1;font:11px/1.45 ui-monospace,SFMono-Regular,Consolas,monospace;background:rgba(2,6,23,.35);border-radius:12px;padding:9px;border:1px solid rgba(148,163,184,.14)}

      #${UI_ID} .nss-mini-bubble{display:none;align-items:center;gap:8px;min-width:112px;max-width:min(280px,calc(100vw - 24px));padding:11px 14px;border-radius:999px;background:linear-gradient(135deg,#0891b2,#2563eb);border:1px solid rgba(34,211,238,.70);color:#fff;box-shadow:0 18px 45px rgba(0,0,0,.42);font-weight:900;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      #${UI_ID} .nss-mini-dot{width:9px;height:9px;border-radius:999px;background:#86efac;box-shadow:0 0 0 3px rgba(134,239,172,.18);flex:0 0 auto}
      #${UI_ID}.nss-running .nss-mini-dot{background:#fbbf24;box-shadow:0 0 0 3px rgba(251,191,36,.20);animation:nss-pulse 1.2s infinite}
      #${UI_ID}.nss-minimized{width:auto;max-height:none;border:0;background:transparent;box-shadow:none;overflow:visible;backdrop-filter:none}
      #${UI_ID}.nss-minimized .nss-header,#${UI_ID}.nss-minimized .nss-content{display:none}
      #${UI_ID}.nss-minimized .nss-mini-bubble{display:flex}
      @keyframes nss-pulse{0%,100%{transform:scale(1);opacity:1}50%{transform:scale(.72);opacity:.65}}
      #${UI_ID}.nss-compact{width:min(392px,calc(100vw - 24px))} #${UI_ID}.nss-compact .nss-advanced,#${UI_ID}.nss-compact .nss-note,#${UI_ID}.nss-compact .nss-logbox{display:none} #${UI_ID}.nss-compact .nss-table-wrap{max-height:220px}
      @media(max-width:640px){#${UI_ID}{right:10px;bottom:10px;width:calc(100vw - 20px);max-height:calc(100vh - 20px)}#${UI_ID} .nss-grid,#${UI_ID} .nss-summary,#${UI_ID} .nss-save-actions,#${UI_ID} .nss-option-grid{grid-template-columns:1fr}}
    `;
    document.head.appendChild(style);
  }

  /** Shows panel. */
  function show() {
    const existing = document.getElementById(UI_ID);
    if (!existing) buildUi();
    else restoreUi();
  }

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
    minimize: minimizeUi,
    restore: restoreUi,
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
    getSpeedProfile,
    parseReaderPageHints,
    tryReadJsonPageCount,
    probePngPageLight,
    buildCandidates,
    parsePatternDocs,
    buildEffectivePatternString,
    normalizePatternConfig,
    extractDocsFromText,
    buildImageUrl,
    getServiceDocVariants,
    collectDocsFromPageLinks,
    parseReaderLink,
    extractRbvMetadataFromPage,
    importMetadataFromRbvUrl,
    normalizeRbvPageUrl,
    resolveCourseCodes,
    importMetadataFromPage,
    applyMetadataSubfolder,
    buildMetadataFiles,
    fetchCoverBlob
  };

  buildUi();
})();
