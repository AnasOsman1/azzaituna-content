# Azzaituna content

`content.json` is the live content of the Azzaituna mosque app (announcements, lessons,
adhkar, iqamah rules, Jumu'ah sessions). The app downloads it on start and caches it.
Edit the file on GitHub and commit; devices pick it up on their next refresh.
Rows use the same fields as the former database tables (see the app repo's `supabase/schema.sql`).

## Validation rules

`.github/scripts/validate-content.mjs` fails the workflow (and so blocks every push notification)
when `content.json` breaks any of these rules. They mirror what the app accepts: a row the app
cannot read is dropped silently, and some mistakes (a `null` row, a missing date key, a
`weekly_days` that is not a list) make it reject the whole update and keep its old copy.

- **File**: valid JSON, at most 1 MB, a JSON object with the five lists `lessons`,
  `announcements`, `adhkar`, `iqamahRules`, `jumuahSessions`. `lessons`, `announcements` and
  `adhkar` cannot all be empty. No number may be `NaN` or infinite (e.g. `1e400`).
- **Every row** is an object (no `null`), with `id` matching `^[a-z0-9-]{1,64}$` (lowercase
  letters, digits and `-`) and unique within its list, `mosque_id` equal to `"azzaituna"`, and
  `updated_at` a date-time.
- **Date-times** are strictly `YYYY-MM-DDTHH:mm:ss`, optionally `.sss` (exactly 3 digits), then
  `Z` or `+hh:mm`/`-hh:mm`, with a real calendar date and a year from 2000 to 2100. No zone-less
  dates, no other formats, so the app and the workflow read the same instant.
- **announcements**: `title_ar/it/en` (at most 120 characters each) and `body_ar/it/en` (at most
  2000 characters each) are strings that are not empty once zero-width characters
  (U+200B-U+200F, U+2060, U+FEFF) and spaces are removed, and contain no bidirectional
  override/isolate controls (U+202A-U+202E, U+2066-U+2069). `priority` is `normal` or `urgent`.
  `starts_at` and `published_at` are required date-times; the key `expires_at` is required, its
  value `null` or a date-time after `starts_at`.
- **Images** (optional): `image_url` is `null`/absent, or a link starting with
  `https://raw.githubusercontent.com/AnasOsman1/azzaituna-content/` (so: an image committed to
  this repository) with no `@`, port, `?` query, `#` fragment, IP address, encoded dots/slashes
  or `.`/`..` segments. With an `image_url`, `image_width` and `image_height` are both required:
  whole numbers from 1 to 8000 whose ratio is between 1:4 and 4:1. Without one, both must be
  absent or `null`.
- **lessons**: `topic_*`, `teacher_*`, `location_*` non-empty in all three languages; the keys
  `starts_at` (`null` or a date-time), `weekly_days` (`null` or a list of 1-7 weekdays, 0 =
  Sunday) and `after_prayer` (`null` or `fajr`/`dhuhr`/`asr`/`maghrib`/`isha`) must all be
  present; `weekly_days` and `after_prayer` are set together; a lesson needs `starts_at` or a
  weekly schedule; `sort` is an integer.
- **adhkar**: `collection` is `morning`, `evening` or `general`; `arabic`, `translation_*` and
  `source` non-empty; `repetitions` a whole number of at least 1; `sort` an integer.
- **iqamahRules**: every column present (`null` where unused). `prayer` is `default` or a prayer
  name, `rule_type` `fixed` (needs `fixed_time` `HH:MM`) or `offset` (needs `minutes` 0-180;
  optional `round` 1-60, `not_before`/`not_after` `HH:MM`). `season_from`/`season_to` are set
  together as `MM-DD`, `on_date` is `YYYY-MM-DD`, never both, and never with `default`. Two rules
  for the same prayer and season/date are rejected (the app would keep only one).
- **jumuahSessions**: `khutbah` and `iqamah` are `HH:MM`; `sort` an integer.

### Isha (or any prayer): automatic or set

The iqamah of a prayer follows its rule in `iqamahRules`; edit that row to switch:

- **Automatic** (follows the adhan, which the app calculates): `"rule_type": "offset"` with
  `"minutes": 5` (adhan + 5 min), `"fixed_time": null`. Optional `round` (round up to a multiple
  of N minutes), `not_before` / `not_after` (`HH:MM`) to clamp it.
- **Set** (same clock time every day): `"rule_type": "fixed"`, `"fixed_time": "19:30"`,
  `"minutes": null`. If the set time falls before the adhan on some day, the app shows adhan + 5.

To change it only for part of the year, add a second row for the same prayer with
`season_from` / `season_to` (`MM-DD`), or for one day with `on_date` (`YYYY-MM-DD`). Those rows
win over the base row (`isha-base`) in their dates. Commit, and phones pick it up within about
five minutes of opening the app.

Every value the scripts print in the Actions log is JSON-escaped and shortened, so text in
`content.json` can never inject workflow commands (`::add-mask::`, `::warning::`, ...).

## Push notifications for new announcements

`.github/workflows/content.yml` has two jobs:

- **validate** (every pull request and push that touches `content.json` or the scripts): runs the
  unit tests and `node .github/scripts/validate-content.mjs` (the rules above).
- **push** (only after **validate** passes, on pushes to `main` and manual runs): runs
  `.github/scripts/send-push.mjs`. It sends every announcement that
  - is **active** now (`published_at` and `starts_at` not in the future, `expires_at` empty or in
    the future),
  - was **published within the last 48 hours** (`published_at`), and
  - is **not yet in the send ledger** (the record of what has been sent, see below).

  For each one it sends one Firebase Cloud Messaging notification to each of the topics
  `announcements-ar`, `announcements-it` and `announcements-en`: title (cut to 65 characters)
  and body (cut to 140 characters) in that language, Android channel `announcements`, data
  `{screen: "announcements", id}`.

  Because the ledger, not the git diff, decides, a fix-forward works: if a commit adds an
  announcement but fails validation (nothing is sent), the commit that fixes it sends it. A topic
  that failed is retried by the next run. Editing an announcement that was already sent sends
  nothing; to notify again, add it under a new `id`.

  **Before sending** it waits until the public `content.json` the app downloads
  (`https://raw.githubusercontent.com/AnasOsman1/azzaituna-content/main/content.json`, without a
  cache-busting query, so the check sees the same CDN copy a phone does) lists every id about to
  be sent, checking every 15 s for at most 6 minutes, so a tap on the notification finds the
  announcement. If it is still not there after 6 minutes it logs a warning and sends anyway.

  **Failures**: each message is tried up to 3 times (network errors, HTTP 429 and 5xx). One
  failing message never stops the others; failures are listed at the end and the job fails, so
  **Re-run failed jobs** retries only what is missing.

The service-account secret is given only to the live send step, which runs only on `main`.
Checkouts do not keep the GitHub token (`persist-credentials: false`) and the workflow token is
read-only (`contents: read`).

### The send ledger

The ledger is a small JSON file (`fcm-ledger/sent.json`: `"<id>|<topic>": "<time sent>"`) kept
in the GitHub Actions cache. Each live run restores the newest copy, adds what it sent and saves a
new copy (entries older than 180 days are dropped). Push jobs run one at a time across all
commits, so two runs never use the ledger at once; if several pushes queue up, GitHub keeps only
the newest waiting run, which sends everything the skipped ones would have.

**Cold start** (no ledger: the first run after this change, or the cache was evicted because no
live run happened for 7 days): the announcements present in the commit before the push are
recorded as already handled without sending, then the rules above apply, which is the same as
the original "new in this push" behaviour. If that previous commit is not available either (first
push, force push), every current announcement is recorded and nothing is sent.

### One-time Firebase setup (repository owner)


1. Open <https://console.firebase.google.com>, **Add project** (e.g. `azzaituna`); Google
   Analytics is optional.
2. In the project, **Add app > Android**, package name `it.azzaituna.app`. Download
   `google-services.json` and add it to the **app** repository (not this one), as its README
   describes.
3. **Project settings > Service accounts > Firebase Admin SDK > Generate new private key**. A
   JSON file downloads. Keep it private; never commit it.
4. In this GitHub repository: **Settings > Secrets and variables > Actions > New repository
   secret**, name `FCM_SERVICE_ACCOUNT_JSON`, value = the whole content of that JSON file. Then
   delete the downloaded file from your computer.
5. In Google Cloud Console (same project), **APIs & Services > Library**, search
   **Firebase Cloud Messaging API** (the V1 API, not the legacy one) and make sure it is
   **Enabled**.

The project id is read from the key file, so nothing else needs configuring. The app must
subscribe each device to `announcements-<language>` and create the `announcements`
notification channel.

### Testing with a dry run

- On GitHub: **Actions > Content > Run workflow**, keep **Dry run** ticked. The log of the
  **push** job prints the exact messages a live run would send now (it reads the current send
  ledger but never saves it; **before** matters only if there is no ledger). No secret is used,
  nothing is sent and nothing is waited for. Unticking **Dry run** on `main` sends for real.
- Locally (Node 20 or newer, no `npm install` needed):

  ```sh
  node --test .github/scripts/send-push.test.mjs .github/scripts/send-push.hardening.test.mjs .github/scripts/validate-content.test.mjs
  node .github/scripts/validate-content.mjs
  BEFORE_SHA=HEAD~1 DRY_RUN=1 node .github/scripts/send-push.mjs
  ```

  Without `FCM_LEDGER_PATH` a local run is a cold start (see above). `NOW=2026-11-01T10:00:00Z`
  overrides the clock; `PUBLISH_WAIT_MS=0` skips the wait for the public file.

### Sending an announcement

1. Add a new object to `announcements` in `content.json` with a **new, never-used `id`**, all six
   text fields, `priority`, `starts_at`, `published_at` (set it to now) and `expires_at` (or
   `null`), plus `mosque_id` and `updated_at` like the other rows.
2. Commit to `main` (directly or by merging a pull request). If it is active at that moment, the
   notification goes out within a few minutes (after the public file shows it); check
   **Actions > Content**.
3. If validation fails, nothing is sent; fix the file and commit again, and the fixing commit
   sends it (as long as `published_at` is within the last 48 hours).

### Limitations

- **Nothing runs on a timer.** Sending happens only in a run triggered by a push to `main` that
  touches `content.json` or the scripts (or a manual run). An announcement scheduled for later
  (`starts_at` in the future) is sent by the first such run after it starts, and only if that run
  is within 48 hours of its `published_at`; otherwise it is never pushed. To notify at a given
  time, commit close to it or start a manual run then.
- **48-hour window.** An announcement whose `published_at` is more than 48 hours old is never
  pushed, even if it was never sent. A `published_at` in the future holds the push back.
- **The ledger is best-effort.** It lives in the GitHub Actions cache, which evicts entries
  unused for 7 days; after that the next run is a cold start (see above), which assumes that
  everything in the previous commit was already handled. So a cold start right after a commit
  that failed validation does not send the announcement that commit added. If the job dies
  between FCM accepting a message and the ledger being saved, a later run can send that message
  again. On Android the notification carries the tag `announcement-<id>`, so a duplicate
  replaces the earlier one in the tray rather than adding a second entry.
- Reusing an `id` that was sent within the last 180 days sends nothing; an older one counts as
  new (if its `published_at` is recent).
- The wait for the public file checks for the ids only, not for later edits to their text.
- Invalid `content.json` at the pushed commit fails the run and sends nothing.
