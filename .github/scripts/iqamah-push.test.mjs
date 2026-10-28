// Run: node --test .github/scripts/iqamah-push.test.mjs
// Iqamah rule change notifications: values, the 14-day window, texts, ledger dedup, cold start.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  effectiveValue,
  hasIqamahEntries,
  iqamahKey,
  iqamahText,
  localDay,
  planIqamah,
  timing,
  valueHash,
} from './iqamah-push.mjs';
import { BODY_MAX_CHARS, buildIqamahMessages, run, TITLE_MAX_CHARS, TOPICS, waitForContent } from './send-push.mjs';
import { ID_PATTERN, validateContent } from './validate-content.mjs';

const NOW = new Date('2026-10-28T10:00:00Z'); // 28 Oct in Rome
const quiet = () => {};

function rule(id, over = {}) {
  return {
    id,
    mosque_id: 'azzaituna',
    updated_at: '2026-10-26T00:00:00.000Z',
    prayer: 'fajr',
    rule_type: 'fixed',
    minutes: null,
    round: null,
    not_before: null,
    not_after: null,
    fixed_time: '05:45',
    season_from: null,
    season_to: null,
    on_date: null,
    ...over,
  };
}
const offset = (id, prayer, minutes, over = {}) => rule(id, { prayer, rule_type: 'offset', fixed_time: null, minutes, ...over });
const BASES = [
  rule('fajr-base'),
  offset('dhuhr-base', 'dhuhr', 10),
  offset('asr-base', 'asr', 10),
  offset('maghrib-base', 'maghrib', 5),
  offset('isha-base', 'isha', 5),
];
const withRules = (rules) => ({ lessons: [], announcements: [], adhkar: [], iqamahRules: rules });
const replace = (rules, id, over) => rules.map((r) => (r.id === id ? { ...r, ...over } : r));
const texts = (row, rows = [row], now = NOW) => {
  const t = timing(row, rows, localDay(now));
  return Object.fromEntries(['ar', 'it', 'en'].map((l) => [l, iqamahText(l, row, t)]));
};

const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const SA = JSON.stringify({
  project_id: 'azzaituna-test',
  private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }),
  client_email: 'fcm@azzaituna-test.iam.gserviceaccount.com',
});
function mockFetch(handler = () => null) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    if (url.includes('oauth2')) return { ok: true, status: 200, text: async () => JSON.stringify({ access_token: 'tok' }) };
    const { status = 200 } = handler(url, init, calls) ?? {};
    return { ok: status < 300, status, text: async () => JSON.stringify({ name: 'projects/p/messages/1' }) };
  };
  fn.calls = calls;
  return fn;
}
const fcmSends = (f) => f.calls.filter((c) => c.url.includes('fcm.googleapis.com')).map((c) => JSON.parse(c.init.body).message);
const live = (over) => run({ now: NOW, dryRun: false, serviceAccountJson: SA, log: quiet, retryDelayMs: 1, ...over });
/** A ledger in which the given rows are already handled (what a previous run leaves). */
function ledgerFor(rows) {
  const ledger = new Set(['some-announcement|announcements-ar']);
  planIqamah({ current: withRules(rows), ledger, now: NOW, topics: TOPICS, coldStart: true });
  return ledger;
}

// ---------------------------------------------------------------- values

test('the value hash ignores updated_at, mosque_id, row order and columns the rule type does not use', () => {
  const a = rule('fajr-base');
  assert.equal(valueHash({ ...a, updated_at: '2026-11-01T00:00:00Z' }), valueHash(a));
  assert.equal(valueHash({ ...a, minutes: 7, round: 5 }), valueHash(a), 'offset columns do not matter for a fixed rule');
  const o = offset('isha-base', 'isha', 5);
  assert.equal(valueHash({ ...o, fixed_time: '20:00' }), valueHash(o), 'fixed_time does not matter for an offset rule');
  assert.notEqual(valueHash({ ...a, fixed_time: '05:50' }), valueHash(a));
  assert.notEqual(valueHash({ ...o, round: 5 }), valueHash(o));
  assert.notEqual(valueHash({ ...a, season_from: '11-01', season_to: '02-28' }), valueHash(a));
  assert.deepEqual(Object.keys(effectiveValue(o)), ['prayer', 'rule_type', 'minutes', 'round', 'not_before', 'not_after', 'season_from', 'season_to', 'on_date']);
  assert.match(valueHash(a), /^[0-9a-f]{16}$/);
});

test('ledger keys cannot collide with announcement keys', () => {
  const k = iqamahKey(rule('fajr-base'), valueHash(rule('fajr-base')), 'announcements-ar');
  assert.match(k, /^iqamah:fajr:fajr-base:[0-9a-f]{16}\|announcements-ar$/);
  assert.equal(ID_PATTERN.test(k.split('|')[0]), false, 'announcement ids cannot contain ":"');
  assert.equal(hasIqamahEntries(new Set(['a|announcements-ar'])), false);
  assert.equal(hasIqamahEntries(new Set([k])), true);
});

test('Rome calendar day: 23:30 UTC on 31 Oct is already 1 Nov at the mosque', () => {
  assert.equal(localDay(new Date('2026-10-31T23:30:00Z')), '2026-11-01');
  assert.equal(localDay(new Date('2026-07-31T21:59:00Z')), '2026-07-31');
  assert.equal(localDay(new Date('2026-07-31T22:00:00Z')), '2026-08-01');
});

// ---------------------------------------------------------------- texts

test('fixed base change: natural text in Arabic, Italian and English', () => {
  assert.deepEqual(texts(rule('fajr-base', { fixed_time: '05:50' })), {
    ar: { title: 'تغيير موعد إقامة الفجر', body: 'أصبحت إقامة الفجر الساعة 05:50' },
    it: { title: "Nuovo orario dell'iqāmah del Fajr", body: "L'iqāmah del Fajr ora è alle 05:50" },
    en: { title: 'Fajr iqamah changed', body: 'Fajr iqamah is now 05:50' },
  });
});

test('offset change: "adhan + N min" with rounding and limits; Arabic number agreement', () => {
  const t = texts(offset('isha-base', 'isha', 5, { round: 15, not_before: '19:30', not_after: '21:00' }));
  assert.equal(t.en.body, 'Isha iqamah is now adhan + 5 min, rounded to 15 min, not before 19:30, not after 21:00');
  assert.equal(t.it.body, "L'iqāmah dell'Isha ora è adhān + 5 min, arrotondata a 15 min, non prima delle 19:30, non oltre le 21:00");
  assert.equal(t.it.title, "Nuovo orario dell'iqāmah dell'Isha");
  assert.equal(t.ar.body, 'أصبحت إقامة العشاء بعد الأذان بـ5 دقائق، مع التقريب إلى أقرب 15 دقيقة، وليس قبل 19:30، وليس بعد 21:00');
  assert.equal(texts(offset('a', 'asr', 1)).ar.body, 'أصبحت إقامة العصر بعد الأذان بدقيقة واحدة');
  assert.equal(texts(offset('a', 'asr', 2)).ar.body, 'أصبحت إقامة العصر بعد الأذان بدقيقتين');
  assert.equal(texts(offset('a', 'asr', 20)).ar.body, 'أصبحت إقامة العصر بعد الأذان بـ20 دقيقة');
  assert.equal(texts(offset('a', 'maghrib', 10)).en.body, 'Maghrib iqamah is now adhan + 10 min');
});

test('season starting within 14 days: dates with localised month names', () => {
  const s = rule('fajr-winter', { season_from: '11-01', season_to: '02-28', fixed_time: '06:15' });
  const t = texts(s, [...BASES, s]);
  assert.equal(t.en.body, 'From 1 Nov to 28 Feb, Fajr iqamah is 06:15');
  assert.equal(t.it.body, "Dal 1° novembre al 28 febbraio, l'iqāmah del Fajr è alle 06:15");
  assert.equal(t.ar.body, 'من 1 نوفمبر إلى 28 فبراير، تكون إقامة الفجر الساعة 06:15');
  // Italian elision before "otto" and "undici".
  const e = rule('x', { season_from: '11-08', season_to: '12-11' });
  assert.equal(texts(e).it.body, "Dall'8 novembre all'11 dicembre, l'iqāmah del Fajr è alle 05:45");
});

test('season active today: "until <end>"', () => {
  const s = offset('isha-autumn', 'isha', 10, { season_from: '10-01', season_to: '11-15' });
  const t = texts(s, [...BASES, s]);
  assert.equal(t.en.body, 'Until 15 Nov, Isha iqamah is adhan + 10 min');
  assert.equal(t.it.body, "Fino al 15 novembre, l'iqāmah dell'Isha è adhān + 10 min");
  assert.equal(t.ar.body, 'حتى 15 نوفمبر، تكون إقامة العشاء بعد الأذان بـ10 دقائق');
});

test('one-day override: "on <date>"', () => {
  const d = rule('fajr-1108', { on_date: '2026-11-08', fixed_time: '06:00' });
  const t = texts(d, [...BASES, d]);
  assert.equal(t.en.body, 'On 8 Nov, Fajr iqamah is 06:00');
  assert.equal(t.it.body, "L'8 novembre, l'iqāmah del Fajr è alle 06:00");
  assert.equal(t.ar.body, 'يوم 8 نوفمبر، تكون إقامة الفجر الساعة 06:00');
  assert.equal(texts(rule('y', { on_date: '2026-11-01' })).it.body, "Il 1° novembre, l'iqāmah del Fajr è alle 05:45");
});

test('a base change while a season of that prayer is active says when it starts to apply', () => {
  const season = rule('fajr-autumn', { season_from: '10-01', season_to: '11-15', fixed_time: '06:00' });
  const base = rule('fajr-base', { fixed_time: '05:50' });
  const t = texts(base, [base, season]);
  assert.equal(t.en.body, 'From 16 Nov, Fajr iqamah is 05:50');
  assert.equal(t.it.body, "Dal 16 novembre, l'iqāmah del Fajr è alle 05:50");
  assert.equal(t.ar.body, 'ابتداءً من 16 نوفمبر، تصبح إقامة الفجر الساعة 05:50');
});

test('the default rule names the prayers that use it; with none it is not announced', () => {
  const d = offset('default-base', 'default', 10);
  const rows = [d, rule('fajr-base'), offset('isha-base', 'isha', 5)];
  const t = texts(d, rows);
  assert.equal(t.en.title, 'Dhuhr, Asr and Maghrib iqamah changed');
  assert.equal(t.en.body, 'Dhuhr, Asr and Maghrib iqamah is now adhan + 10 min');
  assert.equal(t.it.title, "Nuovo orario dell'iqāmah di Dhuhr, Asr e Maghrib");
  assert.equal(t.ar.title, 'تغيير موعد إقامة الظهر والعصر والمغرب');
  assert.equal(timing(d, [d, ...BASES], '2026-10-28').notify, false);
});

test('titles stay within 65 and bodies within 140 characters (truncated with an ellipsis)', () => {
  const long = offset('isha-base', 'isha', 120, { round: 60, not_before: '19:30', not_after: '23:59', season_from: '11-08', season_to: '12-11' });
  const t = timing(long, [long], '2026-10-28');
  const many = { ...t, prayers: [...t.prayers, 'fajr', 'dhuhr', 'asr', 'maghrib', 'isha', 'fajr', 'dhuhr', 'asr', 'maghrib', 'isha'] };
  for (const m of buildIqamahMessages({ row: long, hash: valueHash(long), timing: many })) {
    assert.ok(Array.from(m.notification.title).length <= TITLE_MAX_CHARS, m.notification.title);
    assert.ok(Array.from(m.notification.body).length <= BODY_MAX_CHARS, m.notification.body);
    assert.ok(m.notification.title.endsWith('…'));
    assert.ok(m.notification.body.endsWith('…'));
  }
});

test('messages: one per language topic, channel announcements, unique tag per change, data {screen: prayers}', () => {
  const r = rule('fajr-base', { fixed_time: '05:50' });
  const msgs = buildIqamahMessages({ row: r, hash: valueHash(r), timing: timing(r, [r], '2026-10-28') });
  assert.deepEqual(msgs.map((m) => m.topic), TOPICS);
  for (const m of msgs) {
    assert.deepEqual(m.data, { screen: 'prayers' });
    assert.equal(m.android.notification.channel_id, 'announcements');
    assert.equal(m.android.notification.tag, `iqamah-fajr-base-${valueHash(r)}`);
  }
  const other = rule('fajr-base', { fixed_time: '05:55' });
  assert.notEqual(buildIqamahMessages({ row: other, hash: valueHash(other), timing: timing(other, [other], '2026-10-28') })[0].android.notification.tag, msgs[0].android.notification.tag);
});

// ---------------------------------------------------------------- the 14-day window

test('window: on_date today..+14 days is announced; +15 days and past days are not', () => {
  const at = (on_date) => timing(rule('d', { on_date }), [], '2026-10-28').notify;
  assert.equal(at('2026-10-28'), true);
  assert.equal(at('2026-11-11'), true);
  assert.equal(at('2026-11-12'), false);
  assert.equal(at('2026-10-27'), false);
});

test('window: a season starting within 14 days or active today is announced; later ones are not', () => {
  const s = (season_from, season_to) => timing(rule('s', { season_from, season_to }), [], '2026-10-28').notify;
  assert.equal(s('11-11', '12-31'), true, 'starts in 14 days');
  assert.equal(s('11-12', '12-31'), false, 'starts in 15 days');
  assert.equal(s('12-01', '01-31'), false);
  assert.equal(s('10-01', '10-28'), true, 'ends today, still active');
  assert.equal(s('12-01', '10-30'), true, 'wraps over New Year, active');
  assert.equal(s('01-01', '03-31'), false, 'next start is next year');
  // Across the year end: 20 Dec, season from 1 Jan.
  assert.equal(timing(rule('s', { season_from: '01-01', season_to: '01-31' }), [], '2026-12-20').notify, true);
  assert.deepEqual(timing(rule('s', { season_from: '01-01', season_to: '01-31' }), [], '2026-12-20').when, { kind: 'range', from: '2027-01-01', to: '2027-01-31' });
});

// ---------------------------------------------------------------- ledger: dedup, no-ops, reverts

test('a base change is sent once per topic; a re-run of the same commit sends nothing', async () => {
  const ledger = ledgerFor(BASES);
  const after = replace(BASES, 'fajr-base', { fixed_time: '05:50' });
  const f = mockFetch();
  const rules = [];
  const r = await live({ current: withRules(after), ledger, fetchImpl: f, waitForPublish: async (ids, rl) => { rules.push(...rl); return true; } });
  assert.equal(r.sent.length, 3);
  assert.deepEqual(fcmSends(f).map((m) => m.notification.body), ['أصبحت إقامة الفجر الساعة 05:50', "L'iqāmah del Fajr ora è alle 05:50", 'Fajr iqamah is now 05:50']);
  assert.deepEqual(rules, [{ id: 'fajr-base', hash: valueHash(after[0]) }]);
  for (const t of TOPICS) {
    assert.ok(ledger.has(iqamahKey(after[0], valueHash(after[0]), t)));
    assert.ok(!ledger.has(iqamahKey(BASES[0], valueHash(BASES[0]), t)), 'the old value is replaced');
  }
  const f2 = mockFetch();
  const r2 = await live({ current: withRules(after), ledger, fetchImpl: f2 });
  assert.equal(r2.sent.length, 0);
  assert.equal(f2.calls.length, 0);
});

test('no-op edits (updated_at, an unused column, row order) send nothing', async () => {
  const ledger = ledgerFor(BASES);
  const edited = replace(BASES, 'fajr-base', { updated_at: '2026-11-01T00:00:00Z', minutes: 3 }).reverse();
  const f = mockFetch();
  const r = await live({ current: withRules(edited), ledger, fetchImpl: f });
  assert.equal(r.todo.length, 0);
  assert.equal(f.calls.length, 0);
});

test('revert then redo: every step is announced (the ledger keeps the last value per row)', async () => {
  const ledger = ledgerFor(BASES);
  const steps = ['05:50', '05:45', '05:50'];
  for (const time of steps) {
    const f = mockFetch();
    const r = await live({ current: withRules(replace(BASES, 'fajr-base', { fixed_time: time })), ledger, fetchImpl: f });
    assert.equal(r.sent.length, 3, `step to ${time}`);
    assert.equal(fcmSends(f)[2].notification.body, `Fajr iqamah is now ${time}`);
  }
  assert.equal([...ledger].filter((k) => k.startsWith('iqamah:fajr:fajr-base:')).length, 3, 'one key per topic');
});

test('a change outside the window is recorded without a message and never announced later', async () => {
  const far = rule('fajr-spring', { season_from: '03-01', season_to: '04-30', fixed_time: '05:00' });
  const ledger = ledgerFor([...BASES, far]);
  const typo = replace([...BASES, far], 'fajr-spring', { fixed_time: '05:10' });
  const f = mockFetch();
  const r = await live({ current: withRules(typo), ledger, fetchImpl: f });
  assert.equal(r.sent.length, 0);
  assert.equal(r.iqamah.silent.length, 1);
  assert.ok(ledger.has(iqamahKey(typo[5], valueHash(typo[5]), 'announcements-en')));
  // Weeks later, within the window, an unrelated push still sends nothing for it.
  const r2 = await live({ current: withRules(typo), ledger, fetchImpl: f, now: new Date('2026-02-20T10:00:00Z') });
  assert.equal(r2.sent.length, 0);
});

test('a new on_date row within the window is announced; a removed row is not', async () => {
  const ledger = ledgerFor(BASES);
  const day = rule('fajr-1102', { on_date: '2026-11-02', fixed_time: '06:10' });
  const f = mockFetch();
  const r = await live({ current: withRules([...BASES, day]), ledger, fetchImpl: f });
  assert.deepEqual(fcmSends(f).map((m) => m.notification.body)[2], 'On 2 Nov, Fajr iqamah is 06:10');
  assert.equal(r.sent.length, 3);
  const f2 = mockFetch();
  await live({ current: withRules(BASES), ledger, fetchImpl: f2 });
  assert.equal(f2.calls.length, 0);
});

test('a failed topic is retried by the next run; the others are not re-sent', async () => {
  const ledger = ledgerFor(BASES);
  const after = replace(BASES, 'isha-base', { minutes: 10 });
  const f = mockFetch((url, init) => (JSON.parse(init.body).message.topic === 'announcements-it' ? { status: 400 } : null));
  const r = await live({ current: withRules(after), ledger, fetchImpl: f });
  assert.deepEqual(r.failed.map((x) => x.topic), ['announcements-it']);
  assert.equal(r.failed[0].id, 'iqamah:isha-base');
  const f2 = mockFetch();
  const r2 = await live({ current: withRules(after), ledger, fetchImpl: f2 });
  assert.deepEqual(fcmSends(f2).map((m) => m.topic), ['announcements-it']);
  assert.equal(r2.sent.length, 1);
});

test('announcements and iqamah changes go out in the same run after one wait', async () => {
  const ledger = ledgerFor(BASES);
  const content = withRules(replace(BASES, 'maghrib-base', { minutes: 7 }));
  content.announcements = [{
    id: 'a1', title_ar: 'ع', title_it: 't', title_en: 't', body_ar: 'ن', body_it: 'b', body_en: 'b', priority: 'normal',
    starts_at: '2026-10-28T00:00:00Z', published_at: '2026-10-28T00:00:00Z', expires_at: null,
  }];
  const waits = [];
  const f = mockFetch();
  const r = await live({ current: content, ledger, fetchImpl: f, waitForPublish: async (ids, rules) => { waits.push([ids, rules.map((x) => x.id)]); return true; } });
  assert.deepEqual(waits, [[['a1'], ['maghrib-base']]]);
  assert.deepEqual(fcmSends(f).map((m) => m.data.screen), ['announcements', 'announcements', 'announcements', 'prayers', 'prayers', 'prayers']);
  assert.equal(r.sent.length, 6);
});

// ---------------------------------------------------------------- cold start

test('cold start without a previous commit records the current rules and sends nothing', async () => {
  const ledger = new Set(['x|announcements-ar']);
  const lines = [];
  const f = mockFetch();
  const r = await live({ current: withRules(replace(BASES, 'fajr-base', { fixed_time: '05:50' })), previous: null, ledger, fetchImpl: f, log: (l) => lines.push(l) });
  assert.equal(f.calls.length, 0);
  assert.equal(r.sent.length, 0);
  assert.equal([...ledger].filter((k) => k.startsWith('iqamah:')).length, 15);
  assert.match(lines.join('\n'), /No iqamah entries in the send ledger and no previous commit/);
});

test('cold start (ledger without iqamah keys) uses the previous commit as the baseline', async () => {
  const ledger = new Set(['x|announcements-ar']);
  const f = mockFetch();
  const r = await live({ current: withRules(replace(BASES, 'fajr-base', { fixed_time: '05:50' })), previous: withRules(BASES), ledger, fetchImpl: f });
  assert.equal(r.sent.length, 3);
  // Full cold start (no ledger at all) behaves the same.
  const f2 = mockFetch();
  const r2 = await live({ current: withRules(replace(BASES, 'asr-base', { minutes: 15 })), previous: withRules(BASES), coldStart: true, ledger: new Set(), fetchImpl: f2 });
  assert.deepEqual(fcmSends(f2).map((m) => m.notification.body)[2], 'Asr iqamah is now adhan + 15 min');
  assert.equal(r2.sent.length, 3);
});

test('unchanged rows are refreshed in the ledger on every run (they never age out)', () => {
  const ledger = ledgerFor(BASES);
  const k = iqamahKey(BASES[0], valueHash(BASES[0]), 'announcements-ar');
  const times = new Map([[k, '2026-01-01T00:00:00.000Z']]);
  const plan = planIqamah({ current: withRules(BASES), ledger, times, now: NOW, topics: TOPICS });
  assert.equal(plan.changes.length, 0);
  assert.equal(times.has(k), false, 'time cleared so the ledger writer stamps it now');
  assert.ok(ledger.has(k));
});

// ---------------------------------------------------------------- log safety, waiting, CLI

test('rows with unsafe ids are ignored and no log line can start a workflow command', async () => {
  const evil = rule('x\n::add-mask::secret', { fixed_time: '05:50' });
  const ledger = ledgerFor(BASES);
  const lines = [];
  const r = await run({ current: withRules([...BASES, evil]), now: NOW, dryRun: true, ledger, log: (l) => lines.push(l) });
  assert.equal(r.todo.length, 0);
  for (const line of lines.join('\n').split('\n')) assert.ok(!/^\s*::/.test(line), line);
});

test('dry run prints the iqamah messages JSON-escaped, needs no secret and sends nothing', async () => {
  const lines = [];
  const f = mockFetch();
  const r = await run({ current: withRules(replace(BASES, 'fajr-base', { fixed_time: '05:50' })), previous: withRules(BASES), now: NOW, dryRun: true, fetchImpl: f, log: (l) => lines.push(l) });
  assert.equal(f.calls.length, 0);
  assert.equal(r.todo.length, 3);
  const out = lines.join('\n');
  assert.match(out, /DRY RUN: 3 message\(s\)/);
  assert.match(out, /"body": "Fajr iqamah is now 05:50"/);
  assert.match(out, /"screen": "prayers"/);
});

test('waitForContent also waits until each changed rule shows its new value', async () => {
  const before = rule('fajr-base');
  const after = rule('fajr-base', { fixed_time: '05:50' });
  let n = 0;
  const f = async () => {
    n += 1;
    const rows = n < 3 ? [before] : [after];
    return { ok: true, status: 200, text: async () => JSON.stringify({ announcements: [], iqamahRules: rows }) };
  };
  let t = 0;
  const lines = [];
  const done = await waitForContent([], { rules: [{ id: 'fajr-base', hash: valueHash(after) }], fetchImpl: f, sleep: async (ms) => { t += ms; }, clock: () => t, log: (l) => lines.push(l) });
  assert.equal(done, true);
  assert.equal(n, 3);
  assert.match(lines[0], /iqamah rule "fajr-base" \(old value\)/);
});

test('the fixture rules used here are valid content', () => {
  const content = { lessons: [], announcements: [], adhkar: [{ id: 'z', mosque_id: 'azzaituna', updated_at: '2026-10-26T00:00:00Z', collection: 'general', arabic: 'ا', translation_ar: 'ا', translation_it: 'a', translation_en: 'a', source: 's', repetitions: 1, sort: 0 }], iqamahRules: [...BASES, rule('fajr-winter', { season_from: '11-01', season_to: '02-28' }), rule('fajr-1108', { on_date: '2026-11-08' })], jumuahSessions: [] };
  assert.deepEqual(validateContent(content), []);
});

test('CLI: a dry run against the previous commit prints the iqamah change', () => {
  const dir = mkdtempSync(join(tmpdir(), 'iqamah-cli-'));
  const g = (...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8' }).trim();
  const base = { lessons: [], announcements: [], adhkar: [{ id: 'z', mosque_id: 'azzaituna', updated_at: '2026-10-26T00:00:00Z', collection: 'general', arabic: 'ا', translation_ar: 'ا', translation_it: 'a', translation_en: 'a', source: 's', repetitions: 1, sort: 0 }], iqamahRules: BASES, jumuahSessions: [] };
  g('init', '-q');
  g('config', 'user.email', 't@example.org');
  g('config', 'user.name', 't');
  writeFileSync(join(dir, 'content.json'), JSON.stringify(base));
  g('add', '.');
  g('commit', '-qm', 'one');
  writeFileSync(join(dir, 'content.json'), JSON.stringify({ ...base, iqamahRules: replace(BASES, 'fajr-base', { fixed_time: '05:50' }) }));
  const script = join(fileURLToPath(new URL('.', import.meta.url)), 'send-push.mjs');
  const out = execFileSync(process.execPath, [script], {
    cwd: dir,
    encoding: 'utf8',
    env: { ...process.env, DRY_RUN: '1', BEFORE_SHA: 'HEAD', FCM_LEDGER_PATH: '', GITHUB_ACTIONS: '', NOW: NOW.toISOString() },
  });
  assert.match(out, /Iqamah rules changed and taking effect soon: 1 \(fajr-base: base rule\)/);
  assert.match(out, /"title": "Fajr iqamah changed"/);
  assert.match(out, /"body": "Fajr iqamah is now 05:50"/);
});
