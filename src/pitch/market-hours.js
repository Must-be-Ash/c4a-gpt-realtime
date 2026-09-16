// NYSE session clock (ported from the desk's src/desk/market.ts so both agree).
// Mon–Fri 9:30–16:00 America/New_York, minus full holidays; 13:00 close on
// half-days. Computed through Intl so DST needs no hard-coded offsets.

const OPEN_MIN = 9 * 60 + 30;
const CLOSE_MIN = 16 * 60;
const EARLY_CLOSE_MIN = 13 * 60;

// Extend yearly (keep in sync with the desk).
const HOLIDAYS = new Set([
  "2026-01-01", "2026-01-19", "2026-02-16", "2026-04-03", "2026-05-25",
  "2026-06-19", "2026-07-03", "2026-09-07", "2026-11-26", "2026-12-25",
  "2027-01-01", "2027-01-18", "2027-02-15", "2027-03-26", "2027-05-31",
  "2027-06-18", "2027-07-05", "2027-09-06", "2027-11-25", "2027-12-24",
]);
const EARLY_CLOSE = new Set(["2026-11-27", "2026-12-24", "2027-11-26"]);

const dateFormat = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit",
});
const partsFormat = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York", weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
});

// ET calendar date, YYYY-MM-DD. Also the key for "calls today".
export function etDateKey(now = Date.now()) {
  return dateFormat.format(new Date(now));
}

export function isMarketOpen(now = Date.now()) {
  const parts = partsFormat.formatToParts(new Date(now));
  const get = (type) => parts.find((p) => p.type === type)?.value ?? "";
  if (["Sat", "Sun"].includes(get("weekday"))) return false;
  const key = etDateKey(now);
  if (HOLIDAYS.has(key)) return false;
  const minutes = Number(get("hour")) * 60 + Number(get("minute"));
  return minutes >= OPEN_MIN && minutes < (EARLY_CLOSE.has(key) ? EARLY_CLOSE_MIN : CLOSE_MIN);
}
