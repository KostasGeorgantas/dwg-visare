import createModule from './vendor/wasm/libredwg-web.js';
import { LibreDwg, Dwg_File_Type } from './vendor/dist/libredwg-web.js';

const $ = (id) => document.getElementById(id);
const viewport = $('viewport');
const sheets = $('sheets');
const guides = $('guides');

// I Electron kommer allt via preload (window.api). Utan den (t.ex. vid test i
// en vanlig webbläsare) används enkla ersättningar.
const api = window.api || {
  readWasm: () => fetch('vendor/wasm/libredwg-web.wasm').then((r) => r.arrayBuffer()),
  openDialog: () => pickFileInBrowser(),
  print: () => window.print(),
  readFont: async () => null,
  readXref: (xrefPath) => readXrefInBrowser(xrefPath),
  pathForFile: () => '',
  setTitle: (t) => { document.title = t; },
  on: () => {}
};

// ---------- DWG-motorn ----------

// Läsaren skapas på nytt om den kraschar (t.ex. "memory access out of bounds" i en
// trasig eller ovanlig fil), så att nästa fil inte påverkas
let wasmBinaryCache = null;
async function createLib() {
  if (!wasmBinaryCache) wasmBinaryCache = new Uint8Array(await api.readWasm());
  const mod = await createModule({ wasmBinary: wasmBinaryCache });
  return LibreDwg.createByWasmInstance(mod);
}
let libReady = createLib();

libReady.then(
  () => { $('engine').textContent = ''; },
  (err) => { $('engine').textContent = 'DWG-läsaren kunde inte starta: ' + err.message; }
);

// ---------- Vy (zoom och panorering) ----------
// Vyn beskrivs av en mittpunkt (cx, cy) i ritningens koordinater och hur många
// ritningsenheter en skärmpixel motsvarar (upp). SVG:ns viewBox räknas fram ur det.

// Varje öppen ritning är en flik med egen vy. Variablerna nedan gäller den aktiva fliken.
let svg = null;
let extents = null;          // { x, y, w, h } för hela ritningen
let view = { cx: 0, cy: 0, upp: 1 };
let fitUpp = 1;
let frame = 0;
let tabs = [];
let active = null;

function size() {
  return { w: viewport.clientWidth || 1, h: viewport.clientHeight || 1 };
}

function applyView() {
  frame = 0;
  if (!svg) return;
  const { w, h } = size();
  const vw = w * view.upp;
  const vh = h * view.upp;
  svg.setAttribute('viewBox', `${view.cx - vw / 2} ${view.cy - vh / 2} ${vw} ${vh}`);
  // Skärmpixlar per ritningsenhet, för linjetypernas streck
  svg.style.setProperty('--z', String(1 / view.upp));
  $('st-zoom').textContent = formatZoom(fitUpp / view.upp);
  drawGuides();
}

function scheduleView() {
  if (!frame) frame = requestAnimationFrame(applyView);
}

function fit() {
  if (!extents) return;
  const { w, h } = size();
  fitUpp = Math.max(extents.w / w, extents.h / h) * 1.05 || 1;
  view = { cx: extents.x + extents.w / 2, cy: extents.y + extents.h / 2, upp: fitUpp };
  applyView();
}

function zoomAt(factor, px, py) {
  if (!svg) return;
  const { w, h } = size();
  if (px == null) { px = w / 2; py = h / 2; }
  const newUpp = clamp(view.upp / factor, fitUpp / 1e7, fitUpp * 50);
  // Håll punkten under markören still
  const wx = view.cx + (px - w / 2) * view.upp;
  const wy = view.cy + (py - h / 2) * view.upp;
  view.cx = wx - (px - w / 2) * newUpp;
  view.cy = wy - (py - h / 2) * newUpp;
  view.upp = newUpp;
  scheduleView();
}

function panBy(dx, dy) {
  view.cx -= dx * view.upp;
  view.cy -= dy * view.upp;
  scheduleView();
}

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

function formatZoom(z) {
  const pct = z * 100;
  return (pct >= 1000 ? Math.round(pct).toLocaleString('sv-SE') : pct.toFixed(pct < 10 ? 1 : 0)) + ' %';
}

function formatCoord(v) {
  return v.toLocaleString('sv-SE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// ---------- Mus, hjul och pekskärm ----------

const pointers = new Map();
let pinchDist = 0;

viewport.addEventListener('wheel', (e) => {
  if (!svg) return;
  e.preventDefault();
  const r = viewport.getBoundingClientRect();
  const delta = e.deltaMode === 1 ? e.deltaY * 33 : e.deltaY;
  zoomAt(Math.exp(-delta * 0.0015), e.clientX - r.left, e.clientY - r.top);
}, { passive: false });

viewport.addEventListener('pointerdown', (e) => {
  if (!svg || (e.pointerType === 'mouse' && e.button !== 0 && e.button !== 1)) return;
  e.preventDefault();
  viewport.focus();
  viewport.setPointerCapture(e.pointerId);
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (pointers.size === 2) pinchDist = distance();
  viewport.classList.add('panning');
});

viewport.addEventListener('pointermove', (e) => {
  updateCoords(e);
  const r = viewport.getBoundingClientRect();
  cursor = { x: e.clientX - r.left, y: e.clientY - r.top };
  if (showGuides && !pointers.size) drawGuides();
  const prev = pointers.get(e.pointerId);
  if (!prev) return;
  if (pointers.size === 1) {
    panBy(e.clientX - prev.x, e.clientY - prev.y);
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  } else if (pointers.size === 2) {
    const before = midpoint();
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const after = midpoint();
    const d = distance();
    const r = viewport.getBoundingClientRect();
    panBy(after.x - before.x, after.y - before.y);
    if (pinchDist > 0) zoomAt(d / pinchDist, after.x - r.left, after.y - r.top);
    pinchDist = d;
  }
});

function endPointer(e) {
  pointers.delete(e.pointerId);
  if (pointers.size < 2) pinchDist = 0;
  if (pointers.size === 0) viewport.classList.remove('panning');
}
viewport.addEventListener('pointerup', endPointer);
viewport.addEventListener('pointercancel', endPointer);
viewport.addEventListener('pointerleave', () => {
  $('st-x').textContent = '–';
  $('st-y').textContent = '–';
  cursor = null;
  drawGuides();
});

// Dubbelklick med mushjulet visar hela ritningen, som i AutoCAD
viewport.addEventListener('auxclick', (e) => { if (e.button === 1 && e.detail === 2) fit(); });

function midpoint() {
  const [a, b] = [...pointers.values()];
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}
function distance() {
  const [a, b] = [...pointers.values()];
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function updateCoords(e) {
  if (!svg) return;
  const r = viewport.getBoundingClientRect();
  const { w, h } = size();
  const x = view.cx + (e.clientX - r.left - w / 2) * view.upp;
  const y = view.cy + (e.clientY - r.top - h / 2) * view.upp;
  $('st-x').textContent = formatCoord(x);
  $('st-y').textContent = formatCoord(-y); // SVG:ns y-axel är spegelvänd mot ritningens
}

viewport.addEventListener('keydown', (e) => {
  if (!svg) return;
  const step = 60;
  const keys = {
    ArrowLeft: () => panBy(step, 0), ArrowRight: () => panBy(-step, 0),
    ArrowUp: () => panBy(0, step), ArrowDown: () => panBy(0, -step),
    '+': () => zoomAt(1.25), '-': () => zoomAt(0.8)
  };
  if (keys[e.key]) { e.preventDefault(); keys[e.key](); }
});

new ResizeObserver(() => scheduleView()).observe(viewport);

// ---------- Öppna ritning ----------

// Filer läses en i taget, även om flera öppnas samtidigt
let loadQueue = Promise.resolve();
function openDrawing(name, data, filePath = '') {
  loadQueue = loadQueue.then(() => readDrawing(name, data, filePath));
  return loadQueue;
}

async function readDrawing(name, data, filePath) {
  hideError();
  const bytes = data instanceof ArrayBuffer ? data : data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);

  // Samma fil en gång till: visa fliken som redan är öppen
  const same = tabs.find((t) => t.name === name && t.size === bytes.byteLength);
  if (same) { activate(same); return; }

  $('busy-text').textContent = `Läser ${name}…`;
  $('busy').hidden = false;
  // Låt webbläsaren rita upp "Läser…" innan det tunga arbetet börjar
  await new Promise((r) => setTimeout(r, 30));

  let ptr = null;
  try {
    const lib = await libReady;
    if (!looksLikeDwg(bytes)) throw new Error(`${name} är inte en DWG-ritning.`);

    ptr = lib.dwg_read_data(bytes, Dwg_File_Type.DWG);
    if (!ptr) throw new Error(`${name} kunde inte tolkas. Filen kan vara skadad eller sparad i ett format som inte stöds.`);
    const version = lib.dwg_get_version_type(ptr);
    const db = lib.convert(ptr);
    fixNarrowStrings(db, version);
    const xrefs = await attachXrefs(lib, db, filePath, 0, new Set([filePath.toLowerCase()]));
    const markup = lib.dwg_to_svg(db).replace(/^<\?xml[^>]*>\s*/, '');
    const content = lib.lastSvgStats;

    const tab = createTab(name, bytes.byteLength, markup);
    if (!tab) throw new Error(`${name} verkar vara tom. Det finns inga objekt i modellrymden att visa.`);
    tab.version = describeVersion(version);
    tab.fonts = await applyFonts(tab.svg, db.tables?.STYLE?.entries || [], filePath);
    tab.xrefs = xrefs;
    tab.content = content;
    tabs.push(tab);
    renderTabs();
    activate(tab);
    fit();
  } catch (err) {
    console.error(err);
    if (err instanceof WebAssembly.RuntimeError) {
      ptr = null;
      libReady = createLib();
      showError(`${name} kunde inte läsas: DWG-läsaren kraschade (${err.message}). Andra ritningar kan fortfarande öppnas.`);
    } else {
      showError(err.message || String(err));
    }
  } finally {
    if (ptr) {
      try { (await libReady).dwg_free(ptr); } catch { /* minnet frigörs ändå när appen stängs */ }
    }
    $('busy').hidden = true;
  }
}

// DWG-formatet byts inte varje år. Koden i filhuvudet (t.ex. AC1032) visar vilket
// format filen har, och varje format används av flera AutoCAD-versioner.
const DWG_FORMATS = {
  AC1009: ['R12', 'AutoCAD R11 och R12'],
  AC1012: ['R13', 'AutoCAD R13'],
  AC1014: ['R14', 'AutoCAD R14'],
  AC1015: ['2000', 'AutoCAD 2000–2002'],
  AC1018: ['2004', 'AutoCAD 2004–2006'],
  AC1021: ['2007', 'AutoCAD 2007–2009'],
  AC1024: ['2010', 'AutoCAD 2010–2012'],
  AC1027: ['2013', 'AutoCAD 2013–2017'],
  AC1032: ['2018', 'AutoCAD 2018 och senare']
};

function describeVersion(version) {
  if (!version) return { label: '', tip: '' };
  const known = DWG_FORMATS[version.hdr];
  if (!known) {
    return { label: `DWG-format ${version.hdr || ''}`.trim(), tip: version.description || '' };
  }
  const [format, saved] = known;
  return {
    label: `DWG-format ${format} (${saved})`,
    tip: `Filen är sparad i DWG-formatet från AutoCAD ${format} (${version.hdr}).\n` +
      `Formatet används av ${saved}. Äldre AutoCAD-versioner kan inte öppna filen utan att den först sparas ner.`
  };
}

// I format före AutoCAD 2007 lagras text med 8 bitar per tecken, men DWG-biblioteket
// läser texten i multiledare som 16-bitars Unicode, så två tecken blir ett ("xx" blir
// U+7878, ett kinesiskt tecken). Dela upp tecknen i byte igen och läs dem som Windows-1252.
const decoder1252 = new TextDecoder('windows-1252');
function narrowText(text) {
  const s = String(text || '');
  if (!/[\u0100-\uffff]/.test(s)) return s;
  const bytes = [];
  for (const ch of s) {
    const c = ch.charCodeAt(0);
    bytes.push(c & 255);
    if (c >> 8) bytes.push(c >> 8);
  }
  while (bytes.length && bytes[bytes.length - 1] === 0) bytes.pop();
  return decoder1252.decode(new Uint8Array(bytes));
}

function fixNarrowStrings(db, version) {
  // AC1021 = AutoCAD 2007, det första formatet med Unicode-text
  const hdr = String(version?.hdr || '');
  if (!/^AC10(0\d|1[0-8])$/.test(hdr)) return;
  for (const block of db.tables?.BLOCK_RECORD?.entries || []) {
    for (const e of block.entities || []) {
      if (e.type === 'MULTILEADER' && e.textContent) e.textContent = narrowText(e.textContent);
    }
  }
}

function looksLikeDwg(buf) {
  const head = new TextDecoder('ascii').decode(new Uint8Array(buf, 0, Math.min(6, buf.byteLength)));
  return /^AC\d{4}$/.test(head);
}

function createTab(name, size, markup) {
  const el = document.createElement('div');
  el.className = 'sheet';
  el.hidden = true;
  el.innerHTML = markup;
  const root = el.querySelector('svg');
  if (!root) return null;
  const vb = (root.getAttribute('viewBox') || '').trim().split(/[\s,]+/).map(Number);
  const [x, y, w, h] = vb;
  if (vb.length !== 4 || !(w > 0 || h > 0) || vb.some((n) => !isFinite(n))) return null;
  // Ett ritningsobjekt utan utbredning i ena led (t.ex. en enda rak linje) får ändå en ruta
  const pad = Math.max(w, h) * 0.01;
  root.removeAttribute('width');
  root.removeAttribute('height');
  root.setAttribute('preserveAspectRatio', 'none');
  themeColors(root);
  sheets.appendChild(el);
  return {
    name, size, el, svg: root,
    extents: { x, y, w: w || pad, h: h || pad },
    view: { cx: 0, cy: 0, upp: 1 }, fitUpp: 1, version: ''
  };
}

// ---------- Typsnitt ----------
// Varje textstil i ritningen pekar på en typsnittsfil. TrueType-typsnitt (.ttf)
// läses från datorn och används som de är. AutoCAD:s egna SHX-typsnitt kan inte
// visas exakt och ersätts med osifont, ett tekniskt typsnitt enligt ISO 3098.

const SHX_SUBSTITUTE = 'osifont';
const fontCache = new Map();   // typsnittsfil (gemener) -> Promise<familjenamn | null>
let fontCounter = 0;

// Vanliga typsnitt som oftast finns installerade, om filen inte går att läsa
const KNOWN_FAMILIES = {
  arial: 'Arial', arialn: 'Arial Narrow', arialbd: 'Arial', times: 'Times New Roman', cour: 'Courier New',
  calibri: 'Calibri', verdana: 'Verdana', tahoma: 'Tahoma', segoeui: 'Segoe UI', consola: 'Consolas',
  isocpeur: 'ISOCPEUR', isoct: 'ISOCT', swiss: 'Swis721 BT', simplex: SHX_SUBSTITUTE
};

function fontBase(file) {
  return String(file || '').replace(/\\/g, '/').split('/').pop().trim().toLowerCase();
}

function loadTrueType(file, drawingPath) {
  const key = fontBase(file);
  if (!fontCache.has(key)) {
    fontCache.set(key, (async () => {
      try {
        const bytes = await api.readFont(file, drawingPath);
        if (!bytes) return null;
        const family = `dwg-font-${++fontCounter}`;
        const face = new FontFace(family, bytes instanceof ArrayBuffer ? bytes : new Uint8Array(bytes));
        await face.load();
        document.fonts.add(face);
        return family;
      } catch (err) {
        console.warn('Typsnittet kunde inte läsas:', file, err);
        return null;
      }
    })());
  }
  return fontCache.get(key);
}

async function fontForStyle(style, drawingPath) {
  const file = fontBase(style.font);
  const stem = file.replace(/\.[^.]*$/, '');
  if (!file || file.endsWith('.shx') || !/\.(ttf|ttc|otf)$/.test(file) && !(stem in KNOWN_FAMILIES)) {
    // SHX eller okänt: ett tomt namn betyder txt.shx
    return { file: file || 'txt.shx', css: `"${SHX_SUBSTITUTE}", Arial, sans-serif`, status: 'substituted' };
  }
  const family = await loadTrueType(file, drawingPath);
  if (family) return { file, css: `"${family}", Arial, sans-serif`, status: 'found' };
  const known = KNOWN_FAMILIES[stem];
  if (known) return { file, css: `"${known}", Arial, sans-serif`, status: 'installed' };
  return { file, css: 'Arial, sans-serif', status: 'missing' };
}

async function applyFonts(root, styles, drawingPath) {
  const byStyle = new Map();
  for (const style of styles) {
    if (!style || !style.name) continue;
    byStyle.set(style.name.toLowerCase(), await fontForStyle(style, drawingPath));
  }
  const fallback = byStyle.get('standard') || { file: 'txt.shx', css: `"${SHX_SUBSTITUTE}", Arial, sans-serif`, status: 'substituted' };
  const used = new Map();
  // Typsnittet läggs i style-attributet så att det även gäller texter inuti block
  for (const el of root.querySelectorAll('[data-style]')) {
    const font = byStyle.get(el.dataset.style.toLowerCase()) || fallback;
    el.style.fontFamily = font.css;
    used.set(font.file, font.status);
  }
  return [...used].map(([file, status]) => ({ file, status }));
}

// ---------- Externa referenser (xref) ----------
// En xref är ett block vars innehåll ligger i en annan DWG-fil. Filen läses och
// dess modellrymd läggs in i blocket. Lager, block och textstilar från xref-filen
// får prefixet "XREF|", precis som i AutoCAD, så att namnen inte krockar och så att
// lager som släckts för xref:en i värdritningen fortsätter vara släckta.

const XREF_MAX_DEPTH = 3;
const XREF_TEXT = {
  loaded: 'inläst', missing: 'hittades inte', unreadable: 'kunde inte läsas', circular: 'refererar till sig själv'
};

async function attachXrefs(lib, db, hostPath, depth, seen) {
  const results = [];
  const records = (db.tables?.BLOCK_RECORD?.entries || []).filter((b) => b && (b.isXref || b.xrefPath));
  for (const rec of records) {
    const result = { name: rec.name, path: rec.xrefPath || rec.name, depth, status: 'missing' };
    results.push(result);
    let found = null;
    try { found = await api.readXref(rec.xrefPath || rec.name, hostPath); } catch { /* hittades inte */ }
    if (!found) continue;
    result.path = found.filePath || result.path;
    const key = String(found.filePath || '').toLowerCase();
    if (key && seen.has(key)) { result.status = 'circular'; continue; }

    let ptr = null;
    let xdb = null;
    try {
      const data = found.data;
      const bytes = data instanceof ArrayBuffer ? data : data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
      if (!looksLikeDwg(bytes)) { result.status = 'unreadable'; continue; }
      ptr = lib.dwg_read_data(bytes, Dwg_File_Type.DWG);
      if (!ptr) { result.status = 'unreadable'; continue; }
      xdb = lib.convert(ptr);
      fixNarrowStrings(xdb, lib.dwg_get_version_type(ptr));
    } catch (err) {
      console.warn('Xref kunde inte läsas:', result.path, err);
      result.status = 'unreadable';
      continue;
    } finally {
      if (ptr) { try { lib.dwg_free(ptr); } catch { /* ignoreras */ } }
    }
    if (depth + 1 < XREF_MAX_DEPTH) {
      results.push(...await attachXrefs(lib, xdb, found.filePath || hostPath, depth + 1, new Set([...seen, key])));
    }
    mergeXref(db, rec, xdb);
    result.status = 'loaded';
  }
  return results;
}

function mergeXref(host, rec, xdb) {
  const prefix = `${rec.name}|`;
  const keepLayer = (n) => !n || n === '0' || n.toLowerCase() === 'defpoints';
  const layer = (n) => (keepLayer(n) ? n : prefix + n);
  const fix = (e) => {
    // Handtag från xref-filen kan krocka med värdritningens, så klippgränser i
    // xref-filens egna block (ordlistor) följer inte med
    const out = { ...e, layer: layer(e.layer), ownerDictionaryHardId: undefined };
    if ((e.type === 'INSERT' || e.type === 'DIMENSION') && e.name) out.name = prefix + e.name;
    if (e.styleName) out.styleName = prefix + e.styleName;
    if (Array.isArray(e.attribs)) {
      out.attribs = e.attribs.map((a) => ({
        ...a, layer: layer(a.layer),
        text: a.text ? { ...a.text, styleName: a.text.styleName ? prefix + a.text.styleName : a.text.styleName } : a.text
      }));
    }
    return out;
  };
  const addTo = (table, entry) => {
    if (!host.tables[table]) return;
    const name = entry.name.toLowerCase();
    // Värdritningen kan redan ha posten (t.ex. ett släckt xref-lager); då gäller den
    if (!host.tables[table].entries.some((e) => String(e.name).toLowerCase() === name)) host.tables[table].entries.push(entry);
  };

  for (const l of xdb.tables?.LAYER?.entries || []) {
    if (!keepLayer(l.name)) addTo('LAYER', { ...l, name: prefix + l.name });
  }
  for (const st of xdb.tables?.STYLE?.entries || []) {
    if (st.name) addTo('STYLE', { ...st, name: prefix + st.name });
  }
  let modelSpace = null;
  for (const b of xdb.tables?.BLOCK_RECORD?.entries || []) {
    const n = String(b.name || '').toLowerCase();
    if (n === '*model_space') { modelSpace = b; continue; }
    if (n.startsWith('*paper_space')) continue;
    addTo('BLOCK_RECORD', { ...b, name: prefix + b.name, isXref: false, xrefPath: '', entities: (b.entities || []).map(fix) });
  }
  rec.entities = (modelSpace?.entities || []).map(fix);
}

// ---------- Vad som visas ----------
// Konverteraren räknar varje objekt i modellrymden och i de block som används:
// ritat, inte stöd eller fel. Statusraden visar om allt kom med.

const TYPE_NAMES = {
  '3DSOLID': '3D-solider (kan inte ritas i 2D)', REGION: 'regioner', BODY: '3D-kroppar', SURFACE: 'ytor',
  MESH: 'nät (mesh)', POLYFACE: 'polyface-nät', IMAGE: 'inbäddade bilder', OLE2FRAME: 'OLE-objekt',
  ACAD_TABLE: 'tabeller (placeringen går inte att läsa i DWG 2013 och senare)', TABLE: 'tabeller (placeringen går inte att läsa i DWG 2013 och senare)', ARC_DIMENSION: 'bågmått', LARGE_RADIAL_DIMENSION: 'stora radiemått',
  SHAPE: 'symboler (SHAPE)', TRACE: 'spår (TRACE)', ACAD_PROXY_ENTITY: 'proxyobjekt från andra program',
  PROXY: 'proxyobjekt från andra program', UNDERLAY: 'underlägg (PDF/DWF/DGN)', PDFUNDERLAY: 'PDF-underlägg',
  DWFUNDERLAY: 'DWF-underlägg', DGNUNDERLAY: 'DGN-underlägg', GEOPOSITIONMARKER: 'geopositioner', LIGHT: 'ljuskällor',
  HELIX: 'spiraler', SECTIONOBJECT: 'snittobjekt', POINTCLOUD: 'punktmoln'
};

function showContentStatus(content) {
  const el = $('st-content');
  if (!content) { el.textContent = ''; el.title = ''; el.classList.remove('st-warn'); return; }
  const rows = Object.entries(content.types || {});
  const drawn = rows.reduce((n, [, c]) => n + c.drawn, 0);
  const missing = rows.filter(([, c]) => c.skipped + c.failed > 0);
  const missingCount = missing.reduce((n, [, c]) => n + c.skipped + c.failed, 0);
  const total = drawn + missingCount;
  const fmt = (n) => n.toLocaleString('sv-SE');
  el.classList.toggle('st-warn', missingCount > 0);
  el.textContent = missingCount
    ? `${fmt(missingCount)} av ${fmt(total)} objekt visas inte`
    : `Alla ${fmt(total)} objekt visas`;
  const lines = [];
  if (missingCount) {
    lines.push('Visas inte:');
    for (const [type, c] of missing.sort((a, b) => (b[1].skipped + b[1].failed) - (a[1].skipped + a[1].failed))) {
      const why = TYPE_NAMES[type] ? ` – ${TYPE_NAMES[type]}` : '';
      const err = c.failed ? ` (${c.failed} gick inte att läsa)` : '';
      lines.push(`   ${type}: ${c.skipped + c.failed}${why}${err}`);
    }
    lines.push('');
  }
  lines.push('Ritade objekt per typ:');
  for (const [type, c] of rows.filter(([, c]) => c.drawn).sort((a, b) => b[1].drawn - a[1].drawn)) lines.push(`   ${type}: ${fmt(c.drawn)}`);
  lines.push('', 'Räknar objekt i modellrymden, i block som används och i inlästa xrefs. Objekt på släckta och frysta lager räknas inte.');
  if (content.paperSpace) {
    lines.push('', `Layouterna (pappersrymden) innehåller ${fmt(content.paperSpace)} objekt som inte visas, t.ex. ritningsramar som bara finns där.`);
  }
  el.title = lines.join('\n');
}

function showXrefStatus(xrefs) {
  const el = $('st-xref');
  if (!xrefs || !xrefs.length) { el.hidden = true; return; }
  const problems = xrefs.filter((x) => x.status !== 'loaded').length;
  el.hidden = false;
  el.classList.toggle('st-warn', problems > 0);
  el.textContent = problems
    ? `${problems} av ${xrefs.length} xref${xrefs.length === 1 ? '' : 's'} saknas`
    : `Xref ${xrefs.length}`;
  el.title = 'Externa referenser (xref):\n' + xrefs
    .map((x) => `${'   '.repeat(x.depth)}${x.name}: ${XREF_TEXT[x.status]} (${x.path})`).join('\n') +
    (problems ? '\n\nLägg xref-filerna i samma mapp som ritningen, eller där sökvägen pekar.' : '');
}

function showFontStatus(fonts) {
  const el = $('st-fonts');
  if (!fonts || !fonts.length) { el.textContent = ''; el.title = ''; return; }
  const words = {
    found: 'läst från datorn', installed: 'installerat typsnitt',
    substituted: `SHX, ersatt med ${SHX_SUBSTITUTE}`, missing: 'saknas, visas i Arial'
  };
  const replaced = fonts.filter((f) => f.status !== 'found' && f.status !== 'installed').length;
  el.textContent = `Typsnitt ${fonts.length}` + (replaced ? ` (${replaced} ${replaced === 1 ? 'ersatt' : 'ersatta'})` : '');
  el.title = fonts.map((f) => `${f.file}: ${words[f.status]}`).join('\n');
}

function activate(tab) {
  if (active) { active.view = view; active.fitUpp = fitUpp; }
  active = tab;
  for (const t of tabs) t.el.hidden = t !== tab;
  svg = tab ? tab.svg : null;
  extents = tab ? tab.extents : null;
  view = tab ? tab.view : { cx: 0, cy: 0, upp: 1 };
  fitUpp = tab ? tab.fitUpp : 1;
  setLoaded(!!tab);
  $('st-file').textContent = tab ? tab.name : 'Ingen ritning öppen';
  $('st-version').textContent = tab ? tab.version.label : '';
  $('st-version').title = tab ? tab.version.tip : '';
  showFontStatus(tab ? tab.fonts : null);
  showXrefStatus(tab ? tab.xrefs : null);
  showContentStatus(tab ? tab.content : null);
  if (!tab) { $('st-zoom').textContent = '–'; $('st-grid').textContent = ''; }
  api.setTitle(tab ? `${tab.name} – DWG-visare` : 'DWG-visare');
  renderTabs();
  applyView();
  drawGuides();
}

function closeTab(tab) {
  if (!tab) return;
  const i = tabs.indexOf(tab);
  tabs.splice(i, 1);
  tab.el.remove();
  if (tab === active) {
    active = null;
    activate(tabs[Math.min(i, tabs.length - 1)] || null);
  } else {
    renderTabs();
  }
}

function cycleTab(step) {
  if (tabs.length < 2) return;
  const i = tabs.indexOf(active);
  activate(tabs[(i + step + tabs.length) % tabs.length]);
}

function renderTabs() {
  const bar = $('tabs');
  bar.hidden = tabs.length === 0;
  bar.replaceChildren(...tabs.map((t) => {
    const tab = document.createElement('div');
    tab.className = 'tab' + (t === active ? ' active' : '');
    tab.setAttribute('role', 'tab');
    tab.setAttribute('aria-selected', t === active);
    tab.title = t.name;
    const label = document.createElement('button');
    label.className = 'tab-label';
    label.textContent = t.name;
    label.onclick = () => activate(t);
    const close = document.createElement('button');
    close.className = 'tab-close';
    close.title = 'Stäng (Ctrl+W)';
    close.setAttribute('aria-label', `Stäng ${t.name}`);
    close.textContent = '×';
    close.onclick = () => closeTab(t);
    // Klick med mushjulet stänger fliken, som i en webbläsare
    tab.onauxclick = (e) => { if (e.button === 1) closeTab(t); };
    tab.onmousedown = (e) => { if (e.button === 1) e.preventDefault(); };
    tab.append(label, close);
    return tab;
  }));
}

// ---------- Stödlinjer ----------
// Rutnät som anpassar sig efter zoomen (1, 2 eller 5 gånger en tiopotens),
// axlarna genom origo och ett hårkors vid markören. Ritas på en egen
// canvas ovanpå ritningen och kommer inte med på utskrifter.

let showGuides = false;
let cursor = null;

function gridStep(upp) {
  const minPx = 14;
  let step = Math.pow(10, Math.floor(Math.log10(upp * minPx)));
  for (const m of [1, 2, 5, 10]) {
    if ((step * m) / upp >= minPx) return step * m;
  }
  return step * 10;
}

function drawGuides() {
  const { w, h } = size();
  const dpr = window.devicePixelRatio || 1;
  if (guides.width !== Math.round(w * dpr) || guides.height !== Math.round(h * dpr)) {
    guides.width = Math.round(w * dpr);
    guides.height = Math.round(h * dpr);
  }
  const ctx = guides.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  if (!showGuides || !svg) { $('st-grid').textContent = ''; return; }

  const css = getComputedStyle(document.body);
  const left = view.cx - (w / 2) * view.upp;
  const top = view.cy - (h / 2) * view.upp;
  const toX = (x) => Math.round((x - left) / view.upp) + 0.5;
  const toY = (y) => Math.round((y - top) / view.upp) + 0.5;
  const step = gridStep(view.upp);
  const major = step * 5;

  const lines = (color, every, skip) => {
    ctx.beginPath();
    for (let x = Math.ceil(left / every) * every; x <= left + w * view.upp; x += every) {
      if (skip && Math.abs(x / skip - Math.round(x / skip)) < 1e-6) continue;
      ctx.moveTo(toX(x), 0); ctx.lineTo(toX(x), h);
    }
    for (let y = Math.ceil(top / every) * every; y <= top + h * view.upp; y += every) {
      if (skip && Math.abs(y / skip - Math.round(y / skip)) < 1e-6) continue;
      ctx.moveTo(0, toY(y)); ctx.lineTo(w, toY(y));
    }
    ctx.strokeStyle = color;
    ctx.lineWidth = 1;
    ctx.stroke();
  };
  lines(css.getPropertyValue('--grid'), step, major);
  lines(css.getPropertyValue('--grid-major'), major);

  // Axlar genom origo (ritningens 0,0)
  ctx.beginPath();
  const ox = toX(0), oy = toY(0);
  if (ox >= 0 && ox <= w) { ctx.moveTo(ox, 0); ctx.lineTo(ox, h); }
  if (oy >= 0 && oy <= h) { ctx.moveTo(0, oy); ctx.lineTo(w, oy); }
  ctx.strokeStyle = css.getPropertyValue('--axis');
  ctx.stroke();

  // Hårkors
  if (cursor && !pointers.size) {
    ctx.beginPath();
    ctx.setLineDash([6, 4]);
    ctx.moveTo(Math.round(cursor.x) + 0.5, 0); ctx.lineTo(Math.round(cursor.x) + 0.5, h);
    ctx.moveTo(0, Math.round(cursor.y) + 0.5); ctx.lineTo(w, Math.round(cursor.y) + 0.5);
    ctx.strokeStyle = css.getPropertyValue('--crosshair');
    ctx.stroke();
    ctx.setLineDash([]);
  }

  $('st-grid').innerHTML = `Rutnät <b>${step.toLocaleString('sv-SE', { maximumFractionDigits: 6 })}</b>`;
}

function setGuides(on) {
  showGuides = on;
  $('btn-guides').setAttribute('aria-pressed', on);
  savePref('guides', on);
  drawGuides();
}

// Färgerna läggs som CSS-variabler i style-attributet. Variabler ärvs även in i
// block (<use>), vilket vanliga CSS-regler inte gör. --ink är AutoCAD-färg 7
// (vit på mörk bakgrund, svart på ljus) och --mono sätts vid svartvit utskrift.
function themeColors(root) {
  const isInk = (c) => c === 'rgb(255,255,255)' || c === '#000000';
  for (const node of root.querySelectorAll('[stroke], [fill]')) {
    for (const prop of ['stroke', 'fill']) {
      const c = node.getAttribute(prop);
      if (!c || c === 'none') continue;
      node.style.setProperty(prop, `var(--mono, ${isInk(c) ? 'var(--ink)' : c})`);
    }
  }
  // Text ska bara fyllas, inte få kontur. CSS-regeln för det når inte in i block.
  for (const t of root.querySelectorAll('text')) t.style.stroke = 'none';
  // Linjer ska ha samma tjocklek på skärmen oavsett zoom, även inuti block
  for (const el of root.querySelectorAll('path, line, circle, ellipse, polyline, polygon')) {
    el.style.vectorEffect = 'non-scaling-stroke';
  }
}

function setLoaded(on) {
  $('empty').hidden = on;
  for (const id of ['btn-zoom-in', 'btn-zoom-out', 'btn-fit', 'btn-print', 'btn-guides', 'btn-lw']) $(id).disabled = !on;
}

// Bara för test i vanlig webbläsare: xref-filer hämtas från mappen samples/
async function readXrefInBrowser(xrefPath) {
  const name = String(xrefPath).replace(/\\/g, '/').split('/').pop();
  const file = /\.dwg$/i.test(name) ? name : name + '.dwg';
  try {
    const r = await fetch('samples/' + encodeURIComponent(file));
    return r.ok ? { data: await r.arrayBuffer(), filePath: 'samples/' + file } : null;
  } catch { return null; }
}

function pickFileInBrowser() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.dwg';
  input.multiple = true;
  input.onchange = async () => {
    for (const f of input.files) openDrawing(f.name, await f.arrayBuffer(), api.pathForFile(f));
  };
  input.click();
}

function showError(text) {
  $('error-text').textContent = text;
  $('error').hidden = false;
}
function hideError() { $('error').hidden = true; }

// ---------- Dra och släpp ----------

let dragDepth = 0;
window.addEventListener('dragenter', (e) => { e.preventDefault(); dragDepth++; $('drop').hidden = false; });
window.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; $('drop').hidden = true; } });
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', async (e) => {
  e.preventDefault();
  dragDepth = 0;
  $('drop').hidden = true;
  for (const f of e.dataTransfer.files) openDrawing(f.name, await f.arrayBuffer(), api.pathForFile(f));
});

// ---------- Utskrift ----------
// Det som syns i fönstret skrivs ut, anpassat till papperet.

function beforePrint() {
  if (svg) svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
}
function afterPrint() {
  if (svg) svg.setAttribute('preserveAspectRatio', 'none');
  applyView();
}
window.addEventListener('beforeprint', beforePrint);
window.addEventListener('afterprint', afterPrint);
api.on('before-print', beforePrint);
api.on('after-print', afterPrint);

function print() {
  if (svg) api.print();
}

// ---------- Inställningar som sparas mellan gångerna ----------

function loadPref(key, fallback) {
  try { const v = localStorage.getItem(key); return v == null ? fallback : v === '1'; } catch { return fallback; }
}
function savePref(key, on) {
  try { localStorage.setItem(key, on ? '1' : '0'); } catch { /* inte kritiskt */ }
}

function setLight(on) {
  document.body.classList.toggle('light', on);
  savePref('light', on);
  drawGuides();
}
function setMono(on) {
  document.body.classList.toggle('mono', on);
  $(on ? 'print-mono' : 'print-color').checked = true;
  savePref('mono', on);
}
function setLineweights(on) {
  document.body.style.setProperty('--lwk', on ? '1' : '0');
  $('btn-lw').setAttribute('aria-pressed', on);
  savePref('lineweights', on);
}
setLight(loadPref('light', false));
setMono(loadPref('mono', true));
setLineweights(loadPref('lineweights', true));
setGuides(loadPref('guides', false));

// ---------- Knappar och meny ----------

$('btn-open').onclick = () => api.openDialog();
$('btn-open-2').onclick = () => api.openDialog();
$('btn-zoom-in').onclick = () => zoomAt(1.5);
$('btn-zoom-out').onclick = () => zoomAt(1 / 1.5);
$('btn-fit').onclick = fit;
$('btn-bg').onclick = () => setLight(!document.body.classList.contains('light'));
$('btn-print').onclick = print;
$('btn-guides').onclick = () => setGuides(!showGuides);
$('print-mono').onchange = () => setMono(true);
$('print-color').onchange = () => setMono(false);
$('btn-lw').onclick = () => setLineweights($('btn-lw').getAttribute('aria-pressed') !== 'true');
$('error-close').onclick = hideError;

api.on('file-opened', ({ name, data, filePath }) => openDrawing(name, data, filePath));
api.on('zoom-in', () => zoomAt(1.5));
api.on('zoom-out', () => zoomAt(1 / 1.5));
api.on('zoom-fit', fit);
api.on('toggle-bg', () => setLight(!document.body.classList.contains('light')));
api.on('toggle-guides', () => setGuides(!showGuides));
api.on('toggle-lineweights', () => setLineweights($('btn-lw').getAttribute('aria-pressed') !== 'true'));
api.on('close-tab', () => closeTab(active));
api.on('next-tab', () => cycleTab(1));
api.on('prev-tab', () => cycleTab(-1));

// Ctrl+Tab fångas inte av menyn i alla lägen, så den hanteras även här
window.addEventListener('keydown', (e) => {
  if (e.ctrlKey && e.key === 'Tab') { e.preventDefault(); cycleTab(e.shiftKey ? -1 : 1); }
});
