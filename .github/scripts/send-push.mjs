#!/usr/bin/env node
// Sends one FCM push per language topic for every announcement that is active, was published
// within the last 48 hours and is not yet in the send ledger.
//
// The ledger (FCM_LEDGER_PATH, kept in the GitHub Actions cache across runs) is the source of
// truth for "already sent", not the git diff. So a commit that fixes an announcement added by an
// earlier commit that failed validation still sends it, and a failed topic is retried by the next
// run. The 48-hour bound means a lost ledger can never re-send old history.
//
// Cold start (no ledger file, or an unreadable one): every announcement already present at
// BEFORE_SHA is recorded as handled without sending (the behaviour before the ledger existed),
// then the rules above apply. With no usable BEFORE_SHA either, every current announcement is
// recorded and nothing is sent.
//
// It also announces iqamah rule changes that take effect within 14 days (one message per
// language topic per changed rule row, data {screen: "prayers"}); see iqamah-push.mjs. Their
// ledger keys are "iqamah:<prayer>:<row id>:<value hash>|<topic>", one per row and topic, holding
// the last value handled. With no iqamah key in the ledger yet, the rules at BEFORE_SHA are
// recorded as handled first (or, without BEFORE_SHA, the current rules: nothing is sent).
//
// Before sending, the script waits (up to PUBLISH_WAIT_MS) until the public content.json that
// the app downloads lists every id about to be sent (and every changed iqamah rule with its new
// value), so a tap on the notification finds it.
//
// Dependency-free: Node >= 20 built-ins only (crypto for the RS256 JWT, global fetch).
//
// Environment:
//   BEFORE_SHA                commit used only on a cold start (see above)
//   CONTENT_PATH              default "content.json"
//   DRY_RUN=1                 print the messages, send nothing, no secret needed, ledger untouched
//   FCM_SERVICE_ACCOUNT_JSON  service-account key JSON (required unless DRY_RUN=1)
//   FCM_LEDGER_PATH           JSON file recording what has been sent (persisted by the workflow)
//   CONTENT_RAW_URL           public content.json to wait for (default: the app's URL)
//   PUBLISH_WAIT_MS           how long to wait for it (default 360000; 0 = do not wait)
//   NOW                       optional ISO date-time overriding the clock (testing)

import { createSign } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  escapeCommandData,
  escapeInvisible,
  ID_PATTERN,
  LANGS,
  logSafe,
  parseContent,
  parseStrictDate,
  validateText,
} from './validate-content.mjs';
import { hasIqamahEntries, IQAMAH_WINDOW_DAYS, iqamahText, planIqamah, recordRule, ruleRows, valueHash } from './iqamah-push.mjs';

export const BODY_MAX_CHARS = 140;
export const TITLE_MAX_CHARS = 65;
export const RECENT_WINDOW_MS = 48 * 60 * 60 * 1000;
export const LEDGER_KEEP_MS = 180 * 24 * 60 * 60 * 1000;
export const CONTENT_RAW_URL = 'https://raw.githubusercontent.com/AnasOsman1/azzaituna-content/main/content.json';
export const PUBLISH_WAIT_MS = 6 * 60 * 1000;
export const PUBLISH_POLL_MS = 15 * 1000;
export const FCM_SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';
export const DEFAULT_TOKEN_URI = 'https://oauth2.googleapis.com/token';
const ZERO_SHA = /^0+$/;

/** A workflow warning line whose message cannot break out of the line. */
const warning = (msg) => `::warning::${escapeCommandData(msg)}`;

// ---------------------------------------------------------------- pure helpers

/** Trims, collapses whitespace and cuts to `max` characters (code points), ending with an ellipsis. */
export function truncate(text, max = BODY_MAX_CHARS) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim();
  const chars = Array.from(s);
  if (chars.length <= max) return s;
  return chars.slice(0, max - 1).join('').trimEnd() + '…';
}

/** Active = published_at (if set) <= now, starts_at <= now, expires_at null or > now. */
export function isActive(a, now) {
  const t = now.getTime();
  const starts = parseStrictDate(a.starts_at);
  if (Number.isNaN(starts) || starts > t) return false;
  if (a.published_at != null) {
    const pub = parseStrictDate(a.published_at);
    if (Number.isNaN(pub) || pub > t) return false;
  }
  if (a.expires_at != null) {
    const exp = parseStrictDate(a.expires_at);
    if (Number.isNaN(exp) || exp <= t) return false;
  }
  return true;
}

/** Recent = published_at within the last 48 hours (and not in the future). */
export function isRecent(a, now, windowMs = RECENT_WINDOW_MS) {
  const pub = parseStrictDate(a.published_at);
  const t = now.getTime();
  return !Number.isNaN(pub) && pub <= t && t - pub <= windowMs;
}

const validId = (a) => a !== null && typeof a === 'object' && typeof a.id === 'string' && ID_PATTERN.test(a.id);

/** Announcements whose id is in `current` but not in `previous` (previous === null => none). */
export function newAnnouncements(previous, current) {
  if (previous === null) return [];
  const before = new Set(
    (Array.isArray(previous?.announcements) ? previous.announcements : [])
      .map((a) => a?.id)
      .filter((id) => typeof id === 'string'),
  );
  return (current.announcements ?? []).filter((a) => !before.has(a?.id));
}

/** One FCM v1 message per language topic. */
export function buildMessages(a) {
  return LANGS.map((lang) => ({
    topic: `announcements-${lang}`,
    notification: {
      title: truncate(a[`title_${lang}`], TITLE_MAX_CHARS),
      body: truncate(a[`body_${lang}`], BODY_MAX_CHARS),
    },
    android: {
      priority: 'HIGH',
      // Same tag => a duplicate delivery replaces the tray entry instead of adding a second one.
      notification: { channel_id: 'announcements', tag: `announcement-${a.id}` },
    },
    data: { screen: 'announcements', id: String(a.id) },
  }));
}

/**
 * One FCM v1 message per language topic for a changed iqamah rule (see iqamah-push.mjs).
 * The Android tag names the row and the new value, so a duplicate delivery of the same change
 * replaces its tray entry, while a different change never hides an earlier one.
 */
export function buildIqamahMessages(change) {
  const { row, hash, timing } = change;
  return LANGS.map((lang) => {
    const { title, body } = iqamahText(lang, row, timing);
    return {
      topic: `announcements-${lang}`,
      notification: { title: truncate(title, TITLE_MAX_CHARS), body: truncate(body, BODY_MAX_CHARS) },
      android: {
        priority: 'HIGH',
        notification: { channel_id: 'announcements', tag: `iqamah-${row.id}-${hash}` },
      },
      data: { screen: 'prayers' },
    };
  });
}

export const ledgerKey = (id, topic) => `${id}|${topic}`;
export const TOPICS = LANGS.map((l) => `announcements-${l}`);

/**
 * What to send now: one message per topic for every announcement with a valid id that is
 * active and recent. `messages` are all of them; the caller drops those already in the ledger.
 */
export function planMessages(current, now, log = () => {}) {
  const list = Array.isArray(current?.announcements) ? current.announcements : [];
  const candidates = [];
  for (const a of list) {
    if (!validId(a)) {
      log(warning(`skipping an announcement with an invalid id ${logSafe(a?.id)}`));
      continue;
    }
    if (!isActive(a, now)) continue;
    if (!isRecent(a, now)) continue;
    candidates.push(a);
  }
  return {
    candidates,
    messages: candidates.flatMap((a) => buildMessages(a).map((message) => ({ id: a.id, message }))),
  };
}

/** Ids recorded as handled on a cold start (see the header comment). */
export function coldStartIds(previous, current) {
  const source = previous === null ? current : previous;
  const list = Array.isArray(source?.announcements) ? source.announcements : [];
  return list.filter(validId).map((a) => a.id);
}

// ---------------------------------------------------------------- auth

/** Parses the service-account JSON without ever echoing its content. */
export function parseServiceAccount(text) {
  if (typeof text !== 'string' || text.trim() === '') {
    throw new Error('FCM_SERVICE_ACCOUNT_JSON is empty or not set');
  }
  let sa;
  try {
    sa = JSON.parse(text);
  } catch {
    // Do not include the parser message: it can quote part of the secret.
    throw new Error('FCM_SERVICE_ACCOUNT_JSON is not valid JSON');
  }
  for (const k of ['project_id', 'client_email', 'private_key']) {
    if (typeof sa?.[k] !== 'string' || sa[k] === '') {
      throw new Error(`FCM_SERVICE_ACCOUNT_JSON is missing "${k}"`);
    }
  }
  return sa;
}

const b64url = (buf) => Buffer.from(buf).toString('base64url');

/** RS256-signed JWT for the OAuth2 jwt-bearer grant. */
export function makeJwt(sa, nowSeconds = Math.floor(Date.now() / 1000)) {
  const header = { alg: 'RS256', typ: 'JWT' };
  if (sa.private_key_id) header.kid = sa.private_key_id;
  const claims = {
    iss: sa.client_email,
    scope: FCM_SCOPE,
    aud: sa.token_uri || DEFAULT_TOKEN_URI,
    iat: nowSeconds,
    exp: nowSeconds + 3600,
  };
  const unsigned = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(claims))}`;
  const signature = createSign('RSA-SHA256').update(unsigned).sign(sa.private_key);
  return `${unsigned}.${b64url(signature)}`;
}

/** Exchanges the signed JWT for an OAuth2 access token. */
export async function getAccessToken(sa, { fetchImpl = globalThis.fetch, nowSeconds } = {}) {
  const res = await fetchImpl(sa.token_uri || DEFAULT_TOKEN_URI, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: makeJwt(sa, nowSeconds),
    }).toString(),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`OAuth token request failed: HTTP ${res.status} ${logSafe(text, 300)}`);
  let token;
  try {
    token = JSON.parse(text).access_token;
  } catch {
    token = undefined;
  }
  if (typeof token !== 'string' || !token) throw new Error('OAuth token response had no access_token');
  return token;
}

// ---------------------------------------------------------------- waiting for the public file

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Polls the public content.json (the URL the app downloads, so the check sees what a phone
 * sees, CDN cache included) until it lists every announcement id in `ids` and every iqamah rule
 * in `rules` ({id, hash}) with its new value (same valueHash). Returns true when it does, false
 * after `timeoutMs` (a warning is logged; the caller sends anyway).
 */
export async function waitForContent(ids, {
  url = CONTENT_RAW_URL,
  fetchImpl = globalThis.fetch,
  timeoutMs = PUBLISH_WAIT_MS,
  intervalMs = PUBLISH_POLL_MS,
  sleep = delay,
  clock = Date.now,
  log = console.log,
  rules = [],
} = {}) {
  const wanted = [...new Set(ids)];
  const wantedRules = [...new Map(rules.map((r) => [`${r.id}|${r.hash}`, r])).values()];
  if (wanted.length === 0 && wantedRules.length === 0) return true;
  const deadline = clock() + timeoutMs;
  let missing = wanted;
  let last = '';
  for (let attempt = 1; ; attempt++) {
    try {
      const signal = typeof AbortSignal.timeout === 'function' ? AbortSignal.timeout(20_000) : undefined;
      const res = await fetchImpl(url, { cache: 'no-store', signal });
      if (res.ok) {
        const data = JSON.parse(await res.text());
        const have = new Set((Array.isArray(data?.announcements) ? data.announcements : []).map((a) => a?.id));
        missing = wanted.filter((id) => !have.has(id));
        const haveRules = new Set(ruleRows(data).map((r) => `${r.id}|${valueHash(r)}`));
        const oldRules = wantedRules.filter((r) => !haveRules.has(`${r.id}|${r.hash}`));
        const what = [
          ...missing.map((id) => logSafe(id)),
          ...oldRules.map((r) => `iqamah rule ${logSafe(r.id)} (old value)`),
        ];
        last = what.length ? `missing ${what.join(', ')}` : '';
      } else {
        last = `HTTP ${res.status}`;
      }
    } catch (err) {
      last = `request failed: ${logSafe(err?.message, 120)}`;
    }
    if (last === '') {
      log(`Public content.json lists all ${wanted.length} announcement(s) and ${wantedRules.length} iqamah rule(s) to send (check ${attempt}).`);
      return true;
    }
    if (clock() + intervalMs > deadline) {
      log(warning(`public content.json still not up to date after ${Math.round(timeoutMs / 1000)} s (${last}); sending anyway`));
      return false;
    }
    log(`  waiting for the public content.json (check ${attempt}: ${last})`);
    await sleep(intervalMs);
  }
}

// ---------------------------------------------------------------- sending

/** POSTs one message; retries network errors, 429 and 5xx twice. Returns the FCM message name. */
export async function sendMessage(projectId, token, message, { fetchImpl = globalThis.fetch, retryDelayMs = 2000 } = {}) {
  const url = `https://fcm.googleapis.com/v1/projects/${encodeURIComponent(projectId)}/messages:send`;
  let last = '';
  for (let attempt = 1; attempt <= 3; attempt++) {
    let res;
    let text = '';
    try {
      res = await fetchImpl(url, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ message }),
      });
      text = await res.text();
    } catch (err) {
      last = `network error ${logSafe(err?.message, 200)}`;
      if (attempt < 3) await delay(retryDelayMs * attempt);
      continue;
    }
    if (res.ok) {
      try {
        return String(JSON.parse(text).name ?? '');
      } catch {
        return '';
      }
    }
    last = `HTTP ${res.status} ${logSafe(text, 300)}`;
    if (res.status !== 429 && res.status < 500) break;
    if (attempt < 3) await delay(retryDelayMs * attempt);
  }
  throw new Error(`FCM send to ${message.topic} failed: ${last}`);
}

/**
 * Plans and (unless dryRun) sends. `ledger` is a Set of ledgerKey()s already handled (sent, or
 * recorded on a cold start). `onSent`/`onSeeded` are called after each change so the caller can
 * persist the ledger. A failing message never stops the others; failures are in the result.
 */
export async function run({
  current,
  previous = null,
  coldStart = false,
  now,
  dryRun,
  serviceAccountJson,
  fetchImpl = globalThis.fetch,
  ledger = new Set(),
  ledgerTimes = new Map(),
  onSent = () => {},
  onSeeded = () => {},
  waitForPublish = async () => true,
  log = console.log,
  retryDelayMs,
}) {
  // Iqamah rules start cold on their own when the ledger has no iqamah key yet (first run after
  // this feature, or after a full cold start); `previous` is then their baseline.
  const iqamahCold = coldStart || !hasIqamahEntries(ledger);
  let seededAnnouncements = false;
  if (coldStart) {
    const ids = coldStartIds(previous, current);
    for (const id of ids) for (const topic of TOPICS) ledger.add(ledgerKey(id, topic));
    log(
      previous === null
        ? warning(`No send ledger and no previous commit: recording all ${ids.length} current announcement(s) as handled, sending nothing.`)
        : `No send ledger (first run or cache evicted): recording the ${ids.length} announcement(s) of the previous commit as handled.`,
    );
    seededAnnouncements = ids.length > 0;
  }

  const plan = planMessages(current, now, log);
  log(`Active announcements published in the last 48 h: ${plan.candidates.length} (${plan.candidates.map((a) => a.id).join(', ') || 'none'})`);
  const todo = plan.messages.filter(({ id, message }) => {
    const done = ledger.has(ledgerKey(id, message.topic));
    if (done) log(`  skip "${id}" -> ${message.topic}: already in the send ledger`);
    return !done;
  }).map((t) => ({ ...t, record: () => ledger.add(ledgerKey(t.id, t.message.topic)) }));

  // Iqamah rule changes (iqamah-push.mjs): rows whose value is not the one the ledger recorded.
  const iq = planIqamah({ current, previous, ledger, times: ledgerTimes, now, topics: TOPICS, coldStart: iqamahCold });
  if (iqamahCold) {
    log(
      previous === null
        ? `No iqamah entries in the send ledger and no previous commit: recording the ${iq.seeded} current iqamah rule(s) as handled.`
        : `No iqamah entries in the send ledger: recording the ${iq.seeded} iqamah rule(s) of the previous commit as handled.`,
    );
  }
  for (const s of iq.silent) log(`  iqamah rule ${logSafe(s.row.id)} changed, not announced: ${s.reason} (window ${iq.today} + ${IQAMAH_WINDOW_DAYS} days)`);
  log(`Iqamah rules changed and taking effect soon: ${iq.changes.length} (${iq.changes.map((c) => `${c.row.id}: ${c.timing.reason}`).join(', ') || 'none'})`);
  const rules = [];
  for (const change of iq.changes) {
    const id = `iqamah:${change.row.id}`;
    rules.push({ id: change.row.id, hash: change.hash });
    for (const message of buildIqamahMessages(change)) {
      if (!change.topics.includes(message.topic)) continue;
      todo.push({ id, message, record: () => recordRule(ledger, ledgerTimes, change.row, change.hash, [message.topic]) });
    }
  }
  // Save what was recorded without sending: cold-start announcements, and iqamah values (the
  // planner records or refreshes every current rule row, so unchanged rows never age out).
  if (seededAnnouncements || iq.seeded > 0 || ruleRows(current).length > 0) onSeeded(ledger);

  const result = { planned: plan.messages, todo, sent: [], failed: [], iqamah: iq };
  if (todo.length === 0) {
    log('Nothing to send.');
    return result;
  }
  const ids = [...new Set(todo.filter((t) => !t.id.startsWith('iqamah:')).map((t) => t.id))];
  if (dryRun) {
    const waitFor = [...ids, ...rules.map((r) => `iqamah rule ${r.id} = ${r.hash}`)];
    log(`DRY RUN: ${todo.length} message(s) would be sent (after waiting for the public content.json to list ${waitFor.join(', ')}):`);
    for (const { message } of todo) log(escapeInvisible(JSON.stringify({ message }, null, 2)));
    return result;
  }
  const sa = parseServiceAccount(serviceAccountJson);
  await waitForPublish(ids, rules);
  const token = await getAccessToken(sa, { fetchImpl });
  if (process.env.GITHUB_ACTIONS) console.log(`::add-mask::${token}`);
  for (const { id, message, record } of todo) {
    let name;
    try {
      name = await sendMessage(sa.project_id, token, message, { fetchImpl, retryDelayMs });
    } catch (err) {
      result.failed.push({ id, topic: message.topic, error: err.message });
      log(`  FAILED "${id}" -> ${message.topic}: ${escapeInvisible(err.message)}`);
      continue;
    }
    record();
    result.sent.push({ id, topic: message.topic, name });
    log(`  sent "${id}" -> ${message.topic} ${logSafe(name, 120)}`);
    try {
      onSent(ledger);
    } catch (err) {
      log(warning(`could not save the send ledger: ${err.message}`));
    }
  }
  return result;
}

// ---------------------------------------------------------------- ledger file

/**
 * Reads the ledger file. Format: {"version": 2, "sent": {"<id>|<topic>": "<ISO time>"}}; the
 * older {"sent": ["<id>|<topic>", ...]} is accepted too. `cold` is true when there is no file
 * or it cannot be read.
 */
export function readLedger(path, now = new Date(), warn = console.log) {
  const empty = { keys: new Set(), times: new Map(), cold: true };
  if (!path || !existsSync(path)) return empty;
  let data;
  try {
    data = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    warn(warning(`ledger ${path} is unreadable; treating this as a cold start`));
    return empty;
  }
  const times = new Map();
  if (Array.isArray(data?.sent)) {
    for (const k of data.sent) if (typeof k === 'string') times.set(k, now.toISOString());
  } else if (data?.sent && typeof data.sent === 'object') {
    for (const [k, v] of Object.entries(data.sent)) times.set(k, typeof v === 'string' ? v : now.toISOString());
  } else {
    warn(warning(`ledger ${path} has no "sent" entries; treating this as a cold start`));
    return empty;
  }
  return { keys: new Set(times.keys()), times, cold: false };
}

/** Writes the ledger, dropping entries older than LEDGER_KEEP_MS. */
export function writeLedger(path, keys, times, now = new Date()) {
  if (!path) return;
  const sent = {};
  for (const k of [...keys].sort()) {
    if (!times.has(k)) times.set(k, now.toISOString());
    const at = Date.parse(times.get(k));
    if (!Number.isNaN(at) && now.getTime() - at > LEDGER_KEEP_MS) continue;
    sent[k] = times.get(k);
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ version: 2, sent }, null, 2) + '\n');
}

// ---------------------------------------------------------------- git + CLI

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

/** content.json at `before`, or null (with a warning) when there is nothing usable there. */
export function loadPrevious(before, path, warn = console.log) {
  const ref = (before ?? '').trim();
  if (ref === '' || ZERO_SHA.test(ref)) {
    warn(warning('No previous commit (first push or missing before-ref).'));
    return null;
  }
  let sha;
  try {
    sha = git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]).trim();
  } catch {
    warn(warning(`Previous commit ${logSafe(ref)} is not available (force push?).`));
    return null;
  }
  let text;
  try {
    text = git(['show', `${sha}:./${path}`]);
  } catch {
    warn(warning(`${path} does not exist at ${sha}.`));
    return null;
  }
  try {
    return parseContent(text, `${path}@${sha.slice(0, 7)}`);
  } catch (err) {
    warn(warning(`${err.message}; ignoring the previous commit.`));
    return null;
  }
}

async function main() {
  const env = process.env;
  const path = env.CONTENT_PATH || 'content.json';
  const dryRun = env.DRY_RUN === '1' || env.DRY_RUN === 'true';
  const now = env.NOW ? new Date(env.NOW) : new Date();
  if (Number.isNaN(now.getTime())) throw new Error('NOW is not a valid date-time');

  // HEAD content must be valid: fail loudly otherwise (nothing is sent).
  const text = readFileSync(path, 'utf8');
  const problems = validateText(text, path);
  if (problems.length) {
    for (const p of problems.slice(0, 200)) console.error(`::error::${escapeCommandData(p)}`);
    throw new Error(`${path} is invalid (${problems.length} problem(s)); nothing sent`);
  }
  const current = parseContent(text, path);

  const ledgerPath = env.FCM_LEDGER_PATH || '';
  const { keys: ledger, times, cold } = readLedger(ledgerPath, now);
  // The previous commit is the baseline of a cold start, for announcements (no ledger) and for
  // iqamah rules (no iqamah key in the ledger yet).
  const previous = cold || !hasIqamahEntries(ledger) ? loadPrevious(env.BEFORE_SHA, path) : null;
  const persist = dryRun || !ledgerPath ? () => {} : (l) => writeLedger(ledgerPath, l, times, new Date());
  persist(ledger); // always leave a file for the cache step

  const waitMs = env.PUBLISH_WAIT_MS === undefined || env.PUBLISH_WAIT_MS === '' ? PUBLISH_WAIT_MS : Number(env.PUBLISH_WAIT_MS);
  if (!Number.isFinite(waitMs) || waitMs < 0) throw new Error('PUBLISH_WAIT_MS must be a number >= 0');
  const url = env.CONTENT_RAW_URL || CONTENT_RAW_URL;

  const result = await run({
    current,
    previous,
    coldStart: cold,
    now,
    dryRun,
    serviceAccountJson: env.FCM_SERVICE_ACCOUNT_JSON,
    ledger,
    ledgerTimes: times,
    onSent: persist,
    onSeeded: persist,
    waitForPublish: waitMs === 0 ? async () => true : (ids, rules) => waitForContent(ids, { url, timeoutMs: waitMs, rules }),
  });
  if (result.failed.length) {
    for (const f of result.failed) console.error(`::error::${escapeCommandData(`"${f.id}" -> ${f.topic}: ${escapeInvisible(f.error)}`)}`);
    throw new Error(`${result.failed.length} message(s) failed; ${result.sent.length} sent. Re-run the job to retry the failed ones.`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(`::error::${escapeCommandData(err.message)}`);
    process.exit(1);
  });
}
