// Iqamah-rule change notifications: which rows of `iqamahRules` changed in a way phones should
// hear about, and the notification text for each, in Arabic, Italian and English.
//
// Used by send-push.mjs; everything here is pure (no network, no files).
//
// Change detection is ledger-based, like announcements. For every rule row and topic the send
// ledger holds ONE key, `iqamah:<prayer>:<row id>:<value hash>|<topic>`, recording the last value
// of that row that was announced (or handled without a message). A row whose current value has no
// key is a change. The hash covers only what decides the iqamah (prayer, rule type, the time or
// the offset fields, the season or date), so editing `updated_at`, `id` order or other columns
// sends nothing. Recording a value replaces the row's previous key, so 05:45 -> 05:50 -> 05:45
// -> 05:50 notifies each step (a revert is a change too), while re-running the same job or
// pushing an unrelated commit never repeats one. Keys contain ':' which announcement ids cannot,
// so they never collide with announcement keys.
//
// Only changes that take effect soon are announced (IQAMAH_WINDOW_DAYS): a base row (always),
// an `on_date` row whose day is today or within the window, a season row that is active today or
// starts within the window. A change outside the window is recorded as handled without a message.

import { createHash } from 'node:crypto';
import { ID_PATTERN } from './validate-content.mjs';

export const IQAMAH_WINDOW_DAYS = 14;
export const MOSQUE_TIME_ZONE = 'Europe/Rome';
export const IQAMAH_KEY_PREFIX = 'iqamah:';
export const PRAYERS = ['fajr', 'dhuhr', 'asr', 'maghrib', 'isha'];
const IQAMAH_PRAYERS = ['default', ...PRAYERS];
const DAY_MS = 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------- rows and values

/** A row the planner can use: an object with a safe id and a known prayer. */
export const usableRule = (r) =>
  r !== null && typeof r === 'object' && typeof r.id === 'string' && ID_PATTERN.test(r.id) && IQAMAH_PRAYERS.includes(r.prayer);

export const ruleRows = (content) => (Array.isArray(content?.iqamahRules) ? content.iqamahRules : []).filter(usableRule);

const orNull = (v) => (v === undefined ? null : v);

/** The fields that decide the iqamah, in a fixed order (columns the rule type ignores are left out). */
export function effectiveValue(r) {
  const v = { prayer: orNull(r.prayer), rule_type: orNull(r.rule_type) };
  if (r.rule_type === 'fixed') {
    v.fixed_time = orNull(r.fixed_time);
  } else {
    v.minutes = orNull(r.minutes);
    v.round = orNull(r.round);
    v.not_before = orNull(r.not_before);
    v.not_after = orNull(r.not_after);
    if (r.rule_type !== 'offset') v.fixed_time = orNull(r.fixed_time);
  }
  v.season_from = orNull(r.season_from);
  v.season_to = orNull(r.season_to);
  v.on_date = orNull(r.on_date);
  return v;
}

/** 16 hex characters of SHA-256 over the effective value. */
export const valueHash = (r) => createHash('sha256').update(JSON.stringify(effectiveValue(r))).digest('hex').slice(0, 16);

const rowPrefix = (r) => `${IQAMAH_KEY_PREFIX}${r.prayer}:${r.id}:`;
export const iqamahKey = (r, hash, topic) => `${rowPrefix(r)}${hash}|${topic}`;
export const hasIqamahEntries = (ledger) => [...ledger].some((k) => k.startsWith(IQAMAH_KEY_PREFIX));

/**
 * Records `hash` as the handled value of row `r` for each topic: drops the row's older keys for
 * that topic and (re)adds this one with no time, so the ledger writer stamps it now (an unchanged
 * row is refreshed on every live run and never ages out of the 180-day ledger).
 */
export function recordRule(ledger, times, r, hash, topics) {
  const prefix = rowPrefix(r);
  for (const topic of topics) {
    const keep = iqamahKey(r, hash, topic);
    for (const k of [...ledger]) {
      if (k !== keep && k.startsWith(prefix) && k.endsWith(`|${topic}`)) {
        ledger.delete(k);
        times?.delete(k);
      }
    }
    ledger.add(keep);
    times?.delete(keep);
  }
}

// ---------------------------------------------------------------- dates (mosque time zone)

/** Today's date (YYYY-MM-DD) in the mosque's time zone. */
export function localDay(now, timeZone = MOSQUE_TIME_ZONE) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' })
      .formatToParts(now)
      .map((p) => [p.type, p.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day}`;
}

const dayNumber = (ymd) => Date.UTC(Number(ymd.slice(0, 4)), Number(ymd.slice(5, 7)) - 1, Number(ymd.slice(8, 10))) / DAY_MS;
const fromDayNumber = (n) => new Date(n * DAY_MS).toISOString().slice(0, 10);
export const daysBetween = (a, b) => dayNumber(b) - dayNumber(a);

/** Same rule as the app (prayer-core withinMonthDayRange): inclusive, wrapping over New Year. */
export const withinMonthDay = (mmdd, from, to) => (from <= to ? mmdd >= from && mmdd <= to : mmdd >= from || mmdd <= to);

/** First day on or after `today` whose month-day is `mmdd` (02-29 in a common year = 1 Mar, as the app sees it). */
function nextOccurrence(mmdd, today) {
  const year = Number(today.slice(0, 4));
  for (const y of [year, year + 1]) {
    const day = fromDayNumber(Date.UTC(y, Number(mmdd.slice(0, 2)) - 1, Number(mmdd.slice(3, 5))) / DAY_MS);
    if (day >= today) return day;
  }
  return fromDayNumber(Date.UTC(year + 2, Number(mmdd.slice(0, 2)) - 1, Number(mmdd.slice(3, 5))) / DAY_MS);
}

/**
 * When a row's value takes effect and whether to notify:
 *   { notify, when: {kind: 'now'|'until'|'range'|'on'|'from', ...dates}, prayers, reason }
 * `rows` are all current rows (a base row is shadowed by its prayer's active season; the
 * default row applies only to prayers without their own base row).
 */
export function timing(r, rows, today, windowDays = IQAMAH_WINDOW_DAYS) {
  const mmdd = today.slice(5);
  if (r.on_date) {
    const d = daysBetween(today, r.on_date);
    const notify = d >= 0 && d <= windowDays;
    return { notify, when: { kind: 'on', date: r.on_date }, prayers: [r.prayer], reason: d < 0 ? 'the day has passed' : `takes effect in ${d} days` };
  }
  if (r.season_from && r.season_to) {
    if (withinMonthDay(mmdd, r.season_from, r.season_to)) {
      return { notify: true, when: { kind: 'until', date: nextOccurrence(r.season_to, today) }, prayers: [r.prayer], reason: 'season active today' };
    }
    const start = nextOccurrence(r.season_from, today);
    const d = daysBetween(today, start);
    return {
      notify: d <= windowDays,
      when: { kind: 'range', from: start, to: nextOccurrence(r.season_to, start) },
      prayers: [r.prayer],
      reason: `season starts in ${d} days`,
    };
  }
  if (r.prayer === 'default') {
    const own = new Set(rows.filter((x) => !x.on_date && !x.season_from && x.prayer !== 'default').map((x) => x.prayer));
    const prayers = PRAYERS.filter((p) => !own.has(p));
    return prayers.length
      ? { notify: true, when: { kind: 'now' }, prayers, reason: 'default rule' }
      : { notify: false, when: { kind: 'now' }, prayers, reason: 'every prayer has its own base rule' };
  }
  // A base row applies now, unless a season row of the same prayer is active today: then from
  // the day after that season ends (still announced now, so the change is never lost).
  const season = rows
    .filter((x) => x.prayer === r.prayer && !x.on_date && x.season_from && x.season_to && withinMonthDay(mmdd, x.season_from, x.season_to))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))[0];
  if (season) {
    const date = fromDayNumber(dayNumber(nextOccurrence(season.season_to, today)) + 1);
    return { notify: true, when: { kind: 'from', date }, prayers: [r.prayer], reason: `base rule, after the season ${season.id}` };
  }
  return { notify: true, when: { kind: 'now' }, prayers: [r.prayer], reason: 'base rule' };
}

// ---------------------------------------------------------------- texts

const NAMES = {
  ar: { fajr: 'الفجر', dhuhr: 'الظهر', asr: 'العصر', maghrib: 'المغرب', isha: 'العشاء' },
  it: { fajr: 'Fajr', dhuhr: 'Dhuhr', asr: 'Asr', maghrib: 'Maghrib', isha: 'Isha' },
  en: { fajr: 'Fajr', dhuhr: 'Dhuhr', asr: 'Asr', maghrib: 'Maghrib', isha: 'Isha' },
};
// Italian "of the <prayer>" with the article (the app writes the names without one).
const IT_OF = { fajr: 'del Fajr', dhuhr: 'del Dhuhr', asr: "dell'Asr", maghrib: 'del Maghrib', isha: "dell'Isha" };
const MONTHS = {
  ar: ['يناير', 'فبراير', 'مارس', 'أبريل', 'مايو', 'يونيو', 'يوليو', 'أغسطس', 'سبتمبر', 'أكتوبر', 'نوفمبر', 'ديسمبر'],
  it: ['gennaio', 'febbraio', 'marzo', 'aprile', 'maggio', 'giugno', 'luglio', 'agosto', 'settembre', 'ottobre', 'novembre', 'dicembre'],
  en: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'],
};

const dayOf = (ymd) => Number(ymd.slice(8, 10));
const monthOf = (lang, ymd) => MONTHS[lang][Number(ymd.slice(5, 7)) - 1];
/** "1 Nov" / "1° novembre" / "1 نوفمبر". */
export function dayMonth(lang, ymd) {
  const d = dayOf(ymd);
  return `${lang === 'it' && d === 1 ? '1°' : d} ${monthOf(lang, ymd)}`;
}
// Italian elides the article before "otto" and "undici": dall'8, all'11, l'8.
const itElides = (ymd) => dayOf(ymd) === 8 || dayOf(ymd) === 11;
const itDal = (ymd) => (itElides(ymd) ? `dall'${dayMonth('it', ymd)}` : `dal ${dayMonth('it', ymd)}`);
const itAl = (ymd) => (itElides(ymd) ? `all'${dayMonth('it', ymd)}` : `al ${dayMonth('it', ymd)}`);
const itIl = (ymd) => (itElides(ymd) ? `l'${dayMonth('it', ymd)}` : `il ${dayMonth('it', ymd)}`);
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

function list(lang, prayers) {
  const names = prayers.map((p) => NAMES[lang][p]);
  if (lang === 'ar') return names.join(' و');
  if (names.length === 1) return names[0];
  return `${names.slice(0, -1).join(', ')} ${lang === 'it' ? 'e' : 'and'} ${names.at(-1)}`;
}

// Arabic "by N minutes" / "N minutes" with the right number agreement.
function arBy(m) {
  if (m === 1) return 'بدقيقة واحدة';
  if (m === 2) return 'بدقيقتين';
  return m >= 3 && m <= 10 ? `بـ${m} دقائق` : `بـ${m} دقيقة`;
}
function arMinutes(m) {
  if (m === 1) return 'دقيقة';
  if (m === 2) return 'دقيقتين';
  return m >= 3 && m <= 10 ? `${m} دقائق` : `${m} دقيقة`;
}

/** The iqamah time in words: "05:45", or "adhan + 5 min" plus rounding and limits. */
export function valuePhrase(lang, r) {
  if (r.rule_type === 'fixed') {
    return { ar: `الساعة ${r.fixed_time}`, it: `alle ${r.fixed_time}`, en: String(r.fixed_time) }[lang];
  }
  const m = Number(r.minutes) || 0;
  const parts = {
    ar: [m === 0 ? 'مع الأذان' : `بعد الأذان ${arBy(m)}`],
    it: [`adhān + ${m} min`],
    en: [`adhan + ${m} min`],
  }[lang];
  if (r.round) parts.push({ ar: `مع التقريب إلى أقرب ${arMinutes(r.round)}`, it: `arrotondata a ${r.round} min`, en: `rounded to ${r.round} min` }[lang]);
  if (r.not_before) parts.push({ ar: `وليس قبل ${r.not_before}`, it: `non prima delle ${r.not_before}`, en: `not before ${r.not_before}` }[lang]);
  if (r.not_after) parts.push({ ar: `وليس بعد ${r.not_after}`, it: `non oltre le ${r.not_after}`, en: `not after ${r.not_after}` }[lang]);
  return parts.join(lang === 'ar' ? '، ' : ', ');
}

/** Untruncated {title, body} for one language. */
export function iqamahText(lang, r, t) {
  const v = valuePhrase(lang, r);
  const { when } = t;
  if (lang === 'ar') {
    const who = list('ar', t.prayers);
    const title = `تغيير موعد إقامة ${who}`;
    switch (when.kind) {
      case 'until': return { title, body: `حتى ${dayMonth('ar', when.date)}، تكون إقامة ${who} ${v}` };
      case 'range': return { title, body: `من ${dayMonth('ar', when.from)} إلى ${dayMonth('ar', when.to)}، تكون إقامة ${who} ${v}` };
      case 'on': return { title, body: `يوم ${dayMonth('ar', when.date)}، تكون إقامة ${who} ${v}` };
      case 'from': return { title, body: `ابتداءً من ${dayMonth('ar', when.date)}، تصبح إقامة ${who} ${v}` };
      default: return { title, body: `أصبحت إقامة ${who} ${v}` };
    }
  }
  if (lang === 'it') {
    const of = t.prayers.length === 1 ? IT_OF[t.prayers[0]] : `di ${list('it', t.prayers)}`;
    const title = `Nuovo orario dell'iqāmah ${of}`;
    switch (when.kind) {
      case 'until': return { title, body: `Fino ${itAl(when.date)}, l'iqāmah ${of} è ${v}` };
      case 'range': return { title, body: `${cap(itDal(when.from))} ${itAl(when.to)}, l'iqāmah ${of} è ${v}` };
      case 'on': return { title, body: `${cap(itIl(when.date))}, l'iqāmah ${of} è ${v}` };
      case 'from': return { title, body: `${cap(itDal(when.date))}, l'iqāmah ${of} è ${v}` };
      default: return { title, body: `L'iqāmah ${of} ora è ${v}` };
    }
  }
  const who = list('en', t.prayers);
  const title = `${who} iqamah changed`;
  switch (when.kind) {
    case 'until': return { title, body: `Until ${dayMonth('en', when.date)}, ${who} iqamah is ${v}` };
    case 'range': return { title, body: `From ${dayMonth('en', when.from)} to ${dayMonth('en', when.to)}, ${who} iqamah is ${v}` };
    case 'on': return { title, body: `On ${dayMonth('en', when.date)}, ${who} iqamah is ${v}` };
    case 'from': return { title, body: `From ${dayMonth('en', when.date)}, ${who} iqamah is ${v}` };
    default: return { title, body: `${who} iqamah is now ${v}` };
  }
}

// ---------------------------------------------------------------- planning

/**
 * Decides what to announce and updates the ledger for everything handled without a message.
 *   coldStart: the ledger has no iqamah keys yet; the rows of `previous` (the commit before the
 *              push) are recorded as handled first, or with no previous commit the current rows
 *              (so nothing is sent).
 * Returns { changes: [{ row, hash, timing, topics }], recorded, silent: [{ row, reason }] }.
 */
export function planIqamah({ current, previous = null, ledger, times = new Map(), now, topics, coldStart = false, windowDays = IQAMAH_WINDOW_DAYS }) {
  const rows = ruleRows(current);
  const today = localDay(now);
  let seeded = 0;
  if (coldStart) {
    for (const r of previous === null ? rows : ruleRows(previous)) {
      recordRule(ledger, times, r, valueHash(r), topics);
      seeded += 1;
    }
  }
  const changes = [];
  const silent = [];
  for (const r of rows) {
    const hash = valueHash(r);
    const pending = topics.filter((topic) => !ledger.has(iqamahKey(r, hash, topic)));
    if (pending.length === 0) {
      recordRule(ledger, times, r, hash, topics); // refresh
      continue;
    }
    const t = timing(r, rows, today, windowDays);
    if (t.notify) {
      changes.push({ row: r, hash, timing: t, topics: pending });
    } else {
      recordRule(ledger, times, r, hash, topics);
      silent.push({ row: r, reason: t.reason });
    }
  }
  return { changes, silent, seeded, today };
}
