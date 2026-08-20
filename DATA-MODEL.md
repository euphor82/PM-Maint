# PM Maintenance App — Firestore Data Model

Project: `pm-maintenance-c618e` · Region: `nam5` · Plan: Spark (free)
Master sheet: `PM_Task_Master_Sheet-4-LIVE` (Google Sheet `1frZ9EEnoAnUQ9uYPBJGB5pUaK4TmMc0h3562m05PrDc`)

Two kinds of data, two write paths:

| Kind | Examples | Written by | Read by |
|---|---|---|---|
| Reference content | tasks, wording, people, PINs | Apps Script bridge only (Admin SDK, bypasses rules) | app (except PINs: nobody) |
| Live records | check-offs, issues, notes, sessions, prefs | the app, gated by security rules | app |

## Collections

### `content/tasks` — one packed doc
```
{ rows: [ { id, code, machine, units, en, es, freq }, ... ],   // Active rows only
  updatedAt }
```
503 tasks ≈ 150 KB — comfortably under the 1 MB doc limit. Packing them into one
doc means each phone does ~1 read instead of 503, and one listener catches every
sheet publish. Retired/Draft rows never leave the sheet.

### `content/uiText` — one packed doc
```
{ keys: { "app.title": {en, es}, ... }, updatedAt }
```

### `people/{personId}` — individual docs, e.g. `people/darryl`
```
{ name, lang: 'en'|'es', active: bool, canClear: bool, order }
```
Individual docs (not packed) because the rules must `get()` a person by id —
rules can't search inside an array. **Never contains a PIN.**
`personId` = lowercase slug of the name; it is the stable key that history
points at, so renames in the sheet change the display name without orphaning
records. Departures = `active: false` (from the sheet's Active column), never
row deletion.
`canClear` comes from a `Can Clear` column in the PEOPLE tab if present;
bridge defaults it to Darryl / Dean / Justin / Drew otherwise.

### `secrets/pins` — one doc, unreadable by all clients
```
{ byId: { darryl: "0000", oscar: "0000", ... } }   // values are the real PINs
```
`allow read, write: if false` — but rules `get()` it server-side to validate
sign-ins. PINs therefore never travel to any phone and never appear in app code.

### `sessions/{uid}` — the PIN check
```
{ personId, pin, at }
```
Client signs in anonymously (gets a `uid`), then tries to write this doc.
The rule accepts it only if `pin` matches `secrets/pins.byId[personId]` and the
person is active. **A permission-denied on this write is the "wrong PIN" UX
signal.** Doc is unreadable (`read: if false`); later writes are authorized by
rules calling `get()` on it. Sign-out deletes it.

### `checkoffs/{date}_{taskId}` — e.g. `2026-08-07_HOYT-D-001`
```
{ date: 'YYYY-MM-DD', taskId, byId, by, at: serverTimestamp, unit? }
```
Deterministic doc id ⇒ two phones can't double-sign the same task (second
create fails). Create requires a valid session and `byId == me`. Delete
(un-check) only by the same person. No updates.
`date` is computed client-side in America/Chicago.

### `issues/{autoId}`
```
{ machineCode, unit?, taskId?, byId, by, at, urgent: bool,
  usable: 'usable'|'unusable', note, status: 'open'|'cleared',
  clearedBy?, clearedAt? }
```
- create: any signed-in person, must be `status:'open'`, `byId == me`
- update `usable` only: any signed-in person (logged as a note by the app)
- update `status→cleared` (+`clearedBy`,`clearedAt`): only `canClear` people,
  enforced by rules via `diff().affectedKeys()` — UI hides the button, rules
  enforce it
- delete: never

#### `issues/{id}/notes/{autoId}` — append-only progress log
```
{ byId, by, at, text }
```

### `prefs/{personId}`
```
{ notify: 'urgent' | 'all' | 'off' }        // default 'urgent'
```
Read/write only by the signed-in person themselves.

### `tokens/{uid}`
```
{ token, personId, platform, at }           // FCM push token for this phone
```
Written by the phone, readable only by the bridge (which fans out pushes).

## Accepted risks (deliberate, documented)
1. **PIN brute force.** Anonymous auth means anyone with the URL can attempt
   sign-ins; rules can't rate-limit without Cloud Functions (needs a card).
   10,000 combinations × obscure URL × 6-person shop = acceptable. Mitigation
   if ever needed: rotate PINs, or move to Blaze + rate-limited function.
2. **Client-supplied date** on check-offs (Chicago-local, computed on phone).
   Rules don't validate it against server time; a tampered client could
   back/forward-date a sign-off. The nightly backup keeps `at` (server
   timestamp) alongside, so tampering is detectable.
3. **Session persistence.** Sessions live until sign-out/overwrite; the app
   also auto-signs-out at local midnight (client-side).

## Free-tier headroom (Spark)
- Writes: ~170 check-offs/day + issues ≪ 20K/day limit
- Reads: packed content docs keep a full app load to ~10 reads;
  6 phones × heavy use ≪ 50K/day limit
- Storage: whole dataset well under 1 GB
