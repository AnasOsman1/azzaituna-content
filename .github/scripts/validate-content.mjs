#!/usr/bin/env node
// Checks that content.json parses and that every announcement is complete.
// Usage: node .github/scripts/validate-content.mjs [path/to/content.json]
// Exits 1 and prints every problem found when the file is invalid.

import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const LANGS = ['ar', 'it', 'en'];
export const TEXT_FIELDS = LANGS.flatMap((l) => [`title_${l}`, `body_${l}`]);
const PRIORITIES = new Set(['normal', 'urgent']);
const HTTPS_URL = /^https:\/\/\S+$/;

/** Parses content.json text; throws an Error with a readable message on failure. */
export function parseContent(text, label = 'content.json') {
  let data;
  try {
    data = JSON.parse(text);
  } catch (err) {
    throw new Error(`${label} is not valid JSON: ${err.message}`);
  }
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error(`${label} must contain a JSON object at the top level`);
  }
  return data;
}

function isDate(v) {
  return typeof v === 'string' && v.trim() !== '' && !Number.isNaN(Date.parse(v));
}

/** Returns a list of human-readable problems (empty when the content is valid). */
export function validateContent(data) {
  const errors = [];
  if (!Array.isArray(data.announcements)) {
    errors.push('"announcements" must be an array');
    return errors;
  }
  const seen = new Set();
  data.announcements.forEach((a, i) => {
    const where = `announcements[${i}]${a && typeof a.id === 'string' ? ` (id "${a.id}")` : ''}`;
    if (a === null || typeof a !== 'object' || Array.isArray(a)) {
      errors.push(`${where}: must be an object`);
      return;
    }
    if (typeof a.id !== 'string' || a.id.trim() === '') {
      errors.push(`${where}: "id" must be a non-empty string`);
    } else if (seen.has(a.id)) {
      errors.push(`${where}: duplicate id`);
    } else {
      seen.add(a.id);
    }
    for (const f of TEXT_FIELDS) {
      if (typeof a[f] !== 'string' || a[f].trim() === '') {
        errors.push(`${where}: "${f}" must be a non-empty string`);
      }
    }
    if (!PRIORITIES.has(a.priority)) {
      errors.push(`${where}: "priority" must be "normal" or "urgent"`);
    }
    if (!isDate(a.starts_at)) {
      errors.push(`${where}: "starts_at" must be an ISO date-time`);
    }
    if (a.expires_at != null && !isDate(a.expires_at)) {
      errors.push(`${where}: "expires_at" must be null or an ISO date-time`);
    }
    if (a.published_at != null && !isDate(a.published_at)) {
      errors.push(`${where}: "published_at" must be null or an ISO date-time`);
    }
    if (a.image_url != null) {
      if (typeof a.image_url !== 'string' || !HTTPS_URL.test(a.image_url)) {
        errors.push(`${where}: "image_url" must be an https:// link without spaces`);
      }
      for (const dim of ['image_width', 'image_height']) {
        if (!Number.isInteger(a[dim]) || a[dim] < 1 || a[dim] > 10000) {
          errors.push(`${where}: "${dim}" must be an integer 1-10000 when image_url is set`);
        }
      }
    } else if (a.image_width != null || a.image_height != null) {
      errors.push(`${where}: image_width/image_height are set but image_url is missing`);
    }
  });
  return errors;
}

function main() {
  const path = process.argv[2] ?? 'content.json';
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch (err) {
    console.error(`::error::cannot read ${path}: ${err.message}`);
    process.exit(1);
  }
  let errors;
  try {
    errors = validateContent(parseContent(text, path));
  } catch (err) {
    errors = [err.message];
  }
  if (errors.length) {
    for (const e of errors) console.error(`::error file=${path}::${e}`);
    console.error(`${path}: ${errors.length} problem(s) found`);
    process.exit(1);
  }
  console.log(`${path}: OK`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
