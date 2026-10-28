#!/usr/bin/env node
// Checks content.json against everything the app accepts. The app (azzaituna-mobile,
// src/content/remote/{contentClient,mapRows}.ts and packages/contracts) silently drops a row
// that fails its schema, and rejects the WHOLE update (keeping its old cached copy) when a row
// makes the mapping code throw: a null row, a missing published_at/expires_at/starts_at key,
// weekly_days that is not a list, a non-string date. This validator fails on all of those, and
// adds a few stricter rules of its own (strict dates, text limits, image host, safe ids).
//
// Usage: node .github/scripts/validate-content.mjs [path/to/content.json]
// Exits 1 and prints every problem found when the file is invalid.

import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const LANGS = ['ar', 'it', 'en'];
export const TEXT_FIELDS = LANGS.flatMap((l) => [`title_${l}`, `body_${l}`]);
export const TABLES = ['lessons', 'announcements', 'adhkar', 'iqamahRules', 'jumuahSessions'];

/** The mosque the app is built for (EXPO_PUBLIC_MOSQUE_ID); rows for any other are dropped. */
export const MOSQUE_ID = 'azzaituna';
export const ID_PATTERN = /^[a-z0-9-]{1,64}$/;
export const MAX_FILE_BYTES = 1024 * 1024;
export const TITLE_MAX = 120;
export const BODY_MAX = 2000;
export const IMAGE_URL_PREFIX = 'https://raw.githubusercontent.com/AnasOsman1/azzaituna-content/';
export const IMAGE_MAX_SIDE = 8000;
export const IMAGE_MAX_ASPECT = 4;

const PRIORITIES = ['normal', 'urgent'];
const PRAYERS = ['fajr', 'dhuhr', 'asr', 'maghrib', 'isha'];
const IQAMAH_PRAYERS = ['default', ...PRAYERS];
const COLLECTIONS = ['morning', 'evening', 'general'];
const RULE_TYPES = ['fixed', 'offset'];

const ZERO_WIDTH = /[\u200B-\u200F\u2060\uFEFF]/g;
const BIDI_CONTROL = /[\u202A-\u202E\u2066-\u2069]/;
// Same patterns as packages/contracts/src/prayer.ts.
const WALL_CLOCK = /^([01]\d|2[0-3]):[0-5]\d$/;
const MONTH_DAY = /^(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;
const STRICT_DATE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{3}))?(?:Z|([+-])(\d{2}):(\d{2}))$/;

// ---------------------------------------------------------------- log safety

const LOG_ESCAPE = /[\u007F-\u009F\u00AD\u061C\u200B-\u200F\u2028-\u202E\u2060-\u206F\uFEFF]/g;

/**
 * A value made safe to print in a GitHub Actions log: cut to `max` code points, then
 * JSON-encoded (newlines, quotes and control characters escaped) with invisible and
 * direction-changing characters escaped too. It can never start or contain a new line,
 * so it can never start a workflow command (::error::, ::add-mask::, ...).
 */
export function logSafe(value, max = 60) {
  if (value === undefined) return 'undefined';
  let s = typeof value === 'string' ? value : JSON.stringify(value) ?? String(value);
  const chars = Array.from(s);
  if (chars.length > max) s = `${chars.slice(0, max).join('')}…`;
  return escapeInvisible(JSON.stringify(s));
}

/** Rewrites invisible, line-separating and direction-changing characters as \uXXXX escapes. */
export function escapeInvisible(s) {
  return String(s).replace(LOG_ESCAPE, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

/** Escapes the message part of a workflow command line (GitHub's own escaping rules). */
export function escapeCommandData(s) {
  return String(s).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
}

/** Escapes a property value (e.g. file=...) of a workflow command line. */
export function escapeCommandProperty(s) {
  return escapeCommandData(s).replace(/:/g, '%3A').replace(/,/g, '%2C');
}

// ---------------------------------------------------------------- primitives

const isRecord = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const codePoints = (s) => Array.from(s).length;
/** Text with the zero-width characters removed and the ends trimmed. */
export const visibleText = (s) => s.replace(ZERO_WIDTH, '').trim();

function daysInMonth(y, m) {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/**
 * Milliseconds for a strict `YYYY-MM-DDTHH:mm:ss(.sss)?(Z|±hh:mm)` string with a real calendar
 * date, year 2000-2100 and an offset of at most ±14:00; NaN for anything else. Every string
 * accepted here parses to the same instant in V8 (the Action runner) and Hermes (the app).
 */
export function parseStrictDate(v) {
  if (typeof v !== 'string') return Number.NaN;
  const m = STRICT_DATE.exec(v);
  if (!m) return Number.NaN;
  const [y, mo, d, h, mi, s] = m.slice(1, 7).map(Number);
  if (y < 2000 || y > 2100 || mo < 1 || mo > 12 || d < 1 || d > daysInMonth(y, mo)) return Number.NaN;
  if (h > 23 || mi > 59 || s > 59) return Number.NaN;
  let offsetMin = 0;
  if (m[8] !== undefined) {
    const oh = Number(m[9]);
    const om = Number(m[10]);
    if (om > 59 || oh * 60 + om > 14 * 60) return Number.NaN;
    offsetMin = (oh * 60 + om) * (m[8] === '-' ? -1 : 1);
  }
  return Date.UTC(y, mo - 1, d, h, mi, s, m[7] ? Number(m[7]) : 0) - offsetMin * 60_000;
}

const isStrictDate = (v) => !Number.isNaN(parseStrictDate(v));

function isCalendarDay(v) {
  const m = typeof v === 'string' ? DAY.exec(v) : null;
  if (!m) return false;
  const [y, mo, d] = m.slice(1).map(Number);
  return y >= 2000 && y <= 2100 && mo >= 1 && mo <= 12 && d >= 1 && d <= daysInMonth(y, mo);
}

/** Why `v` is not an acceptable image_url, or null when it is. */
export function imageUrlProblem(v) {
  if (typeof v !== 'string' || v === '') return 'must be null or a link';
  if (/[\s\u0000-\u001F\u007F\\]/.test(v)) return 'must not contain spaces, control characters or backslashes';
  let u;
  try {
    u = new URL(v);
  } catch {
    return 'is not a valid URL';
  }
  if (u.protocol !== 'https:' || !/^https:\/\//i.test(v)) return 'must start with https://';
  const authority = v.slice('https://'.length).split('/')[0];
  if (authority.includes('@') || u.username !== '' || u.password !== '') return 'must not contain "@" (user info)';
  if (authority.includes(':') && !authority.startsWith('[')) return 'must not contain a port';
  if (u.port !== '') return 'must not contain a port';
  if (v.includes('?') || v.includes('#')) return 'must not have a query (?) or fragment (#)';
  if (u.hostname.startsWith('[') || /^\d{1,3}(\.\d{1,3}){3}$/.test(u.hostname)) return 'must not use an IP address';
  if (u.hostname !== 'raw.githubusercontent.com') return 'host must be raw.githubusercontent.com';
  if (/%(2e|2f|5c)/i.test(v)) return 'must not contain encoded dots or slashes (%2e, %2f, %5c)';
  if (u.href !== v) return 'must be written in canonical form (lowercase host, no "." or ".." segments)';
  if (!v.startsWith(IMAGE_URL_PREFIX)) return `must start with ${IMAGE_URL_PREFIX}`;
  const rest = v.slice(IMAGE_URL_PREFIX.length);
  if (rest === '' || rest.endsWith('/') || rest.includes('//')) return 'must name a file path inside the repository';
  return null;
}

// ---------------------------------------------------------------- row checks

function rowChecker(errors, where, row) {
  const err = (m) => errors.push(`${where}: ${m}`);
  const has = (k) => Object.prototype.hasOwnProperty.call(row, k) && row[k] !== undefined;
  /** Runs `check(value)` when the key is present; reports a missing key otherwise. */
  const field = (k, check) => {
    if (!has(k)) return err(`"${k}" is missing`);
    const problem = check(row[k]);
    if (problem) err(`"${k}" ${problem}`);
  };
  return {
    err,
    has,
    field,
    text(k, { max, noBidi = false } = {}) {
      field(k, (v) => {
        if (typeof v !== 'string') return 'must be a string';
        if (visibleText(v) === '') return 'must not be empty (zero-width characters do not count)';
        if (max !== undefined && codePoints(v) > max) return `is ${codePoints(v)} characters; the limit is ${max}`;
        if (noBidi && BIDI_CONTROL.test(v)) return 'contains a bidirectional control character (U+202A-U+202E, U+2066-U+2069)';
        return null;
      });
    },
    date(k, { nullable = false } = {}) {
      field(k, (v) => {
        if (nullable && v === null) return null;
        return isStrictDate(v)
          ? null
          : `must be ${nullable ? 'null or ' : ''}a date-time like 2026-10-27T18:00:00Z or 2026-10-27T19:00:00+01:00 (got ${logSafe(v)})`;
      });
    },
    oneOf(k, values, { nullable = false } = {}) {
      field(k, (v) =>
        (nullable && v === null) || values.includes(v)
          ? null
          : `must be ${nullable ? 'null or ' : ''}one of ${values.join(', ')} (got ${logSafe(v)})`,
      );
    },
    int(k, min, max, { nullable = false } = {}) {
      field(k, (v) =>
        (nullable && v === null) || (Number.isInteger(v) && v >= min && v <= max)
          ? null
          : `must be ${nullable ? 'null or ' : ''}an integer ${min}-${max} (got ${logSafe(v)})`,
      );
    },
    pattern(k, re, what, { nullable = false } = {}) {
      field(k, (v) =>
        (nullable && v === null) || (typeof v === 'string' && re.test(v))
          ? null
          : `must be ${nullable ? 'null or ' : ''}${what} (got ${logSafe(v)})`,
      );
    },
  };
}

const SORT_LIMIT = 1_000_000;

function checkLesson(c, row) {
  for (const base of ['topic', 'teacher', 'location']) for (const l of LANGS) c.text(`${base}_${l}`);
  c.date('starts_at', { nullable: true });
  c.field('weekly_days', (v) => {
    if (v === null) return null;
    const okList = Array.isArray(v) && v.length >= 1 && v.length <= 7 && v.every((d) => Number.isInteger(d) && d >= 0 && d <= 6);
    return okList ? null : `must be null or a list of 1-7 weekdays 0-6 (0 = Sunday) (got ${logSafe(v)})`;
  });
  c.oneOf('after_prayer', PRAYERS, { nullable: true });
  c.int('sort', -SORT_LIMIT, SORT_LIMIT);
  if (c.has('weekly_days') && c.has('after_prayer') && (row.weekly_days === null) !== (row.after_prayer === null)) {
    c.err('"weekly_days" and "after_prayer" must both be set or both be null');
  }
  if (row.starts_at === null && (row.weekly_days === null || row.after_prayer === null)) {
    c.err('needs "starts_at" or a weekly schedule ("weekly_days" and "after_prayer")');
  }
}

function checkAnnouncement(c, row) {
  c.oneOf('priority', PRIORITIES);
  for (const l of LANGS) c.text(`title_${l}`, { max: TITLE_MAX, noBidi: true });
  for (const l of LANGS) c.text(`body_${l}`, { max: BODY_MAX, noBidi: true });
  c.date('starts_at');
  c.date('published_at');
  c.date('expires_at', { nullable: true });
  const starts = parseStrictDate(row.starts_at);
  const expires = parseStrictDate(row.expires_at);
  if (!Number.isNaN(starts) && !Number.isNaN(expires) && expires <= starts) {
    c.err('"expires_at" must be after "starts_at"');
  }

  const hasUrl = c.has('image_url') && row.image_url !== null;
  if (hasUrl) {
    const problem = imageUrlProblem(row.image_url);
    if (problem) c.err(`"image_url" ${problem} (got ${logSafe(row.image_url, 120)})`);
    c.int('image_width', 1, IMAGE_MAX_SIDE);
    c.int('image_height', 1, IMAGE_MAX_SIDE);
    const w = row.image_width;
    const h = row.image_height;
    if (Number.isInteger(w) && Number.isInteger(h) && w > 0 && h > 0 && (w / h > IMAGE_MAX_ASPECT || h / w > IMAGE_MAX_ASPECT)) {
      c.err(`image aspect ratio ${w}x${h} is outside 1:${IMAGE_MAX_ASPECT} to ${IMAGE_MAX_ASPECT}:1`);
    }
  } else if ((c.has('image_width') && row.image_width !== null) || (c.has('image_height') && row.image_height !== null)) {
    c.err('image_width/image_height are set but image_url is missing');
  }
}

function checkZikr(c) {
  c.oneOf('collection', COLLECTIONS);
  c.text('arabic');
  for (const l of LANGS) c.text(`translation_${l}`);
  c.text('source');
  c.int('repetitions', 1, 100_000);
  c.int('sort', -SORT_LIMIT, SORT_LIMIT);
}

/** The slot an iqamah rule fills (mapRows.ts placementOf), or null after reporting why it fits none. */
function checkIqamahRule(c, row) {
  c.oneOf('prayer', IQAMAH_PRAYERS);
  c.oneOf('rule_type', RULE_TYPES);
  const offset = row.rule_type === 'offset';
  const fixed = row.rule_type === 'fixed';
  c.int('minutes', 0, 180, { nullable: !offset });
  c.int('round', 1, 60, { nullable: true });
  c.pattern('not_before', WALL_CLOCK, 'a time HH:MM', { nullable: true });
  c.pattern('not_after', WALL_CLOCK, 'a time HH:MM', { nullable: true });
  c.pattern('fixed_time', WALL_CLOCK, 'a time HH:MM', { nullable: !fixed });
  c.pattern('season_from', MONTH_DAY, 'a month-day MM-DD', { nullable: true });
  c.pattern('season_to', MONTH_DAY, 'a month-day MM-DD', { nullable: true });
  c.field('on_date', (v) => (v === null || isCalendarDay(v) ? null : `must be null or a day YYYY-MM-DD (got ${logSafe(v)})`));

  const from = row.season_from ?? null;
  const to = row.season_to ?? null;
  const date = row.on_date ?? null;
  if ((from === null) !== (to === null)) {
    c.err('season_from and season_to must both be set or both be null');
    return null;
  }
  if (from !== null && date !== null) {
    c.err('a rule cannot have both a season and a date');
    return null;
  }
  if ((from !== null || date !== null) && row.prayer === 'default') {
    c.err('prayer "default" cannot have a season or a date; name the prayer');
    return null;
  }
  if (from !== null) return `season|${from}|${to}|${row.prayer}`;
  if (date !== null) return `date|${date}|${row.prayer}`;
  return `base|${row.prayer}`;
}

function checkJumuah(c) {
  c.pattern('khutbah', WALL_CLOCK, 'a time HH:MM');
  c.pattern('iqamah', WALL_CLOCK, 'a time HH:MM');
  c.int('sort', -SORT_LIMIT, SORT_LIMIT);
}

const CHECKS = {
  lessons: checkLesson,
  announcements: checkAnnouncement,
  adhkar: checkZikr,
  iqamahRules: checkIqamahRule,
  jumuahSessions: checkJumuah,
};

/** Reports numbers that are NaN or infinite anywhere in the tree (JSON's 1e400 parses as Infinity). */
function checkFinite(value, path, errors, budget = { left: 20 }) {
  if (budget.left <= 0) return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      budget.left -= 1;
      errors.push(`${path}: numbers must be finite (got ${String(value)})`);
    }
  } else if (Array.isArray(value)) {
    value.forEach((v, i) => checkFinite(v, `${path}[${i}]`, errors, budget));
  } else if (isRecord(value)) {
    for (const [k, v] of Object.entries(value)) checkFinite(v, `${path}.${logSafe(k, 40)}`, errors, budget);
  }
}

// ---------------------------------------------------------------- entry points

/** Parses content.json text; throws an Error with a readable message on failure. */
export function parseContent(text, label = 'content.json') {
  let data;
  try {
    data = JSON.parse(text);
  } catch (err) {
    throw new Error(`${label} is not valid JSON: ${logSafe(err.message, 200)}`);
  }
  if (!isRecord(data)) {
    throw new Error(`${label} must contain a JSON object at the top level`);
  }
  return data;
}

/** Returns a list of human-readable, log-safe problems (empty when the content is valid). */
export function validateContent(data) {
  if (!isRecord(data)) return ['content.json must contain a JSON object at the top level'];
  const errors = [];
  for (const table of TABLES) {
    if (!Array.isArray(data[table])) errors.push(`"${table}" must be an array`);
  }
  checkFinite(data, 'content', errors);

  for (const table of TABLES) {
    const rows = data[table];
    if (!Array.isArray(rows)) continue;
    const seen = new Map();
    const slots = new Map();
    rows.forEach((row, i) => {
      const id = isRecord(row) ? row.id : undefined;
      const where = `${table}[${i}]${typeof id === 'string' ? ` (id ${logSafe(id)})` : ''}`;
      if (!isRecord(row)) {
        errors.push(`${where}: must be an object (got ${row === null ? 'null' : Array.isArray(row) ? 'a list' : typeof row})`);
        return;
      }
      const c = rowChecker(errors, where, row);
      c.field('id', (v) => (typeof v === 'string' && ID_PATTERN.test(v) ? null : 'must match ^[a-z0-9-]{1,64}$ (lowercase letters, digits, "-")'));
      if (typeof id === 'string') {
        if (seen.has(id)) c.err(`duplicate id (also ${table}[${seen.get(id)}])`);
        else seen.set(id, i);
      }
      c.field('mosque_id', (v) => (v === MOSQUE_ID ? null : `must be "${MOSQUE_ID}" (got ${logSafe(v)})`));
      c.date('updated_at');
      const slot = CHECKS[table](c, row);
      if (table === 'iqamahRules' && slot) {
        if (slots.has(slot)) c.err(`fills the same slot as iqamahRules[${slots.get(slot)}] (same prayer, season or date); the app keeps only one`);
        else slots.set(slot, i);
      }
    });
  }

  const empty = (t) => Array.isArray(data[t]) && data[t].length === 0;
  if (empty('lessons') && empty('announcements') && empty('adhkar')) {
    errors.push('lessons, announcements and adhkar cannot all be empty (the app treats that as a failed download)');
  }
  return errors;
}

/** Size check + parse + validate, for the raw file text. Never throws. */
export function validateText(text, label = 'content.json') {
  const errors = [];
  const bytes = Buffer.byteLength(text, 'utf8');
  if (bytes > MAX_FILE_BYTES) errors.push(`${label} is ${bytes} bytes, larger than the ${MAX_FILE_BYTES}-byte (1 MB) limit`);
  let data;
  try {
    data = parseContent(text, label);
  } catch (err) {
    return [...errors, err.message];
  }
  return [...errors, ...validateContent(data)];
}

const MAX_PRINTED = 200;

function main() {
  const path = process.argv[2] ?? 'content.json';
  const fileProp = escapeCommandProperty(path);
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch (err) {
    console.error(`::error::${escapeCommandData(`cannot read ${path}: ${err.message}`)}`);
    process.exit(1);
  }
  const errors = validateText(text, path);
  if (errors.length) {
    for (const e of errors.slice(0, MAX_PRINTED)) console.error(`::error file=${fileProp}::${escapeCommandData(e)}`);
    if (errors.length > MAX_PRINTED) console.error(`... and ${errors.length - MAX_PRINTED} more`);
    console.error(`${path}: ${errors.length} problem(s) found`);
    process.exit(1);
  }
  console.log(`${path}: OK`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
