// Maps upstream objects to table rows. Upstream sends every value as a
// string; typed columns get parsed values, `raw` keeps the original.

/** An object as bowwwl.com sends it: string values, unknown shape. */
export type UpstreamRecord = Record<string, unknown>;

export interface BallRow {
  ball_id: string;
  core_weight: string;
  weight: number | null;
  ball_name: string;
  brand_id: string | null;
  brand_name: string | null;
  core_id: string | null;
  core_name: string | null;
  core_type: string | null;
  core_rg: number | null;
  core_diff: number | null;
  core_int_diff: number | null;
  coverstock_id: string | null;
  coverstock_name: string | null;
  coverstock_type: string | null;
  factory_finish: string | null;
  availability: string | null;
  us_int: string | null;
  release_date: string | null;
  raw: UpstreamRecord;
}

export interface ReferenceRow {
  id: string;
  name: string;
  brand: string | null;
  raw: UpstreamRecord;
}

function asRecord(value: unknown): UpstreamRecord | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as UpstreamRecord) : null;
}

function text(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  const s = String(value).trim();
  return s === '' ? null : s;
}

export function toNumber(value: unknown): number | null {
  const s = text(value);
  if (s === null) return null;
  const n = Number(s.replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}

export function toDate(value: unknown): string | null {
  const s = text(value);
  if (s === null) return null;
  const time = Date.parse(s);
  return Number.isNaN(time) ? null : new Date(time).toISOString().slice(0, 10);
}

export function normalizeBall(input: unknown): BallRow | null {
  const raw = asRecord(input);
  if (!raw) return null;
  const ball_id = text(raw.ball_id);
  const core_weight = text(raw.core_weight);
  const ball_name = text(raw.ball_name);
  if (!ball_id || !core_weight || !ball_name) return null;

  return {
    ball_id,
    core_weight,
    weight: toNumber(core_weight),
    ball_name,
    brand_id: text(raw.brand_id),
    brand_name: text(raw.brand_name),
    core_id: text(raw.core_id),
    core_name: text(raw.core_name),
    core_type: text(raw.core_type),
    core_rg: toNumber(raw.core_rg),
    core_diff: toNumber(raw.core_diff),
    core_int_diff: toNumber(raw.core_int_diff),
    coverstock_id: text(raw.coverstock_id),
    coverstock_name: text(raw.coverstock_name),
    coverstock_type: text(raw.coverstock_type),
    factory_finish: text(raw.factory_finish),
    availability: text(raw.availability),
    us_int: text(raw.us_int),
    release_date: toDate(raw.release_date),
    raw,
  };
}

export function normalizeBrand(input: unknown): ReferenceRow | null {
  const raw = asRecord(input);
  if (!raw) return null;
  const id = text(raw.id);
  const name = text(raw.brand_name);
  return id && name ? { id, name, brand: null, raw } : null;
}

export function normalizeCore(input: unknown): ReferenceRow | null {
  const raw = asRecord(input);
  if (!raw) return null;
  const id = text(raw.id);
  const name = text(raw.core_name);
  return id && name ? { id, name, brand: text(raw.brand), raw } : null;
}

export function normalizeCoverstock(input: unknown): ReferenceRow | null {
  const raw = asRecord(input);
  if (!raw) return null;
  const id = text(raw.id);
  const name = text(raw.coverstock_name);
  return id && name ? { id, name, brand: text(raw.brand), raw } : null;
}

export const ballKey = (row: { ball_id: string; core_weight: string }): string => `${row.ball_id}|${row.core_weight}`;
