// Maps upstream objects to table rows. Upstream sends every value as a
// string; typed columns get parsed values, `raw` keeps the original.

function text(value) {
  if (value === undefined || value === null) return null;
  const s = String(value).trim();
  return s === '' ? null : s;
}

export function toNumber(value) {
  const s = text(value);
  if (s === null) return null;
  const n = Number(s.replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}

export function toDate(value) {
  const s = text(value);
  if (s === null) return null;
  const time = Date.parse(s);
  return Number.isNaN(time) ? null : new Date(time).toISOString().slice(0, 10);
}

export function normalizeBall(raw) {
  const ball_id = text(raw?.ball_id);
  const core_weight = text(raw?.core_weight);
  const ball_name = text(raw?.ball_name);
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

export function normalizeBrand(raw) {
  const id = text(raw?.id);
  const name = text(raw?.brand_name);
  return id && name ? { id, name, brand: null, raw } : null;
}

export function normalizeCore(raw) {
  const id = text(raw?.id);
  const name = text(raw?.core_name);
  return id && name ? { id, name, brand: text(raw.brand), raw } : null;
}

export function normalizeCoverstock(raw) {
  const id = text(raw?.id);
  const name = text(raw?.coverstock_name);
  return id && name ? { id, name, brand: text(raw.brand), raw } : null;
}

export const ballKey = (row) => `${row.ball_id}|${row.core_weight}`;
