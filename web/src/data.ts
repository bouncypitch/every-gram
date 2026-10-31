// All numbers shown in the UI come from these files. Nothing here is a result.
export type Status = 'verified' | 'estimated' | 'proposed' | 'untouched';
export type Tier = 'verified' | 'estimated' | 'proposed';
export const TIERS: Tier[] = ['verified', 'estimated', 'proposed'];
export const AGENTS = ['mechanical', 'thermal', 'electrical', 'reliability', 'cost', 'power'] as const;
export type Agent = (typeof AGENTS)[number];

export interface Check { status: 'pass' | 'warn' | 'fail' | 'na'; summary: string; basis: string }
export interface Design { id: string; label: string; material?: string; mass_g: number; mesh?: string | null; status: Status }
export interface Part {
  id: string; label: string; group: string;
  mass_g: number; mass_opt_g: number | null; status: Status;
  matrix: number[]; explode: [number, number, number];
  mesh: string; mesh_opt: string | null;
  checks: Partial<Record<Agent, Check>>;
  designs?: Design[];
}
export interface RobotDoc { robot: { name: string; source: string; mass_kg: number }; parts: Part[] }

export interface MaterialRow {
  part: string; material?: string; process?: string; mass_g?: number; saved_pct?: number;
  sf?: number; stiff_vs_orig?: number; feasible?: boolean;
}
export interface ProposalItem { subsystem: string; mass_kg: number | null; proposed_kg: number | null; rationale?: string; status: Status }
export interface Proposal { baseline_kg: number; items: ProposalItem[] }

export const dataUrl = (p: string) => `${import.meta.env.BASE_URL}data/${p}`;

async function json(path: string): Promise<any | null> {
  try {
    const r = await fetch(dataUrl(path), { cache: 'no-store' });
    if (!r.ok || !(r.headers.get('content-type') ?? '').includes('json')) return null;
    return await r.json();
  } catch { return null; }
}

export const loadRobot = async (): Promise<RobotDoc | null> => {
  const d = await json('robot.json');
  return d && Array.isArray(d.parts) ? d : null;
};

/** materials.json may be a list, {rows|parts|materials:[...]}, or a map keyed by part id. */
export async function loadMaterials(): Promise<MaterialRow[] | null> {
  const d = await json('materials.json');
  if (!d) return null;
  const list = Array.isArray(d) ? d
    : Array.isArray(d.rows) ? d.rows : Array.isArray(d.parts) ? d.parts : Array.isArray(d.materials) ? d.materials
    : Object.entries(d).flatMap(([k, v]) => (Array.isArray(v) ? v : [v]).map((r: any) => ({ part: k, ...r })));
  return list.filter((r: any) => r && typeof r === 'object')
    .map((r: any) => ({ ...r, part: r.part ?? r.part_id ?? r.id ?? r.label ?? '' }));
}

export async function loadProposal(): Promise<Proposal | null> {
  const d = await json('proposal.json');
  return d && Array.isArray(d.items) && d.items.length ? d : null;
}

/** Design chosen globally, plus per-part overrides from the panel. '' means the part's own default. */
export interface Selection { global: string; perPart: Record<string, string> }
export interface Effective { mass: number | null; status: Status; mesh: string | null; designId: string; label: string | null; material: string | null }

export function effective(p: Part, sel: Selection): Effective {
  const want = sel.perPart[p.id] ?? sel.global;
  const designs = p.designs ?? [];
  const d = designs.find((x) => x.id === want) ?? (p.mass_opt_g == null ? designs[0] : undefined);
  if (d) return { mass: d.mass_g, status: d.status, mesh: d.mesh ?? null, designId: d.id, label: d.label, material: d.material ?? null };
  return { mass: p.mass_opt_g, status: p.status, mesh: p.mesh_opt, designId: '', label: null, material: null };
}

export type Totals = Record<Tier, { saved: number; parts: number }>;

/** Savings per tier. Tiers stay separate on purpose: this never returns a blended sum. */
export function totals(parts: Part[], sel: Selection): Totals {
  const t: Totals = { verified: { saved: 0, parts: 0 }, estimated: { saved: 0, parts: 0 }, proposed: { saved: 0, parts: 0 } };
  for (const p of parts) {
    const e = effective(p, sel);
    if (e.mass == null || e.status === 'untouched') continue;
    t[e.status].saved += p.mass_g - e.mass;
    t[e.status].parts++;
  }
  return t;
}

export function designOptions(parts: Part[]): { id: string; label: string }[] {
  const seen = new Map<string, string>();
  for (const p of parts) for (const d of p.designs ?? []) if (!seen.has(d.id)) seen.set(d.id, d.label);
  return [...seen].map(([id, label]) => ({ id, label }));
}

const CANON = /^(www\.)?github\.com\/hybridrobotics\/berkeley-humanoid-lite(\.git)?(\/.*)?$/i;
export const isKnownRobot = (raw: string) => CANON.test(raw.trim().replace(/^https?:\/\//i, '').replace(/[?#].*$/, ''));

export const fmtMass = (g: number) => {
  const a = Math.abs(g);
  return a >= 1000 ? `${(g / 1000).toFixed(2)} kg` : `${g.toFixed(a < 10 ? 2 : 1)} g`;
};
export const fmtUsd = (v: number) => `$${Math.round(v).toLocaleString('en-US')}`;
