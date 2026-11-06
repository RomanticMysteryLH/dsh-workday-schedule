/**
 * Time-zone helpers for workday scheduling.
 * All calendar math happens in an explicit IANA zone, never in the host clock's zone.
 * @module dsh-workday-schedule/time
 */

const dateTimeFormatters = new Map()

/** @param {string} timeZone IANA zone name. @returns {Intl.DateTimeFormat} Cached en-CA formatter. */
function formatter(timeZone) {
  let f = dateTimeFormatters.get(timeZone)
  if (f === undefined) {
    f = new Intl.DateTimeFormat('en-CA', {
      timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
    })
    dateTimeFormatters.set(timeZone, f)
  }
  return f
}

/**
 * Wall-clock parts of one instant as observed in a zone.
 * @param {number} ms Epoch milliseconds.
 * @param {string} timeZone IANA zone name.
 * @returns {{year:number,month:number,day:number,hour:number,minute:number,second:number}}
 */
export function partsInZone(ms, timeZone) {
  const out = {}
  for (const part of formatter(timeZone).formatToParts(new Date(ms))) {
    if (part.type !== 'literal') out[part.type] = Number(part.value)
  }
  return { year: out.year, month: out.month, day: out.day, hour: out.hour % 24, minute: out.minute, second: out.second }
}

/** @param {number} n Two-digit pad. @returns {string} */
function pad(n) { return String(n).padStart(2, '0') }

/**
 * Local calendar date of one instant.
 * @param {number} ms Epoch milliseconds.
 * @param {string} timeZone IANA zone name.
 * @returns {string} `YYYY-MM-DD`
 */
export function localDate(ms, timeZone) {
  const p = partsInZone(ms, timeZone)
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`
}

/**
 * Convert one local wall-clock date and time in a zone to an instant.
 * Resolves by fixed-point iteration so DST transitions and offset changes converge.
 * @param {string} dateStr `YYYY-MM-DD`
 * @param {string} timeStr `HH:MM`
 * @param {string} timeZone IANA zone name.
 * @returns {number} Epoch milliseconds.
 */
export function zonedInstant(dateStr, timeStr, timeZone) {
  const [y, mo, d] = dateStr.split('-').map(Number)
  const [h, mi] = timeStr.split(':').map(Number)
  const desired = Date.UTC(y, mo - 1, d, h, mi, 0)
  let guess = desired
  for (let i = 0; i < 4; i += 1) {
    const p = partsInZone(guess, timeZone)
    const actual = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second)
    const delta = desired - actual
    if (delta === 0) break
    guess += delta
  }
  return guess
}

/**
 * ISO weekday of a calendar date: Monday 1 through Sunday 7.
 * @param {string} dateStr `YYYY-MM-DD`
 * @returns {number}
 */
export function isoWeekday(dateStr) {
  const [y, mo, d] = dateStr.split('-').map(Number)
  const day = new Date(Date.UTC(y, mo - 1, d)).getUTCDay()
  return day === 0 ? 7 : day
}

/**
 * Shift a calendar date by whole days.
 * @param {string} dateStr `YYYY-MM-DD`
 * @param {number} days Offset in days.
 * @returns {string} `YYYY-MM-DD`
 */
export function addDays(dateStr, days) {
  const [y, mo, d] = dateStr.split('-').map(Number)
  const t = Date.UTC(y, mo - 1, d) + days * 86400000
  const dt = new Date(t)
  return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`
}

/**
 * Validate a strict `HH:MM` time of day.
 * @param {unknown} value Candidate value.
 * @returns {string | undefined} Normalized `HH:MM`, or undefined when invalid.
 */
export function normalizeTime(value) {
  if (typeof value !== 'string') return undefined
  const m = /^(\d{1,2}):(\d{2})$/.exec(value.trim())
  if (m === null) return undefined
  const h = Number(m[1])
  const mi = Number(m[2])
  if (h > 23 || mi > 59) return undefined
  return `${pad(h)}:${pad(mi)}`
}
