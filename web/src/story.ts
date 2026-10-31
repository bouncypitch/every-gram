import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { toCreasedNormals } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import './story.css';
import { changesHtml, reviewHtml } from './review';
import { AGENTS, dataUrl, fmtMass, fmtUsd, totals, type Agent, type Mug, type MugDesign, type Part, type Proposal, type RobotDoc, type Selection } from './data';
import type { Viewer, Shot } from './viewer';

const USD_PER_KG = 7000; // SpaceX rideshare list price, a citation constant
const G = 9.81;
const REPO = 'https://github.com/bouncypitch/every-gram';
const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export const AGENT_COLORS: Record<Agent, string> = {
  mechanical: '#2e8bff', thermal: '#ff6a2b', electrical: '#ffd400', reliability: '#19e0d0', cost: '#b18cff', power: '#ff5ad6',
};
interface Strategy { key: string; test: RegExp; color: string; name: string; from: string; body: string; icon: string }
const STRATEGIES: Strategy[] = [
  {
    key: 'honeycomb', test: /honeycomb/i, color: '#ffb800', name: 'Honeycomb', from: 'Inspired by honeybee cells',
    body: 'Bees build hexagons because they enclose the most space for the least wax. The foot keeps a thin skin and fills the core with through-thickness hex walls, so it stays stiff where it meets the ground.',
    icon: '<path d="M32 6l13 7.5v15L32 36l-13-7.5v-15zM18 30l13 7.5v15L18 60 5 52.5v-15zM46 30l13 7.5v15L46 60l-13-7.5v-15z" fill="none" stroke="currentColor" stroke-width="3" stroke-linejoin="round"/>',
  },
  {
    key: 'topology', test: /topolog/i, color: '#ff3d6e', name: 'Topology removal', from: 'Inspired by bone',
    body: 'Bone adds material along lines of stress and removes it elsewhere. The yoke does the same: stress from the simulation decides which walls stay, and low-stress material goes.',
    icon: '<path d="M14 10c8 6 8 12 18 22s14 12 18 22M50 10c-8 6-8 12-18 22S18 44 14 54M10 32h44" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"/>',
  },
  {
    key: 'hollow', test: /hollow/i, color: '#2e8bff', name: 'Hollow core', from: 'Inspired by launch-vehicle isogrid',
    body: 'Rocket skins put strength in a thin shell over a light rib pattern. Isogrid ribs were in the test set here; the arm links ship as a skin around a hollow core, with bosses kept at the joints.',
    icon: '<path d="M6 54L32 10l26 44zM19 32h26M32 10l13 22-13 22-13-22z" fill="none" stroke="currentColor" stroke-width="3" stroke-linejoin="round"/>',
  },
];
export const strategyOf = (p: Part) => {
  const label = p.designs?.[0]?.label ?? '';
  return STRATEGIES.find((s) => s.test.test(label)) ?? null;
};
const STATE = { pass: 'PASS', warn: 'WARN', fail: 'FAIL', na: 'N/A' } as Record<string, string>;
const STATE_C = { pass: 'var(--verified)', warn: 'var(--warn)', fail: 'var(--fail)', na: 'var(--ink-2)' } as Record<string, string>;

type Mode = 'plain' | 'stress' | 'changes';

interface Ctx {
  viewer: Viewer; doc: RobotDoc; proposal: Proposal | null; mug: Mug | null; ready: () => Promise<void>;
  preloadOpt: () => void; sel: Selection;
  onClose: () => void; onExplore: () => void; onLeaveExplore: () => void;
}

const STEPS = [
  { c: '#2e8bff', k: 'Input design', h: 'Start with what exists.', body: () => '' },
  { c: '#ffb800', k: 'Exploded', h: 'Every part answers for itself.', body: () => '' },
  { c: '#00e58a', k: 'Lighter design', h: 'AI proposes. Physics decides.', body: () => '' },
  { c: '#ff5ad6', k: 'Reassembly', h: 'Same robot. Fewer grams.', body: () => '' },
];

export function createStory(ctx: Ctx) {
  const { viewer, doc } = ctx;
  const parts = doc.parts;
  const done = parts.filter((p) => p.mass_opt_g != null && p.status !== 'untouched');
  const verified = parts.filter((p) => p.status === 'verified' && p.mass_opt_g != null);
  const t = totals(parts, ctx.sel);
  const palette = Object.fromEntries(done.flatMap((p) => { const s = strategyOf(p); return s ? [[p.id, s.color]] : []; }));
  STEPS[0].body = () => `${doc.robot.name}: ${parts.length} parts, ${doc.robot.mass_kg.toFixed(2)} kg, from the open CAD model.`;
  STEPS[1].body = () => 'Each link comes apart so it can be judged alone.';
  STEPS[2].body = () => `${verified.length} parts redesigned and checked by the solver. ${fmtMass(t.verified.saved)} removed. Colors show the strategy.`;
  STEPS[3].body = () => `From ${doc.robot.mass_kg.toFixed(2)} kg to ${fmtMass(doc.robot.mass_kg * 1000 - t.verified.saved)}, counting verified savings only.`;

  const el = document.createElement('div');
  el.className = 'story';
  el.tabIndex = -1;
  el.innerHTML = `
    <div class="st-bar"><div class="st-bar-in"><button id="st-close">Back to demo</button></div></div>
    <section class="st-scrub" id="st-scrub"><div class="st-pin">
      <div class="st-steps">${STEPS.map((s, i) => `<div class="st-step" data-i="${i}"><span class="st-kicker" style="background:${s.c}">${s.k}</span><h2>${s.h}</h2><p>${esc(s.body())}</p></div>`).join('')}</div>
      <div class="st-rail">${STEPS.map(() => '<i></i>').join('')}</div>
    </div></section>
    ${videosHtml()}${compareHtml()}${approachHtml()}${agentsHtml()}${savingsHtml()}${mugHtml()}${footHtml()}`;
  document.body.append(el);

  const bar = document.createElement('div');
  bar.className = 'xp';
  bar.innerHTML = '<button id="xp-back">Back to the story</button><span>Drag to orbit. Scroll to zoom. Click a part to dive in.</span>';
  document.body.append(bar);

  function videosHtml() {
    const clips = [
      ['explode', 'Explode', 'Each link leaves the assembly.'],
      ['honeycomb', 'Honeycomb close-up', 'Cutaway of the foot core, colored by simulated stress.'],
      ['reassembly', 'Reassembly', 'The verified parts return to the robot.'],
    ];
    return `<section class="st-sec"><div class="st-in st-reveal">
      <h2 class="big-h">Rendered from the real model.</h2>
      <p class="st-lede">Short clips captured from this app's own 3D renderer, using the same meshes you can open below. No stock footage.</p>
      <div class="st-videos">${clips.map(([f, a, b]) => `<figure><video muted loop playsinline preload="none" poster="${dataUrl(`video/${f}.jpg`)}" aria-label="${esc(a)}"><source src="${dataUrl(`video/${f}.mp4`)}" type="video/mp4" /></video><figcaption><b>${esc(a)}</b>${esc(b)}</figcaption></figure>`).join('')}</div>
      <button class="st-cta" id="st-explore">Explore the robot in 3D</button>
    </div></section>`;
  }

  /** One example of each strategy; mirrored twins would only repeat it. */
  function compareParts() {
    const seen = new Set<string>();
    const order = (p: Part) => STRATEGIES.findIndex((s) => s.key === strategyOf(p)?.key);
    return [...verified].sort((a, b) => order(a) - order(b)).filter((p) => {
      const k = strategyOf(p)?.key;
      if (!k || seen.has(k) || !p.mesh_opt) return false;
      seen.add(k);
      return true;
    });
  }

  function compareHtml() {
    const list = compareParts();
    if (!list.length) return '';
    return `<section class="st-sec"><div class="st-in st-reveal">
      <h2 class="big-h">See exactly what changed.</h2>
      <p class="st-lede">Drag across the part to orbit both sides together. Slide to compare. Where the data exists, Changes shows kept material in grey and removed material in orange. Cutaway opens the core.</p>
      <div class="st-pick" id="cmp-pick">${list.map((p, i) => `<button data-id="${esc(p.id)}" class="${i ? '' : 'on'}" style="--c:${strategyOf(p)!.color}">${esc(p.label)}</button>`).join('')}</div>
      <div class="cmp" id="cmp"><canvas aria-label="Before and after comparison of the selected part"></canvas><i class="cmp-line"></i><span class="cmp-l">Before</span><span class="cmp-r">After</span></div>
      <div class="cmp-ctl">
        <input id="cmp-range" type="range" min="0" max="100" value="50" aria-label="Before and after split" />
        <div class="seg" id="cmp-color"><button data-v="changes" id="cmp-ch" hidden>Changes</button><button data-v="plain" class="on">Strategy</button><button data-v="stress">Stress</button></div>
        <div class="seg" id="cmp-cut"><button data-v="off" class="on">Whole</button><button data-v="on">Cutaway</button></div>
      </div>
      <div class="cmp-read" id="cmp-read"></div>
      <div class="cmp-side"><div id="cmp-changes"></div><div id="cmp-review"></div></div>
    </div></section>`;
  }

  function approachHtml() {
    const cards = STRATEGIES.map((s) => {
      const ps = done.filter((p) => strategyOf(p)?.key === s.key);
      if (!ps.length) return '';
      const p = ps[0];
      const saved = p.mass_g - (p.mass_opt_g as number);
      return `<article class="st-card" style="--c:${s.color}"><svg viewBox="0 0 64 64" aria-hidden="true">${s.icon}</svg>
        <span class="tag2">${esc(s.from)}</span><h3>${esc(p.designs?.[0]?.label ?? s.name)}</h3><p>${esc(s.body)}</p>
        <div class="tot num">${esc(p.label.replace(/^(Left|Right) /, ''))}, ${fmtMass(p.mass_g)} to ${fmtMass(p.mass_opt_g as number)}, ${ps.length} part${ps.length > 1 ? 's' : ''}</div></article>`;
    }).join('');
    return `<section class="st-sec paper"><div class="st-in st-reveal">
      <h2 class="big-h">How it got lighter.</h2>
      <p class="st-lede">No single trick. Each part got the strategy that held up in simulation.</p>
      <div class="st-cards">${cards}</div>
      <div class="st-foam" id="st-foam" hidden></div>
      <ol class="st-loop">
        <li style="--c:#2e8bff"><b>Propose</b>A candidate shape, material and wall or rib size.</li>
        <li style="--c:#ffb800"><b>Simulate</b>Linear static voxel finite elements under the part's load cases.</li>
        <li style="--c:#ff3d6e"><b>Compare</b>Peak stress against the material limit, deflection against the original part.</li>
        <li style="--c:#00e58a"><b>Accept or reject</b>Fails go back. The search bisects toward the lightest design that passes.</li>
      </ol>
      <p class="st-solver">The solver turns each part into a regular grid of 8-node hexahedral voxels and solves linear elasticity with a Jacobi-preconditioned conjugate gradient. Peak von Mises stress is read at the 99.5th percentile, away from the idealized load and support regions. A design must pass every load case. These are simulations with typical datasheet properties and assumed loads, not physical tests.</p>
    </div></section>`;
  }

  function agentsHtml() {
    const list = verified.filter((p, i) => verified.findIndex((q) => q.label.replace(/^(Left|Right) /, '') === p.label.replace(/^(Left|Right) /, '')) === i);
    if (!list.length) return '';
    const sim = AGENTS.filter((a) => verified.every((p) => p.checks[a]?.basis === 'simulated'));
    const lead = sim.length === 1 ? `Only ${sim[0][0].toUpperCase() + sim[0].slice(1)} is simulated.` : `${sim.length} of ${AGENTS.length} agents are simulated.`;
    return `<section class="st-sec"><div class="st-in st-reveal">
      <h2 class="big-h">Six agents. One honest label each.</h2>
      <p class="ag-call">${esc(lead)} The others are calculated from it or assumed, and they say so.</p>
      <div class="st-pick" id="ag-pick">${list.map((p, i) => `<button data-id="${esc(p.id)}" class="${i ? '' : 'on'}" style="--c:${strategyOf(p)?.color ?? 'var(--ink)'}">${esc(p.label)}</button>`).join('')}</div>
      <div class="ag-grid" id="ag-grid"></div>
    </div></section>`;
  }

  function savingsHtml() {
    const v = t.verified;
    const kg = v.saved / 1000;
    const filament = verified.reduce((s, p) => {
      const m = /Uses (\d+(?:\.\d+)?) g of filament/.exec(p.checks.cost?.summary ?? '');
      return s + (m ? parseFloat(m[1]) : 0);
    }, 0);
    const rows = [...verified].sort((a, b) => (b.mass_g - b.mass_opt_g!) - (a.mass_g - a.mass_opt_g!));
    const prop = ctx.proposal;
    const propAfter = prop?.items.every((i) => typeof i.proposed_kg === 'number') ? prop.items.reduce((s, i) => s + i.proposed_kg!, 0) : null;
    const tile = (c: string, l: string, b: string, s: string) => `<div class="sv" style="--c:${c}"><span>${l}</span><b class="num">${b}</b><small>${s}</small></div>`;
    return `<section class="st-sec paper"><div class="st-in st-reveal">
      <h2 class="big-h">What the grams are worth.</h2>
      <p class="st-lede"><span class="badge verified">VERIFIED</span> Everything in these tiles counts verified structural savings only.</p>
      <div class="sv-hero">
        ${tile('#00e58a', 'Mass saved', fmtMass(v.saved), `${v.parts} parts`)}
        ${tile('#ffd400', 'Of the whole robot', `${((v.saved / (doc.robot.mass_kg * 1000)) * 100).toFixed(1)}%`, `of ${doc.robot.mass_kg.toFixed(2)} kg`)}
        ${tile('#19e0d0', 'Launch cost saved', fmtUsd(kg * USD_PER_KG), '$7,000/kg, SpaceX rideshare list price')}
        ${tile('#ff9a3d', 'Static support load removed', `${(kg * G).toFixed(1)} N`, 'Saved mass x 9.81 m/s²')}
        ${tile('#b18cff', 'Filament to print them', filament ? fmtMass(filament) : '—', 'Sum of the cost agent figures')}
        ${tile('#ff5ad6', 'Kilograms', `${kg.toFixed(3)} kg`, 'Same saving, for the launch manifest')}
      </div>
      <div class="sv-tiers">
        <div class="sv-tier"><span class="badge estimated">ESTIMATED</span><span class="num">${t.estimated.parts ? fmtMass(t.estimated.saved) : 'none'}</span></div>
        <div class="sv-tier"><span class="badge proposed">PROPOSED</span><span class="num">${propAfter != null ? `Whole-robot path to ${propAfter.toFixed(2)} kg, ${((propAfter / (prop!.baseline_kg)) * 100).toFixed(0)}% of baseline.` : 'none'}</span><span class="sv-note" style="margin:0">Not verified. Never added to the verified totals.</span></div>
      </div>
      <div class="scroll-x"><table class="sv-tbl"><thead><tr><th>Part</th><th class="r">Before</th><th class="r">After</th><th class="r">Saved</th><th class="r">Percent</th><th class="r">Launch</th></tr></thead>
      <tbody>${rows.map((p) => { const s = p.mass_g - p.mass_opt_g!; return `<tr><td>${esc(p.label)}</td><td class="r num">${fmtMass(p.mass_g)}</td><td class="r num">${fmtMass(p.mass_opt_g!)}</td><td class="r num">${fmtMass(s)}</td><td class="r num">${((s / p.mass_g) * 100).toFixed(1)}%</td><td class="r num">${fmtUsd((s / 1000) * USD_PER_KG)}</td></tr>`; }).join('')}</tbody></table></div>
      <p class="sv-note">Each part's mass includes the hardware that stays in place, so percentages are for the whole link.</p>
      <p style="margin-top:24px"><a class="st-cta" href="${dataUrl('every-gram-design.zip')}" download style="margin:0;text-decoration:none">Download the design</a></p>
    </div></section>`;
  }

  function mugHtml() {
    const mug = ctx.mug;
    if (!mug) return '';
    const base = mug.designs[0];
    const thin = mug.designs.find((d) => /2\.5\s*mm/.test(d.design)) ?? mug.designs[mug.designs.length - 1];
    const stress = (d: MugDesign) => (d.peak_mpa != null && d.limit_mpa != null ? `${d.peak_mpa.toFixed(1)} of ${d.limit_mpa} MPa` : 'Not simulated');
    // A calculated row can never read as VERIFIED, whatever its status field says.
    const status = (d: MugDesign) => {
      const st = d.basis !== 'simulated' && d.status === 'verified' ? 'estimated' : d.status;
      return `<span class="badge ${st === 'baseline' ? 'untouched' : esc(st)}">${esc(st.toUpperCase())}</span>`;
    };
    const picks = mug.designs.filter((d) => d.pick);
    return `<section class="st-sec mug" id="st-mug"><div class="st-in st-reveal">
      <div class="eyebrow">Case study</div>
      <h2 class="big-h">${esc(mug.title)}</h2>
      ${mug.subject ? `<p class="mug-sub"><b>Subject:</b> ${esc(mug.subject)}.</p>` : ''}
      ${mug.load ? `<p class="mug-sub"><b>Load:</b> ${esc(mug.load)}.</p>` : ''}
      <div class="cmp" id="mug-cmp" style="margin-top:26px"><canvas aria-label="Cutaway comparison of the two mug walls"></canvas><i class="cmp-line"></i><span class="cmp-l">${esc(base.design)}</span><span class="cmp-r">${esc(thin.design)}</span></div>
      <div class="cmp-ctl">
        <input id="mug-range" type="range" min="0" max="100" value="50" aria-label="Before and after split" />
        <div class="seg" id="mug-cut"><button data-v="on" class="on">Cutaway</button><button data-v="off">Whole</button></div>
      </div>
      ${picks.length ? `<div class="mug-picks">${picks.map((d, i) => `<div class="mug-pick" style="--c:${i ? '#19e0d0' : '#ff9a3d'}"><span>${esc(d.pick)} pick</span><b>${esc(d.design)}</b><small class="num">${fmtMass(d.mass_g)}, ${esc(d.saved_pct)}% lighter. ${esc(d.tradeoff ?? '')}</small><br />${status(d)}</div>`).join('')}</div>` : ''}
      <table class="mug-tbl"><thead><tr><th>Design</th><th>Mass</th><th>Saving</th><th>Stress vs limit</th><th>Tradeoff</th><th>Basis</th><th>Status</th></tr></thead>
      <tbody>${mug.designs.map((d) => `<tr><td>${esc(d.design)}</td><td class="num" data-l="Mass">${fmtMass(d.mass_g)}</td><td class="num" data-l="Saving">${d.saved_pct ? `${esc(d.saved_pct)}%` : '—'}</td><td class="num" data-l="Stress vs limit">${stress(d)}</td><td class="tr">${esc(d.tradeoff ?? '')}</td><td><span class="ag-basis ${esc(d.basis)}">${esc(d.basis.toUpperCase())}</span></td><td>${status(d)}</td></tr>`).join('')}</tbody></table>
      ${mug.sense?.length ? `<h3 class="mug-h">Does this make sense?</h3><ul class="mug-sense">${mug.sense.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}
      ${mug.line ? `<blockquote>${esc(mug.line)}</blockquote>` : ''}
    </div></section>`;
  }

  function footHtml() {
    return `<footer class="st-foot">
      <p>Robot models and designs derived from them are adapted from <a href="${esc(doc.robot.source)}" rel="noreferrer">Berkeley Humanoid Lite</a> by HybridRobotics, under <a href="https://creativecommons.org/licenses/by-sa/4.0/" rel="noreferrer">CC BY-SA 4.0</a>.</p>
      <p>Results are simulations under stated load and material assumptions, not physical tests.</p>
      <p><a href="${REPO}" rel="noreferrer">github.com/bouncypitch/every-gram</a></p>
    </footer>`;
  }

  // ---------- Scroll scrub ----------
  const scrub = el.querySelector<HTMLElement>('#st-scrub')!;
  const stepEls = [...el.querySelectorAll<HTMLElement>('.st-step')];
  const rail = [...el.querySelectorAll<HTMLElement>('.st-rail i')];
  const m = () => innerWidth < 760;
  const assembled = (): Shot => ({ fit: 'assembled', az: 0.55, el: 0.1, pad: m() ? 1.5 : 1.2, shiftX: m() ? 0 : 0.17, shiftY: m() ? -0.15 : 0 });
  const exploded = (): Shot => ({ fit: 'exploded', az: 0.25, el: 0.1, pad: m() ? 1.5 : 1.14, shiftX: m() ? 0 : 0.17, shiftY: m() ? -0.15 : 0 });
  let phase = -1;
  let inHero = false;

  function applyPhase(i: number) {
    if (i === phase) return;
    phase = i;
    stepEls.forEach((s, k) => s.classList.toggle('on', k === i));
    rail.forEach((r, k) => { r.style.background = k <= i ? STEPS[k].c : ''; });
    viewer.setShot(i === 1 || i === 2 ? exploded() : assembled());
    viewer.setChanges(i === 2 && viewer.hasRemoved());
    if (i >= 2) { viewer.setView(true, false); viewer.setPalette(palette); } else { viewer.setView(false, false); viewer.setPalette(i === 1 ? palette : null); }
  }

  function onScroll() {
    const range = scrub.offsetHeight - el.clientHeight;
    const p = Math.min(1, Math.max(0, el.scrollTop / range));
    const heroVisible = el.scrollTop < scrub.offsetHeight;
    if (heroVisible !== inHero) { inHero = heroVisible; viewer.setPaused(!heroVisible); }
    applyPhase(p < 0.2 ? 0 : p < 0.45 ? 1 : p < 0.75 ? 2 : 3);
    const ramp = (a: number, b: number) => Math.min(1, Math.max(0, (p - a) / (b - a)));
    viewer.setExplode(ramp(0.16, 0.38) * (1 - ramp(0.72, 0.92)));
  }
  el.addEventListener('scroll', () => requestAnimationFrame(onScroll), { passive: true });
  addEventListener('resize', () => { if (el.isConnected && phase >= 0) { const i = phase; phase = -1; applyPhase(i); } });

  // ---------- Reveal + videos ----------
  const io = new IntersectionObserver((es) => es.forEach((e) => { if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); } }), { root: el, threshold: 0.08 });
  el.querySelectorAll('.st-reveal').forEach((s) => io.observe(s));
  const videos = [...el.querySelectorAll('video')];
  const vo = new IntersectionObserver((es) => es.forEach((e) => {
    const v = e.target as HTMLVideoElement;
    if (e.isIntersecting && !reduced()) void v.play().catch(() => { /* poster stays */ });
    else v.pause();
  }), { root: el, threshold: 0.35 });
  videos.forEach((v) => {
    if (reduced()) v.controls = true;
    v.querySelector('source')?.addEventListener('error', () => v.closest('figure')?.remove());
    vo.observe(v);
  });

  // ---------- Agents ----------
  function renderAgents(id: string) {
    const p = parts.find((x) => x.id === id);
    const box = el.querySelector('#ag-grid');
    if (!p || !box) return;
    box.innerHTML = AGENTS.map((a) => {
      const c = p.checks[a];
      const name = a[0].toUpperCase() + a.slice(1);
      return `<div class="ag" style="--c:${AGENT_COLORS[a]}"><h3>${name}<span class="ag-state" style="color:${STATE_C[c?.status ?? 'na']}">${c ? STATE[c.status] ?? esc(c.status) : 'NOT RUN'}</span></h3>
        <p>${esc(c?.summary ?? '')}</p>${c ? `<span class="ag-basis ${esc(c.basis)}">${esc(c.basis.toUpperCase())}</span>` : ''}</div>`;
    }).join('');
  }
  const ag0 = el.querySelector<HTMLElement>('#ag-pick button');
  if (ag0) renderAgents(ag0.dataset.id!);
  const pick = (root: Element | null, fn: (b: HTMLElement) => void) => root?.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>('button');
    if (!b) return;
    root.querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
    fn(b);
  });
  pick(el.querySelector('#ag-pick'), (b) => renderAgents(b.dataset.id!));

  // ---------- Foam (optional file) ----------
  void fetch(dataUrl('foam_foot.json'), { cache: 'no-store' }).then(async (r) => {
    if (!r.ok || !(r.headers.get('content-type') ?? '').includes('json')) return;
    const rows: { mass_g: number; ratio: number; ok: boolean; skin_mm: number; foam_kg_m3: number }[] = await r.json();
    const ok = rows.filter((x) => x.ok).sort((a, b) => a.mass_g - b.mass_g)[0];
    const foot = done.find((p) => strategyOf(p)?.key === 'honeycomb');
    const box = el.querySelector<HTMLElement>('#st-foam');
    if (!ok || !foot || !box) return;
    const foamSaved = ok.mass_g / ok.ratio - ok.mass_g;
    const combSaved = foot.mass_g - foot.mass_opt_g!;
    if (foamSaved >= combSaved) return;
    box.hidden = false;
    box.innerHTML = `<b>Metal foam was tested and lost.</b> Aluminum skins over a foam core passed on the foot, but the lightest passing option (${esc(ok.skin_mm)} mm skin, ${esc(ok.foam_kg_m3)} kg/m³ foam) saved ${fmtMass(foamSaved)}. Honeycomb saved ${fmtMass(combSaved)}, so honeycomb stayed. Foam stiffness and strength came from Gibson-Ashby scaling, not a foam-level simulation.`;
  }).catch(() => { /* optional */ });

  // ---------- Compare ----------
  let compare: Compare | null = null;
  const cmpHost = el.querySelector<HTMLElement>('#cmp');
  if (cmpHost) {
    const first = compareParts()[0];
    const co = new IntersectionObserver((es) => es.forEach((e) => {
      if (e.isIntersecting && !compare) {
        compare = new Compare(cmpHost, (p) => {
          const s = p.mass_g - p.mass_opt_g!;
          el.querySelector('#cmp-read')!.innerHTML = `<div><span>Before</span><b class="num">${fmtMass(p.mass_g)}</b></div><div><span>After</span><b class="num">${fmtMass(p.mass_opt_g!)}</b></div><div><span>Saved</span><b class="num">${fmtMass(s)}</b></div><div><span>Status</span><b><span class="badge ${esc(p.status)}">${esc(p.status.toUpperCase())}</span></b></div>`;
          el.querySelector('#cmp-changes')!.innerHTML = changesHtml(p);
          el.querySelector('#cmp-review')!.innerHTML = reviewHtml(p);
          const has = compare!.hasRemoved();
          const btn = el.querySelector<HTMLElement>('#cmp-ch')!;
          btn.hidden = !has;
          if (has) btn.click();
          else if (btn.classList.contains('on')) el.querySelector<HTMLElement>('#cmp-color [data-v=plain]')!.click();
        });
        void compare.load(first);
      }
      compare?.setActive(e.isIntersecting);
    }), { root: el, threshold: 0.05 });
    co.observe(cmpHost);
    pick(el.querySelector('#cmp-pick'), (b) => { const p = parts.find((x) => x.id === b.dataset.id); if (p) void compare?.load(p); });
    el.querySelector<HTMLInputElement>('#cmp-range')!.addEventListener('input', (e) => compare?.setSplit(Number((e.target as HTMLInputElement).value) / 100));
    pick(el.querySelector('#cmp-color'), (b) => compare?.setMode(b.dataset.v as Mode));
    pick(el.querySelector('#cmp-cut'), (b) => compare?.setCut(b.dataset.v === 'on'));
  }

  // ---------- Mug ----------
  const mugHost = el.querySelector<HTMLElement>('#mug-cmp');
  if (mugHost && ctx.mug) {
    const mug = ctx.mug;
    const url = (p: string) => `${import.meta.env.BASE_URL}${p}`;
    let mc: Compare | null = null;
    const mo = new IntersectionObserver((es) => es.forEach((e) => {
      if (e.isIntersecting && !mc) {
        mc = new Compare(mugHost, () => { /* no part readout */ }, true);
        mc.setCut(true);
        void mc.loadPair(url(mug.before), url(mug.after)).catch((err) => { console.error(err); mugHost.remove(); });
      }
      mc?.setActive(e.isIntersecting);
    }), { root: el, threshold: 0.05 });
    mo.observe(mugHost);
    el.querySelector<HTMLInputElement>('#mug-range')!.addEventListener('input', (e) => mc?.setSplit(Number((e.target as HTMLInputElement).value) / 100));
    pick(el.querySelector('#mug-cut'), (b) => mc?.setCut(b.dataset.v === 'on'));
  }

  // ---------- Wiring ----------
  el.querySelector('#st-close')!.addEventListener('click', () => ctx.onClose());
  el.querySelector('#st-explore')?.addEventListener('click', () => {
    viewer.setPaused(false);
    inHero = true; // forces a recheck on return
    ctx.onExplore();
  });
  bar.querySelector('#xp-back')!.addEventListener('click', () => ctx.onLeaveExplore());

  function show() {
    el.hidden = false;
    el.scrollTop = 0;
    phase = -1;
    inHero = false;
    viewer.setPaused(false);
    ctx.preloadOpt();
    viewer.setColorMode('neutral');
    viewer.setExplode(0);
    onScroll();
    el.focus({ preventScroll: true });
  }
  function resume() { phase = -1; onScroll(); el.focus({ preventScroll: true }); }
  function hide() { el.hidden = true; viewer.setChanges(false); compare?.setActive(false); viewer.setPaused(false); viewer.setPalette(null); }
  function goto(id: string) {
    const t = el.querySelector<HTMLElement>(`#${id}`);
    if (t) el.scrollTo({ top: t.offsetTop, behavior: 'instant' });
  }
  return { show, hide, resume, goto, palette };
}

/** One renderer, two scissored halves: orbit stays in sync because there is one camera. */
class Compare {
  private r: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private cam = new THREE.PerspectiveCamera(26, 1, 0.01, 20);
  private ctl: OrbitControls;
  private before = new THREE.Group();
  private after = new THREE.Group();
  private loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
  private split = 0.5;
  private mode: Mode = 'plain';
  private ghost = new THREE.Group();
  private matG = new THREE.MeshStandardMaterial({ color: 0xff3b00, emissive: 0xff3b00, emissiveIntensity: 0.7, roughness: 0.5, transparent: true, opacity: 0.5, depthWrite: false, side: THREE.DoubleSide });
  private cut = false;
  private matCap = new THREE.MeshBasicMaterial({ color: 0xff3d6e, side: THREE.BackSide });
  private plane = new THREE.Plane(new THREE.Vector3(0, 0, -1), 0);
  private matB = new THREE.MeshStandardMaterial({ color: 0xc8cbe6, metalness: 0.2, roughness: 0.48, side: THREE.DoubleSide });
  private matA = new THREE.MeshStandardMaterial({ color: 0xffffff, metalness: 0.15, roughness: 0.5, side: THREE.DoubleSide });
  private active = false;
  private token = 0;
  private line: HTMLElement;
  private canvas: HTMLCanvasElement;

  /** zUp: mesh files stay in Z-up metres; section mode paints the cut wall solid. */
  constructor(host: HTMLElement, private onPart: (p: Part) => void, private section = false) {
    this.canvas = host.querySelector('canvas')!;
    this.line = host.querySelector('.cmp-line')!;
    this.r = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: true });
    this.r.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.r.toneMapping = THREE.ACESFilmicToneMapping;
    this.r.setClearColor(0x15123a);
    this.r.localClippingEnabled = true;
    this.r.setScissorTest(true);
    const pm = new THREE.PMREMGenerator(this.r);
    this.scene.environment = pm.fromScene(new RoomEnvironment(), 0.05).texture;
    this.scene.environmentIntensity = 0.5;
    const key = new THREE.DirectionalLight(0xffffff, 2.2);
    key.position.set(2, 3, 2);
    const rim = new THREE.DirectionalLight(0xcfe0ff, 1.5);
    rim.position.set(-3, 1, -2);
    this.cam.add(key);
    this.after.add(this.ghost);
    this.scene.add(this.cam, rim, this.before, this.after);
    if (section) this.cam.up.set(0, 0, 1);
    this.ctl = new OrbitControls(this.cam, this.canvas);
    this.ctl.enableZoom = false;
    this.ctl.enablePan = false;
    this.ctl.enableDamping = true;
    this.canvas.style.touchAction = 'pan-y'; // vertical swipes keep scrolling the page
    addEventListener('resize', () => this.size());
    this.size();
  }

  private size() {
    const w = this.canvas.clientWidth, h = this.canvas.clientHeight;
    if (!w || !h) return;
    this.r.setSize(w, h, false);
    this.cam.aspect = w / h;
    this.cam.updateProjectionMatrix();
  }

  /** Two plain models. Back faces, seen only through the cut, read as a solid section of the wall. */
  async loadPair(beforeUrl: string, afterUrl: string) {
    const [a, b] = await Promise.all([this.loader.loadAsync(beforeUrl), this.loader.loadAsync(afterUrl)]);
    this.matA.side = this.matB.side = THREE.FrontSide;
    this.matA.color.set(0xe9ebf7);
    this.plainColor = new THREE.Color(0xe9ebf7);
    this.matB.color.set(0xe9ebf7);
    const dress = (scene: THREE.Object3D, mat: THREE.Material, group: THREE.Group) => {
      const meshes: THREE.Mesh[] = [];
      scene.traverse((o) => { if ((o as THREE.Mesh).isMesh) meshes.push(o as THREE.Mesh); });
      for (const m of meshes) { // collected first: adding children mid-traverse would recurse forever
        m.geometry = toCreasedNormals(m.geometry, 0.6);
        m.material = mat;
        m.add(new THREE.Mesh(m.geometry, this.matCap));
      }
      group.add(scene);
    };
    this.before.clear();
    this.after.clear();
    dress(a.scene, this.matB, this.before);
    dress(b.scene, this.matA, this.after);
    this.after.add(this.ghost);
    const box = new THREE.Box3().setFromObject(this.before);
    const c = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    this.plane.setFromNormalAndCoplanarPoint(new THREE.Vector3(0, -1, 0), new THREE.Vector3(0, 0, 0));
    this.ctl.target.copy(c);
    const dist = ((size.length() / 2) * 0.82) / Math.tan(THREE.MathUtils.degToRad(13)) / Math.min(1, this.cam.aspect);
    this.cam.position.set(c.x - dist * 0.04, c.y + dist, c.z + dist * 0.1);
    this.apply();
  }

  async load(p: Part) {
    const mine = ++this.token;
    const [a, b, g] = await Promise.all([
      this.loader.loadAsync(dataUrl(p.mesh)), this.loader.loadAsync(dataUrl(p.mesh_opt!)),
      this.loader.loadAsync(dataUrl(`parts/${p.id}_removed.glb`)).catch(() => null), // optional
    ]);
    if (mine !== this.token) return;
    this.before.clear();
    this.after.clear();
    this.ghost.clear();
    this.before.add(a.scene);
    this.after.add(b.scene, this.ghost);
    if (g) {
      g.scene.traverse((o) => { if ((o as THREE.Mesh).isMesh) { (o as THREE.Mesh).material = this.matG; o.renderOrder = 3; } });
      this.ghost.add(g.scene);
    }
    a.scene.traverse((o) => { if ((o as THREE.Mesh).isMesh) (o as THREE.Mesh).material = this.matB; });
    b.scene.traverse((o) => { if ((o as THREE.Mesh).isMesh) (o as THREE.Mesh).material = this.matA; });
    const color = new THREE.Color(strategyOf(p)?.color ?? '#00e58a');
    this.plainColor = color;
    const box = new THREE.Box3().setFromObject(this.before);
    const c = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    const r = size.length() / 2;
    // Cut across the thinnest axis: that is where through-thickness cells show.
    const axis = size.x <= size.y && size.x <= size.z ? 0 : size.y <= size.z ? 1 : 2;
    const n = new THREE.Vector3().setComponent(axis, -1);
    this.plane.setFromNormalAndCoplanarPoint(n, c);
    this.ctl.target.copy(c);
    const dist = (r * 1.25) / Math.tan(THREE.MathUtils.degToRad(13)) / Math.min(1, this.cam.aspect);
    this.cam.position.copy(c).add(n.clone().multiplyScalar(-dist * 0.82)).add(new THREE.Vector3(0.45, 0.25, 0.3).multiplyScalar(dist * 0.6));
    this.apply();
    this.onPart(p);
  }

  private plainColor = new THREE.Color('#00e58a');
  private apply() {
    const planes = this.cut ? [this.plane] : [];
    this.matA.clippingPlanes = planes;
    this.matCap.clippingPlanes = planes;
    this.matB.clippingPlanes = planes;
    const stress = this.mode === 'stress';
    this.ghost.visible = this.mode === 'changes';
    this.matA.vertexColors = stress;
    this.matA.color.copy(stress ? new THREE.Color(0xffffff) : this.mode === 'changes' ? new THREE.Color(0xd9dbe8) : this.plainColor);
    this.matA.needsUpdate = true;
  }

  setMode(v: Mode) { this.mode = v; this.apply(); }
  hasRemoved() { return this.ghost.children.length > 0; }
  setCut(v: boolean) { this.cut = v; this.apply(); }
  setSplit(v: number) { this.split = v; }
  setActive(v: boolean) {
    if (v === this.active) return;
    this.active = v;
    if (v) { this.size(); this.loop(); }
  }

  private loop = () => {
    if (!this.active) return;
    requestAnimationFrame(this.loop);
    this.ctl.update();
    const w = this.canvas.clientWidth, h = this.canvas.clientHeight;
    const x = Math.round(w * this.split);
    this.line.style.left = `${x}px`;
    this.r.setViewport(0, 0, w, h);
    this.before.visible = true; this.after.visible = false;
    this.r.setScissor(0, 0, x, h);
    this.r.render(this.scene, this.cam);
    this.before.visible = false; this.after.visible = true;
    this.r.setScissor(x, 0, w - x, h);
    this.r.render(this.scene, this.cam);
  };
}
