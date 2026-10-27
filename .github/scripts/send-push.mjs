#!/usr/bin/env node
// Sends one FCM push per language topic for every announcement that is new in this push.
//
// "New" = id present in content.json at HEAD but absent at BEFORE_SHA (the commit before the push).
// Only announcements that are currently active are sent (published, started, not expired).
// Dependency-free: Node >= 20 built-ins only (crypto for the RS256 JWT, global fetch).
//
// Environment:
//   BEFORE_SHA                commit to diff against; empty / all zeros / unknown => send nothing
//   CONTENT_PATH              default "content.json"
//   DRY_RUN=1                 print the messages, send nothing, no secret needed
//   FCM_SERVICE_ACCOUNT_JSON  service-account key JSON (required unless DRY_RUN=1)
//   FCM_LEDGER_PATH           optional JSON file recording messages already sent for this commit
//   NOW                       optional ISO date-time overriding the clock (testing)

import { createSign } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { LANGS, parseContent, validateContent } from './validate-content.mjs';

export const BODY_MAX_CHARS = 140;
export const FCM_SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';
export const DEFAULT_TOKEN_URI = 'https://oauth2.googleapis.com/token';
const ZERO_SHA = /^0+$/;

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
  const starts = Date.parse(a.starts_at);
  if (Number.isNaN(starts) || starts > t) return false;
  if (a.published_at != null) {
    const pub = Date.parse(a.published_at);
    if (Number.isNaN(pub) || pub > t) return false;
  }
  if (a.expires_at != null) {
    const exp = Date.parse(a.expires_at);
    if (Number.isNaN(exp) || exp <= t) return false;
  }
  return true;
}

/** Announcements whose id is in `current` but not in `previous` (previous === null => none). */
export function newAnnouncements(previous, current) {
  if (previous === null) return [];
  const before = new Set(
    (Array.isArray(previous?.announcements) ? previous.announcements : [])
      .map((a) => a?.id)
      .filter((id) => typeof id === 'string'),
  );
  return (current.announcements ?? []).filter((a) => !before.has(a.id));
}

/** One FCM v1 message per language topic. */
export function buildMessages(a) {
  return LANGS.map((lang) => ({
    topic: `announcements-${lang}`,
    notification: {
      title: String(a[`title_${lang}`]).trim(),
      body: truncate(a[`body_${lang}`]),
    },
    android: {
      priority: 'HIGH',
      // Same tag => a duplicate delivery replaces the tray entry instead of adding a second one.
      notification: { channel_id: 'announcements', tag: `announcement-${a.id}` },
    },
    data: { screen: 'announcements', id: String(a.id) },
  }));
}

/** Messages to send for this push. */
export function planMessages(previous, current, now) {
  const fresh = newAnnouncements(previous, current);
  const active = fresh.filter((a) => isActive(a, now));
  return {
    fresh,
    active,
    messages: active.flatMap((a) => buildMessages(a).map((message) => ({ id: a.id, message }))),
  };
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
  if (!res.ok) throw new Error(`OAuth token request failed: HTTP ${res.status} ${text.slice(0, 300)}`);
  let token;
  try {
    token = JSON.parse(text).access_token;
  } catch {
    token = undefined;
  }
  if (typeof token !== 'string' || !token) throw new Error('OAuth token response had no access_token');
  return token;
}

// ---------------------------------------------------------------- sending

/** POSTs one message; retries 429/5xx twice. Returns the FCM message name. */
export async function sendMessage(projectId, token, message, { fetchImpl = globalThis.fetch, retryDelayMs = 2000 } = {}) {
  const url = `https://fcm.googleapis.com/v1/projects/${encodeURIComponent(projectId)}/messages:send`;
  let last = '';
  for (let attempt = 1; attempt <= 3; attempt++) {
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ message }),
    });
    const text = await res.text();
    if (res.ok) {
      try {
        return JSON.parse(text).name ?? '';
      } catch {
        return '';
      }
    }
    last = `HTTP ${res.status} ${text.slice(0, 500)}`;
    if (res.status !== 429 && res.status < 500) break;
    if (attempt < 3) await new Promise((r) => setTimeout(r, retryDelayMs * attempt));
  }
  throw new Error(`FCM send to ${message.topic} failed: ${last}`);
}

export const ledgerKey = (id, topic) => `${id}|${topic}`;

/**
 * Plans and (unless dryRun) sends. `ledger` is a Set of ledgerKey()s already sent for this
 * commit; `onSent` is called after each successful send so the caller can persist it.
 */
export async function run({
  previous,
  current,
  now,
  dryRun,
  serviceAccountJson,
  fetchImpl = globalThis.fetch,
  ledger = new Set(),
  onSent = () => {},
  log = console.log,
  retryDelayMs,
}) {
  const plan = planMessages(previous, current, now);
  log(`New announcements in this push: ${plan.fresh.length} (${plan.fresh.map((a) => a.id).join(', ') || 'none'})`);
  for (const a of plan.fresh.filter((x) => !plan.active.includes(x))) {
    log(`  skip "${a.id}": not active at ${now.toISOString()}`);
  }
  const todo = plan.messages.filter(({ id, message }) => {
    const done = ledger.has(ledgerKey(id, message.topic));
    if (done) log(`  skip "${id}" -> ${message.topic}: already sent for this commit`);
    return !done;
  });
  const result = { planned: plan.messages, sent: [], failed: [] };
  if (todo.length === 0) {
    log('Nothing to send.');
    return result;
  }
  if (dryRun) {
    log(`DRY RUN: ${todo.length} message(s) would be sent:`);
    for (const { message } of todo) log(JSON.stringify({ message }, null, 2));
    return result;
  }
  const sa = parseServiceAccount(serviceAccountJson);
  const token = await getAccessToken(sa, { fetchImpl });
  if (process.env.GITHUB_ACTIONS) console.log(`::add-mask::${token}`);
  for (const { id, message } of todo) {
    try {
      const name = await sendMessage(sa.project_id, token, message, { fetchImpl, retryDelayMs });
      ledger.add(ledgerKey(id, message.topic));
      onSent(ledger);
      result.sent.push({ id, topic: message.topic, name });
      log(`  sent "${id}" -> ${message.topic} ${name}`);
    } catch (err) {
      result.failed.push({ id, topic: message.topic, error: err.message });
      log(`  FAILED "${id}" -> ${message.topic}: ${err.message}`);
    }
  }
  return result;
}

// ---------------------------------------------------------------- git + CLI

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

/** content.json at `before`, or null (with a warning) when there is nothing safe to diff against. */
export function loadPrevious(before, path, warn = console.log) {
  const ref = (before ?? '').trim();
  if (ref === '' || ZERO_SHA.test(ref)) {
    warn('::warning::No previous commit (first push or missing before-ref): sending nothing.');
    return null;
  }
  let sha;
  try {
    sha = git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]).trim();
  } catch {
    warn(`::warning::Previous commit ${ref} is not available (force push?): sending nothing.`);
    return null;
  }
  let text;
  try {
    text = git(['show', `${sha}:./${path}`]);
  } catch {
    warn(`::warning::${path} does not exist at ${sha}: treating as first publish, sending nothing.`);
    return null;
  }
  try {
    return parseContent(text, `${path}@${sha.slice(0, 7)}`);
  } catch (err) {
    warn(`::warning::${err.message}; cannot tell which announcements are new, sending nothing.`);
    return null;
  }
}

function readLedger(path) {
  if (!path || !existsSync(path)) return new Set();
  try {
    const data = JSON.parse(readFileSync(path, 'utf8'));
    return new Set(Array.isArray(data.sent) ? data.sent : []);
  } catch {
    console.log(`::warning::ledger ${path} unreadable; starting empty`);
    return new Set();
  }
}

function writeLedger(path, ledger) {
  if (!path) return;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ sent: [...ledger].sort() }, null, 2) + '\n');
}

async function main() {
  const env = process.env;
  const path = env.CONTENT_PATH || 'content.json';
  const dryRun = env.DRY_RUN === '1' || env.DRY_RUN === 'true';
  const now = env.NOW ? new Date(env.NOW) : new Date();
  if (Number.isNaN(now.getTime())) throw new Error('NOW is not a valid date-time');

  // HEAD content must be valid: fail loudly otherwise.
  const current = parseContent(readFileSync(path, 'utf8'), path);
  const problems = validateContent(current);
  if (problems.length) throw new Error(`${path} is invalid:\n  ${problems.join('\n  ')}`);

  const previous = loadPrevious(env.BEFORE_SHA, path);
  const ledgerPath = dryRun ? '' : env.FCM_LEDGER_PATH;
  const ledger = readLedger(ledgerPath);
  if (ledgerPath) writeLedger(ledgerPath, ledger); // always leave a file for the cache step

  const result = await run({
    previous,
    current,
    now,
    dryRun,
    serviceAccountJson: env.FCM_SERVICE_ACCOUNT_JSON,
    ledger,
    onSent: (l) => writeLedger(ledgerPath, l),
  });
  if (result.failed.length) {
    throw new Error(`${result.failed.length} message(s) failed; ${result.sent.length} sent`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(`::error::${err.message}`);
    process.exit(1);
  });
}
