# Azzaituna content

`content.json` is the live content of the Azzaituna mosque app (announcements, lessons,
adhkar, iqamah rules, Jumu'ah sessions). The app downloads it on start and caches it.
Edit the file on GitHub and commit; devices pick it up on their next refresh.
Rows use the same fields as the former database tables (see the app repo's `supabase/schema.sql`).

## Push notifications for new announcements

`.github/workflows/content.yml` has two jobs:

- **validate** (every pull request and push that touches `content.json` or the scripts): runs the
  unit tests and `node .github/scripts/validate-content.mjs`, which checks that `content.json`
  parses and that every announcement has a unique `id`, all six texts (`title_ar/it/en`,
  `body_ar/it/en`), a valid `priority` and dates, and an `https://` `image_url` (with
  `image_width`/`image_height`) when an image is set.
- **push** (only after **validate** passes, on pushes to `main`): runs
  `.github/scripts/send-push.mjs`. For every announcement whose `id` is in `content.json` now but
  was not in the commit before the push, and that is active now (`published_at` and `starts_at`
  not in the future, `expires_at` empty or in the future), it sends one Firebase Cloud Messaging
  notification to each of the topics `announcements-ar`, `announcements-it` and
  `announcements-en` (title and body in that language, body cut to 140 characters, Android
  channel `announcements`, data `{screen: "announcements", id}`). Editing or deleting an existing
  announcement sends nothing.

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
  **push** job prints the exact messages that would be sent for the latest commit (compared with
  its parent, or with the commit given in **before**). No secret is used and nothing is sent.
  Unticking **Dry run** on `main` sends for real.
- Locally (Node 20 or newer, no `npm install` needed):

  ```sh
  node --test .github/scripts/send-push.test.mjs
  node .github/scripts/validate-content.mjs
  BEFORE_SHA=HEAD~1 DRY_RUN=1 node .github/scripts/send-push.mjs
  ```

  `NOW=2026-11-01T10:00:00Z` overrides the clock for the active check.

### Sending an announcement

1. Add a new object to `announcements` in `content.json` with a **new, never-used `id`**, all six
   text fields, `priority`, `starts_at`, `published_at` and `expires_at` (or `null`).
2. Commit to `main` (directly or by merging a pull request). If it is active at that moment, the
   notification goes out within a minute or two; check **Actions > Content**.
3. An announcement scheduled for later (`starts_at` in the future) is **not** pushed when its
   time comes: the push happens only in the run triggered by the commit that adds it. To notify
   later, commit it close to its start time.

### Limitations

- **No double sends on re-run, within reason.** Each sent message is recorded in a small ledger
  stored in the GitHub Actions cache under the commit SHA, so re-running a job (or a manual run on
  the same commit) skips what was already sent and retries only what failed. The cache is
  best-effort: GitHub evicts entries unused for 7 days, and if the job dies between FCM accepting
  a message and the ledger being written, a re-run can send that one message again. On Android
  the notification carries the tag `announcement-<id>`, so a duplicate replaces the earlier one in
  the tray rather than adding a second entry.
- Reusing an `id` that was deleted earlier counts as new and is pushed again.
- First push to the branch, a force push whose previous commit is gone, or an unreadable previous
  `content.json` sends nothing (a warning is logged). Invalid `content.json` at the new commit
  fails the run.
