/**
 * Occurrence resolution: turn one workday rule into the next concrete instant.
 * @module dsh-workday-schedule/rules
 */

import { addDays, isoWeekday, localDate, zonedInstant } from './time.js'
import { normalizeSelectors, evaluateSelectors, describeSelectors } from './rule.js'

/** How far ahead a rule may search before it is considered unsatisfiable. */
const MAX_LOOKAHEAD_DAYS = 400

/** The three supported day-selection modes. */
export const DAY_KINDS = ['workday', 'restday', 'restday-first']

/**
 * Narrow an unknown value to a supported day kind.
 * @param {unknown} value Candidate.
 * @returns {'workday'|'restday'|'restday-first'}
 */
export function normalizeDayKind(value) {
  if (value === 'restday-first') return 'restday-first'
  if (value === 'restday') return 'restday'
  return 'workday'
}

/**
 * Next instant at which a task should run, strictly after `nowMs`.
 * @param {{time: string, weekdays: number[], skipHolidays: boolean, runOnMakeupWorkdays: boolean, fallbackWhenUnknown: string}} task Rule-bearing task.
 * @param {number} nowMs Current epoch milliseconds.
 * @param {import('./holiday.js').HolidayCalendar} calendar Loaded calendar.
 * @param {{timeZone: string, fallbackWhenUnknown: string}} config Plugin configuration.
 * @returns {{at: number, date: string, time: string, reason: string, skipped: string[]} | null} Next occurrence, or null.
 */
export function nextOccurrence(task, nowMs, calendar, config) {
  const timeZone = config.timeZone
  const rule = {
    dayKind: normalizeDayKind(task.dayKind),
    weekdays: task.weekdays,
    skipHolidays: task.skipHolidays,
    runOnMakeupWorkdays: task.runOnMakeupWorkdays,
    fallbackWhenUnknown: task.fallbackWhenUnknown ?? config.fallbackWhenUnknown,
  }
  // A composable rule supersedes the three historical modes when present.
  const selectors = normalizedSelectorsOf(task)
  const today = localDate(nowMs, timeZone)
  const skipped = []
  for (let offset = 0; offset <= MAX_LOOKAHEAD_DAYS; offset += 1) {
    const date = addDays(today, offset)
    const verdict = selectors === undefined
      ? calendar.evaluate(date, rule)
      : evaluateSelectors(date, selectors, calendar, addDays)
    if (!verdict.allowed) {
      if (verdict.reason.startsWith('holiday:')) skipped.push(`${date} ${verdict.reason}`)
      continue
    }
    const at = zonedInstant(date, task.time, timeZone)
    if (at <= nowMs) continue
    return { at, date, time: task.time, reason: verdict.reason, skipped }
  }
  return null
}

/**
 * Parse a task's composable selectors, tolerating the historical shapes.
 * @param {any} task Task.
 * @returns {any[]|undefined} Normalized selectors, or undefined for a legacy rule.
 */
export function normalizedSelectorsOf(task) {
  if (!Array.isArray(task?.selectors) || task.selectors.length === 0) return undefined
  try {
    return normalizeSelectors(task.selectors)
  } catch {
    // A stored rule that no longer validates must not take the scheduler down; falling
    // back to the legacy mode keeps the task running on its old days.
    return undefined
  }
}

/**
 * Human-readable rule summary, e.g. `工作日 09:00（跳过法定节假日，调休上班日执行）`.
 * @param {{time: string, weekdays: number[], skipHolidays: boolean, runOnMakeupWorkdays: boolean}} task Task.
 * @returns {string}
 */
export function describeRule(task) {
  const selectors = normalizedSelectorsOf(task)
  if (selectors !== undefined) {
    return `${describeSelectors(selectors)} ${task.time}`
  }
  if (task.dayKind === 'restday-first') {
    return `节假日/休息日第一天 ${task.time}（只在休息日开始的那天执行，连休其余日子不跑）`
  }
  if (task.dayKind === 'restday') {
    return `每个休息日 ${task.time}（周末与法定节假日执行，调休上班日不跑）`
  }
  const names = { 1: '一', 2: '二', 3: '三', 4: '四', 5: '五', 6: '六', 7: '日' }
  const days = [...task.weekdays].sort((a, b) => a - b)
  const label = days.length === 7
    ? '每天'
    : days.length === 5 && days[0] === 1 && days[4] === 5
      ? '工作日'
      : `周${days.map(d => names[d] ?? d).join('、')}`
  const head = `${label} ${task.time}`
  const modifiers = []
  if (task.skipHolidays) modifiers.push('跳过法定节假日')
  if (task.runOnMakeupWorkdays) modifiers.push('调休上班日执行')
  return modifiers.length === 0 ? head : `${head}（${modifiers.join('，')}）`
}

/**
 * Upcoming occurrences, used for previews and verification.
 * @param {any} task Task.
 * @param {number} nowMs Current epoch milliseconds.
 * @param {import('./holiday.js').HolidayCalendar} calendar Loaded calendar.
 * @param {{timeZone: string, fallbackWhenUnknown: string}} config Plugin configuration.
 * @param {number} count How many to collect.
 * @returns {Array<{at: number, date: string, time: string, reason: string}>}
 */
export function upcoming(task, nowMs, calendar, config, count = 5) {
  const out = []
  let cursor = nowMs
  for (let i = 0; i < count; i += 1) {
    const hit = nextOccurrence(task, cursor, calendar, config)
    if (hit === null) break
    out.push({ at: hit.at, date: hit.date, time: hit.time, reason: hit.reason })
    cursor = hit.at
  }
  return out
}

export { isoWeekday }
