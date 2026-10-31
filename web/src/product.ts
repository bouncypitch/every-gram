import { dataUrl, fmtMass } from './data';
import type { Viewer } from './viewer';

// Any-product-link flow. Every value shown here comes from the analysis server.
const API = String(import.meta.env.VITE_API_BASE ?? '').replace(/\/+$/, '');
const apiUrl = (path: string) => `${API}/${path.replace(/^\/+/, '')}`;
// No API base means the static Pages build: saved examples only, never a request.
export const STATIC_MODE = !API;
const STATIC_MSG = "Live analysis runs on the presenter's machine tonight. Try a saved example above.";
const POLL_MS = 1500;
const REPLAY_MS = 2400; // whole log, however long
const REPLAY_MAX_STEP = 220;
const MAX_POLL_FAILURES = 5;
const UNREACHABLE = 'Could not reach the analysis server, so this link was not analyzed. Analysis needs a downloadable closed CAD model.';

const SHOP = 'https://core-electronics.com.au/';
const EXAMPLES = [
  { slug: 'gobilda-bracket', label: 'goBILDA bracket', url: `${SHOP}1111-series-angle-pattern-bracket-1-1.html` },
  { slug: 'motor-mount', label: 'Motor mount', url: `${SHOP}1702-series-quad-block-motor-mount-32-2.html` },
  { slug: 'steel-u-bracket', label: 'Steel U-bracket', url: `${SHOP}round-end-steel-u-bracket.html` },
];
export type Chip = { label: string; url: string };
const canon = (u: string) => u.trim().toLowerCase().replace(/^https?:\/\/(www\.)?/, '').replace(/[?#].*$/, '').replace(/\/+$/, '');

type Field = 'load_n' | 'material' | 'cad_url';
type Overrides = Partial<{ load_n: number; material: string; cad_url: string }>;
interface Info { name?: string; mass_g?: number; material?: string; load_n?: number; load_basis?: string; cad_url?: string; function?: string }
interface Result {
  name?: string; material?: string; mass_before_g?: number; mass_after_g?: number; saved_pct?: number;
  peak_before_mpa?: number; peak_after_mpa?: number; limit_mpa?: number; deflection_ratio?: number;
  assumption?: string; load_n?: number; load_basis?: string; status?: string; note?: string;
}
interface Job { status: string; log?: string[]; info?: Info; message?: string; result?: Result; files?: { before?: string; after?: string; stl?: string } }

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const num = (v: unknown, d: number, unit = '') => (typeof v === 'number' && isFinite(v) ? `${v.toFixed(d)}${unit}` : '—');
const mass = (v: unknown) => (typeof v === 'number' && isFinite(v) ? fmtMass(v) : '—');

/** Latest mass stated in the log, in grams, or null. Never inferred from anything else. */
export function massFromLog(log: string[]): number | null {
  for (let i = log.length - 1; i >= 0; i--) {
    const m = /\bmass(_g|_kg)?\b/i.exec(log[i]);
    if (!m) continue;
    const tail = log[i].slice(m.index + m[0].length);
    const united = [...tail.matchAll(/(\d+(?:\.\d+)?)\s*(kg|g)\b/gi)].pop();
    if (united) return parseFloat(united[1]) * (united[2].toLowerCase() === 'kg' ? 1000 : 1);
    const bare = m[1] && /^\s*[=:]\s*(\d+(?:\.\d+)?)/.exec(tail);
    if (bare) return parseFloat(bare[1]) * (m[1].toLowerCase() === '_kg' ? 1000 : 1);
  }
  return null;
}

interface Deps {
  viewer: Viewer;
  root: HTMLElement;
  setMsg: (s: string) => void;
  setBusy: (b: boolean) => void;
  tick: (el: HTMLElement, v: number, fmt: (v: number) => string) => void;
  onExit: () => void;
}

export function createProductFlow({ viewer, root, setMsg, setBusy, tick, onExit }: Deps) {
  let token = 0;
  let busy = false;
  let url = '';
  let overrides: Overrides = {};
  let timer = 0;
  let logShown = 0;
  let stress = true;
  let side: 'before' | 'after' = 'after';

  const saved = new Map<string, Job>(); // slug -> stored job response, status done only

  /** Chips to offer. In static mode, only examples whose stored run is complete. */
  async function chips(): Promise<Chip[]> {
    if (!STATIC_MODE) return EXAMPLES;
    await Promise.all(EXAMPLES.map(async ({ slug }) => {
      try {
        const r = await fetch(dataUrl(`examples/${slug}.json`), { cache: 'no-store' });
        if (!r.ok || !(r.headers.get('content-type') ?? '').includes('json')) return;
        const job: Job = await r.json();
        if (job.status === 'done' && job.result) saved.set(slug, job);
      } catch { /* not offered */ }
    }));
    return EXAMPLES.filter((e) => saved.has(e.slug));
  }

  function replay(slug: string, link: string) {
    const job = saved.get(slug)!;
    const mine = ++token;
    url = link;
    setMsg('');
    lastLog = [];
    logShown = 0;
    setMode('run');
    root.innerHTML = runCard('Saved run', job.info?.name ?? link);
    const log = job.log ?? [];
    const step = Math.min(REPLAY_MAX_STEP, REPLAY_MS / Math.max(1, log.length));
    let n = 0;
    const next = () => {
      if (mine !== token) return;
      if (n >= log.length) return void showResult(job, slug);
      renderJob({ ...job, log: log.slice(0, ++n) });
      timer = window.setTimeout(next, step);
    };
    next();
  }

  const setMode = (m: string) => { document.body.dataset.prod = m; };
  const active = () => !!document.body.dataset.prod;
  const backBtn = (label: string) => `<button class="link" data-prod-exit>${label}</button>`;

  async function post(body: unknown) {
    const r = await fetch(apiUrl('api/analyze'), {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    const ct = r.headers.get('content-type') ?? '';
    return ct.includes('json') ? r.json() : null;
  }

  async function analyze(link: string, extra: Overrides = {}) {
    if (STATIC_MODE) {
      const ex = EXAMPLES.find((e) => canon(e.url) === canon(link) && saved.has(e.slug));
      if (ex) replay(ex.slug, link); else setMsg(STATIC_MSG);
      return;
    }
    if (busy) return;
    const mine = ++token;
    busy = true;
    setBusy(true);
    url = link;
    overrides = { ...overrides, ...extra };
    if (!active()) setMsg('Reading the link.');
    let res: any = null;
    try { res = await post({ url, overrides }); } catch { /* handled below */ }
    busy = false;
    setBusy(false);
    if (mine !== token) return;
    if (res?.status === 'needs_input') return showForm(res);
    if (res?.status === 'running' && res.job != null) { setMsg(''); return startJob(String(res.job)); }
    showError(res?.status === 'error' && res.message ? String(res.message) : UNREACHABLE);
  }

  function showError(message: string) {
    if (document.body.dataset.prod === 'run' || document.body.dataset.prod === 'form') {
      setMode('err');
      root.innerHTML = `<div class="prod-card"><div class="eyebrow">Stopped</div><p class="prod-err">${esc(message)}</p>${logBox()}${backBtn('Try another link')}</div>`;
      renderLogTail();
    } else setMsg(message);
  }

  let lastLog: string[] = [];
  const logBox = () => (lastLog.length ? `<ol class="log" id="prod-log"></ol>` : '');
  function renderLogTail() {
    const el = document.getElementById('prod-log');
    if (!el) return;
    logShown = 0;
    appendLog(el);
  }
  function appendLog(el: HTMLElement) {
    for (; logShown < lastLog.length; logShown++) {
      const li = document.createElement('li');
      li.textContent = lastLog[logShown];
      el.append(li);
    }
    el.scrollTop = el.scrollHeight;
  }

  function showForm(res: { info?: Info; missing?: Field[]; materials?: string[]; message?: string }) {
    setMsg('');
    setMode('form');
    const info = res.info ?? {};
    const missing = res.missing ?? [];
    const rows: [string, string][] = [];
    if (info.function) rows.push(['Function', info.function]);
    if (info.mass_g != null) rows.push(['Mass', mass(info.mass_g)]);
    if (info.material && !missing.includes('material')) rows.push(['Material', info.material]);
    if (info.load_n != null && !missing.includes('load_n')) rows.push(['Load', `${info.load_n} N${info.load_basis ? `, ${info.load_basis}` : ''}`]);
    if (info.cad_url && !missing.includes('cad_url')) rows.push(['CAD', info.cad_url]);
    const mats = res.materials ?? [];
    const field = (f: Field) => {
      if (f === 'load_n') return `<label>Load, newtons<input name="load_n" type="number" inputmode="decimal" min="0" step="any" required value="${esc(overrides.load_n ?? '')}" /></label>`;
      if (f === 'cad_url') return `<label>Link to a closed CAD file<input name="cad_url" type="url" required spellcheck="false" autocomplete="off" value="${esc(overrides.cad_url ?? '')}" /></label>`;
      return mats.length
        ? `<label>Material<select name="material" required><option value="">Choose</option>${mats.map((m) => `<option ${m === overrides.material ? 'selected' : ''}>${esc(m)}</option>`).join('')}</select></label>`
        : `<label>Material<input name="material" required autocomplete="off" value="${esc(overrides.material ?? '')}" /></label>`;
    };
    root.innerHTML = `<form class="prod-card" id="prod-form">
      <div class="eyebrow">Read from the page</div>
      <h2>${esc(info.name || 'Unnamed product')}</h2>
      ${res.message ? `<p class="prod-sub">${esc(res.message)}</p>` : ''}
      ${rows.length ? `<dl class="facts">${rows.map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join('')}</dl>` : ''}
      <div class="fields">${missing.map(field).join('')}</div>
      <div class="prod-actions"><button type="submit" class="cta">Continue</button>${backBtn('Back')}</div>
    </form>`;
    const form = document.getElementById('prod-form') as HTMLFormElement;
    (form.querySelector('input,select') as HTMLElement | null)?.focus();
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const d = new FormData(form);
      const next: Overrides = {};
      if (d.has('load_n')) next.load_n = Number(d.get('load_n'));
      if (d.has('material')) next.material = String(d.get('material'));
      if (d.has('cad_url')) next.cad_url = String(d.get('cad_url')).trim();
      (form.querySelector('[type=submit]') as HTMLButtonElement).disabled = true;
      void analyze(url, next);
    });
  }

  const runCard = (eyebrow: string, name: string) => `<div class="prod-card run">
      <div class="eyebrow">${esc(eyebrow)}</div>
      <h2 id="prod-name">${esc(name)}</h2>
      <div class="big num" id="prod-mass" hidden></div>
      <ol class="log" id="prod-log"></ol>
      ${backBtn('Leave')}
    </div>`;

  function startJob(id: string) {
    const mine = token;
    let failures = 0;
    lastLog = [];
    logShown = 0;
    setMode('run');
    root.innerHTML = runCard('Agents working', url);
    const poll = async () => {
      if (mine !== token) return;
      let job: Job | null = null;
      try {
        const r = await fetch(apiUrl(`api/job/${encodeURIComponent(id)}`), { cache: 'no-store' });
        if ((r.headers.get('content-type') ?? '').includes('json')) job = await r.json();
      } catch { /* counted below */ }
      if (mine !== token) return;
      if (!job?.status) {
        if (++failures >= MAX_POLL_FAILURES) return showError('Lost contact with the analysis server.');
        timer = window.setTimeout(poll, POLL_MS);
        return;
      }
      failures = 0;
      renderJob(job);
      if (job.status === 'running') timer = window.setTimeout(poll, POLL_MS);
      else if (job.status === 'done' && job.result) void showResult(job);
      else showError(job.message || 'The analysis ended without a result.');
    };
    void poll();
  }

  function renderJob(job: Job) {
    lastLog = job.log ?? [];
    const log = document.getElementById('prod-log');
    if (log) appendLog(log);
    const name = document.getElementById('prod-name');
    if (name && job.info?.name) name.textContent = job.info.name;
    const m = massFromLog(lastLog);
    const el = document.getElementById('prod-mass');
    if (el && m != null) { el.hidden = false; tick(el, m, fmtMass); }
  }

  async function showResult(job: Job, slug?: string) {
    const mine = token;
    const r = job.result!;
    // A saved run ignores the /files/ paths in its JSON; its files sit beside it.
    const f = slug
      ? { before: dataUrl(`examples/${slug}-before.glb`), after: dataUrl(`examples/${slug}-after.glb`), stl: dataUrl(`examples/${slug}-design.stl`) }
      : Object.fromEntries(Object.entries(job.files ?? {}).map(([k, v]) => [k, apiUrl(v as string)])) as NonNullable<Job['files']>;
    setMode('done');
    side = 'after';
    const status = String(r.status ?? '').toLowerCase();
    const over = typeof r.peak_after_mpa === 'number' && typeof r.limit_mpa === 'number' && r.peak_after_mpa > r.limit_mpa;
    root.innerHTML = `<div class="result">
      <div class="eyebrow">${esc(r.name ?? job.info?.name ?? '')}${r.material ? `, ${esc(r.material)}` : ''} ${status ? `<span class="badge ${esc(status)}">${esc(status.toUpperCase())}</span>` : ''}${slug ? ' <span class="saved">Saved run</span>' : ''}</div>
      <div class="hero num">${esc(num(r.saved_pct, 1))}<span class="unit">% lighter</span></div>
      <dl class="masses">
        <div><dt>Before</dt><dd class="num">${mass(r.mass_before_g)}</dd></div>
        <div><dt>After</dt><dd class="num accent">${mass(r.mass_after_g)}</dd></div>
      </dl>
      <dl class="masses">
        <div><dt>Peak stress</dt><dd class="num ${over ? 'over' : ''}">${num(r.peak_before_mpa, 1)} to ${num(r.peak_after_mpa, 1)} MPa</dd></div>
        <div><dt>Limit</dt><dd class="num">${num(r.limit_mpa, 1)} MPa</dd></div>
        <div><dt>Deflection ratio</dt><dd class="num">${num(r.deflection_ratio, 2, 'x')}</dd></div>
      </dl>
      ${r.load_n != null ? `<p class="fine"><b>Load</b> ${esc(r.load_n)} N${r.load_basis ? `, ${esc(r.load_basis)}` : ''}${slug ? '. Assumed for this example.' : ''}</p>` : ''}
      ${r.note ? `<p class="fine"><b>Note</b> ${esc(r.note)}</p>` : ''}
      ${r.assumption ? `<p class="fine"><b>Assumption</b> ${esc(r.assumption)}</p>` : ''}
      <p class="fine bad" id="prod-model-msg" hidden></p>
      <div class="prod-actions">
        ${f.stl ? `<a class="cta" href="${esc(f.stl)}" download>Download STL</a>` : ''}
        ${backBtn('Try another link')}
      </div>
    </div>
    <div class="prod-tools" id="prod-tools"></div>`;
    const loaded = await viewer.showProduct(f.before ?? null, f.after ?? null);
    if (mine !== token) return;
    placeCamera();
    if (!loaded.before && !loaded.after) {
      const el = document.getElementById('prod-model-msg');
      if (el) { el.hidden = false; el.textContent = 'The 3D model could not be loaded.'; }
    }
    if (!loaded.after) side = 'before';
    applyView();
  }

  function placeCamera() {
    const m = innerWidth < 760;
    viewer.setShot({ fit: 'assembled', az: 0.7, el: 0.35, pad: m ? 2.1 : 1.5, shiftX: m ? 0 : 0.22, shiftY: m ? -0.3 : 0 });
  }

  function applyView() {
    viewer.setProductView(side, stress);
    const box = document.getElementById('prod-tools');
    if (!box) return;
    const seg = (name: string, opts: [string, string][], val: string) =>
      `<div class="seg">${opts.map(([v, l]) => `<button data-prod-seg="${name}" data-v="${v}" class="${v === val ? 'on' : ''}">${l}</button>`).join('')}</div>`;
    const parts = [];
    if (viewer.productHas('before') && viewer.productHas('after')) parts.push(seg('side', [['before', 'Before'], ['after', 'After']], side));
    if (viewer.productHasStress(side)) parts.push(seg('stress', [['off', 'Solid'], ['on', 'Stress']], stress ? 'on' : 'off'));
    box.innerHTML = parts.join('');
  }

  function exit() {
    token++;
    clearTimeout(timer);
    busy = false;
    setBusy(false);
    overrides = {};
    lastLog = [];
    delete document.body.dataset.prod;
    root.innerHTML = '';
    viewer.clearProduct();
    onExit();
  }

  root.addEventListener('click', (e) => {
    const t = e.target as HTMLElement;
    if (t.closest('[data-prod-exit]')) { e.preventDefault(); return exit(); }
    const b = t.closest<HTMLElement>('[data-prod-seg]');
    if (b) {
      if (b.dataset.prodSeg === 'side') side = b.dataset.v as typeof side;
      else stress = b.dataset.v === 'on';
      applyView();
    }
  });
  addEventListener('resize', () => { if (document.body.dataset.prod === 'done') placeCamera(); });

  return { analyze, chips, exit, active, busy: () => busy };
}
