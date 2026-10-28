// Run: node --test .github/scripts/validate-content.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  escapeCommandData,
  logSafe,
  MAX_FILE_BYTES,
  parseStrictDate,
  validateContent,
  validateText,
} from './validate-content.mjs';

// ---------------------------------------------------------------- fixtures (one valid row per table)

const T = '2026-10-26T00:00:00.000Z';
const IMG = 'https://raw.githubusercontent.com/AnasOsman1/azzaituna-content/main/images/poster.jpg';

const lesson = (over = {}) => ({
  updated_at: T,
  id: 'tafsir',
  mosque_id: 'azzaituna',
  topic_ar: 'درس', topic_it: 'Lezione', topic_en: 'Lesson',
  teacher_ar: 'الشيخ', teacher_it: 'Shaykh', teacher_en: 'Shaykh',
  location_ar: 'المسجد', location_it: 'Moschea', location_en: 'Mosque',
  starts_at: null,
  weekly_days: [0, 2],
  after_prayer: 'fajr',
  sort: 1,
  ...over,
});

const ann = (over = {}) => ({
  updated_at: T,
  id: 'welcome',
  mosque_id: 'azzaituna',
  title_ar: 'مرحبا', title_it: 'Benvenuti', title_en: 'Welcome',
  body_ar: 'نص', body_it: 'Testo', body_en: 'Body',
  priority: 'normal',
  starts_at: '2026-08-01T00:00:00.000Z',
  expires_at: null,
  published_at: '2026-08-01T00:00:00.000Z',
  ...over,
});

const zikr = (over = {}) => ({
  updated_at: T,
  id: 'morning-ikhlas',
  mosque_id: 'azzaituna',
  collection: 'morning',
  arabic: 'قل هو الله أحد',
  translation_ar: 'سورة الإخلاص', translation_it: 'Di’: Egli è Allah', translation_en: 'Say: He is Allah',
  repetitions: 3,
  source: 'Qurʾān 112',
  sort: 1,
  ...over,
});

const rule = (over = {}) => ({
  updated_at: T,
  id: 'fajr-base',
  mosque_id: 'azzaituna',
  prayer: 'fajr',
  rule_type: 'fixed',
  minutes: null, round: null, not_before: null, not_after: null,
  fixed_time: '05:45',
  season_from: null, season_to: null, on_date: null,
  ...over,
});

const session = (over = {}) => ({
  updated_at: T, id: 'jumuah-1', mosque_id: 'azzaituna', khutbah: '12:45', iqamah: '13:05', sort: 1, ...over,
});

const content = (over = {}) => ({
  lessons: [lesson()],
  announcements: [ann()],
  adhkar: [zikr()],
  iqamahRules: [rule()],
  jumuahSessions: [session()],
  ...over,
});

const errs = (data) => validateContent(data).join('\n');
const ok = (data) => assert.deepEqual(validateContent(data), []);
const bad = (data, re) => assert.match(errs(data), re);
const annWith = (over) => content({ announcements: [ann(over)] });
const annWithout = (key) => {
  const a = ann();
  delete a[key];
  return content({ announcements: [a] });
};

// ---------------------------------------------------------------- baseline

test('the fixture and the real content.json are valid', () => {
  ok(content());
  const text = readFileSync(new URL('../../content.json', import.meta.url), 'utf8');
  assert.deepEqual(validateText(text), []);
});

test('a full announcement with an image and every optional field is valid', () => {
  ok(annWith({
    priority: 'urgent',
    expires_at: '2026-10-29T23:00:00.000Z',
    image_url: IMG,
    image_width: 1080,
    image_height: 1526,
  }));
  ok(annWith({ image_url: null, image_width: null, image_height: null }));
});

// ---------------------------------------------------------------- top level

test('top level: every table must be an array (lessons: {} and missing tables are rejected)', () => {
  bad(content({ lessons: {} }), /"lessons" must be an array/);
  const missing = content();
  delete missing.jumuahSessions;
  bad(missing, /"jumuahSessions" must be an array/);
  assert.match(validateContent([]).join('\n'), /JSON object/);
  assert.match(validateContent(null).join('\n'), /JSON object/);
});

test('top level: lessons, announcements and adhkar cannot all be empty (the app treats that as a failed fetch)', () => {
  bad(content({ lessons: [], announcements: [], adhkar: [] }), /cannot all be empty/);
  ok(content({ lessons: [], announcements: [] }));
});

test('null rows and non-object rows are rejected in every table', () => {
  for (const table of ['lessons', 'announcements', 'adhkar', 'iqamahRules', 'jumuahSessions']) {
    bad(content({ [table]: [null] }), new RegExp(`${table}\\[0\\]: must be an object`));
    bad(content({ [table]: ['x'] }), new RegExp(`${table}\\[0\\]: must be an object`));
    bad(content({ [table]: [[]] }), new RegExp(`${table}\\[0\\]: must be an object`));
  }
});

test('duplicate ids are rejected in every table, including lessons', () => {
  bad(content({ lessons: [lesson(), lesson({ sort: 2 })] }), /lessons\[1\].*duplicate id/);
  bad(content({ announcements: [ann(), ann()] }), /announcements\[1\].*duplicate id/);
  bad(content({ adhkar: [zikr(), zikr()] }), /adhkar\[1\].*duplicate id/);
  bad(content({ iqamahRules: [rule(), rule({ prayer: 'isha' })] }), /iqamahRules\[1\].*duplicate id/);
  bad(content({ jumuahSessions: [session(), session()] }), /jumuahSessions\[1\].*duplicate id/);
});

test('mosque_id is required on every row and must be the app mosque', () => {
  bad(annWith({ mosque_id: 'other' }), /"mosque_id" must be "azzaituna"/);
  bad(content({ lessons: [lesson({ mosque_id: undefined })] }), /lessons\[0\].*"mosque_id"/);
  bad(content({ adhkar: [zikr({ mosque_id: null })] }), /adhkar\[0\].*"mosque_id"/);
});

test('updated_at is a required strict date on every row', () => {
  bad(annWithout('updated_at'), /"updated_at" is missing/);
  bad(content({ jumuahSessions: [session({ updated_at: 5 })] }), /jumuahSessions\[0\].*"updated_at"/);
  bad(content({ iqamahRules: [rule({ updated_at: '2026-10-26' })] }), /iqamahRules\[0\].*"updated_at"/);
});

test('NaN and non-finite numbers are rejected anywhere (1e400 parses as Infinity)', () => {
  assert.match(validateText(JSON.stringify(content()).replace('"sort":1', '"sort":1e400')).join('\n'), /finite/);
  bad(content({ adhkar: [zikr({ repetitions: Number.NaN })] }), /finite/);
  bad(annWith({ extra: { deep: [Infinity] } }), /finite/);
});

// ---------------------------------------------------------------- announcements: required fields

test('announcements: published_at null or missing is rejected (the app throws on it)', () => {
  bad(annWith({ published_at: null }), /"published_at" must be a date-time/);
  bad(annWithout('published_at'), /"published_at" is missing/);
});

test('announcements: the expires_at key must exist (null is fine)', () => {
  bad(annWithout('expires_at'), /"expires_at" is missing/);
  ok(annWith({ expires_at: null }));
  bad(annWith({ expires_at: 5 }), /"expires_at" must be null or a date-time/);
});

test('announcements: starts_at is required, and expires_at must be after it', () => {
  bad(annWithout('starts_at'), /"starts_at" is missing/);
  bad(annWith({ starts_at: null }), /"starts_at" must be a date-time/);
  bad(annWith({ expires_at: '2026-08-01T00:00:00.000Z' }), /"expires_at" must be after "starts_at"/);
});

test('announcements: texts must be strings in all three languages, priority normal/urgent', () => {
  bad(annWithout('title_ar'), /"title_ar" is missing/);
  bad(annWith({ body_it: 42 }), /"body_it" must be a string/);
  bad(annWith({ body_en: '   ' }), /"body_en" must not be empty/);
  bad(annWith({ priority: 'high' }), /"priority"/);
  bad(annWithout('priority'), /"priority" is missing/);
});

// ---------------------------------------------------------------- dates

test('dates: strict YYYY-MM-DDTHH:mm:ss(.sss)?(Z|±hh:mm) only', () => {
  for (const d of ['2026-10-27T00:00:00Z', '2026-10-27T00:00:00.000Z', '2026-10-27T02:00:00+02:00', '2026-10-27T00:00:00.123-05:30']) {
    assert.ok(!Number.isNaN(parseStrictDate(d)), d);
    assert.equal(parseStrictDate(d), Date.parse(d), d);
    ok(annWith({ starts_at: d, published_at: d }));
  }
  const zoneless = ['2026-10-27T00:00:00', '2026-10-27T00:00:00.000', '2026-10-27', '2026-10-27 00:00:00Z'];
  const odd = ['2026-10-27T00:00Z', '2026-10-27T00:00:00.1Z', '2026-10-27T00:00:00+0200', '2026-10-27T00:00:00+02', 'Tue, 27 Oct 2026 00:00:00 GMT', '27/10/2026', ' 2026-10-27T00:00:00Z', '2026-10-27t00:00:00z'];
  for (const d of [...zoneless, ...odd]) {
    assert.ok(Number.isNaN(parseStrictDate(d)), d);
    bad(annWith({ published_at: d }), /"published_at" must be a date-time/);
  }
});

test('dates: impossible calendar values and years outside 2000-2100 are rejected', () => {
  for (const d of ['2026-02-30T00:00:00Z', '2026-13-01T00:00:00Z', '2026-10-27T24:00:00Z', '2026-10-27T23:60:00Z', '2026-10-27T23:59:60Z', '2026-10-27T00:00:00+15:00', '1999-12-31T23:59:59Z', '2101-01-01T00:00:00Z', '+002026-10-27T00:00:00Z']) {
    assert.ok(Number.isNaN(parseStrictDate(d)), d);
  }
  assert.ok(!Number.isNaN(parseStrictDate('2028-02-29T00:00:00Z')));
  assert.ok(!Number.isNaN(parseStrictDate('2100-12-31T23:59:59Z')));
  assert.ok(!Number.isNaN(parseStrictDate('2000-01-01T00:00:00Z')));
});

// ---------------------------------------------------------------- ids and log injection

test('announcement id must match ^[a-z0-9-]{1,64}$', () => {
  ok(annWith({ id: 'a' }));
  ok(annWith({ id: 'x'.repeat(64) }));
  for (const id of ['', 'A', 'with space', 'under_score', 'x'.repeat(65), 'é', 7]) {
    bad(annWith({ id }), /"id" must match/);
  }
});

test('an id with a newline and ::add-mask:: is rejected and never reaches the log raw', () => {
  const evil = 'x\n::add-mask::secret\n::error::pwned';
  const out = validateContent(annWith({ id: evil, title_en: '\n::warning::hi' }));
  assert.ok(out.length > 0);
  for (const line of out) {
    assert.ok(!line.includes('\n'), 'no raw newline in a problem line');
    assert.ok(!/(^|\n)\s*::/.test(line), 'no line starts a workflow command');
  }
  assert.match(out.join(' '), /\\n::add-mask::/); // shown JSON-escaped
});

test('logSafe JSON-escapes and cuts values; escapeCommandData encodes %, CR and LF', () => {
  assert.equal(logSafe('a\nb'), '"a\\nb"');
  assert.equal(logSafe('x\u2028y\u202Ez'), '"x\\u2028y\\u202ez"');
  assert.equal(logSafe(undefined), 'undefined');
  assert.ok(Array.from(logSafe('a'.repeat(10_000))).length < 100);
  assert.equal(escapeCommandData('50%\r\nx'), '50%25%0D%0Ax');
});

// ---------------------------------------------------------------- text limits and invisible characters

test('titles over 120 characters and bodies over 2000 characters are rejected (10k-char title, 5 MB body)', () => {
  ok(annWith({ title_en: 't'.repeat(120), body_en: 'b'.repeat(2000) }));
  bad(annWith({ title_en: 't'.repeat(121) }), /"title_en" is 121 characters; the limit is 120/);
  bad(annWith({ title_ar: 'ع'.repeat(10_000) }), /"title_ar" is 10000 characters/);
  bad(annWith({ body_it: 'b'.repeat(2001) }), /"body_it" is 2001 characters; the limit is 2000/);
  const huge = 'b'.repeat(5 * 1024 * 1024);
  const problems = validateText(JSON.stringify(annWith({ body_en: huge })));
  assert.match(problems.join('\n'), /larger than/);
  assert.ok(problems.join('\n').length < 2000, 'the huge value is not echoed');
});

test('limits count code points, so emoji and Arabic are not penalised', () => {
  ok(annWith({ title_en: '\u{1F54C}'.repeat(120) }));
  bad(annWith({ title_en: '\u{1F54C}'.repeat(121) }), /121 characters/);
});

test('content.json larger than 1 MB is rejected', () => {
  const big = JSON.stringify(content({ adhkar: Array.from({ length: 900 }, (_, i) => zikr({ id: `z-${i}`, arabic: 'ب'.repeat(600) })) }));
  assert.ok(Buffer.byteLength(big) > MAX_FILE_BYTES);
  assert.match(validateText(big).join('\n'), /larger than/);
  assert.equal(MAX_FILE_BYTES, 1024 * 1024);
});

test('a title or body made only of zero-width characters is rejected', () => {
  bad(annWith({ title_en: '\u200B\u200C\u200D' }), /"title_en" must not be empty/);
  bad(annWith({ body_ar: '\uFEFF\u2060\u200E\u200F ' }), /"body_ar" must not be empty/);
  ok(annWith({ title_en: 'Hello\u200Bworld' }));
});

test('bidi override and isolate controls are rejected in titles and bodies', () => {
  for (const c of ['\u202A', '\u202B', '\u202C', '\u202D', '\u202E', '\u2066', '\u2067', '\u2068', '\u2069']) {
    bad(annWith({ title_it: `abc${c}def` }), /"title_it" contains a bidirectional control character/);
    bad(annWith({ body_en: `abc${c}def` }), /"body_en" contains a bidirectional control character/);
  }
});

// ---------------------------------------------------------------- images

test('image_url: only https://raw.githubusercontent.com/AnasOsman1/azzaituna-content/...', () => {
  const dims = { image_width: 100, image_height: 100 };
  ok(annWith({ image_url: IMG, ...dims }));
  const cases = [
    ['https://raw.githubusercontent.com@evil.example/a.jpg', /"@"/],
    ['https://user:pw@raw.githubusercontent.com/AnasOsman1/azzaituna-content/a.jpg', /"@"/],
    ['http://raw.githubusercontent.com/AnasOsman1/azzaituna-content/a.jpg', /https/],
    ['https://raw.githubusercontent.com:443/AnasOsman1/azzaituna-content/a.jpg', /port/],
    ['https://raw.githubusercontent.com:8443/AnasOsman1/azzaituna-content/a.jpg', /port/],
    [`${IMG}?x=1`, /query/],
    [`${IMG}#frag`, /query/],
    ['https://127.0.0.1/AnasOsman1/azzaituna-content/a.jpg', /IP address/],
    ['https://2130706433/AnasOsman1/azzaituna-content/a.jpg', /IP address/],
    ['https://[::1]/AnasOsman1/azzaituna-content/a.jpg', /IP address/],
    ['https://example.org/AnasOsman1/azzaituna-content/a.jpg', /host must be raw\.githubusercontent\.com/],
    ['https://raw.githubusercontent.com.evil.example/AnasOsman1/azzaituna-content/a.jpg', /host must be/],
    ['https://RAW.githubusercontent.com/AnasOsman1/azzaituna-content/a.jpg', /canonical|host/],
    ['https://raw.githubusercontent.com/someone-else/repo/main/a.jpg', /must start with/],
    ['https://raw.githubusercontent.com/AnasOsman1/azzaituna-content-evil/a.jpg', /must start with/],
    ['https://raw.githubusercontent.com/AnasOsman1/azzaituna-content/../../evil/x/a.jpg', /must start with|canonical/],
    ['https://raw.githubusercontent.com/AnasOsman1/azzaituna-content/main/%2e%2e/a.jpg', /encoded/],
    ['https://raw.githubusercontent.com/AnasOsman1/azzaituna-content/main/a b.jpg', /spaces/],
    ['https://raw.githubusercontent.com/AnasOsman1/azzaituna-content/', /file path/],
    ['', /must be null or a link/],
    [42, /must be null or a link/],
  ];
  for (const [url, re] of cases) {
    bad(annWith({ image_url: url, ...dims }), re);
  }
});

test('image size: width/height required together with image_url, integers 1..8000, aspect 1:4 to 4:1', () => {
  ok(annWith({ image_url: IMG, image_width: 1000, image_height: 4000 }));
  ok(annWith({ image_url: IMG, image_width: 8000, image_height: 2000 }));
  bad(annWith({ image_url: IMG, image_width: 1, image_height: 10000 }), /"image_height" must be an integer 1-8000/);
  bad(annWith({ image_url: IMG, image_width: 1, image_height: 10000 }), /aspect ratio/);
  bad(annWith({ image_url: IMG, image_width: 100, image_height: 401 }), /aspect ratio/);
  bad(annWith({ image_url: IMG, image_width: 100 }), /"image_height" is missing/);
  bad(annWith({ image_url: IMG, image_width: 10.5, image_height: 10 }), /"image_width" must be an integer/);
  bad(annWith({ image_url: IMG, image_width: 0, image_height: 10 }), /"image_width" must be an integer/);
  bad(annWith({ image_url: IMG, image_width: '100', image_height: 100 }), /"image_width" must be an integer/);
  bad(annWith({ image_width: 100, image_height: 100 }), /image_url is missing/);
  bad(annWith({ image_url: null, image_height: 100 }), /image_url is missing/);
});

// ---------------------------------------------------------------- lessons

test('lessons: weekly_days must be null or an array of weekdays 0-6 (weekly_days: 5 makes the app throw)', () => {
  bad(content({ lessons: [lesson({ weekly_days: 5 })] }), /"weekly_days" must be null or a list/);
  bad(content({ lessons: [lesson({ weekly_days: {} })] }), /"weekly_days" must be null or a list/);
  bad(content({ lessons: [lesson({ weekly_days: [] })] }), /"weekly_days"/);
  bad(content({ lessons: [lesson({ weekly_days: [7] })] }), /"weekly_days"/);
  bad(content({ lessons: [lesson({ weekly_days: [1.5] })] }), /"weekly_days"/);
  bad(content({ lessons: [lesson({ weekly_days: undefined })] }), /"weekly_days" is missing/);
});

test('lessons: starts_at/weekly_days/after_prayer keys required, a schedule is required, recurrence not half-set', () => {
  const noKey = lesson();
  delete noKey.starts_at;
  bad(content({ lessons: [noKey] }), /"starts_at" is missing/);
  bad(content({ lessons: [lesson({ after_prayer: 'noon' })] }), /"after_prayer"/);
  bad(content({ lessons: [lesson({ after_prayer: null })] }), /both be set or both be null/);
  bad(content({ lessons: [lesson({ weekly_days: null, after_prayer: null })] }), /needs "starts_at" or/);
  ok(content({ lessons: [lesson({ weekly_days: null, after_prayer: null, starts_at: '2026-11-01T18:00:00+01:00' })] }));
  bad(content({ lessons: [lesson({ starts_at: '2026-11-01T18:00:00' })] }), /"starts_at" must be null or a date-time/);
  bad(content({ lessons: [lesson({ topic_en: '' })] }), /"topic_en" must not be empty/);
  bad(content({ lessons: [lesson({ sort: '1' })] }), /"sort" must be an integer/);
});

// ---------------------------------------------------------------- adhkar, iqamah, jumu'ah

test('adhkar: collection, texts, repetitions, sort', () => {
  bad(content({ adhkar: [zikr({ collection: 'night' })] }), /"collection"/);
  bad(content({ adhkar: [zikr({ arabic: ' ' })] }), /"arabic" must not be empty/);
  bad(content({ adhkar: [zikr({ repetitions: 0 })] }), /"repetitions" must be an integer/);
  bad(content({ adhkar: [zikr({ translation_it: null })] }), /"translation_it" must be a string/);
  bad(content({ adhkar: [zikr({ source: undefined })] }), /"source" is missing/);
});

test('iqamahRules: every column present, rule shapes, slots', () => {
  ok(content({ iqamahRules: [rule(), rule({ id: 'd', prayer: 'dhuhr', rule_type: 'offset', fixed_time: null, minutes: 10, round: 5, not_before: '13:00', not_after: null })] }));
  bad(content({ iqamahRules: [rule({ fixed_time: '5:45' })] }), /"fixed_time"/);
  bad(content({ iqamahRules: [rule({ fixed_time: null })] }), /"fixed_time"/);
  bad(content({ iqamahRules: [rule({ rule_type: 'offset', fixed_time: null })] }), /"minutes"/);
  bad(content({ iqamahRules: [rule({ rule_type: 'offset', fixed_time: null, minutes: 181 })] }), /"minutes"/);
  bad(content({ iqamahRules: [rule({ rule_type: 'other' })] }), /"rule_type"/);
  bad(content({ iqamahRules: [rule({ prayer: 'jumuah' })] }), /"prayer"/);
  const noCol = rule();
  delete noCol.season_to;
  bad(content({ iqamahRules: [noCol] }), /"season_to" is missing/);
  bad(content({ iqamahRules: [rule({ season_from: '03-01' })] }), /season_from and season_to/);
  bad(content({ iqamahRules: [rule({ season_from: '3-1', season_to: '10-31' })] }), /"season_from"/);
  bad(content({ iqamahRules: [rule({ on_date: '2026-02-30' })] }), /"on_date"/);
  bad(content({ iqamahRules: [rule({ on_date: '2026-03-01', season_from: '03-01', season_to: '04-01' })] }), /both a season and a date/);
  bad(content({ iqamahRules: [rule({ prayer: 'default', on_date: '2026-03-01' })] }), /"default"/);
  bad(content({ iqamahRules: [rule(), rule({ id: 'fajr-2' })] }), /iqamahRules\[1\].*same slot as iqamahRules\[0\]/);
  ok(content({ iqamahRules: [rule(), rule({ id: 'fajr-2', on_date: '2026-12-25' }), rule({ id: 'fajr-3', season_from: '06-01', season_to: '08-31' })] }));
});

test('jumuahSessions: wall-clock times and sort', () => {
  bad(content({ jumuahSessions: [session({ khutbah: '24:00' })] }), /"khutbah"/);
  bad(content({ jumuahSessions: [session({ iqamah: null })] }), /"iqamah"/);
  bad(content({ jumuahSessions: [session({ sort: 1.5 })] }), /"sort"/);
});

// ---------------------------------------------------------------- CLI

test('validateText: invalid JSON and non-object roots are reported, not thrown', () => {
  assert.match(validateText('{ nope').join('\n'), /not valid JSON/);
  assert.match(validateText('[]').join('\n'), /JSON object/);
});
