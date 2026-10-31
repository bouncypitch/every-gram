import '@fontsource-variable/inter';
import './style.css';
import {
  AGENTS, TIERS, dataUrl, designOptions, effective, fmtMass, fmtUsd, isKnownRobot,
  loadMaterials, loadMug, loadProposal, loadRobot, totals,
  type MaterialRow, type Mug, type Part, type Proposal, type RobotDoc, type Selection, type Status, type Tier,
} from './data';
import { Viewer, type Shot } from './viewer';
import { createProductFlow } from './product';
import { changesHtml, reviewHtml } from './review';

// Launch price is a citation constant, not a result.
const USD_PER_KG = 7000;
const DWELL = [0, 3500, 4500, 2500, 0]; // autoplay ms per stage
const STEP_RESULT = 1500, STEP_EMPTY = 160;

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const params = new URLSearchParams(location.search);

let doc: RobotDoc | null = null;
let materials: MaterialRow[] | null = null;
let proposal: Proposal | null = null;
let mug: Mug | null = null;
let ready = false;
let loadFailed = false;

let stage = 0;
let cursor = -1;            // current part in the optimize sequence
let stepElapsed = 0;
let stageElapsed = 0;
let auto = params.get('autoplay') !== '0'; // the show plays itself; ?autoplay=0 hands control to Space
let landingHeld = false; // touching the landing page stops it starting on its own
let selected: string | null = null;
let after = false;
let stress = false;
let colorBy: 'mass' | 'status' = 'mass';
let sheet: '' | 'materials' | 'robot' = '';
let zipOk: boolean | null = null;
let cut = false;
let changes = false;
let explore = false;
let storyReturn = 0;
let story: { show(): void; hide(): void; resume(): void; goto(id: string): void; palette: Record<string, string> } | null = null;
const storyOpen = () => !!document.body.dataset.story;
const sel: Selection = { global: '', perPart: {} };

const viewer = new Viewer($<HTMLCanvasElement>('gl'), (id) => {
  if (stage === 0 || sheet) return;
  openPanel(id === selected ? null : id);
});
(window as any).__viewer = viewer;

const parts = () => doc?.parts ?? [];
const baselineG = () => parts().reduce((s, p) => s + p.mass_g, 0);
const isMobile = () => innerWidth < 760;

/** Only parts already passed by the sequence count on screen. */
function revealed(): Part[] {
  if (stage < 3) return [];
  return stage === 3 ? parts().slice(0, cursor + 1) : parts();
}

const fmtSaved = (g: number) => `${g < 0 ? '+' : '−'}${fmtMass(Math.abs(g))}`;
const badge = (s: Status) => `<span class="badge ${s}">${s.toUpperCase()}</span>`;

// ---------- Ticking numbers ----------
const ticks = new Map<HTMLElement, { value: number; target: number; fmt: (v: number) => string }>();
function tick(el: HTMLElement, target: number, fmt: (v: number) => string) {
  const t = ticks.get(el);
  if (t) { t.target = target; t.fmt = fmt; } else { ticks.set(el, { value: target, target, fmt }); el.textContent = fmt(target); }
}
(function loop() {
  for (const [el, t] of ticks) {
    if (!el.isConnected) { ticks.delete(el); continue; }
    if (Math.abs(t.value - t.target) < 0.05) { if (t.value !== t.target) { t.value = t.target; el.textContent = t.fmt(t.value); } continue; }
    t.value += (t.target - t.value) * 0.12;
    el.textContent = t.fmt(t.value);
  }
  requestAnimationFrame(loop);
})();

// ---------- Tier strip, always visible past landing ----------
function buildTiers() {
  $('tiers').innerHTML = TIERS.map((t) => `<div class="tier"><span class="badge ${t}">${t.toUpperCase()}</span><span class="num" id="tier-${t}"></span></div>`).join('');
}
function updateTiers() {
  const t = totals(revealed(), sel);
  for (const k of TIERS) {
    const el = $(`tier-${k}`);
    if (t[k].parts) tick(el, t[k].saved, fmtSaved);
    else { ticks.delete(el); el.textContent = 'none'; }
  }
  const om = $('opt-mass');
  if (stage === 3) {
    const v = totals(revealed(), sel).verified;
    om.innerHTML = `<span class="num big" id="vmass"></span><span class="lbl">Mass, verified savings only</span>`;
    const vm = $('vmass');
    const prior = ticks.get(vm);
    if (!prior) ticks.set(vm, { value: baselineG() - v.saved, target: baselineG() - v.saved, fmt: fmtMass });
    tick(vm, baselineG() - v.saved, fmtMass);
    vm.textContent = fmtMass(ticks.get(vm)!.value);
  }
}

// ---------- Stages ----------
function shotFor(s: number): Shot {
  const m = isMobile();
  switch (s) {
    case 1: return { fit: 'assembled', az: 0.55, el: 0.08, pad: m ? 1.5 : 1.25, shiftX: m ? 0 : 0.12, shiftY: m ? 0.04 : 0 };
    case 2: return { fit: 'exploded', az: 0.22, el: 0.08, pad: m ? 1.2 : 1.16, shiftX: 0, shiftY: m ? 0.03 : -0.01 };
    case 3: return { fit: 'exploded', az: 0.22, el: 0.08, pad: m ? 1.75 : 1.2, shiftX: m ? 0 : 0.14, shiftY: m ? -0.2 : -0.01 };
    case 4: return { fit: 'assembled', az: 0.6, el: 0.08, pad: m ? 2.2 : 1.25, shiftX: m ? 0 : 0.23, shiftY: m ? -0.28 : 0 };
    default: return { fit: 'assembled', az: 0.6, el: 0.08, pad: 1.3, shiftX: 0, shiftY: 0 };
  }
}

function currentStatuses() {
  const shown: Record<string, Status> = {};
  for (const p of revealed()) shown[p.id] = effective(p, sel).status;
  return shown;
}

const allStatuses = () => Object.fromEntries(parts().map((p) => [p.id, effective(p, sel).status]));

function enter(s: number) {
  stage = s;
  stageElapsed = 0;
  stepElapsed = 0;
  document.body.dataset.stage = String(s);
  openPanel(null);
  if (s < 3) { cursor = -1; after = false; changes = false; viewer.setChanges(false); }
  if (s === 3) { cursor = 0; }
  viewer.setExplode(s === 2 || s === 3);
  viewer.setShot(shotFor(s));
  viewer.setCurrent(null);
  viewer.setColorMode(s <= 1 ? 'neutral' : s === 2 ? colorBy : 'status');
  viewer.setStatuses(s === 2 ? allStatuses() : currentStatuses());
  viewer.setView(after, stress);
  if (s === 3) { renderLanes(); viewer.setCurrent(parts()[0]?.id ?? null); preloadOpt(); }
  if (s === 4) checkZip();
  renderCopy();
  renderSummary();
  renderTools();
  renderSteps();
  updateTiers();
}

function renderCopy() {
  const c = $('copy');
  if (!doc || stage === 0 || stage >= 3) { c.innerHTML = ''; return; }
  if (stage === 1) {
    c.innerHTML = `<div class="eyebrow">${esc(doc.robot.name)}</div>
      <div class="hero num">${doc.robot.mass_kg.toFixed(2)}<span class="unit">kg</span></div>
      <a class="src" href="${esc(doc.robot.source)}" target="_blank" rel="noreferrer">${parts().length} parts from the open CAD model</a>`;
  } else {
    c.innerHTML = `<div class="eyebrow">${parts().length} components</div>
      <div class="lede">${colorBy === 'mass' ? 'Brighter means heavier.' : 'Colored by status.'}</div>`;
  }
}

function renderSteps() {
  $('steps').innerHTML = [1, 2, 3, 4].map((i) => `<i class="${i === stage ? 'on' : ''}"></i>`).join('');
  $('nav-auto').setAttribute('aria-pressed', String(auto));
}

/** The results a stage needs may have changed the moment a selection changes. */
function selectionChanged() {
  for (const p of parts()) void viewer.setOptMesh(p.id, effective(p, sel).mesh).then(afterOptLoad);
  viewer.setStatuses(currentStatuses());
  updateTiers();
  renderSummary();
  if (stage === 3) renderLanes();
  renderTools();
  renderPanel();
}
function preloadOpt() { for (const p of parts()) { const m = effective(p, sel).mesh; if (m) void viewer.setOptMesh(p.id, m).then(afterOptLoad); } }
function afterOptLoad() { if (selected) renderPanelToggles(); renderToolsSoon(); }
let toolsT = 0;
function renderToolsSoon() { clearTimeout(toolsT); toolsT = window.setTimeout(renderTools, 60); }

function renderTools() {
  const el = $('tools');
  const groups: string[] = [];
  if (stage === 2 && !explore) groups.push(seg('color', [['mass', 'Mass'], ['status', 'Status']], colorBy));
  if ((stage >= 3 || explore) && parts().some((p) => effective(p, sel).mesh)) {
    groups.push(seg('view', viewOpts(), viewVal()));
    if (after && !changes && parts().some((p) => viewer.hasStress(p.id))) groups.push(seg('stress', [['off', 'Solid'], ['on', 'Stress']], stress ? 'on' : 'off'));
  }
  const opts = designOptions(parts());
  if (stage >= 3 && opts.length) groups.push(seg('design', [['', 'Default'], ...opts.map((o): [string, string] => [o.id, o.label])], sel.global));
  el.innerHTML = groups.join('');
}
const viewOpts = (): [string, string][] => [['before', 'Before'], ['after', 'After'], ...(viewer.hasRemoved() ? [['changes', 'Changes'] as [string, string]] : [])];
const viewVal = () => (changes ? 'changes' : after ? 'after' : 'before');
const seg = (name: string, opts: [string, string][], val: string) =>
  `<div class="seg" data-seg="${name}">${opts.map(([v, l]) => `<button data-v="${esc(v)}" class="${v === val ? 'on' : ''}">${esc(l)}</button>`).join('')}</div>`;

function onSeg(name: string, v: string) {
  if (name === 'color') { colorBy = v as typeof colorBy; viewer.setColorMode(colorBy); viewer.setStatuses(allStatuses()); renderCopy(); renderTools(); }
  if (name === 'view') { after = v !== 'before'; changes = v === 'changes'; viewer.setChanges(changes); viewer.setView(after, stress); renderTools(); renderPanelToggles(); }
  if (name === 'stress') { stress = v === 'on'; viewer.setView(after, stress); renderTools(); renderPanelToggles(); }
  if (name === 'cut') { cut = v === 'on'; viewer.setCut(cut ? selected : null); renderPanelToggles(); }
  if (name === 'design') { sel.global = v; sel.perPart = {}; selectionChanged(); }
  if (name === 'part-design' && selected) { sel.perPart[selected] = v; selectionChanged(); }
}
document.addEventListener('click', (e) => {
  const b = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-seg] button');
  if (b) { onSeg(b.closest<HTMLElement>('[data-seg]')!.dataset.seg!, b.dataset.v!); b.blur(); }
});

// ---------- Optimize lanes ----------
const SHORT: Record<string, string> = { pass: 'PASS', warn: 'WARN', fail: 'FAIL', na: 'N/A' };
function renderLanes() {
  const p = parts()[cursor];
  if (!p) return;
  const e = effective(p, sel);
  $('opt-count').textContent = `Part ${cursor + 1} of ${parts().length}`;
  const saved = e.mass != null ? p.mass_g - e.mass : null;
  $('opt-part').innerHTML = `<span class="name">${esc(p.label)}</span>${badge(e.status)}
    <span class="delta num">${fmtMass(p.mass_g)}${e.mass != null ? ` <span class="arrow">to</span> ${fmtMass(e.mass)}` : ''}${saved != null ? ` <b>${fmtSaved(saved)}</b>` : ''}</span>`;
  $('lanes').innerHTML = AGENTS.map((a, i) => {
    const c = p.checks?.[a];
    return `<div class="lane ${c ? c.status : 'none'}" style="--i:${i}">
      <span class="lane-name">${a[0].toUpperCase() + a.slice(1)}</span>
      <span class="lane-state">${c ? SHORT[c.status] ?? esc(c.status).toUpperCase() : 'NOT RUN'}</span>
      <span class="lane-sum">${c ? esc(c.summary) : ''}</span></div>`;
  }).join('');
  const any = parts().some((x) => effective(x, sel).mass != null);
  $('opt-note').textContent = any ? 'Click any part for detail.' : 'No physics results in robot.json yet. Nothing is claimed until they arrive.';
  $('opt-replay').hidden = !any;
}

function stepTo(i: number) {
  cursor = i;
  renderLanes();
  viewer.setCurrent(parts()[i]?.id ?? null);
  viewer.setStatuses(currentStatuses());
  updateTiers();
}

// ---------- Part panel ----------
function openPanel(id: string | null) {
  selected = id;
  if (cut) { cut = false; viewer.setCut(null); }
  viewer.setSelected(id);
  $('panel').classList.toggle('open', !!id);
  document.body.classList.toggle('inspecting', !!id);
  renderPanel();
}

function renderPanel() {
  const p = parts().find((x) => x.id === selected);
  const el = $('panel');
  if (!p) return;
  const e = effective(p, sel);
  const saved = e.mass != null ? p.mass_g - e.mass : null;
  const designs = p.designs ?? [];
  el.innerHTML = `
    <button class="close" id="panel-close" aria-label="Close">Close</button>
    <div class="eyebrow">${esc(p.group)}</div>
    <h2>${esc(p.label)}</h2>
    ${badge(e.status)}
    <dl class="masses">
      <div><dt>Before</dt><dd class="num">${fmtMass(p.mass_g)}</dd></div>
      <div><dt>After</dt><dd class="num">${e.mass != null ? fmtMass(e.mass) : 'No result'}</dd></div>
      ${saved != null ? `<div><dt>Saved</dt><dd class="num accent">${fmtSaved(saved)}</dd></div>` : ''}
    </dl>
    ${e.material ? `<p class="meta">${esc(e.material)}</p>` : ''}
    ${designs.length ? `<div class="block"><div class="lbl">Design</div>${seg('part-design', designs.map((d): [string, string] => [d.id, d.label]), e.designId)}</div>` : ''}
    <div id="panel-toggles"></div>
    <div class="block"><div class="lbl">Checks</div><ul class="checks">
    ${AGENTS.map((a) => {
      const c = p.checks?.[a];
      const name = a[0].toUpperCase() + a.slice(1);
      return c
        ? `<li class="${esc(c.status)}"><span class="ck-name">${name}</span><span class="ck-state">${SHORT[c.status] ?? esc(c.status)}</span><span class="ck-sum">${esc(c.summary)}</span><span class="ck-basis">${esc(c.basis)}</span></li>`
        : `<li class="none"><span class="ck-name">${name}</span><span class="ck-state">NOT RUN</span></li>`;
    }).join('')}</ul></div>
    ${changesHtml(p)}${reviewHtml(p)}`;
  $('panel-close').onclick = () => openPanel(null);
  renderPanelToggles();
}

function renderPanelToggles() {
  const box = document.getElementById('panel-toggles');
  if (!box || !selected) return;
  if (!viewer.hasOpt(selected)) { box.innerHTML = ''; return; }
  box.innerHTML = `<div class="block row">${seg('view', viewOpts(), viewVal())}
    ${after && !changes && viewer.hasStress(selected) ? seg('stress', [['off', 'Solid'], ['on', 'Stress']], stress ? 'on' : 'off') : ''}
    ${changes && viewer.hasRemoved(selected) ? '<p class="note legend-r"><i></i>Removed material</p>' : ''}
    ${after ? seg('cut', [['off', 'Shell'], ['on', 'Cutaway']], cut ? 'on' : 'off') : ''}</div>`;
}

// ---------- Summary ----------
async function checkZip() {
  try {
    const r = await fetch(dataUrl('every-gram-design.zip'), { method: 'HEAD', cache: 'no-store' });
    zipOk = r.ok && !(r.headers.get('content-type') ?? '').includes('html');
  } catch { zipOk = false; }
  renderSummary();
}

const known = (v: unknown): v is number => typeof v === 'number' && isFinite(v);

/** A total is only meaningful if the items partition the robot. Levers that overlap are never summed. */
function proposedPath() {
  if (!proposal) return null;
  const items = proposal.items;
  if (!items.every((i) => known(i.mass_kg) && known(i.proposed_kg))) return null;
  const base = proposal.baseline_kg ?? items.reduce((s, i) => s + i.mass_kg!, 0);
  if (Math.abs(items.reduce((s, i) => s + i.mass_kg!, 0) - base) > base * 0.01) return null;
  const after = items.reduce((s, i) => s + i.proposed_kg!, 0);
  return { base, after, pct: (after / base) * 100 };
}

/** Biggest single proposed cut, for the summary when no total can be stated. */
function biggestLever() {
  return (proposal?.items ?? []).filter((i) => known(i.mass_kg) && known(i.proposed_kg))
    .sort((x, y) => (y.mass_kg! - y.proposed_kg!) - (x.mass_kg! - x.proposed_kg!))[0] ?? null;
}

function renderSummary() {
  const el = $('summary');
  if (stage !== 4 || !doc) { el.innerHTML = ''; return; }
  const t = totals(parts(), sel);
  const base = baselineG();
  const rows = TIERS.map((k: Tier) => {
    const r = t[k];
    return `<tr><th>${badge(k)}</th>
      <td class="num">${r.parts ? fmtMass(r.saved) : 'none'}</td>
      <td class="num">${r.parts ? fmtMass(base - r.saved) : 'none'}</td>
      <td class="num">${r.parts ? fmtUsd((r.saved / 1000) * USD_PER_KG) : 'none'}</td>
      <td class="num">${r.parts}</td></tr>`;
  }).join('');
  const path = proposedPath();
  const lever = biggestLever();
  const v = t.verified;
  el.innerHTML = `
    <div class="eyebrow">Verified structural savings ${badge('verified')}</div>
    <div class="hero num">${v.parts ? (v.saved / 1000).toFixed(2) : '0.00'}<span class="unit">kg</span></div>
    <p class="lede">${v.parts ? `of ${doc.robot.mass_kg.toFixed(2)} kg, across ${v.parts} part${v.parts > 1 ? 's' : ''} checked by the physics solver.` : `No part has been verified yet. Baseline ${doc.robot.mass_kg.toFixed(2)} kg.`}</p>
    <div class="scroll-x"><table class="tiertable">
      <thead><tr><th></th><th>Saved</th><th>Mass after</th><th>Launch cost saved</th><th>Parts</th></tr></thead>
      <tbody>${rows}</tbody></table></div>
    <p class="note">Each row stands alone; tiers are never added together. Launch cost at $${USD_PER_KG.toLocaleString('en-US')}/kg, SpaceX rideshare list price.</p>
    ${path ? `<button class="path" id="open-path">
      <span>${badge('proposed')} <b>Not verified</b></span>
      <span class="num path-n">${path.after.toFixed(2)} kg, ${path.pct.toFixed(0)}% of ${path.base.toFixed(2)} kg</span>
      <span class="path-l">Proposed path for the whole robot${path.pct < 50 ? ', under 50%' : ''}. A separate figure, not part of the savings above.</span>
    </button>` : lever ? `<button class="path" id="open-path">
      <span>${badge('proposed')} <b>Not verified</b></span>
      <span class="num path-n">${esc(lever.subsystem)}: ${lever.mass_kg!.toFixed(2)} to ${lever.proposed_kg!.toFixed(2)} kg</span>
      <span class="path-l">Largest of ${proposal!.items.length} whole-robot levers. Separate options, not added up and not part of the savings above.</span>
    </button>` : ''}
    <button class="link st-link" id="to-story">See how it got lighter</button>
    ${zipOk ? `<a class="cta" href="${dataUrl('every-gram-design.zip')}" download>Download the design</a>` : `<span class="cta off">${zipOk === null ? 'Checking design package' : 'Design package not available yet'}</span>`}`;
  const b = document.getElementById('open-path');
  if (b) b.onclick = () => openSheet('robot');
  $('to-story').onclick = () => void openStory();
}

// ---------- Sheets ----------
function openSheet(k: typeof sheet) {
  sheet = k;
  openPanel(null);
  $('sheet').classList.toggle('open', !!k);
  if (k === 'materials') renderMaterials();
  if (k === 'robot') renderRobot();
}

const sheetHead = (title: string, sub: string) => `<button class="close" id="sheet-close">Close</button><div class="eyebrow">${esc(sub)}</div><h2>${esc(title)}</h2>`;
const cell = (v: unknown, d = 1, suffix = '') => (typeof v === 'number' ? `${v.toFixed(d)}${suffix}` : '—');

function renderMaterials() {
  const body = $('sheet-in');
  if (!materials?.length) {
    body.innerHTML = `${sheetHead('Materials', 'By part')}<p class="empty">No material study available yet. It will appear here when data/materials.json is published.</p>`;
  } else {
    const label = (id: string) => parts().find((p) => p.id === id)?.label ?? id;
    body.innerHTML = `${sheetHead('Materials', 'By part')}<div class="scroll-x"><table class="data">
      <thead><tr><th>Part</th><th>Material</th><th>Process</th><th class="r">Mass, g</th><th class="r">Saved</th><th class="r">Safety factor</th><th class="r">Stiffness vs original</th><th>Feasible</th></tr></thead>
      <tbody>${materials.map((m) => `<tr class="${m.feasible === false ? 'infeasible' : ''}">
        <td>${esc(label(m.part))}</td><td>${esc(m.material ?? '—')}</td><td>${esc(m.process ?? '—')}</td>
        <td class="r num">${cell(m.mass_g)}</td><td class="r num">${cell(m.saved_pct, 1, '%')}</td><td class="r num">${cell(m.sf, 2)}</td><td class="r num">${cell(m.stiff_vs_orig, 2, 'x')}</td>
        <td>${m.feasible == null ? '—' : m.feasible ? 'Yes' : 'No'}</td></tr>`).join('')}</tbody></table></div>`;
  }
  $('sheet-close').onclick = () => openSheet('');
}

function renderRobot() {
  const body = $('sheet-in');
  const shades = (n: number, i: number) => `color-mix(in srgb, var(--ink) ${82 - (i * 60) / Math.max(1, n - 1)}%, var(--bg))`;
  // Measured breakdown comes from robot.json link masses, so it stands even with no proposal.
  const groups = [...parts().reduce((m, p) => m.set(p.group, (m.get(p.group) ?? 0) + p.mass_g), new Map<string, number>())]
    .sort((a, b) => b[1] - a[1]);
  const totalG = baselineG();
  const breakdown = groups.length ? `<div class="bars"><div class="bar-row">
      <div class="bar-l"><span>Mass today</span><span class="num">${fmtMass(totalG)}</span></div>
      <div class="bar">${groups.map(([g, m], i) => `<i style="width:${(m / totalG) * 100}%;background:${shades(groups.length, i)}" title="${esc(g)}: ${fmtMass(m)}"></i>`).join('')}</div>
      <div class="legend">${groups.map(([g, m], i) => `<span><i class="swatch" style="background:${shades(groups.length, i)}"></i>${esc(g[0].toUpperCase() + g.slice(1))} <span class="num">${fmtMass(m)}</span></span>`).join('')}</div>
    </div></div>` : '';
  const head = sheetHead('Whole robot', 'Mass and proposals') + breakdown;
  if (!proposal) {
    body.innerHTML = `${head}<p class="empty">No whole-robot proposal available yet. It will appear here when data/proposal.json is published.</p>`;
  } else {
    const path = proposedPath();
    const items = proposal.items;
    const scale = Math.max(proposal.baseline_kg ?? 0, ...items.map((i) => i.mass_kg ?? 0), 1e-9);
    const pathBar = path ? `<div class="bars"><div class="bar-row"><div class="bar-l"><span>${badge('proposed')}</span><span class="num">${path.after.toFixed(2)} kg, ${path.pct.toFixed(0)}%</span></div>
      <div class="bar">${items.map((it, i) => `<i style="width:${(it.proposed_kg! / path.base) * 100}%;background:${shades(items.length, i)}" title="${esc(it.subsystem)}: ${it.proposed_kg!.toFixed(2)} kg"></i>`).join('')}</div></div></div>` : '';
    const mini = (it: (typeof items)[number]) => (known(it.mass_kg) && known(it.proposed_kg)
      ? `<div class="lever"><i style="width:${(it.mass_kg / scale) * 100}%"></i><i class="prop" style="width:${(it.proposed_kg / scale) * 100}%"></i></div>` : '');
    body.innerHTML = `${head}${pathBar}
      <p class="note">${path ? 'The proposed bar is not a verified result.' : 'Proposals are separate options. They are not verified and are not added into a total.'}</p>
      <div class="scroll-x"><table class="data"><thead><tr><th>Proposal</th><th class="r">Today, kg</th><th class="r">Proposed, kg</th><th>Status</th><th>Rationale</th></tr></thead>
      <tbody>${items.map((it) => `<tr><td>${esc(it.subsystem)}${mini(it)}</td>
        <td class="r num">${cell(it.mass_kg, 2)}</td><td class="r num">${cell(it.proposed_kg, 2)}</td><td>${badge(it.status)}</td><td class="wrap">${esc(it.rationale ?? '')}</td></tr>`).join('')}</tbody></table></div>`;
  }
  $('sheet-close').onclick = () => openSheet('');
}

// ---------- Flow ----------
function setMsg(s: string) { $('link-msg').textContent = s; }

const product = createProductFlow({
  viewer, root: $('prod'), setMsg, tick,
  setBusy: (b) => { $<HTMLButtonElement>('go').disabled = b; },
  onExit: () => viewer.setShot(shotFor(0)),
});

async function submitLink() {
  if (product.busy()) return;
  const raw = $<HTMLInputElement>('link').value.trim();
  if (!raw) return setMsg('Enter a robot or product link.');
  if (isKnownRobot(raw)) {
    if (loadFailed || !doc) return setMsg('The robot data could not be loaded.');
    if (!ready) { setMsg('Loading model.'); pendingStart = true; return; }
    setMsg('');
    return enter(1);
  }
  await product.analyze(raw);
}

let pendingStart = false;

function advance() {
  if (sheet) return openSheet('');
  if (selected) return openPanel(null);
  if (stage === 0) return void submitLink();
  if (stage === 3 && cursor < parts().length - 1) return stepTo(parts().length - 1);
  if (stage < 4) enter(stage + 1);
}
function back() {
  if (sheet) return openSheet('');
  if (stage > 1) enter(stage - 1);
}
function reset() {
  if (product.active()) product.exit();
  sel.global = ''; sel.perPart = {}; after = false; stress = false;
  openSheet('');
  enter(0);
}

const lastPartWithResult = (p?: Part) => !!p && (effective(p, sel).mass != null || Object.keys(p.checks ?? {}).length > 0);

setInterval(() => {
  const paused = !!selected || !!sheet || product.active() || product.busy() || storyOpen();
  if (paused || stage === 0 && (landingHeld || !(auto && isKnownRobot($<HTMLInputElement>('link').value)))) return;
  if (stage === 3 && cursor < parts().length - 1) {
    stepElapsed += 100;
    if (stepElapsed >= (lastPartWithResult(parts()[cursor]) ? STEP_RESULT : STEP_EMPTY)) { stepElapsed = 0; stepTo(cursor + 1); }
    return;
  }
  if (!auto) return;
  stageElapsed += 100;
  if (stage === 0 ? ready && stageElapsed > 4000 : DWELL[stage] > 0 && stageElapsed >= DWELL[stage]) { stageElapsed = 0; advance(); }
}, 100);

addEventListener('keydown', (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  if (product.active()) {
    if (e.key === 'Escape') product.exit();
    return; // the product flow has real form fields; the stage keys stay out of its way
  }
  if (storyOpen()) {
    if (e.key !== 'Escape') return; // Space scrolls the page in the story
    if (sheet) openSheet(''); else if (selected) openPanel(null); else if (explore) leaveExplore(); else closeStory();
    return;
  }
  const inField = (e.target as HTMLElement).tagName === 'INPUT';
  if (e.code === 'Space') {
    e.preventDefault(); // URLs have no spaces, so Space always drives the show
    if (!e.repeat) advance();
  } else if (e.key === 'Escape') {
    if (sheet) openSheet(''); else if (selected) openPanel(null);
  } else if (inField) {
    return;
  } else if (e.key === 'ArrowRight') advance();
  else if (e.key === 'ArrowLeft') back();
  else if (e.key === 'r' || e.key === 'R') reset();
  else if (e.key === 'a' || e.key === 'A') toggleAuto();
  else if (e.key === 'm' || e.key === 'M') openSheet(sheet === 'materials' ? '' : 'materials');
  else if (e.key === 'w' || e.key === 'W') openSheet(sheet === 'robot' ? '' : 'robot');
});

function toggleAuto() { auto = !auto; stageElapsed = 0; renderSteps(); }

$<HTMLFormElement>('link-form').addEventListener('submit', (e) => { e.preventDefault(); void submitLink(); });
$<HTMLFormElement>('link-form').addEventListener('pointerdown', () => { landingHeld = true; });
$<HTMLInputElement>('link').addEventListener('input', () => { landingHeld = true; });
void Promise.all([product.chips(), loadMug()]).then(([list, m]) => {
  mug = m;
  $('chips').innerHTML = list.map((c) => `<button type="button" data-url="${esc(c.url)}">${esc(c.label)}</button>`).join('')
    + (m ? `<button type="button" class="chip-mug" data-mug="1">${esc(m.title)}</button>` : '');
});
$('chips').addEventListener('click', (e) => {
  if ((e.target as HTMLElement).closest('[data-mug]')) return void openStory('st-mug');
  const b = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-url]');
  if (!b) return;
  $<HTMLInputElement>('link').value = b.dataset.url!;
  b.blur();
  void submitLink();
});
$('story-link').onclick = () => void openStory();
$('nav-story').onclick = () => void openStory();
$('home').onclick = () => { reset(); $('home').blur(); };
$('nav-auto').onclick = () => { toggleAuto(); $('nav-auto').blur(); };
$('nav-materials').onclick = () => { openSheet('materials'); $('nav-materials').blur(); };
$('nav-robot').onclick = () => { openSheet('robot'); $('nav-robot').blur(); };
$('sheet').addEventListener('click', (e) => { if (e.target === $('sheet')) openSheet(''); });
addEventListener('resize', () => { if (stage) viewer.setShot(shotFor(stage)); });

// The story loads on demand so the stage flow never pays for it.
let readyResolve: () => void;
const robotReady = new Promise<void>((r) => (readyResolve = r));

async function openStory(anchor?: string) {
  if (!doc || storyOpen()) return;
  storyReturn = stage;
  openPanel(null);
  document.body.dataset.story = 'read';
  await robotReady;
  const { createStory } = await import('./story');
  if (!storyOpen()) return;
  story ??= createStory({
    viewer, doc, proposal, mug: mug ?? await loadMug(), sel, ready: () => robotReady, preloadOpt,
    onClose: closeStory, onExplore: enterExplore, onLeaveExplore: leaveExplore,
  });
  story.show();
  if (anchor) story.goto(anchor);
}

function closeStory() {
  explore = false;
  delete document.body.dataset.story;
  story?.hide();
  after = false;
  cut = false;
  enter(storyReturn);
}

function enterExplore() {
  explore = true;
  document.body.dataset.story = 'explore';
  enter(2);
  after = true;
  viewer.setPalette(story!.palette);
  viewer.setView(true, stress);
  renderTools();
}

function leaveExplore() {
  explore = false;
  openPanel(null);
  document.body.dataset.story = 'read';
  $('tools').innerHTML = '';
  story?.resume();
}

async function boot() {
  buildTiers();
  renderSteps();
  [materials, proposal] = await Promise.all([loadMaterials(), loadProposal()]);
  doc = await loadRobot();
  if (!doc) { loadFailed = true; return setMsg('The robot data could not be loaded.'); }
  viewer.setShot(shotFor(0));
  try {
    await viewer.load(doc.parts, (d, n) => { if (pendingStart) setMsg(`Loading model, ${d} of ${n} parts.`); });
    ready = true;
    readyResolve();
    if (location.hash === '#story') void openStory();
    if (location.hash === '#mug') void openStory('st-mug');
    if (pendingStart) { setMsg(''); enter(1); }
  } catch {
    loadFailed = true;
    setMsg('The 3D model could not be loaded.');
  }
}
void boot();
