/**
 * PM Maintenance — Sheet → Firestore bridge
 * ------------------------------------------------------------
 * Lives inside the LIVE master sheet (Extensions → Apps Script).
 * Adds a "PM App" menu to the sheet with a Publish button.
 *
 * What Publish does:
 *   TASKS   (Active rows only) → content/tasks   (one packed doc)
 *   UI_TEXT                    → content/uiText  (one packed doc)
 *   PEOPLE                     → people/{id} docs (no PINs)
 *   PEOPLE PINs                → secrets/pins     (server-only doc)
 *
 * Auth: runs as the sheet owner, who also owns the Firebase
 * project, so no service-account keys are needed. Writes go
 * through the Firestore REST API with your own Google token.
 */

var PROJECT_ID = 'pm-maintenance-c618e';
var BASE = 'https://firestore.googleapis.com/v1/projects/' + PROJECT_ID +
           '/databases/(default)/documents';

// People who can clear issues if the sheet has no "Can Clear" column:
var DEFAULT_CLEARERS = ['darryl', 'dean', 'justin', 'drew'];

// ------------------------------------------------------------------
// Menu
// ------------------------------------------------------------------
function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('PM App')
    .addItem('Publish everything to app', 'publishAll')
    .addItem('Publish people & PINs only', 'publishPeopleOnly')
    .addSeparator()
    .addItem('Restore dropdowns (Status / Frequency)', 'restoreDropdowns')
    .addToUi();
}

// ------------------------------------------------------------------
// Publish actions
// ------------------------------------------------------------------
function publishAll() {
  var ui = SpreadsheetApp.getUi();
  try {
    var tasks  = readTasks();
    var uiText = readUiText();
    var people = readPeople();

    var tx = machineTranslateBlanks(tasks);   // fill blank Spanish via Google Translate (cached)

    writeDoc('content/tasks',  { rows: tasks, updatedAt: nowIso() });
    writeDoc('content/uiText', { keys: uiText, updatedAt: nowIso() });
    publishPeopleDocs(people);

    ui.alert('Published',
      tasks.length + ' active tasks\n' +
      Object.keys(uiText).length + ' wording keys\n' +
      people.length + ' people (PINs stored server-side only)\n' +
      (tx.translated + tx.fromCache) + ' Spanish auto-translated' +
        (tx.failed ? ' (' + tx.failed + ' failed → shown in English)' : '') + '\n\n' +
      'Every phone will pick this up within seconds.',
      ui.ButtonSet.OK);
  } catch (e) {
    ui.alert('Publish failed', String(e && e.message ? e.message : e), ui.ButtonSet.OK);
    throw e;
  }
}

function publishPeopleOnly() {
  var ui = SpreadsheetApp.getUi();
  try {
    var people = readPeople();
    publishPeopleDocs(people);
    ui.alert('Published', people.length + ' people updated (PINs server-side only).',
      ui.ButtonSet.OK);
  } catch (e) {
    ui.alert('Publish failed', String(e && e.message ? e.message : e), ui.ButtonSet.OK);
    throw e;
  }
}

function publishPeopleDocs(people) {
  var token = ScriptApp.getOAuthToken();
  var pins = {}, currentIds = {};
  people.forEach(function (p) {
    currentIds[p.id] = true;
    pins[p.id] = p.pin;
    writeDoc('people/' + p.id, {
      name: p.name, lang: p.lang, active: p.active,
      canClear: p.canClear, order: p.order
    });
  });
  // Rebuilt from the sheet only -> PINs of anyone removed are revoked here.
  writeDoc('secrets/pins', { byId: pins, updatedAt: nowIso() });

  // Reconcile: if a person's row was removed or renamed out of the sheet,
  // hide them from sign-in. Their doc is kept (active:false), not deleted,
  // so any past sign-offs still resolve their name.
  try {
    firestoreList(token, 'people').forEach(function (d) {
      if (!currentIds[d.id] && d.active !== false) {
        firestorePatch(token, 'people/' + d.id, { active: { booleanValue: false } }, ['active']);
      }
    });
  } catch (e) {
    Logger.log('People reconcile skipped (is push.gs present?): ' + e);
  }
}

// ------------------------------------------------------------------
// Sheet readers
// ------------------------------------------------------------------
function sheetOrDie(name) {
  var sh = SpreadsheetApp.getActive().getSheetByName(name);
  if (!sh) throw new Error('Tab "' + name + '" not found. Is this script inside the LIVE master sheet?');
  return sh;
}

function readTasks() {
  var values = sheetOrDie('TASKS').getDataRange().getValues();
  var hdrRow = -1, col = {};
  for (var i = 0; i < values.length; i++) {
    var lower = values[i].map(function (c) { return String(c).trim().toLowerCase(); });
    if (lower.indexOf('task id') !== -1) {
      hdrRow = i;
      lower.forEach(function (h, j) { col[h] = j; });
      break;
    }
  }
  if (hdrRow === -1) throw new Error('TASKS: header row with "Task ID" not found.');
  function need(h) {
    if (!(h in col)) throw new Error('TASKS: column "' + h + '" not found.');
    return col[h];
  }
  var cId = need('task id'), cMach = need('machine'), cUnits = need('units'),
      cEn = need('task (english)'),
      cFreq = need('frequency'), cStat = need('status');
  var cEs = ('task (spanish)' in col) ? col['task (spanish)'] : -1;  // optional — blanks are machine-translated at publish
  var cDue = ('due date' in col) ? col['due date'] : -1;     // optional
  var tz = SpreadsheetApp.getActive().getSpreadsheetTimeZone();

  var rows = [], seen = {};
  for (var r = hdrRow + 1; r < values.length; r++) {
    var id = String(values[r][cId]).trim();
    if (!id) continue;
    var status = String(values[r][cStat]).trim();
    if (status !== 'Active') continue;                       // Draft/Retired never leave the sheet
    if (seen[id]) throw new Error('TASKS: duplicate Task ID ' + id + ' — fix before publishing.');
    seen[id] = true;
    var en = String(values[r][cEn]).trim();
    if (!en) throw new Error('TASKS: ' + id + ' has empty English text.');
    var task = {
      id: id,
      code: id.split('-')[0],
      machine: String(values[r][cMach]).trim(),
      units: String(values[r][cUnits]).trim(),
      en: en,
      es: cEs >= 0 ? String(values[r][cEs]).trim() : '',
      freq: String(values[r][cFreq]).trim()
    };
    if (cDue >= 0) {
      var dv = values[r][cDue];
      if (dv instanceof Date && !isNaN(dv)) {
        task.due = Utilities.formatDate(dv, tz, 'yyyy-MM-dd');
      } else if (dv) {
        var ds = new Date(String(dv).trim());
        if (!isNaN(ds)) task.due = Utilities.formatDate(ds, tz, 'yyyy-MM-dd');
      }
    }
    rows.push(task);
  }
  if (rows.length === 0) throw new Error('TASKS: no Active rows found.');
  return rows;
}

function readUiText() {
  var values = sheetOrDie('UI_TEXT').getDataRange().getValues();
  var keys = {};
  values.forEach(function (row) {
    var k = String(row[0]).trim();
    if (k && k.indexOf('.') > 0 && k.toLowerCase() !== 'key') {
      keys[k] = { en: String(row[1]).trim(), es: String(row[2]).trim() };
    }
  });
  if (Object.keys(keys).length === 0) throw new Error('UI_TEXT: no keys found.');
  return keys;
}

function readPeople() {
  var values = sheetOrDie('PEOPLE').getDataRange().getValues();
  var hdrRow = -1, col = {};
  for (var i = 0; i < values.length; i++) {
    var lower = values[i].map(function (c) { return String(c).trim().toLowerCase(); });
    if (lower[0] === 'name') {
      hdrRow = i;
      lower.forEach(function (h, j) { if (h) col[h] = j; });
      break;
    }
  }
  if (hdrRow === -1) throw new Error('PEOPLE: header row starting with "Name" not found.');
  var hasClearCol = ('can clear' in col);

  var people = [], order = 0;
  for (var r = hdrRow + 1; r < values.length; r++) {
    var name = String(values[r][col['name']]).trim();
    if (!name) continue;
    var pin = String(values[r][col['pin']]).trim();
    if (!/^\d{4}$/.test(pin)) {
      throw new Error('PEOPLE: ' + name + ' needs a 4-digit PIN (found "' + pin.replace(/./g, '•') +
        '", length ' + pin.length + '). Format the PIN column as Plain text and re-enter.');
    }
    var langRaw = String(values[r][col['language']] || '').trim().toLowerCase();
    var active = String(values[r][col['active']] || '').trim().toLowerCase() === 'yes';
    var id = name.toLowerCase().replace(/[^a-z0-9]/g, '');
    var canClear = hasClearCol
      ? String(values[r][col['can clear']] || '').trim().toLowerCase() === 'yes'
      : DEFAULT_CLEARERS.indexOf(id) !== -1;
    people.push({
      id: id, name: name, pin: pin,
      lang: langRaw.indexOf('span') === 0 ? 'es' : 'en',
      active: active, canClear: canClear, order: order++
    });
  }
  if (people.length === 0) throw new Error('PEOPLE: no rows found.');
  var pinSet = {};
  people.forEach(function (p) {
    if (pinSet[p.pin]) throw new Error('PEOPLE: ' + p.name + ' and ' + pinSet[p.pin] +
      ' have the same PIN — every PIN must be unique.');
    pinSet[p.pin] = p.name;
  });
  return people;
}

// ------------------------------------------------------------------
// Firestore REST helpers
// ------------------------------------------------------------------
function writeDoc(path, obj) {
  var res = UrlFetchApp.fetch(BASE + '/' + path, {
    method: 'patch',
    contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() },
    payload: JSON.stringify({ fields: encodeFields(obj) }),
    muteHttpExceptions: true
  });
  var code = res.getResponseCode();
  if (code < 200 || code >= 300) {
    throw new Error('Firestore write to ' + path + ' failed (HTTP ' + code + '): ' +
      res.getContentText().slice(0, 300));
  }
}

function encodeFields(obj) {
  var fields = {};
  Object.keys(obj).forEach(function (k) { fields[k] = encodeValue(obj[k]); });
  return fields;
}

function encodeValue(v) {
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === 'boolean') return { booleanValue: v };
  if (typeof v === 'number') {
    return (v % 1 === 0) ? { integerValue: String(v) } : { doubleValue: v };
  }
  if (typeof v === 'string') return { stringValue: v };
  if (Array.isArray(v)) {
    return { arrayValue: { values: v.map(encodeValue) } };
  }
  return { mapValue: { fields: encodeFields(v) } };
}

function nowIso() {
  return new Date().toISOString();
}

// ------------------------------------------------------------------
// Restore the Status / Frequency dropdowns on the TASKS tab
// ------------------------------------------------------------------
// Re-applies the data-validation dropdowns (they're a sheet-only convenience;
// the app reads the plain text either way). Options = the canonical values the
// app recognizes, unioned with anything already in the column so nothing that's
// currently entered gets flagged. Safe to re-run anytime.
function restoreDropdowns() {
  var ui = SpreadsheetApp.getUi();
  try {
    var sh = sheetOrDie('TASKS');
    var values = sh.getDataRange().getValues();
    var hdrRow = -1, col = {};
    for (var i = 0; i < values.length; i++) {
      var lower = values[i].map(function (c) { return String(c).trim().toLowerCase(); });
      if (lower.indexOf('task id') !== -1) { hdrRow = i; lower.forEach(function (h, j) { if (h) col[h] = j; }); break; }
    }
    if (hdrRow === -1) throw new Error('Could not find the TASKS header row.');
    if (!('status' in col)) throw new Error('No "Status" column found.');
    if (!('frequency' in col)) throw new Error('No "Frequency" column found.');

    var firstDataRow = hdrRow + 2;                         // 1-based sheet row of first data row
    var nRows = sh.getLastRow() - (firstDataRow - 1);
    if (nRows < 1) throw new Error('No data rows to apply to.');

    var statusOpts = uniqueUnion(['Active', 'Retired', 'Draft'], columnValues(values, hdrRow, col['status']));
    var freqCanon = ['Daily', 'Mon & Thu', 'Weekly', 'Bi-Weekly', 'Every 45 Days', 'Monthly',
                     'Quarterly', 'Semi-Annually', 'Annually', 'Every Load', 'Every 3 Loads',
                     'Every 25 Loads', 'Every 250 Loads', 'Every 300 Loads', 'As Needed'];
    var freqOpts = uniqueUnion(freqCanon, columnValues(values, hdrRow, col['frequency']));

    applyDropdown(sh, firstDataRow, col['status'] + 1, nRows, statusOpts);
    applyDropdown(sh, firstDataRow, col['frequency'] + 1, nRows, freqOpts);

    ui.alert('Dropdowns restored',
      'Applied to ' + nRows + ' rows.\n\n' +
      'Status: ' + statusOpts.join(', ') + '\n\n' +
      'Frequency: ' + freqOpts.join(', '),
      ui.ButtonSet.OK);
  } catch (e) {
    ui.alert('Restore failed', String(e && e.message ? e.message : e), ui.ButtonSet.OK);
    throw e;
  }
}
function columnValues(values, hdrRow, cIdx) {
  var out = [];
  for (var r = hdrRow + 1; r < values.length; r++) { var v = String(values[r][cIdx]).trim(); if (v) out.push(v); }
  return out;
}
function uniqueUnion(a, b) {
  var seen = {}, out = [];
  a.concat(b).forEach(function (x) { var k = String(x).trim(); if (k && !seen[k]) { seen[k] = true; out.push(k); } });
  return out;
}
function applyDropdown(sh, firstRow, colNum, nRows, options) {
  // allowInvalid:true → shows the dropdown for picking but never rejects a value
  // already in the cell (so restoring can't disrupt existing data)
  var rule = SpreadsheetApp.newDataValidation().requireValueInList(options, true).setAllowInvalid(true).build();
  sh.getRange(firstRow, colNum, nRows, 1).setDataValidation(rule);
}

// ------------------------------------------------------------------
// Spanish auto-translation (Google Translate, built-in & free)
// ------------------------------------------------------------------
// Any task whose Spanish cell is BLANK gets machine-translated at publish
// time. Filled Spanish cells are treated as human overrides and never touched.
// Results are cached in content/txCache (keyed by a hash of the English) so
// repeat publishes only translate new or changed text. Every step is guarded:
// a translation (or cache) failure just leaves that task in English — it can
// never break a publish.
function machineTranslateBlanks(rows) {
  var token = ScriptApp.getOAuthToken();
  var cache = {};
  try {
    var doc = firestoreGet(token, 'content/txCache');
    if (doc && doc.map) cache = doc.map;
  } catch (e) { cache = {}; }

  var translated = 0, fromCache = 0, failed = 0, added = false, sinceFlush = 0;
  rows.forEach(function (t) {
    if (t.es) return;                        // human Spanish present — leave it alone
    var key = md5hex(t.en);
    if (cache[key]) { t.es = cache[key]; t.esAuto = true; fromCache++; return; }
    try {
      var tr = LanguageApp.translate(t.en, 'en', 'es');
      if (tr && String(tr).trim()) {
        t.es = String(tr).trim(); t.esAuto = true;
        cache[key] = t.es; translated++; added = true; sinceFlush++;
        // flush the cache periodically so a big first run survives a timeout —
        // a re-publish then continues from where it left off instead of restarting
        if (sinceFlush >= 40) { try { writeDoc('content/txCache', { map: cache, updatedAt: nowIso() }); sinceFlush = 0; } catch (e) {} }
      }
    } catch (e) { failed++; }                // leave blank → app falls back to English
  });

  if (added) { try { writeDoc('content/txCache', { map: cache, updatedAt: nowIso() }); } catch (e) {} }
  return { translated: translated, fromCache: fromCache, failed: failed };
}

function md5hex(s) {
  var d = Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, s || '', Utilities.Charset.UTF_8);
  var h = '';
  for (var i = 0; i < d.length; i++) { var b = (d[i] + 256) % 256; h += (b < 16 ? '0' : '') + b.toString(16); }
  return h;
}

// ------------------------------------------------------------------
// Keep Spanish fresh: when a TASKS row's English is edited, clear that
// row's Spanish cell so the next Publish re-translates it. (Simple trigger —
// active automatically; runs only on manual edits in the sheet.)
// ------------------------------------------------------------------
function onEdit(e) {
  try {
    if (!e || !e.range) return;
    var sh = e.range.getSheet();
    if (sh.getName() !== 'TASKS') return;
    var scan = sh.getRange(1, 1, Math.min(sh.getLastRow(), 30), sh.getLastColumn()).getValues();
    var hdrRow = -1, cEn = -1, cEs = -1;
    for (var i = 0; i < scan.length; i++) {
      var low = scan[i].map(function (c) { return String(c).trim().toLowerCase(); });
      if (low.indexOf('task id') !== -1) { hdrRow = i; cEn = low.indexOf('task (english)'); cEs = low.indexOf('task (spanish)'); break; }
    }
    if (hdrRow === -1 || cEn === -1 || cEs === -1) return;   // no Spanish column to keep in sync
    var enCol = cEn + 1, esCol = cEs + 1, headerSheetRow = hdrRow + 1;
    var rng = e.range;
    if (enCol < rng.getColumn() || enCol > rng.getLastColumn()) return;  // edit didn't touch the English column
    for (var row = rng.getRow(); row <= rng.getLastRow(); row++) {
      if (row <= headerSheetRow) continue;                   // skip header
      sh.getRange(row, esCol).clearContent();
    }
  } catch (err) { /* never block the user's edit */ }
}
