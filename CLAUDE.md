# DCL & Boiler Maintenance App — project context

Phone-first preventive-maintenance (PM) **log** for Paul Morrell Dry Cleaning's DCL & Boiler
department, replacing a spreadsheet. ~6 users. Per-task check-off with who/when, EN/ES,
name + 4-digit PIN sign-in, per-machine issue reporting, calendar compliance view, history.

> NOTE: this repository is **public** (free GitHub Pages requires it). Never commit secrets,
> credentials, PINs, or service-account keys here. The Firebase web config is public-safe by
> design — security is enforced by Firestore rules, not by hiding the config.

## Architecture

- **`index.html`** is the entire web app: one self-contained file, no build step. It imports the
  Firebase JS SDK **10.12.2** as ES modules from gstatic. Edit it directly.
- **Hosting:** GitHub Pages serves `index.html` from the repo root of `main`. Live URL:
  https://euphor82.github.io/PM-Maint/ . Committing app changes to `main` auto-deploys.
- **Backend:** Firebase project `pm-maintenance-c618e` (under the owner's personal Google account).
  - **Anonymous Auth** for a baseline uid; real identity is name + PIN (see below).
  - **Firestore** for realtime sync (`onSnapshot`) + offline (`persistentLocalCache`).
  - **FCM web push** for notifications.
- **Free Spark plan, no billing.** These constraints are load-bearing — do not design around them:
  - **No Cloud Functions** → the PIN check lives in Firestore **rules**.
  - **No Firebase Storage** → issue photos are compressed client-side and stored as base64 in a
    Firestore subcollection.
  - Sending push / running the sheet→Firestore sync is done by an **Apps Script bridge** (below),
    not Cloud Functions.

## Sign-in / identity (important)

- The client signs in **anonymously** just to get a uid.
- App identity = a person + their **4-digit PIN**. The PIN is verified **server-side in Firestore
  rules**: the client writes `sessions/{uid} = {personId, pin, at}`; a rule compares the pin against
  an unreadable `secrets/pins` doc via `get()`. **A rejected write is the "wrong PIN" signal.**
- Never move PIN verification into client JS. Never make `secrets/pins` readable.

## People & roles

- People come from the master sheet. Supervisors have `canClear: true`
  (Darryl, Dean, Justin, Drew). Supervisors can: clear / reopen / edit / delete issues, and
  **undo anyone's task check-off** (regular users can only undo their own).
- A non-supervisor **test account "Claude"** exists for testing (ask the owner for its PIN — never
  put PINs in this repo).

## Firestore data model (see `firestore.rules`)

- `content/tasks`, `content/uiText` — packed docs the app reads (bridge-written).
- `content/txCache` — bridge's Spanish machine-translation cache (bridge-only).
- `people/{personId}` — `{name, lang, active, canClear, order}` (no PIN).
- `secrets/pins` — unreadable by clients; rules `get()` it.
- `sessions/{uid}` — the PIN-check write.
- `checkoffs/{date_taskId}` — deterministic id prevents double sign-off.
- `events/{autoId}` — append-only audit log (`done`/`undone`), never edited/deleted.
- `issues/{iid}` (+ `notes`, `photos` subcollections) — reported issues.
- `days/{date}`, `state/lastDone` — denormalized speed summaries maintained on each check-off.
- `prefs/{personId}`, `tokens/{uid}` — notification prefs + this phone's push token.

## The Apps Script bridge (lives in the LIVE master Google Sheet, NOT this repo's runtime)

Files here for reference/versioning: `bridge/Code.gs`, `bridge/push.gs`, `bridge/appsscript.json`.
It runs as the sheet owner (owner OAuth **bypasses** Firestore rules), so no service-account keys.

- **`Code.gs`** — "PM App" sheet menu: *Publish everything* (TASKS→`content/tasks`,
  UI_TEXT→`content/uiText`, PEOPLE→`people/*`+`secrets/pins`), *Publish people & PINs only*,
  *Restore dropdowns* (re-applies Status/Frequency data-validation).
  - Reads only **Active** task rows. Optional columns: `Due Date`, `Task (Spanish)`.
  - **Spanish auto-translate:** blank `Task (Spanish)` cells are machine-translated at publish via
    built-in `LanguageApp.translate` (cached in `content/txCache`); a filled cell = human override.
    An `onEdit` trigger clears a row's Spanish when its English is edited, so it re-translates fresh.
  - LanguageApp has a **daily quota** (~a few hundred); a big first run may report "N failed →
    English" — re-publish next day and the cache fills in the rest. Failures never break a publish.
- **`push.gs`** — FCM sender on time triggers: new-issue notifications (respects each user's pref)
  and due-date reminders. `installNotifications()` creates the triggers (run once).

## Locked rules (from the original project brief)

- Task IDs are **permanent** — retire (Status=Retired), never delete or renumber.
- **Wording lives in the sheet**, not the app (UI_TEXT + task text).
- Never edit the original Drive source files; work from the LIVE copy.

## Bilingual (EN/ES)

- UI wording + task text come from the sheet (task Spanish now auto-translated at publish, above).
- **Typed** issue notes/descriptions auto-translate on the fly via the free MyMemory API
  (`autoTx`/`translateText` in `index.html`), shown with a 🌐 marker. System-generated log lines
  are stored bilingual `{en,es}` (see `content()` / `both()` helpers).

## Key `index.html` structure

- Single state object `S`; `render()` rebuilds the screen. Tabs: Today, History, Calendar, Issues,
  Shift. `taskText(tk)` returns display text (keep it a **plain string** — history search matches on it).
- **Today** = cadence status board (`renderToday`, `cadenceOf`). **Calendar** = daily-rounds
  compliance board with a green→red completion **gradient**, due-date badges, and a "machine down"
  flag (`renderCalendar`, `calCounts`). **Issues** has search + machine filter (`renderIssues`).
- **Weekends** (Sat/Sun) are excluded from daily-rounds compliance. **Machine-down** (an open
  "unusable" issue) is shown as a flag only — tasks still count (units under one machine code can be
  independently up/down, and we don't track per-unit state).

## Deploying changes (three separate targets)

1. **App (`index.html`, icons, manifest, sw):** merge to `main` → GitHub Pages auto-deploys.
   iPhones with the app on their Home Screen may need a **remove + re-add** to clear the PWA cache.
2. **`firestore.rules`:** the owner must paste them into the Firebase console → Rules → Publish.
   (Editing the file here does **not** publish them.)
3. **Bridge (`Code.gs`/`push.gs`):** the owner pastes into the sheet's Apps Script editor → Save →
   runs *PM App → Publish everything*. Not deployable from this repo.

When a change spans app + rules, publish the rules **before/with** the app to avoid permission errors.

## Testing notes

- You cannot test real sign-in (PINs are sealed server-side). Use the "Claude" test account.
- Prefer text-based verification (read the DOM/console) — screenshots are often flaky here.
