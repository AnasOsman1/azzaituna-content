// Run: node --test .github/scripts/send-push.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createVerify, generateKeyPairSync } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildMessages,
  FCM_SCOPE,
  getAccessToken,
  isActive,
  ledgerKey,
  loadPrevious,
  makeJwt,
  newAnnouncements,
  parseServiceAccount,
  run,
  truncate,
} from './send-push.mjs';
import { parseContent, validateContent } from './validate-content.mjs';

const NOW = new Date('2026-10-27T12:00:00Z');

function ann(id, over = {}) {
  return {
    id,
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

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const SA = {
  type: 'service_account',
  project_id: 'azzaituna-test',
  private_key_id: 'kid123',
  private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }),
  client_email: 'fcm@azzaituna-test.iam.gserviceaccount.com',
  token_uri: 'https://oauth2.googleapis.com/token',
};

const decode = (part) => JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));

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
  mockFetch((url) =>
    url.includes('oauth2') ? { body: { access_token: 'tok-abc' } } : { body: { name: 'projects/p/messages/1' } },
  );

// ---------------------------------------------------------------- diff

test('newAnnouncements returns ids present now but absent before', () => {
  const prev = { announcements: [ann('a'), ann('b')] };
  const curr = { announcements: [ann('a'), ann('b'), ann('c'), ann('d')] };
  assert.deepEqual(newAnnouncements(prev, curr).map((a) => a.id), ['c', 'd']);
});

test('newAnnouncements ignores edits and removals of existing ids', () => {
  const prev = { announcements: [ann('a'), ann('b')] };
  const curr = { announcements: [ann('a', { title_en: 'edited' })] };
  assert.deepEqual(newAnnouncements(prev, curr), []);
});

test('newAnnouncements sends nothing when there is no previous content (first push)', () => {
  assert.deepEqual(newAnnouncements(null, { announcements: [ann('a')] }), []);
});

test('newAnnouncements treats a previous file without announcements as empty', () => {
  assert.deepEqual(newAnnouncements({ lessons: [] }, { announcements: [ann('a')] }).map((a) => a.id), ['a']);
});

// ---------------------------------------------------------------- active filter

test('isActive: started, not expired, published', () => {
  assert.equal(isActive(ann('a'), NOW), true);
  assert.equal(isActive(ann('a', { expires_at: '2026-10-28T00:00:00Z' }), NOW), true);
});

test('isActive: future start, past/equal expiry, future publish are inactive', () => {
  assert.equal(isActive(ann('a', { starts_at: '2026-10-27T12:00:01Z' }), NOW), false);
  assert.equal(isActive(ann('a', { expires_at: '2026-10-27T11:59:59Z' }), NOW), false);
  assert.equal(isActive(ann('a', { expires_at: NOW.toISOString() }), NOW), false);
  assert.equal(isActive(ann('a', { published_at: '2026-11-01T00:00:00Z' }), NOW), false);
});

test('isActive: starts_at exactly now is active; missing published_at is allowed', () => {
  assert.equal(isActive(ann('a', { starts_at: NOW.toISOString(), published_at: undefined }), NOW), true);
});

// ---------------------------------------------------------------- payloads

test('buildMessages: one message per language topic with the right fields', () => {
  const msgs = buildMessages(ann('x', { priority: 'urgent' }));
  assert.deepEqual(msgs.map((m) => m.topic), ['announcements-ar', 'announcements-it', 'announcements-en']);
  for (const [i, lang] of ['ar', 'it', 'en'].entries()) {
    const m = msgs[i];
    assert.equal(m.notification.title, ann('x')[`title_${lang}`]);
    assert.equal(m.notification.body, ann('x')[`body_${lang}`]);
    assert.equal(m.android.priority, 'HIGH');
    assert.equal(m.android.notification.channel_id, 'announcements'); // urgent uses the same channel
    assert.deepEqual(m.data, { screen: 'announcements', id: 'x' });
  }
});

test('truncate: short text unchanged, long text cut to 140 code points with ellipsis', () => {
  assert.equal(truncate('  hello   world '), 'hello world');
  const long = 'a'.repeat(200);
  const t = truncate(long);
  assert.equal(Array.from(t).length, 140);
  assert.ok(t.endsWith('…'));
  assert.equal(truncate('b'.repeat(140)), 'b'.repeat(140));
});

test('truncate counts code points (Arabic and emoji are not split)', () => {
  const arabic = 'محاضرة '.repeat(40);
  const t = truncate(arabic);
  assert.ok(Array.from(t).length <= 140);
  const emoji = '\u{1F54C}'.repeat(150);
  const e = truncate(emoji);
  assert.equal(Array.from(e).length, 140);
  assert.ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(e), 'no lone high surrogate');
});

test('buildMessages truncates long bodies but not titles', () => {
  const m = buildMessages(ann('x', { body_en: 'w '.repeat(200) }))[2];
  assert.ok(Array.from(m.notification.body).length <= 140);
});

// ---------------------------------------------------------------- content.json handling

test('parseContent fails loudly on invalid JSON and on non-object roots', () => {
  assert.throws(() => parseContent('{ "announcements": [ }'), /not valid JSON/);
  assert.throws(() => parseContent('[]'), /JSON object/);
  assert.throws(() => parseContent(''), /not valid JSON/);
});

test('validateContent accepts complete announcements', () => {
  assert.deepEqual(validateContent({ announcements: [ann('a'), ann('b')] }), []);
  const withImage = ann('c', { image_url: 'https://example.org/p.jpg', image_width: 10, image_height: 20 });
  assert.deepEqual(validateContent({ announcements: [withImage] }), []);
});

test('validateContent reports missing text fields, bad image_url, duplicates', () => {
  const bad = ann('a', { body_it: '  ' });
  delete bad.title_ar;
  const errs = validateContent({
    announcements: [
      bad,
      ann('a'),
      ann('h', { image_url: 'http://example.org/p.jpg', image_width: 1, image_height: 1 }),
      ann('s', { image_url: 'https://example.org/a b.jpg', image_width: 1, image_height: 1 }),
      ann('p', { priority: 'high' }),
    ],
  });
  const text = errs.join('\n');
  assert.match(text, /"title_ar"/);
  assert.match(text, /"body_it"/);
  assert.match(text, /duplicate id/);
  assert.match(text, /id "h".*image_url/);
  assert.match(text, /id "s".*image_url/);
  assert.match(text, /"priority"/);
});

test('validateContent requires an announcements array', () => {
  assert.deepEqual(validateContent({}), ['"announcements" must be an array']);
});

test('the real content.json is valid', async () => {
  const { readFileSync } = await import('node:fs');
  const path = new URL('../../content.json', import.meta.url);
  assert.deepEqual(validateContent(parseContent(readFileSync(path, 'utf8'))), []);
});

// ---------------------------------------------------------------- service account / JWT

test('parseServiceAccount never echoes the secret', () => {
  const secret = '{"private_key": "-----BEGIN SUPERSECRET';
  assert.throws(() => parseServiceAccount(secret), (err) => {
    assert.ok(!err.message.includes('SUPERSECRET'));
    return /not valid JSON/.test(err.message);
  });
  assert.throws(() => parseServiceAccount(''), /empty or not set/);
  assert.throws(() => parseServiceAccount('{"project_id":"p"}'), /client_email/);
});

test('makeJwt: RS256 header, claims for the FCM scope, valid signature', () => {
  const jwt = makeJwt(SA, 1_800_000_000);
  const [h, c, s] = jwt.split('.');
  assert.deepEqual(decode(h), { alg: 'RS256', typ: 'JWT', kid: 'kid123' });
  assert.deepEqual(decode(c), {
    iss: SA.client_email,
    scope: FCM_SCOPE,
    aud: 'https://oauth2.googleapis.com/token',
    iat: 1_800_000_000,
    exp: 1_800_003_600,
  });
  const ok = createVerify('RSA-SHA256').update(`${h}.${c}`).verify(publicKey, Buffer.from(s, 'base64url'));
  assert.equal(ok, true);
});

test('getAccessToken posts a jwt-bearer grant and returns the token', async () => {
  const f = okFetch();
  const token = await getAccessToken(SA, { fetchImpl: f, nowSeconds: 1_800_000_000 });
  assert.equal(token, 'tok-abc');
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].url, 'https://oauth2.googleapis.com/token');
  const form = new URLSearchParams(f.calls[0].init.body);
  assert.equal(form.get('grant_type'), 'urn:ietf:params:oauth:grant-type:jwt-bearer');
  assert.equal(decode(form.get('assertion').split('.')[1]).iss, SA.client_email);
});

test('getAccessToken surfaces OAuth errors', async () => {
  const f = mockFetch(() => ({ status: 400, body: { error: 'invalid_grant' } }));
  await assert.rejects(getAccessToken(SA, { fetchImpl: f }), /HTTP 400.*invalid_grant/);
});

// ---------------------------------------------------------------- end to end (mock fetch)

const prev = { announcements: [ann('old')] };
const curr = {
  announcements: [
    ann('old'),
    ann('new1'),
    ann('future', { starts_at: '2026-12-01T00:00:00Z' }),
    ann('expired', { expires_at: '2026-10-01T00:00:01Z' }),
  ],
};
const quiet = () => {};

test('run sends 3 topic messages per new active announcement with a bearer token', async () => {
  const f = okFetch();
  const r = await run({ previous: prev, current: curr, now: NOW, dryRun: false, serviceAccountJson: JSON.stringify(SA), fetchImpl: f, log: quiet });
  assert.equal(r.sent.length, 3);
  assert.deepEqual(r.failed, []);
  const sends = f.calls.filter((c) => c.url.includes('fcm.googleapis.com'));
  assert.equal(sends.length, 3);
  for (const c of sends) {
    assert.equal(c.url, 'https://fcm.googleapis.com/v1/projects/azzaituna-test/messages:send');
    assert.equal(c.init.headers.authorization, 'Bearer tok-abc');
    const { message } = JSON.parse(c.init.body);
    assert.equal(message.data.id, 'new1');
  }
});

test('dry run prints messages and makes no network calls, needs no secret', async () => {
  const f = okFetch();
  const lines = [];
  const r = await run({ previous: prev, current: curr, now: NOW, dryRun: true, serviceAccountJson: undefined, fetchImpl: f, log: (l) => lines.push(l) });
  assert.equal(f.calls.length, 0);
  assert.equal(r.planned.length, 3);
  assert.match(lines.join('\n'), /DRY RUN: 3 message/);
  assert.match(lines.join('\n'), /announcements-ar/);
});

test('ledger: a re-run for the same commit does not send again', async () => {
  const ledger = new Set();
  await run({ previous: prev, current: curr, now: NOW, dryRun: false, serviceAccountJson: JSON.stringify(SA), fetchImpl: okFetch(), ledger, log: quiet });
  assert.equal(ledger.size, 3);
  const f2 = okFetch();
  const r2 = await run({ previous: prev, current: curr, now: NOW, dryRun: false, serviceAccountJson: JSON.stringify(SA), fetchImpl: f2, ledger, log: quiet });
  assert.equal(f2.calls.length, 0);
  assert.equal(r2.sent.length, 0);
});

test('a failed topic is reported, the others still go out, and only successes enter the ledger', async () => {
  const f = mockFetch((url, init) => {
    if (url.includes('oauth2')) return { body: { access_token: 't' } };
    return JSON.parse(init.body).message.topic === 'announcements-it'
      ? { status: 400, body: { error: { message: 'bad' } } }
      : { body: { name: 'n' } };
  });
  const ledger = new Set();
  const r = await run({ previous: prev, current: curr, now: NOW, dryRun: false, serviceAccountJson: JSON.stringify(SA), fetchImpl: f, ledger, log: quiet, retryDelayMs: 1 });
  assert.equal(r.sent.length, 2);
  assert.equal(r.failed.length, 1);
  assert.ok(!ledger.has(ledgerKey('new1', 'announcements-it')));
});

test('5xx is retried', async () => {
  let n = 0;
  const f = mockFetch((url) => {
    if (url.includes('oauth2')) return { body: { access_token: 't' } };
    n += 1;
    return n === 1 ? { status: 503, body: 'unavailable' } : { body: { name: 'n' } };
  });
  const r = await run({ previous: prev, current: { announcements: [ann('old'), ann('z')] }, now: NOW, dryRun: false, serviceAccountJson: JSON.stringify(SA), fetchImpl: f, log: quiet, retryDelayMs: 1 });
  assert.equal(r.sent.length, 3);
  assert.equal(r.failed.length, 0);
});

test('live run with an invalid service account fails without sending', async () => {
  const f = okFetch();
  await assert.rejects(
    run({ previous: prev, current: curr, now: NOW, dryRun: false, serviceAccountJson: 'nope', fetchImpl: f, log: quiet }),
    /not valid JSON/,
  );
  assert.equal(f.calls.length, 0);
});

// ---------------------------------------------------------------- git before-ref handling

test('loadPrevious: zero/empty/unknown before-ref and missing or invalid old file => null', () => {
  const dir = mkdtempSync(join(tmpdir(), 'push-test-'));
  const g = (...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8' }).trim();
  g('init', '-q');
  g('config', 'user.email', 't@example.org');
  g('config', 'user.name', 't');
  writeFileSync(join(dir, 'README'), 'x');
  g('add', '.');
  g('commit', '-qm', 'no content yet');
  const noFile = g('rev-parse', 'HEAD');
  writeFileSync(join(dir, 'content.json'), '{ broken');
  g('add', '.');
  g('commit', '-qm', 'broken');
  const broken = g('rev-parse', 'HEAD');
  writeFileSync(join(dir, 'content.json'), JSON.stringify({ announcements: [ann('a')] }));
  g('add', '.');
  g('commit', '-qm', 'good');
  const good = g('rev-parse', 'HEAD');

  const cwd = process.cwd();
  process.chdir(dir);
  try {
    assert.equal(loadPrevious('', 'content.json', quiet), null);
    assert.equal(loadPrevious('0000000000000000000000000000000000000000', 'content.json', quiet), null);
    assert.equal(loadPrevious('deadbeefdeadbeefdeadbeefdeadbeefdeadbeef', 'content.json', quiet), null);
    assert.equal(loadPrevious(noFile, 'content.json', quiet), null);
    assert.equal(loadPrevious(broken, 'content.json', quiet), null);
    assert.deepEqual(loadPrevious(good, 'content.json', quiet).announcements.map((a) => a.id), ['a']);
  } finally {
    process.chdir(cwd);
  }
});
