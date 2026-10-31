import type { Part } from './data';

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const pct = (v: unknown) => (typeof v === 'number' ? `${(v * 100).toFixed(0)}%` : '—');

/** Numbered callouts for what changed. Empty when the file has none. */
export function changesHtml(p: Part) {
  const c = p.review?.changes ?? [];
  if (!c.length) return '';
  return `<div class="block"><div class="lbl">What changed</div><ol class="changes">${c.map((x) => `<li>${esc(x)}</li>`).join('')}</ol></div>`;
}

/** Geometry sanity review. Deliberately separate from the physics checks. */
export function reviewHtml(p: Part) {
  const r = p.review;
  if (!r) return '';
  const pieces = r.pieces;
  const rows: [string, string][] = [
    ['Bolt holes preserved', r.holes != null ? String(r.holes) : '—'],
    ['Material kept around holes', pct(r.rim_kept)],
    ['Minimum wall', r.thin_fraction != null ? `${pct(r.thin_fraction)} flagged thin` : '—'],
    ['One connected piece', pieces == null ? '—' : pieces === 1 ? 'Yes' : `No, ${pieces} pieces`],
  ];
  const v = r.verdict ?? '';
  const issues = r.issues ?? [];
  return `<div class="review"><div class="review-h"><b>Does this change make sense?</b>${v ? `<span class="verdict ${esc(v)}">${esc(v.toUpperCase())}</span>` : ''}</div>
    <dl>${rows.map(([k, x]) => `<div><dt>${k}</dt><dd class="num">${esc(x)}</dd></div>`).join('')}</dl>
    ${issues.length ? `<ul class="issues">${issues.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}
    <p class="review-note">Geometry checks only, separate from physics. Not a claim that the part can be manufactured.</p></div>`;
}
