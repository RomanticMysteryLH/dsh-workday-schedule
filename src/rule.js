/**
 * Composable date selection.
 *
 * A rule is a list of selectors joined as a union. Each selector answers three questions:
 * which kind of day, at what scale it is counted, and which ordinals of that count fire.
 * The three historical modes (workday / restday / first rest day) are all special cases of
 * this model, so they keep working while anything else becomes expressible.
 *
 * Ordinals are anchored deliberately: "the 2nd working day" means something different by
 * stretch (the second day after a break) and by week (Tuesday), and both are useful.
 * @module dsh-workday-schedule/rule
 */

/** Scales a selector may count within. */
export const ANCHORS = ['stretch', 'week', 'month']

/** Day kinds a selector may target. */
export const DAY_TYPES = ['workday', 'restday']

/** Most selectors one rule may hold; keeps evaluation bounded. */
const MAX_SELECTORS = 12

/** Most ordinals one selector may hold. */
const MAX_ORDINALS = 20

/** Largest ordinal magnitude accepted, in either direction. */
const MAX_ORDINAL = 60

/** Hard cap on how far a stretch scan walks, in days. */
const MAX_SCAN_DAYS = 60

/** Chinese names used in generated descriptions. */
const ANCHOR_LABEL = { stretch: '连续段', week: '本周', month: '本月' }

/**
 * Normalize one ordinal list.
 * @param {unknown} value Candidate.
 * @returns {number[]|undefined} Deduped sorted ordinals, or undefined when invalid.
 */
function normalizeOrdinals(value) {
  if (!Array.isArray(value) || value.length === 0) return undefined
  const out = new Set()
  for (const raw of value) {
    const n = Number(raw)
    if (!Number.isInteger(n) || n === 0 || Math.abs(n) > MAX_ORDINAL) return undefined
    out.add(n)
  }
  const list = [...out].sort((a, b) => a - b)
  return list.length > MAX_ORDINALS ? list.slice(0, MAX_ORDINALS) : list
}

/**
 * Normalize a selector list, rejecting anything unusable.
 *
 * Throwing here is deliberate: a rule that silently loses a selector would run on the
 * wrong days, which is much worse than refusing to save it.
 * @param {unknown} input Candidate selector list.
 * @returns {Array<{dayType: string, anchor: string, ordinals: number[], every: number}>}
 */
export function normalizeSelectors(input) {
  if (!Array.isArray(input) || input.length === 0) throw new Error('rule must be a non-empty array of selectors')
  if (input.length > MAX_SELECTORS) throw new Error(`rule may hold at most ${MAX_SELECTORS} selectors`)
  return input.map((raw, index) => {
    if (raw === null || typeof raw !== 'object') throw new Error(`selector ${index + 1} must be an object`)
    const dayType = raw.dayType
    if (!DAY_TYPES.includes(dayType)) throw new Error(`selector ${index + 1}: dayType must be workday or restday`)
    const anchor = raw.anchor ?? 'stretch'
    if (!ANCHORS.includes(anchor)) throw new Error(`selector ${index + 1}: anchor must be ${ANCHORS.join(', ')}`)
    const ordinals = normalizeOrdinals(raw.ordinals ?? [1])
    if (ordinals === undefined) {
      throw new Error(`selector ${index + 1}: ordinals must be non-zero integers within ±${MAX_ORDINAL}`)
    }
    const everyRaw = raw.every ?? 1
    const every = Number(everyRaw)
    if (!Number.isInteger(every) || every < 1 || every > 52) throw new Error(`selector ${index + 1}: every must be 1..52`)
    return { dayType, anchor, ordinals, every }
  })
}

/**
 * Whether a day belongs to the requested day type.
 * @param {string} dayType workday or restday.
 * @param {any} info Calendar describe() result.
 * @returns {boolean}
 */
function matchesType(dayType, info) {
  return dayType === 'workday' ? info.isStatutoryWorkday : !info.isStatutoryWorkday
}

/**
 * Count how many same-type days sit in the given window, and where `date` falls.
 * @param {string} date Target date.
 * @param {string} dayType Requested day type.
 * @param {string[]} window Ordered dates of the window.
 * @param {import('./holiday.js').HolidayCalendar} calendar Loaded calendar.
 * @returns {{ordinal: number, total: number}}
 */
function ordinalInWindow(date, dayType, window, calendar) {
  let ordinal = 0
  let total = 0
  let hit = 0
  for (const day of window) {
    if (!matchesType(dayType, calendar.describe(day))) continue
    total += 1
    if (day === date) hit = total
  }
  ordinal = hit
  return { ordinal, total }
}

/**
 * Dates of the ISO week containing `date`, Monday first.
 * @param {string} date `YYYY-MM-DD`
 * @param {(date: string, days: number) => string} addDays Date arithmetic.
 * @returns {string[]}
 */
function weekWindow(date, addDays) {
  const [y, m, d] = date.split('-').map(Number)
  const weekday = new Date(Date.UTC(y, m - 1, d)).getUTCDay()
  const iso = weekday === 0 ? 7 : weekday
  const start = addDays(date, -(iso - 1))
  return Array.from({ length: 7 }, (_, i) => addDays(start, i))
}

/**
 * Dates of the calendar month containing `date`.
 * @param {string} date `YYYY-MM-DD`
 * @param {(date: string, days: number) => string} addDays Date arithmetic.
 * @returns {string[]}
 */
function monthWindow(date, addDays) {
  const [y, m] = date.split('-').map(Number)
  const first = `${date.slice(0, 7)}-01`
  const out = []
  let cursor = first
  // 31 is the longest month; the loop stops as soon as the month changes.
  for (let i = 0; i < 31; i += 1) {
    if (Number(cursor.slice(5, 7)) !== m) break
    out.push(cursor)
    cursor = addDays(cursor, 1)
  }
  void y
  return out
}

/**
 * The contiguous run of same-type days containing `date`.
 * @param {string} date Target date.
 * @param {string} dayType Requested day type.
 * @param {import('./holiday.js').HolidayCalendar} calendar Loaded calendar.
 * @param {(date: string, days: number) => string} addDays Date arithmetic.
 * @returns {{ordinal: number, total: number}}
 */
function ordinalInStretch(date, dayType, calendar, addDays) {
  let start = date
  for (let i = 0; i < MAX_SCAN_DAYS; i += 1) {
    const prev = addDays(start, -1)
    if (!matchesType(dayType, calendar.describe(prev))) break
    start = prev
  }
  let total = 0
  let cursor = start
  let ordinal = 0
  for (let i = 0; i < MAX_SCAN_DAYS * 2; i += 1) {
    if (!matchesType(dayType, calendar.describe(cursor))) break
    total += 1
    if (cursor === date) ordinal = total
    cursor = addDays(cursor, 1)
  }
  return { ordinal, total }
}

/**
 * Whether one selector fires on a date.
 * @param {any} selector Normalized selector.
 * @param {string} date `YYYY-MM-DD`
 * @param {import('./holiday.js').HolidayCalendar} calendar Loaded calendar.
 * @param {(date: string, days: number) => string} addDays Date arithmetic.
 * @returns {{matches: boolean, reason: string}}
 */
function selectorMatches(selector, date, calendar, addDays) {
  const info = calendar.describe(date)
  if (!matchesType(selector.dayType, info)) {
    return { matches: false, reason: selector.dayType === 'workday' ? 'rest-day' : 'workday' }
  }
  if (selector.every > 1) {
    if (selector.anchor !== 'week') return { matches: false, reason: 'cadence-needs-week-anchor' }
    // Count ISO weeks from a fixed epoch so the cadence is stable across restarts.
    const epochDays = Math.floor(Date.parse(`${date}T00:00:00Z`) / 86_400_000)
    const weekIndex = Math.floor((epochDays + 3) / 7)
    if (((weekIndex % selector.every) + selector.every) % selector.every !== 0) {
      return { matches: false, reason: 'off-cadence' }
    }
  }
  let counted
  if (selector.anchor === 'week') counted = ordinalInWindow(date, selector.dayType, weekWindow(date, addDays), calendar)
  else if (selector.anchor === 'month') counted = ordinalInWindow(date, selector.dayType, monthWindow(date, addDays), calendar)
  else counted = ordinalInStretch(date, selector.dayType, calendar, addDays)

  if (counted.ordinal === 0) return { matches: false, reason: 'type-mismatch' }
  const hit = selector.ordinals.some((n) => (n > 0 ? counted.ordinal === n : counted.ordinal === counted.total + n + 1))
  return { matches: hit, reason: hit ? 'selector' : 'ordinal-miss' }
}

/**
 * Evaluate a selector list against one date.
 * @param {string} date `YYYY-MM-DD`
 * @param {any[]} selectors Normalized selectors.
 * @param {import('./holiday.js').HolidayCalendar} calendar Loaded calendar.
 * @param {(date: string, days: number) => string} addDays Date arithmetic.
 * @returns {{allowed: boolean, reason: string}}
 */
export function evaluateSelectors(date, selectors, calendar, addDays) {
  const info = calendar.describe(date)
  if (!info.known) {
    // Outside the calendar's coverage the type cannot be trusted; stay inclusive the way
    // the rest of the plugin does rather than silently dropping occurrences.
    return { allowed: true, reason: 'unknown-calendar' }
  }
  let lastReason = 'ordinal-miss'
  for (const selector of selectors) {
    const result = selectorMatches(selector, date, calendar, addDays)
    if (result.matches) return { allowed: true, reason: 'selector' }
    if (result.reason.startsWith('holiday') || result.reason === 'workday' || result.reason === 'rest-day') {
      lastReason = result.reason
    }
  }
  return { allowed: false, reason: lastReason }
}

/**
 * Weekdays a recurring native reminder should repeat on for this rule.
 *
 * The base record only has to be a superset of the days the rule can fire on; everything
 * else is suppressed before it delivers, so the page still shows one sensible repeat rule
 * instead of a pile of one-shot records.
 * @param {any[]} selectors Normalized selectors.
 * @returns {number[]}
 */
export function baseWeekdaysForSelectors(selectors) {
  const set = new Set()
  for (const selector of selectors) {
    if (selector.dayType === 'restday') [6, 7].forEach((d) => set.add(d))
    else [1, 2, 3, 4, 5].forEach((d) => set.add(d))
  }
  return [...set].sort((a, b) => a - b)
}

/**
 * Ordinal phrase for a description.
 * @param {number} n Ordinal, negative meaning from the end.
 * @returns {string}
 */
function ordinalText(n) {
  return n > 0 ? `第 ${n} 个` : `倒数第 ${Math.abs(n)} 个`
}

/**
 * Human-readable rule summary.
 * @param {any[]} selectors Normalized selectors.
 * @returns {string}
 */
export function describeSelectors(selectors) {
  return selectors.map((selector) => {
    const type = selector.dayType === 'workday' ? '工作日' : '休息日'
    const ordinals = selector.ordinals.map(ordinalText).join('、')
    const cadence = selector.every > 1 ? `（每 ${selector.every} 周）` : ''
    return `${ANCHOR_LABEL[selector.anchor]}${ordinals}${type}${cadence}`
  }).join('，或 ')
}

/**
 * Convert one of the three historical modes into the equivalent selector list.
 * @param {string} dayKind Legacy mode.
 * @param {number[]} weekdays Legacy weekday list.
 * @returns {any[]} Selectors.
 */
export function selectorsForKind(dayKind, weekdays) {
  if (dayKind === 'restday') return [{ dayType: 'restday', anchor: 'stretch', ordinals: Array.from({ length: 60 }, (_, i) => i + 1), every: 1 }]
  if (dayKind === 'restday-first') return [{ dayType: 'restday', anchor: 'stretch', ordinals: [1], every: 1 }]
  const ordinals = []
  for (const day of weekdays ?? [1, 2, 3, 4, 5]) {
    const n = weekIndexOrdinal(day)
    if (n !== 0) ordinals.push(n)
  }
  return [{ dayType: 'workday', anchor: 'week', ordinals: ordinals.length > 0 ? ordinals : [1, 2, 3, 4, 5], every: 1 }]
}

/**
 * Index of an ISO weekday among the working days of a week.
 * Mon=1 … Fri=5 map to 1…5; weekend values have no working-day ordinal.
 * @param {number} iso ISO weekday.
 * @returns {number}
 */
function weekIndexOrdinal(iso) {
  return iso >= 1 && iso <= 5 ? iso : 0
}
