// Run: node --test .github/scripts/send-push.hardening.test.mjs
// Ledger-based sending, payload limits, failure isolation, waiting for the public file, log safety.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildMessages,
  coldStartIds,
  isRecent,
  ledgerKey,
  newAnnouncements,
  readLedger,
  run,
  sendMessage,
  TITLE_MAX_CHARS,
  waitForContent,
  writeLedger,
} from './send-push.mjs';

const NOW = new Date('2026-10-27T12:00:00Z');
const RECENT = '2026-10-27T00:00:00Z'; // within the 48 h send window of NOW
const TOPICS = ['announcements-ar', 'announcements-it', 'announcements-en'];
const quiet = () => {};
const MOSQUE = String.fromCodePoint(0x1f54c);

function ann(id, over = {}) {
  return {
    id,
    mosque_id: 'azzaituna',
    updated_at: '2026-10-01T00:00:00Z',
    title_ar: `عنوان ${id}`,
    title_it: `Titolo ${id}`,
    title_en: `Title ${id}`,
    body_ar: `نص ${id}`,
    body_it: `Testo ${id}`,
    body_en: `Body ${id}`,
    priority: 'normal',
    starts_at: '2026-10-01T00:00:00Z',
    expires_at: null,
    published_at: '2026-10-01T00:00:00Z',
    ...over,
  };
}

const tables = (announcements) => ({ lessons: [], announcements, adhkar: [], iqamahRules: [], jumuahSessions: [] });

const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const SA = {
  type: 'service_account',
  project_id: 'azzaituna-test',
  private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }),
  client_email: 'fcm@azzaituna-test.iam.gserviceaccount.com',
};

function mockFetch(handler) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    const { status = 200, body = {} } = handler(url, init, calls.length) ?? {};
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
    };
  };
  fn.calls = calls;
  return fn;
}

const okFetch = () =>
  mockFetch((url) => (url.includes('oauth2') ? { body: { access_token: 'tok' } } : { body: { name: 'projects/p/messages/1' } }));
const live = (over) => run({ now: NOW, dryRun: false, serviceAccountJson: JSON.stringify(SA), log: quiet, retryDelayMs: 1, ...over });
const fcmSends = (f) => f.calls.filter((c) => c.url.includes('fcm.googleapis.com')).map((c) => JSON.parse(c.init.body).message);
const sentIds = (f) => [...new Set(fcmSends(f).map((m) => m.data.id))];
const keysFor = (id) => TOPICS.map((t) => ledgerKey(id, t));
const hasLoneSurrogate = (s) => {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const n = s.charCodeAt(i + 1);
      if (!(n >= 0xdc00 && n <= 0xdfff)) return true;
      i += 1;
    } else if (c >= 0xdc00 && c <= 0xdfff) return true;
  }
  return false;
};

// ---------------------------------------------------------------- payload size

test('titles are cut to 65 code points with an ellipsis; Arabic and emoji are not split', () => {
  assert.equal(TITLE_MAX_CHARS, 65);
  const [ar, it, en] = buildMessages(ann('x', {
    title_ar: 'محاضرة '.repeat(30),
    title_it: MOSQUE.repeat(100),
    title_en: 't'.repeat(10_000),
    body_en: 'b'.repeat(5 * 1024 * 1024),
  }));
  for (const m of [ar, it, en]) {
    assert.ok(Array.from(m.notification.title).length <= 65);
    assert.ok(m.notification.title.endsWith('…'));
    assert.ok(Array.from(m.notification.body).length <= 140);
  }
  assert.equal(Array.from(it.notification.title).length, 65);
  assert.ok(!hasLoneSurrogate(it.notification.title));
  assert.equal(buildMessages(ann('x', { title_en: 'a'.repeat(65) }))[2].notification.title, 'a'.repeat(65));
  assert.ok(Buffer.byteLength(JSON.stringify({ message: en })) < 2048, 'payload stays small');
});

// ---------------------------------------------------------------- what gets sent

test('isRecent: published within the last 48 h, not in the future', () => {
  assert.equal(isRecent(ann('a', { published_at: '2026-10-25T12:00:00Z' }), NOW), true);
  assert.equal(isRecent(ann('a', { published_at: '2026-10-25T11:59:59Z' }), NOW), false);
  assert.equal(isRecent(ann('a', { published_at: '2026-10-27T12:00:01Z' }), NOW), false);
  assert.equal(isRecent(ann('a', { published_at: null }), NOW), false);
});

test('sends every active, recent announcement not in the ledger; old history is never re-sent', async () => {
  const current = { announcements: [ann('ancient'), ann('fresh', { published_at: RECENT }), ann('done', { published_at: RECENT })] };
  const f = okFetch();
  const r = await live({ current, fetchImpl: f, ledger: new Set(keysFor('done')) });
  assert.deepEqual(sentIds(f), ['fresh']);
  assert.equal(r.sent.length, 3);
});

test('fix-forward: an announcement added by a commit that failed validation is sent by the fixing commit', async () => {
  // Commit A added "conf" but failed validation: the push job never ran, so the ledger has no "conf".
  // Commit B fixes it. Its `before` (commit A) already contains "conf", so a git diff would miss it.
  const ledger = new Set(keysFor('welcome'));
  const commitA = { announcements: [ann('welcome'), ann('conf', { published_at: RECENT, title_en: '' })] };
  const commitB = { announcements: [ann('welcome'), ann('conf', { published_at: RECENT })] };
  assert.deepEqual(newAnnouncements(commitA, commitB), []); // what the old diff-based logic saw
  const f = okFetch();
  const r = await live({ current: commitB, previous: commitA, fetchImpl: f, ledger });
  assert.equal(r.sent.length, 3);
  assert.deepEqual(fcmSends(f).map((m) => m.data.id), ['conf', 'conf', 'conf']);
  assert.ok(keysFor('conf').every((k) => ledger.has(k)));
  // The next run sends nothing more.
  const f2 = okFetch();
  await live({ current: commitB, fetchImpl: f2, ledger });
  assert.equal(f2.calls.length, 0);
});

test('a topic that failed is retried by the next run, the others are not re-sent', async () => {
  const current = { announcements: [ann('a', { published_at: RECENT })] };
  const ledger = new Set();
  const failIt = mockFetch((url, init) => {
    if (url.includes('oauth2')) return { body: { access_token: 't' } };
    return JSON.parse(init.body).message.topic === 'announcements-it' ? { status: 503, body: 'down' } : { body: { name: 'n' } };
  });
  const r1 = await live({ current, fetchImpl: failIt, ledger });
  assert.equal(r1.failed.length, 1);
  const f2 = okFetch();
  const r2 = await live({ current, fetchImpl: f2, ledger });
  assert.deepEqual(fcmSends(f2).map((m) => m.topic), ['announcements-it']);
  assert.equal(r2.sent.length, 1);
});

test('cold start: announcements present at the previous commit are recorded, only new ones are sent', async () => {
  const previous = { announcements: [ann('old-recent', { published_at: RECENT })] };
  const current = { announcements: [ann('old-recent', { published_at: RECENT }), ann('new', { published_at: RECENT })] };
  const ledger = new Set();
  let seeded = 0;
  const f = okFetch();
  const r = await live({ current, previous, coldStart: true, fetchImpl: f, ledger, onSeeded: () => { seeded += 1; } });
  assert.deepEqual(sentIds(f), ['new']);
  assert.equal(r.sent.length, 3);
  assert.equal(seeded, 1);
  assert.ok(keysFor('old-recent').every((k) => ledger.has(k)));
  assert.deepEqual(coldStartIds(previous, current), ['old-recent']);
});

test('cold start with no previous commit records everything and sends nothing', async () => {
  const current = { announcements: [ann('a', { published_at: RECENT })] };
  const f = okFetch();
  const ledger = new Set();
  const r = await live({ current, previous: null, coldStart: true, fetchImpl: f, ledger });
  assert.equal(f.calls.length, 0);
  assert.equal(r.sent.length, 0);
  assert.equal(ledger.size, 3);
});

test('announcements with invalid ids are skipped (not a crash); the others still go out; logs stay one-line', async () => {
  const evil = 'x\n::add-mask::secret';
  const current = { announcements: [null, ann(evil, { published_at: RECENT }), ann('ok', { published_at: RECENT })] };
  const lines = [];
  const f = okFetch();
  const r = await live({ current, fetchImpl: f, log: (l) => lines.push(l) });
  assert.deepEqual(sentIds(f), ['ok']);
  assert.equal(r.failed.length, 0);
  for (const l of lines.join('\n').split('\n')) assert.ok(!/^\s*::add-mask::/.test(l), `log line starts a command: ${l}`);
  assert.ok(lines.some((l) => l.startsWith('::warning::skipping an announcement with an invalid id "x\\n::add-mask::secret"')));
});

// ---------------------------------------------------------------- failures do not abort the rest

test('a network error on one topic is retried, then reported; the remaining topics still go out', async () => {
  let itCalls = 0;
  const f = mockFetch((url, init) => {
    if (url.includes('oauth2')) return { body: { access_token: 't' } };
    if (JSON.parse(init.body).message.topic === 'announcements-it') {
      itCalls += 1;
      throw new TypeError('fetch failed');
    }
    return { body: { name: 'n' } };
  });
  const current = { announcements: [ann('a', { published_at: RECENT }), ann('b', { published_at: RECENT })] };
  const r = await live({ current, fetchImpl: f });
  assert.equal(itCalls, 6, 'three attempts for each of the two "it" messages');
  assert.equal(r.sent.length, 4);
  assert.equal(r.failed.length, 2);
  assert.match(r.failed[0].error, /network error/);
});

test('sendMessage gives up after 3 attempts on 5xx and does not retry 4xx', async () => {
  let n = 0;
  const f500 = mockFetch(() => { n += 1; return { status: 500, body: 'boom' }; });
  await assert.rejects(sendMessage('p', 't', { topic: 'x' }, { fetchImpl: f500, retryDelayMs: 1 }), /HTTP 500/);
  assert.equal(n, 3);
  n = 0;
  const f404 = mockFetch(() => { n += 1; return { status: 404, body: 'nope' }; });
  await assert.rejects(sendMessage('p', 't', { topic: 'x' }, { fetchImpl: f404, retryDelayMs: 1 }), /HTTP 404/);
  assert.equal(n, 1);
});

test('a ledger write error does not turn a sent message into a failure', async () => {
  const lines = [];
  const r = await live({
    current: { announcements: [ann('a', { published_at: RECENT })] },
    fetchImpl: okFetch(),
    onSent: () => { throw new Error('disk full'); },
    log: (l) => lines.push(l),
  });
  assert.equal(r.sent.length, 3);
  assert.equal(r.failed.length, 0);
  assert.match(lines.join('\n'), /could not save the send ledger/);
});

// ---------------------------------------------------------------- waiting for the public file

test('run waits for the public content.json (after checking the secret) before sending', async () => {
  const order = [];
  const f = mockFetch((url) => {
    order.push(url.includes('oauth2') ? 'token' : 'send');
    return url.includes('oauth2') ? { body: { access_token: 't' } } : { body: { name: 'n' } };
  });
  await live({
    current: { announcements: [ann('a', { published_at: RECENT })] },
    fetchImpl: f,
    waitForPublish: async (ids) => { order.push(`wait:${ids.join(',')}`); return true; },
  });
  assert.deepEqual(order, ['wait:a', 'token', 'send', 'send', 'send']);
  // A bad secret fails before any waiting.
  let waited = false;
  await assert.rejects(live({
    current: { announcements: [ann('a', { published_at: RECENT })] },
    serviceAccountJson: 'nope',
    waitForPublish: async () => { waited = true; },
  }), /not valid JSON/);
  assert.equal(waited, false);
});

test('a timed-out wait still sends', async () => {
  const f = okFetch();
  const r = await live({ current: { announcements: [ann('a', { published_at: RECENT })] }, fetchImpl: f, waitForPublish: async () => false });
  assert.equal(r.sent.length, 3);
});

test('dry run never waits and never sends', async () => {
  let waited = false;
  const f = okFetch();
  await run({ current: { announcements: [ann('a', { published_at: RECENT })] }, now: NOW, dryRun: true, fetchImpl: f, log: quiet, waitForPublish: async () => { waited = true; } });
  assert.equal(waited, false);
  assert.equal(f.calls.length, 0);
});

test('waitForContent polls until every id is listed', async () => {
  let n = 0;
  const f = mockFetch(() => {
    n += 1;
    if (n === 1) return { status: 404, body: 'x' };
    if (n === 2) return { body: { announcements: [{ id: 'a' }] } };
    return { body: { announcements: [{ id: 'a' }, { id: 'b' }] } };
  });
  let t = 0;
  const done = await waitForContent(['a', 'b', 'a'], { fetchImpl: f, url: 'https://example.test/content.json', timeoutMs: 60_000, intervalMs: 10_000, sleep: async (ms) => { t += ms; }, clock: () => t, log: quiet });
  assert.equal(done, true);
  assert.equal(n, 3);
  assert.equal(f.calls[0].url, 'https://example.test/content.json');
});

test('waitForContent gives up after about 6 minutes with a warning; default URL is the one the app reads', async () => {
  const f = mockFetch(() => ({ body: { announcements: [] } }));
  let t = 0;
  const lines = [];
  const done = await waitForContent(['a'], { fetchImpl: f, sleep: async (ms) => { t += ms; }, clock: () => t, log: (l) => lines.push(l) });
  assert.equal(done, false);
  assert.ok(t <= 6 * 60_000, `waited ${t} ms`);
  assert.ok(f.calls.length >= 20, `checked ${f.calls.length} times`);
  assert.match(lines.at(-1), /^::warning::public content.json still not up to date/);
  assert.equal(f.calls[0].url, 'https://raw.githubusercontent.com/AnasOsman1/azzaituna-content/main/content.json');
});

test('waitForContent survives network errors and invalid JSON', async () => {
  let n = 0;
  const f = mockFetch(() => {
    n += 1;
    if (n === 1) throw new Error('ECONNRESET');
    if (n === 2) return { body: '{ not json' };
    return { body: { announcements: [{ id: 'a' }] } };
  });
  let t = 0;
  assert.equal(await waitForContent(['a'], { fetchImpl: f, sleep: async (ms) => { t += ms; }, clock: () => t, log: quiet }), true);
  assert.equal(n, 3);
});

// ---------------------------------------------------------------- ledger file

test('ledger file: round trip, old array format accepted, missing or broken file = cold start, old entries pruned', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ledger-test-'));
  const p = join(dir, 'sub', 'sent.json');
  assert.equal(readLedger(p, NOW, quiet).cold, true);
  const keys = new Set(['a|announcements-ar', 'b|announcements-ar']);
  const times = new Map([['a|announcements-ar', '2026-01-01T00:00:00.000Z']]);
  writeLedger(p, keys, times, NOW);
  const back = readLedger(p, NOW, quiet);
  assert.equal(back.cold, false);
  assert.deepEqual([...back.keys], ['b|announcements-ar'], 'entries older than 180 days are dropped');
  assert.equal(JSON.parse(readFileSync(p, 'utf8')).version, 2);
  writeFileSync(p, JSON.stringify({ sent: ['x|announcements-it'] }));
  assert.deepEqual([...readLedger(p, NOW, quiet).keys], ['x|announcements-it']);
  writeFileSync(p, '{ broken');
  assert.equal(readLedger(p, NOW, quiet).cold, true);
});

// ---------------------------------------------------------------- CLI

function tempRepo(content) {
  const dir = mkdtempSync(join(tmpdir(), 'cli-test-'));
  const g = (...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8' }).trim();
  g('init', '-q');
  g('config', 'user.email', 't@example.org');
  g('config', 'user.name', 't');
  writeFileSync(join(dir, 'content.json'), typeof content === 'string' ? content : JSON.stringify(content));
  g('add', '.');
  g('commit', '-qm', 'content');
  return dir;
}

function runScript(script, cwd, env = {}) {
  const path = join(fileURLToPath(new URL('.', import.meta.url)), script);
  try {
    const stdout = execFileSync(process.execPath, [path], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, DRY_RUN: '1', BEFORE_SHA: '', FCM_LEDGER_PATH: '', GITHUB_ACTIONS: '', ...env },
    });
    return { code: 0, out: stdout };
  } catch (err) {
    return { code: err.status, out: `${err.stdout}\n${err.stderr}` };
  }
}

test('CLI: poison content.json fails both scripts, and no output line starts a workflow command', () => {
  const dir = tempRepo(tables([
    ann('x\n::add-mask::secret\n::warning::pwned', { published_at: RECENT }),
    null,
    ann('late', { published_at: null, image_url: 'https://raw.githubusercontent.com@evil.example/a.jpg', image_width: 1, image_height: 10000 }),
  ]));
  for (const script of ['validate-content.mjs', 'send-push.mjs']) {
    const { code, out } = runScript(script, dir);
    assert.equal(code, 1, `${script} must exit 1`);
    assert.match(out, /::error/);
    for (const line of out.split(/\r?\n/)) {
      assert.ok(!/^\s*::(add-mask|warning|stop-commands|set-output|set-env|add-path)/.test(line), `${script}: ${line}`);
    }
  }
});

test('CLI: dry run on valid content with no ledger behaves like the old diff (cold start)', () => {
  const dir = tempRepo(tables([ann('a', { published_at: RECENT })]));
  const { code, out } = runScript('send-push.mjs', dir, { NOW: NOW.toISOString() });
  assert.equal(code, 0, out);
  assert.match(out, /No previous commit/);
  assert.match(out, /Nothing to send/);
});
