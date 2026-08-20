/**
 * PM Maintenance — push notifications sender
 * ------------------------------------------------------------
 * Second file in the SAME Apps Script project as Code.gs.
 * A time trigger runs pushNewIssues() every minute; it finds
 * newly reported issues and pushes them (via FCM) to each
 * person, honoring their notify preference.
 *
 * Uses the sheet owner's own credentials (same as the bridge) —
 * reads Firestore over REST (owner bypasses security rules) and
 * calls FCM with the firebase.messaging scope. No key files.
 *
 * Run installNotifications() ONCE from the editor to authorize
 * and create the every-minute trigger.
 *
 * (PROJECT_ID and BASE are defined in Code.gs.)
 */

var FCM_URL = 'https://fcm.googleapis.com/v1/projects/' + PROJECT_ID + '/messages:send';
var APP_URL = 'https://euphor82.github.io/PM-Maint/';

function installNotifications() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    var h = t.getHandlerFunction();
    if (h === 'pushNewIssues' || h === 'pushDueReminders') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('pushNewIssues').timeBased().everyMinutes(1).create();
  ScriptApp.newTrigger('pushDueReminders').timeBased().atHour(7).everyDays(1).create();  // 7am (script tz = Chicago)
  SpreadsheetApp.getUi().alert('Notifications on',
    'Issues push every minute; task due-date reminders are checked each morning.',
    SpreadsheetApp.getUi().ButtonSet.OK);
}
function stopNotifications() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    var h = t.getHandlerFunction();
    if (h === 'pushNewIssues' || h === 'pushDueReminders') ScriptApp.deleteTrigger(t);
  });
}

function pushNewIssues() {
  var token = ScriptApp.getOAuthToken();

  var issues = firestoreRunQuery(token, {
    from: [{ collectionId: 'issues' }],
    orderBy: [{ field: { fieldPath: 'at' }, direction: 'DESCENDING' }],
    limit: 25
  });
  var cutoff = Date.now() - 20 * 60 * 1000;
  var fresh = issues.filter(function (i) {
    if (i.pushSent) return false;
    var at = i.at ? Date.parse(i.at) : 0;
    return at >= cutoff;
  });
  if (!fresh.length) return;

  var people = firestoreList(token, 'people');
  var prefs  = firestoreList(token, 'prefs');
  var tokens = firestoreList(token, 'tokens');
  var prefById = {}; prefs.forEach(function (p) { prefById[p.id] = p.notify || 'urgent'; });
  var personById = {}; people.forEach(function (p) { personById[p.id] = p; });
  var toksByPerson = {};
  tokens.forEach(function (tk) { if (tk.token && tk.personId) (toksByPerson[tk.personId] = toksByPerson[tk.personId] || []).push(tk); });

  fresh.forEach(function (issue) {
    var urgent = (issue.urgent === true);   // urgency follows the reporter's flag, not machine condition
    people.forEach(function (p) {
      if (!p.active) return;
      if (p.id === issue.byId) return;               // don't ping the reporter
      var pref = prefById[p.id] || 'urgent';
      if (pref === 'off') return;
      if (pref === 'urgent' && !urgent) return;
      (toksByPerson[p.id] || []).forEach(function (tk) { sendPush(token, tk, issue, urgent); });
    });
    firestorePatch(token, 'issues/' + issue.id, { pushSent: { booleanValue: true } }, ['pushSent']);
  });
}

function sendPush(token, tk, issue, urgent) {
  var lang = tk.lang || 'en';
  var machine = issue.machineName || (lang === 'es' ? 'Otro' : 'Other');
  var title = urgent
    ? (lang === 'es' ? '⚠️ Urgente: ' + machine : '⚠️ Urgent: ' + machine)
    : (lang === 'es' ? 'Nuevo problema: ' + machine : 'New issue: ' + machine);
  var body = (issue.note || '').slice(0, 120) + (issue.by ? ' — ' + issue.by : '');
  var msg = { message: {
    token: tk.token,
    data: { title: title, body: body, url: APP_URL, issueId: issue.id, urgent: urgent ? '1' : '0' },
    webpush: { headers: { Urgency: 'high' }, fcmOptions: { link: APP_URL } }
  } };
  var res = UrlFetchApp.fetch(FCM_URL, {
    method: 'post', contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + token },
    payload: JSON.stringify(msg), muteHttpExceptions: true
  });
  var code = res.getResponseCode();
  if (code === 404 || code === 410) {
    firestoreDelete(token, 'tokens/' + tk.id);        // stale token — clean it up
  } else if (code < 200 || code >= 300) {
    Logger.log('FCM ' + code + ': ' + res.getContentText().slice(0, 250));
  }
}

/* ---- manual test: send yourself a ping (run from editor after enabling on a phone) ---- */
function testPushToEveryone() {
  var token = ScriptApp.getOAuthToken();
  var tokens = firestoreList(token, 'tokens');
  if (!tokens.length) { Logger.log('No registered phones yet. Enable notifications in the app first.'); return; }
  tokens.forEach(function (tk) {
    sendPush(token, tk, { machineName: 'Test', note: 'This is a test notification from setup.', by: 'System', id: 'test' }, true);
  });
  Logger.log('Sent test to ' + tokens.length + ' phone(s).');
}

/* ================= due-date reminders (daily) ================= */
function pushDueReminders() {
  var token = ScriptApp.getOAuthToken();
  var tasksDoc = firestoreGet(token, 'content/tasks');
  if (!tasksDoc || !tasksDoc.rows) return;
  var dueTasks = tasksDoc.rows.filter(function (r) { return r.due; });
  if (!dueTasks.length) return;

  var lastDoc = firestoreGet(token, 'state/lastDone');
  var lastDone = (lastDoc && lastDoc.byTask) || {};
  var people = firestoreList(token, 'people');
  var prefs = firestoreList(token, 'prefs');
  var tokens = firestoreList(token, 'tokens');
  var prefById = {}; prefs.forEach(function (p) { prefById[p.id] = p; });
  var toksByPerson = {};
  tokens.forEach(function (tk) { if (tk.token && tk.personId) (toksByPerson[tk.personId] = toksByPerson[tk.personId] || []).push(tk); });

  var today = Utilities.formatDate(new Date(), 'America/Chicago', 'yyyy-MM-dd');

  dueTasks.forEach(function (task) {
    var dd = dayDiff(today, task.due);                 // due - today
    var ld = lastDone[task.id];
    var met = ld && ld.date && (ld.date >= addDaysKey(task.due, -7));   // done within the reminder window
    if (met) return;
    var kind = (dd === 7) ? 'week' : (dd === 0) ? 'day' : (dd < 0) ? 'overdue' : null;
    if (!kind) return;
    var overdueDays = dd < 0 ? -dd : 0;

    people.forEach(function (p) {
      if (!p.active) return;
      var pr = prefById[p.id] || {};
      var send = false;
      if (kind === 'week') send = (pr.dueWeekBefore !== false);
      else if (kind === 'day') send = (pr.dueOnDay !== false);
      else if (kind === 'overdue') {
        var ov = pr.overdueEvery || 'daily';
        if (ov === 'daily') send = true;
        else if (ov === '3days') send = (overdueDays % 3 === 0);
        else if (ov === 'weekly') send = (overdueDays % 7 === 0);
      }
      if (!send) return;
      (toksByPerson[p.id] || []).forEach(function (tk) { sendDuePush(token, tk, task, kind); });
    });
  });
}

function sendDuePush(token, tk, task, kind) {
  var lang = tk.lang || 'en';
  var name = (lang === 'es' && task.es) ? task.es : task.en;
  var title;
  if (kind === 'week') title = (lang === 'es') ? ('📅 Vence en 1 semana · ' + task.due) : ('📅 Due in 1 week · ' + task.due);
  else if (kind === 'day') title = (lang === 'es') ? '📅 Vence hoy' : '📅 Due today';
  else title = (lang === 'es') ? ('⚠️ Vencida · ' + task.due) : ('⚠️ Overdue · ' + task.due);
  var body = name + (task.machine ? (' — ' + task.machine) : '');
  var msg = { message: {
    token: tk.token,
    data: { title: title, body: body, url: APP_URL, taskId: task.id, kind: kind },
    webpush: { headers: { Urgency: 'high' }, fcmOptions: { link: APP_URL } }
  } };
  var res = UrlFetchApp.fetch(FCM_URL, {
    method: 'post', contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + token }, payload: JSON.stringify(msg), muteHttpExceptions: true
  });
  var code = res.getResponseCode();
  if (code === 404 || code === 410) firestoreDelete(token, 'tokens/' + tk.id);
  else if (code < 200 || code >= 300) Logger.log('DueFCM ' + code + ': ' + res.getContentText().slice(0, 200));
}

function keyToMs(k) { var p = k.split('-'); return Date.UTC(+p[0], +p[1] - 1, +p[2]); }
function dayDiff(a, b) { return Math.round((keyToMs(b) - keyToMs(a)) / 86400000); }
function addDaysKey(k, n) { return Utilities.formatDate(new Date(keyToMs(k) + n * 86400000), 'UTC', 'yyyy-MM-dd'); }

/* ================= Firestore REST helpers ================= */
function firestoreGet(token, path) {
  var res = UrlFetchApp.fetch(BASE + '/' + path, { headers: { Authorization: 'Bearer ' + token }, muteHttpExceptions: true });
  if (res.getResponseCode() !== 200) return null;
  return decodeFields(JSON.parse(res.getContentText()).fields || {});
}
function decodeValue(v) {
  if (v == null) return null;
  if ('stringValue' in v) return v.stringValue;
  if ('booleanValue' in v) return v.booleanValue;
  if ('integerValue' in v) return Number(v.integerValue);
  if ('doubleValue' in v) return v.doubleValue;
  if ('timestampValue' in v) return v.timestampValue;
  if ('nullValue' in v) return null;
  if ('mapValue' in v) return decodeFields((v.mapValue && v.mapValue.fields) || {});
  if ('arrayValue' in v) return ((v.arrayValue && v.arrayValue.values) || []).map(decodeValue);
  return null;
}
function decodeFields(f) { var o = {}; Object.keys(f || {}).forEach(function (k) { o[k] = decodeValue(f[k]); }); return o; }
function docId(name) { return name.split('/').pop(); }

function firestoreList(token, coll) {
  var out = [], pageToken = '';
  do {
    var url = BASE + '/' + coll + '?pageSize=300' + (pageToken ? ('&pageToken=' + encodeURIComponent(pageToken)) : '');
    var res = UrlFetchApp.fetch(url, { headers: { Authorization: 'Bearer ' + token }, muteHttpExceptions: true });
    if (res.getResponseCode() !== 200) { Logger.log('list ' + coll + ' ' + res.getResponseCode() + ': ' + res.getContentText().slice(0, 150)); return out; }
    var data = JSON.parse(res.getContentText());
    (data.documents || []).forEach(function (d) { var o = decodeFields(d.fields); o.id = docId(d.name); out.push(o); });
    pageToken = data.nextPageToken || '';
  } while (pageToken);
  return out;
}
function firestoreRunQuery(token, sq) {
  var res = UrlFetchApp.fetch(BASE + ':runQuery', {
    method: 'post', contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + token },
    payload: JSON.stringify({ structuredQuery: sq }), muteHttpExceptions: true
  });
  if (res.getResponseCode() !== 200) { Logger.log('runQuery ' + res.getResponseCode() + ': ' + res.getContentText().slice(0, 150)); return []; }
  var out = [];
  JSON.parse(res.getContentText()).forEach(function (r) {
    if (r.document) { var o = decodeFields(r.document.fields); o.id = docId(r.document.name); out.push(o); }
  });
  return out;
}
function firestorePatch(token, path, fields, mask) {
  var url = BASE + '/' + path + '?' + mask.map(function (m) { return 'updateMask.fieldPaths=' + m; }).join('&');
  UrlFetchApp.fetch(url, { method: 'patch', contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + token }, payload: JSON.stringify({ fields: fields }), muteHttpExceptions: true });
}
function firestoreDelete(token, path) {
  UrlFetchApp.fetch(BASE + '/' + path, { method: 'delete', headers: { Authorization: 'Bearer ' + token }, muteHttpExceptions: true });
}
