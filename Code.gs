/**
 * Booking Widget — Google Apps Script backend
 * Matches the API contract expected by booking-widget.js:
 *
 *   GET  ?action=config                  -> { businessName, services[], hours{}, maxAdvanceDays, minNoticeHours }
 *   GET  ?action=slots&date=YYYY-MM-DD&service=ID -> { slots: ["17:00", "18:00", ...] }
 *   POST { service, serviceName, date, time, email, note?, name?, phone?,
 *          consent?, extra?: { food, vibe, ... }, lang }
 *        -> { ok:true } | { ok:false, error }
 *
 * WHAT'S NEW
 *   - serviceName: the label the page shows ("Dinner: Pizza · comfy but
 *     cute") becomes the event title (see useClientServiceName).
 *   - extra.food / extra.vibe (vibe check) land in the event description,
 *     both emails and the .ics file. Add more keys in EXTRA_LABELS.
 *   - consent (the dessert clause) is recorded.
 *   - Confirmation email now looks like the ticket on the page and
 *     follows the page language (en/de).
 *   - Everything the visitor types is escaped before it goes into the
 *     HTML email, and date/time input is validated.
 *
 * SETUP
 * 1. In this Apps Script project: Project Settings → set Time zone to
 *    "Europe/Berlin" (or wherever the calendar/event should actually live).
 * 2. Adjust the CONFIG block below.
 * 3. Deploy → New deployment → type "Web app".
 *      Execute as: Me
 *      Who has access: Anyone
 * 4. Copy the resulting /exec URL into index.html as `endpoint`.
 * 5. Every time you *change the code*: Deploy → Manage deployments →
 *    pencil icon → Version: "New version" → Deploy. That keeps the SAME
 *    /exec URL. ("New deployment" would give you a new URL instead.)
 */

/* ───────────────────────── CONFIG — edit this ───────────────────────── */

var CONFIG = {
  // Shown to the widget; not shown anywhere since this flow uses forceService
  // client-side, but kept as a sane fallback if you ever reuse this backend
  // for a widget instance that shows the normal service picker.
  businessName: 'Max & you',
  services: [
    { id: 'date', name: 'Dinner-Date', duration: 120 }
  ],

  // Which calendar new bookings actually get created on. '' = your default
  // (primary) calendar. To use a specific calendar instead, paste its
  // Calendar ID here (Google Calendar → calendar settings → "Integrate
  // calendar" → Calendar ID).
  calendarId: 'mamfred.meyer@gmail.com',

  // Other calendars to check for conflicts, WITHOUT ever creating events
  // on them — e.g. a second calendar you use to block off time (work,
  // another commitment, etc.). A slot is only offered if it's free on
  // calendarId AND every calendar listed here. Leave as [] if you only
  // have one calendar.
  //
  // Each entry needs to be shared with whichever Google account runs
  // this script (Project Settings → your account, or the "Execute as"
  // account from the deployment) with at least "See all event details"
  // permission, or getCalendarById() won't be able to read it.
  additionalBusyCalendarIds: [
    'family01378191518770149100@group.calendar.google.com'
  ],

  // Opening hours per weekday. 0 = Sunday ... 6 = Saturday, matching JS Date#getDay().
  // Empty array = closed that day. Ranges are "HH:MM-HH:MM", 24h format.
  hours: {
    0: ['17:00-22:00'], // Sun
    1: ['17:00-22:00'], // Mon
    2: ['17:00-22:00'], // Tue
    3: ['17:00-22:00'], // Wed
    4: ['17:00-22:00'], // Thu
    5: ['17:00-22:00'], // Fri
    6: ['17:00-22:00']  // Sat
  },

  // How far apart candidate start times are, in minutes.
  slotIntervalMinutes: 60,

  // Fallback event duration (minutes) if the requested service id isn't
  // found in `services` above — this is what actually gets used for the
  // "Dinner date" forced-service flow from the front end.
  defaultDurationMinutes: 120,

  // Don't allow booking a slot less than this many hours from now.
  minNoticeHours: 3,

  // Don't allow booking further out than this many days.
  maxAdvanceDays: 60,

  // Calendar event title. {service} is replaced with the service name.
  eventTitleTemplate: '{service}',

  // NEW: use the service name the page sends (e.g. "Dinner: Pizza · comfy
  // but cute") as the event title, instead of the fixed name in `services`.
  // Only applies when the service id exists above (here: 'date').
  useClientServiceName: true,

  // Your own email, to get notified whenever someone books. Leave '' to skip.
  notifyEmail: Session.getEffectiveUser().getEmail()
};

// Labels for the `extra` fields the page sends. Keys not listed here are
// still shown, just with their raw key as label.
var EXTRA_LABELS = {
  en: { food: 'Menu', vibe: 'Dress code' },
  de: { food: 'Essen', vibe: 'Dresscode' }
};

// Email / text strings per language (the page sends lang: 'en' or 'de').
var TEXT = {
  en: {
    subject: 'Confirmed: ',
    kicker: 'it\u2019s a date',
    headline: 'See you there.',
    ticketTitle: 'Dinner date, admit two',
    when: 'When',
    note: 'Side quests',
    consent: 'Dessert clause',
    consentYes: 'accepted \u2713',
    footer: 'Tap the attached invite to add it to Apple, Google & co.',
    timeSuffix: '',
    weekdays: ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'],
    months: ['January', 'February', 'March', 'April', 'May', 'June', 'July',
             'August', 'September', 'October', 'November', 'December'],
    dateLabel: function (wd, d, m) { return wd + ', ' + m + ' ' + d; },
    notifySubject: 'New booking: '
  },
  de: {
    subject: 'Best\u00e4tigt: ',
    kicker: 'es ist ein Date',
    headline: 'Wir sehen uns.',
    ticketTitle: 'Dinner-Date, Eintritt f\u00fcr zwei',
    when: 'Wann',
    note: 'Anmerkung',
    consent: 'Dessert-Klausel',
    consentYes: 'akzeptiert \u2713',
    footer: 'Tippe auf die angeh\u00e4ngte Einladung, um sie in Apple, Google & Co. einzutragen.',
    timeSuffix: ' Uhr',
    weekdays: ['Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag', 'Sonntag'],
    months: ['Januar', 'Februar', 'M\u00e4rz', 'April', 'Mai', 'Juni', 'Juli',
             'August', 'September', 'Oktober', 'November', 'Dezember'],
    dateLabel: function (wd, d, m) { return wd + ', ' + d + '. ' + m; },
    notifySubject: 'Neue Buchung: '
  }
};

/* ───────────────────────── HTTP entry points ───────────────────────── */

function doGet(e) {
  try {
    var action = e.parameter.action;
    if (action === 'config') return jsonOut(getConfig());
    if (action === 'slots') return jsonOut(getSlots(e.parameter.date, e.parameter.service));
    return jsonOut({ error: 'unknown_action' });
  } catch (err) {
    return jsonOut({ error: 'server_error', message: String(err) });
  }
}

function doPost(e) {
  try {
    var body = JSON.parse(e.postData.contents);
    var check = validateBooking(body);
    if (!check.ok) return jsonOut({ ok: false, error: check.error });
    return jsonOut(createBooking(sanitizeBooking(body)));
  } catch (err) {
    return jsonOut({ ok: false, error: 'server_error', message: String(err) });
  }
}

function jsonOut(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

/* ───────────────────────── config ───────────────────────── */

function getConfig() {
  return {
    businessName: CONFIG.businessName,
    services: CONFIG.services,
    hours: CONFIG.hours,
    maxAdvanceDays: CONFIG.maxAdvanceDays,
    minNoticeHours: CONFIG.minNoticeHours
  };
}

/* ───────────────────────── slots ───────────────────────── */

function getSlots(dateStr, serviceId) {
  if (!isValidDate(dateStr)) return { slots: [] };

  var dateParts = dateStr.split('-').map(Number); // [YYYY, MM, DD]
  var weekday = new Date(dateParts[0], dateParts[1] - 1, dateParts[2]).getDay();
  var ranges = CONFIG.hours[weekday] || [];
  if (!ranges.length) return { slots: [] };

  var duration = getDurationForService(serviceId);
  var candidates = buildCandidateTimes(ranges, duration);
  if (!candidates.length) return { slots: [] };

  var dayStart = new Date(dateParts[0], dateParts[1] - 1, dateParts[2], 0, 0, 0);
  var dayEnd = new Date(dateParts[0], dateParts[1] - 1, dateParts[2], 23, 59, 59);
  var busy = getBusyIntervals(dayStart, dayEnd);

  var earliestAllowed = new Date(Date.now() + CONFIG.minNoticeHours * 3600 * 1000);

  var free = candidates.filter(function (c) {
    var start = partsToDate(dateStr, c.time);
    var end = new Date(start.getTime() + duration * 60000);
    if (start < earliestAllowed) return false;
    return !overlapsAny(start, end, busy);
  });

  return { slots: free.map(function (c) { return c.time; }) };
}

function getDurationForService(serviceId) {
  var match = getServiceMeta(serviceId);
  return match ? match.duration : CONFIG.defaultDurationMinutes;
}

function getServiceMeta(serviceId) {
  return CONFIG.services.filter(function (s) { return s.id === serviceId; })[0] || null;
}

// Turns ["17:00-22:00"] + a duration into a flat list of candidate start times
// spaced by slotIntervalMinutes, that still fit before the range's end.
function buildCandidateTimes(ranges, durationMinutes) {
  var out = [];
  ranges.forEach(function (range) {
    var bounds = range.split('-');
    var startMin = hhmmToMinutes(bounds[0]);
    var endMin = hhmmToMinutes(bounds[1]);
    for (var t = startMin; t + durationMinutes <= endMin; t += CONFIG.slotIntervalMinutes) {
      out.push({ time: minutesToHHMM(t) });
    }
  });
  return out;
}

function hhmmToMinutes(hhmm) {
  var p = hhmm.split(':').map(Number);
  return p[0] * 60 + p[1];
}

function minutesToHHMM(mins) {
  var h = Math.floor(mins / 60);
  var m = mins % 60;
  return (h < 10 ? '0' : '') + h + ':' + (m < 10 ? '0' : '') + m;
}

function partsToDate(dateStr, timeStr) {
  var d = dateStr.split('-').map(Number);
  var t = timeStr.split(':').map(Number);
  return new Date(d[0], d[1] - 1, d[2], t[0], t[1], 0, 0);
}

function isValidDate(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(s || ''))) return false;
  var p = s.split('-').map(Number);
  var d = new Date(p[0], p[1] - 1, p[2]);
  return d.getFullYear() === p[0] && d.getMonth() === p[1] - 1 && d.getDate() === p[2];
}

function isValidTime(s) {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(String(s || ''));
}

// The single calendar new bookings are actually created on.
function getBookingCalendar() {
  return resolveCalendarById(CONFIG.calendarId);
}

function resolveCalendarById(id) {
  return id ? CalendarApp.getCalendarById(id) : CalendarApp.getDefaultCalendar();
}

// Busy intervals across the booking calendar AND every calendar listed in
// additionalBusyCalendarIds — a slot only counts as free if it's free on
// all of them. Any calendar ID that can't be resolved (typo, not shared
// with this script's account, etc.) is skipped rather than crashing the
// whole request, so one bad ID doesn't take slot-checking down entirely.
function getBusyIntervals(rangeStart, rangeEnd) {
  var ids = [CONFIG.calendarId].concat(CONFIG.additionalBusyCalendarIds || []);
  var intervals = [];

  ids.forEach(function (id) {
    var cal;
    try {
      cal = resolveCalendarById(id);
    } catch (err) {
      cal = null;
    }
    if (!cal) return;

    var events = cal.getEvents(rangeStart, rangeEnd);
    events.forEach(function (ev) {
      intervals.push({ start: ev.getStartTime(), end: ev.getEndTime() });
    });
  });

  return intervals;
}

function overlapsAny(start, end, busyIntervals) {
  return busyIntervals.some(function (b) {
    return start < b.end && end > b.start;
  });
}

/* ───────────────────────── booking ───────────────────────── */

// Only email is required. name/phone are optional — the widget only sends
// them when its `fields` option shows them (this page doesn't).
function validateBooking(body) {
  if (!body || !body.service || !isValidDate(body.date) || !isValidTime(body.time)) {
    return { ok: false, error: 'bad_request' };
  }
  if (!getServiceMeta(body.service)) {
    return { ok: false, error: 'bad_request' };
  }
  var email = String(body.email || '').trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 200) {
    return { ok: false, error: 'bad_request' };
  }

  var requested = partsToDate(body.date, body.time);
  var now = new Date();

  if (requested < new Date(now.getTime() + CONFIG.minNoticeHours * 3600 * 1000)) {
    return { ok: false, error: 'too_soon' };
  }
  var maxDate = new Date(now.getTime() + CONFIG.maxAdvanceDays * 86400 * 1000);
  if (requested > maxDate) {
    return { ok: false, error: 'too_far' };
  }

  // is this slot actually still open, per current calendar state?
  var stillFree = getSlots(body.date, body.service).slots.indexOf(body.time) !== -1;
  if (!stillFree) return { ok: false, error: 'slot_taken' };

  return { ok: true };
}

// Trims, length-limits and strips control characters from everything the
// visitor (or anyone calling the URL directly) can send.
function sanitizeBooking(body) {
  function clean(v, max) {
    return String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);
  }
  function cleanMultiline(v, max) {
    return String(v == null ? '' : v).replace(/\r\n?/g, '\n')
      .replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, ' ').trim().slice(0, max);
  }

  var extra = {};
  if (body.extra && typeof body.extra === 'object') {
    Object.keys(body.extra).slice(0, 8).forEach(function (k) {
      var key = clean(k, 30);
      var val = clean(body.extra[k], 120);
      if (key && val) extra[key] = val;
    });
  }

  return {
    service: body.service,
    serviceName: clean(body.serviceName, 140),
    date: body.date,
    time: body.time,
    email: clean(body.email, 200),
    name: clean(body.name, 100),
    phone: clean(body.phone, 40),
    note: cleanMultiline(body.note, 600),
    consent: body.consent === true,
    extra: extra,
    lang: body.lang === 'de' ? 'de' : 'en'
  };
}

function createBooking(body) {
  // Serialize concurrent bookings so two people can't grab the same slot
  // in the same instant.
  var lock = LockService.getScriptLock();
  var gotLock = lock.tryLock(10000);
  if (!gotLock) return { ok: false, error: 'server_busy' };

  try {
    // re-check freshness once more now that we hold the lock
    var stillFree = getSlots(body.date, body.service).slots.indexOf(body.time) !== -1;
    if (!stillFree) return { ok: false, error: 'slot_taken' };

    var t = TEXT[body.lang];
    var duration = getDurationForService(body.service);
    var start = partsToDate(body.date, body.time);
    var end = new Date(start.getTime() + duration * 60000);

    var serviceMeta = getServiceMeta(body.service);
    var serviceName = (CONFIG.useClientServiceName && body.serviceName)
      ? body.serviceName
      : (serviceMeta ? serviceMeta.name : 'Dinner date');
    var title = CONFIG.eventTitleTemplate.replace('{service}', serviceName) + ' — ' + body.email;

    // one list of "label: value" rows, reused for the event, emails and .ics
    var rows = detailRows(body, t);
    var descriptionLines = ['Datenight', 'Email: ' + body.email]
      .concat(rows.map(function (r) { return r.label + ': ' + r.value; }));

    // The actual event only ever goes on the one booking calendar — the
    // additionalBusyCalendarIds ones were only consulted for conflicts.
    // sendInvite:false — we skip Google's own plain invite email and
    // send exactly one branded email ourselves, with the calendar file
    // attached directly to it (see sendConfirmationEmail below).
    var event = getBookingCalendar().createEvent(title, start, end, {
      description: descriptionLines.join('\n'),
      guests: body.email,
      sendInvite: false
    });

    sendConfirmationEmail(body, serviceName, start, end, event, rows, t);

    if (CONFIG.notifyEmail) {
      MailApp.sendEmail({
        to: CONFIG.notifyEmail,
        subject: t.notifySubject + serviceName + ' — ' + body.email,
        body: descriptionLines.join('\n') + '\n' + t.when + ': ' + whenLabel(start, t)
      });
    }

    return { ok: true };
  } finally {
    lock.releaseLock();
  }
}

// [{ label, value }] for food, vibe, any other extras, name/phone, note, consent
function detailRows(body, t) {
  var labels = EXTRA_LABELS[body.lang] || {};
  var rows = [];
  Object.keys(body.extra).forEach(function (k) {
    rows.push({ label: labels[k] || k, value: body.extra[k] });
  });
  if (body.name) rows.push({ label: 'Name', value: body.name });
  if (body.phone) rows.push({ label: body.lang === 'de' ? 'Telefon' : 'Phone', value: body.phone });
  if (body.note) rows.push({ label: t.note, value: body.note });
  if (body.consent) rows.push({ label: t.consent, value: t.consentYes });
  return rows;
}

function whenLabel(start, t) {
  var tz = Session.getScriptTimeZone();
  var wd = Number(Utilities.formatDate(start, tz, 'u')) - 1;   // 1 = Monday … 7 = Sunday
  var d = Number(Utilities.formatDate(start, tz, 'd'));
  var m = Number(Utilities.formatDate(start, tz, 'M')) - 1;
  var time = Utilities.formatDate(start, tz, 'HH:mm');
  return t.dateLabel(t.weekdays[wd], d, t.months[m]) + ' \u00b7 ' + time + t.timeSuffix;
}

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/* ───────────────────────── branded confirmation email ───────────────────────── */

// Sent to the guest right after the booking succeeds — ONE email, with
// the calendar file attached directly to it. Styled like the ticket on the
// page (cream paper, plum ink, dashed perforation). Styling is inline
// because email clients ignore <style> blocks / external CSS.
function sendConfirmationEmail(body, serviceName, start, end, event, rows, t) {
  var serif = "Georgia,'Times New Roman',serif";
  var sans = "Arial,Helvetica,sans-serif";

  function row(label, value) {
    return ''
      + '<tr>'
      +   '<td style="padding:7px 0;vertical-align:top;width:38%;font-family:' + sans + ';font-size:12px;color:#8a7682;">' + escapeHtml(label) + '</td>'
      +   '<td style="padding:7px 0;vertical-align:top;font-family:' + serif + ';font-size:16px;color:#24121f;">' + escapeHtml(value).replace(/\n/g, '<br>') + '</td>'
      + '</tr>';
  }

  var tableRows = row(t.when, whenLabel(start, t));
  rows.forEach(function (r) { tableRows += row(r.label, r.value); });

  var html = ''
    + '<div style="background:#24121f;padding:40px 16px;">'
    +   '<div style="max-width:440px;margin:0 auto;">'
    +     '<p style="text-align:center;color:#f2c17b;font-family:' + serif + ';font-style:italic;font-size:16px;margin:0 0 8px;">' + escapeHtml(t.kicker) + '</p>'
    +     '<h1 style="text-align:center;color:#fff7ee;font-family:' + serif + ';font-weight:normal;font-size:32px;line-height:1.25;margin:0 0 26px;">' + escapeHtml(t.headline) + '</h1>'
    +     '<div style="background:#fff7ee;border-radius:16px;padding:26px 24px 20px;">'
    +       '<p style="font-family:' + serif + ';font-style:italic;font-size:22px;color:#3a1f33;margin:0 0 4px;">' + escapeHtml(t.ticketTitle) + '</p>'
    +       '<p style="font-family:' + sans + ';font-size:13px;color:#8a7682;margin:0 0 16px;">' + escapeHtml(serviceName) + '</p>'
    +       '<div style="border-top:2px dashed #e3d5d2;margin:0 0 10px;"></div>'
    +       '<table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;border-collapse:collapse;">' + tableRows + '</table>'
    +     '</div>'
    +     '<p style="text-align:center;color:#a9909f;font-family:' + sans + ';font-size:12.5px;margin:20px 0 0;">' + escapeHtml(t.footer) + '</p>'
    +   '</div>'
    + '</div>';

  var ics = buildICS({
    uid: event.getId(),
    title: serviceName,
    description: rows.map(function (r) { return r.label + ': ' + r.value; }).join('\n'),
    start: start,
    end: end,
    organizerEmail: CONFIG.notifyEmail || Session.getEffectiveUser().getEmail(),
    attendeeEmail: body.email
  });
  var icsBlob = Utilities.newBlob(ics, 'text/calendar', 'invite.ics');

  MailApp.sendEmail({
    to: body.email,
    subject: t.subject + serviceName,
    htmlBody: html,
    attachments: [icsBlob]
  });
}

// Builds a minimal but valid RFC 5545 .ics invite as plain text.
function buildICS(opts) {
  function fmtUTC(d) {
    return Utilities.formatDate(d, 'Etc/UTC', "yyyyMMdd'T'HHmmss'Z'");
  }
  function esc(text) {
    return String(text || '')
      .replace(/\\/g, '\\\\')
      .replace(/;/g, '\\;')
      .replace(/,/g, '\\,')
      .replace(/\n/g, '\\n');
  }
  // RFC 5545: lines longer than 75 bytes must be folded (CRLF + space).
  // Emojis and umlauts are multi-byte, so this counts bytes, not characters.
  function fold(line) {
    var out = [], cur = '', bytes = 0, limit = 75;
    Array.from(line).forEach(function (ch) {
      var b = Utilities.newBlob(ch).getBytes().length;
      if (bytes + b > limit) {
        out.push(cur);
        cur = ' ';
        bytes = 1;
        limit = 75;
      }
      cur += ch;
      bytes += b;
    });
    out.push(cur);
    return out.join('\r\n');
  }
  var lines = [
    'BEGIN:VCALENDAR',
    'PRODID:-//' + CONFIG.businessName + '//Booking Widget//EN',
    'VERSION:2.0',
    'CALSCALE:GREGORIAN',
    'METHOD:REQUEST',
    'BEGIN:VEVENT',
    'UID:' + esc(opts.uid),
    'DTSTAMP:' + fmtUTC(new Date()),
    'DTSTART:' + fmtUTC(opts.start),
    'DTEND:' + fmtUTC(opts.end),
    'SUMMARY:' + esc(opts.title),
    'DESCRIPTION:' + esc(opts.description),
    'ORGANIZER;CN=' + esc(CONFIG.businessName) + ':mailto:' + opts.organizerEmail,
    'ATTENDEE;CN=' + esc(opts.attendeeEmail) + ';RSVP=TRUE:mailto:' + opts.attendeeEmail,
    'STATUS:CONFIRMED',
    'SEQUENCE:0',
    'END:VEVENT',
    'END:VCALENDAR'
  ];
  return lines.map(fold).join('\r\n');
}
