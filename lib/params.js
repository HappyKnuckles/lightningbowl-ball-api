// Query-string parsing and validation. Pure functions; every value that ends
// up in SQL goes through here and then into a bind parameter.

export class BadRequestError extends Error {
  constructor(message) {
    super(message);
    this.name = 'BadRequestError';
  }
}

const MAX_PARAM_LENGTH = 200;
const MAX_LIST_ITEMS = 100;

export const DEFAULT_PAGE_SIZE = 20;
export const MAX_PAGE_SIZE = 100;

const isMissing = (value) => value === undefined || value === null || value === '';

function checkLength(name, value) {
  if (String(value).length > MAX_PARAM_LENGTH) {
    throw new BadRequestError(`Parameter "${name}" is too long (max ${MAX_PARAM_LENGTH} characters)`);
  }
}

/** Last value of a possibly repeated parameter. */
function single(name, value) {
  const result = Array.isArray(value) ? value[value.length - 1] : value;
  if (!isMissing(result)) checkLength(name, result);
  return result;
}

export function parseString(name, value) {
  const raw = single(name, value);
  if (isMissing(raw)) return undefined;
  return String(raw).trim() || undefined;
}

export function parseRequired(name, value) {
  const result = parseString(name, value);
  if (result === undefined) throw new BadRequestError(`Parameter "${name}" is required`);
  return result;
}

/** Repeated parameter (`?brand=a&brand=b`) as a list of non-empty strings. */
export function parseList(name, value) {
  if (isMissing(value)) return [];
  const values = (Array.isArray(value) ? value : [value]).map((v) => String(v).trim()).filter(Boolean);
  if (values.length > MAX_LIST_ITEMS) {
    throw new BadRequestError(`Parameter "${name}" accepts at most ${MAX_LIST_ITEMS} values`);
  }
  values.forEach((v) => checkLength(name, v));
  return values;
}

export function parseNumber(name, value, { min = -Infinity, max = Infinity } = {}) {
  const raw = single(name, value);
  if (isMissing(raw)) return undefined;
  const num = Number(raw);
  if (!Number.isFinite(num)) throw new BadRequestError(`Parameter "${name}" must be a number`);
  if (num < min || num > max) throw new BadRequestError(`Parameter "${name}" must be between ${min} and ${max}`);
  return num;
}

export function parseInteger(name, value, range) {
  const num = parseNumber(name, value, range);
  if (num !== undefined && !Number.isInteger(num)) throw new BadRequestError(`Parameter "${name}" must be an integer`);
  return num;
}

export function parseBoolean(name, value) {
  const raw = parseString(name, value)?.toLowerCase();
  if (raw === undefined) return undefined;
  if (raw === 'true' || raw === '1') return true;
  if (raw === 'false' || raw === '0') return false;
  throw new BadRequestError(`Parameter "${name}" must be true or false`);
}

/** Case-insensitive match against fixed values; returns the canonical spelling. */
export function parseEnum(name, value, allowed) {
  const raw = parseString(name, value);
  if (raw === undefined) return undefined;
  const match = allowed.find((a) => a.toLowerCase() === raw.toLowerCase());
  if (!match) throw new BadRequestError(`Parameter "${name}" must be one of: ${allowed.join(', ')}`);
  return match;
}

/** `YYYY-MM-DD` date, returned as that string. */
export function parseDate(name, value) {
  const raw = parseString(name, value);
  if (raw === undefined) return undefined;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw) || Number.isNaN(Date.parse(raw))) {
    throw new BadRequestError(`Parameter "${name}" must be a date (YYYY-MM-DD)`);
  }
  return raw;
}

/** Spring-style paging: zero-based `page`, `size` 1–100 (default 20). */
export function parsePageable(query) {
  return {
    page: parseInteger('page', query.page, { min: 0, max: 100000 }) ?? 0,
    size: parseInteger('size', query.size, { min: 1, max: MAX_PAGE_SIZE }) ?? DEFAULT_PAGE_SIZE,
  };
}

export const wantsPaging = (query) => !isMissing(query.page) || !isMissing(query.size);

/**
 * Spring-style sort: `sort=field[,asc|desc]`, repeatable. `fields` maps each
 * public field name to the SQL expression it sorts on (a fixed whitelist, so
 * nothing user-supplied reaches the ORDER BY).
 */
export function parseSort(value, fields) {
  return parseList('sort', value).map((entry) => {
    const [field, rawDirection = 'asc'] = entry.split(',').map((s) => s.trim());
    if (!Object.hasOwn(fields, field)) {
      throw new BadRequestError(`Cannot sort by "${field}". Sortable fields: ${Object.keys(fields).join(', ')}`);
    }
    const direction = rawDirection.toLowerCase();
    if (direction !== 'asc' && direction !== 'desc') {
      throw new BadRequestError(`Sort direction for "${field}" must be asc or desc`);
    }
    return { field, direction };
  });
}

/** Page envelope modelled on Spring Data's `PagedModel` JSON. */
export function pageOf(content, { page, size }, totalElements) {
  return {
    content,
    page: { number: page, size, totalElements, totalPages: Math.ceil(totalElements / size) },
  };
}

/** Escapes LIKE wildcards so user input matches literally. */
export const escapeLike = (s) => s.replace(/[\\%_]/g, (c) => `\\${c}`);
