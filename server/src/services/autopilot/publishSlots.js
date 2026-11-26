// Booking a publish time for a video: the next free slot, or a time the user types
// ("27 Nov 18:30", "tomorrow 9am", "19:30"). Pure (no database).
import {normalizeAutopilot,nextSlots} from './autopilotRules.js';
import {zoned,zonedToUtc} from '../uploadSettings.js';

export const MIN_LEAD_MINUTES = 15;          // YouTube needs some time to process before going public
export const MAX_AHEAD_DAYS = 180;

// Slot times for a profile: its Autopilot times when Autopilot is on, else its daily
// publish time, else the Autopilot default times.
export function slotSettingsFor(series = {}) {
  const tz = series.uploadSettings?.timezone || series.autopilot?.timezone || 'Asia/Kolkata';
  const ap = normalizeAutopilot(series.autopilot || {}, {timezone: tz});
  const daily = String(series.uploadSettings?.scheduleTime || '').trim();
  if (!ap.enabled && /^([01]?\d|2[0-3]):[0-5]\d$/.test(daily)) return {...ap, times: [daily.padStart(5, '0')], days: [0, 1, 2, 3, 4, 5, 6]};
  return ap;
}

// First slot at least MIN_LEAD_MINUTES away that no video/run already uses.
export function nextFreeSlot(settings, taken = [], now = new Date(), minLeadMinutes = MIN_LEAD_MINUTES) {
  const used = taken.map(d => new Date(d).getTime()).filter(Number.isFinite);
  const from = new Date(now.getTime() + minLeadMinutes * 60000);
  return nextSlots(settings, from, 16).find(s => !used.some(t => Math.abs(t - s.getTime()) < 60000)) || null;
}

export function formatWhen(date, timeZone = 'Asia/Kolkata') {
  return new Intl.DateTimeFormat('en-IN', {timeZone, weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', hour12: true}).format(new Date(date)).replace(/\b(am|pm)\b/gi, m => m.toLowerCase());
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const month = name => MONTHS.indexOf(String(name).slice(0, 3).toLowerCase()) + 1;

// Parses a typed date/time in the profile's time zone. Returns {at} or {error}.
export function parseWhen(input, timeZone = 'Asia/Kolkata', now = new Date()) {
  let s = ` ${String(input || '').toLowerCase().replace(/[,]/g, ' ').replace(/\s+/g, ' ').trim()} `;
  if (!s.trim()) return {error: 'Send a date and time, for example “27 Nov 18:30” or “tomorrow 9am”.'};
  // Time: 18:30, 6:30 pm, 6.30pm, 6 pm, 9am
  let h = null, mi = 0;
  const t1 = /\s(\d{1,2})[:.](\d{2})\s*(am|pm|a\.m\.|p\.m\.)?(?=\s)/.exec(s);
  const t2 = t1 ? null : /\s(\d{1,2})\s*(am|pm|a\.m\.|p\.m\.)(?=\s)/.exec(s);
  const t = t1 || t2;
  if (!t) return {error: 'Please include a time, for example “18:30” or “6:30 pm”.'};
  h = Number(t[1]); mi = t1 ? Number(t1[2]) : 0;
  const ap = (t1 ? t1[3] : t2[2]) || '';
  if (ap) { if (h < 1 || h > 12) return {error: 'With am/pm the hour must be 1–12.'}; if (ap.startsWith('p') && h !== 12) h += 12; if (ap.startsWith('a') && h === 12) h = 0; }
  if (h > 23 || mi > 59) return {error: 'That time is not valid.'};
  s = s.slice(0, t.index) + ' ' + s.slice(t.index + t[0].length);
  // Date
  const today = zoned(now, timeZone);
  let y = today.y, m = today.m, d = today.d, explicit = false, yearGiven = false;
  const shift = n => { const b = new Date(Date.UTC(today.y, today.m - 1, today.d + n)); y = b.getUTCFullYear(); m = b.getUTCMonth() + 1; d = b.getUTCDate(); explicit = true; };
  let r;
  if (/\s(day after tomorrow|parso|parson)\s/.test(s)) shift(2);
  else if (/\s(tomorrow|tmrw|tmr|kal)\s/.test(s)) shift(1);
  else if (/\s(today|tonight|aaj)\s/.test(s)) shift(0);
  else if ((r = /\s(\d{4})-(\d{1,2})-(\d{1,2})\s/.exec(s))) { y = +r[1]; m = +r[2]; d = +r[3]; explicit = yearGiven = true; }
  else if ((r = /\s(\d{1,2})\s*([a-z]{3,9})\s*(\d{4})?\s/.exec(s)) && month(r[2])) { d = +r[1]; m = month(r[2]); if (r[3]) { y = +r[3]; yearGiven = true; } explicit = true; }
  else if ((r = /\s([a-z]{3,9})\s*(\d{1,2})\s*(\d{4})?\s/.exec(s)) && month(r[1])) { m = month(r[1]); d = +r[2]; if (r[3]) { y = +r[3]; yearGiven = true; } explicit = true; }
  else if ((r = /\s(\d{1,2})[/.-](\d{1,2})(?:[/.-](\d{2,4}))?\s/.exec(s))) { d = +r[1]; m = +r[2]; if (r[3]) { y = +r[3] < 100 ? 2000 + +r[3] : +r[3]; yearGiven = true; } explicit = true; }
  if (m < 1 || m > 12 || d < 1 || d > 31) return {error: 'That date is not valid.'};
  let at = zonedToUtc(y, m, d, h, mi, timeZone);
  const check = zoned(at, timeZone);
  if (check.d !== d || check.m !== m) return {error: 'That date does not exist.'};
  const soon = now.getTime() + MIN_LEAD_MINUTES * 60000;
  let rolled = false;
  if (at.getTime() < soon) {
    if (!explicit) at = zonedToUtc(...(() => { const b = new Date(Date.UTC(today.y, today.m - 1, today.d + 1)); return [b.getUTCFullYear(), b.getUTCMonth() + 1, b.getUTCDate()]; })(), h, mi, timeZone);
    else if (!yearGiven && at.getTime() < now.getTime() - 86400000) { at = zonedToUtc(y + 1, m, d, h, mi, timeZone); rolled = true; }
  }
  if (at.getTime() < soon) return {error: `That time is in the past or too soon. Pick a time at least ${MIN_LEAD_MINUTES} minutes from now.`};
  if (rolled && at.getTime() > now.getTime() + MAX_AHEAD_DAYS * 86400000) return {error: 'That date has already passed.'};
  if (at.getTime() > now.getTime() + MAX_AHEAD_DAYS * 86400000) return {error: `Pick a time within the next ${MAX_AHEAD_DAYS} days.`};
  return {at};
}
