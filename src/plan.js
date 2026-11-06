/**
 * Page feed: one call answers everything the automation page draws.
 *
 * The page must show which days are working days, which are statutory holidays, which
 * are 调休 make-up workdays, and for each day which tasks fire or are skipped and why.
 * None of that is derivable on the client: the holiday calendar lives only in the Host,
 * and the rule that decides an occurrence is the Host's. So the Host computes one plan
 * document and the client only renders it — a single source of truth for both the
 * calendar colours and the numbers in the statistics panel.
 * @module dsh-workday-schedule/plan
 */

import { addDays, isoWeekday, localDate, zonedInstant } from './time.js'
import { normalizeDayKind, describeRule } from './rules.js'
import { evaluateSelectors, baseWeekdaysForSelectors } from './rule.js'

/** Longest window one request may ask for. */
const MAX_DAYS = 120

/**
 * Classify one calendar date for display.
 * @param {import('./holiday.js').HolidayCalendar} calendar Loaded calendar.
 * @param {string} date `YYYY-MM-DD`
 * @returns {{kind: 'workday'|'restday'|'holiday'|'makeup', holidayName: string|null, known: boolean}}
 */
function classify(calendar, date) {
  const info = calendar.describe(date)
  if (info.isHoliday) return { kind: 'holiday', holidayName: info.holidayName, known: info.known }
  if (info.isMakeup && info.isWeekend) return { kind: 'makeup', holidayName: null, known: info.known }
  if (info.isWeekend) return { kind: 'restday', holidayName: null, known: info.known }
  return { kind: 'workday', holidayName: null, known: info.known }
}

/**
 * Build the page feed.
 * @param {{from: string, days: number, tasks: any[], calendar: import('./holiday.js').HolidayCalendar, config: any, nowMs: number}} input Inputs.
 * @returns {any} Plan document.
 */
export function buildPlan(input) {
  const { tasks, calendar, config, nowMs } = input
  const timeZone = config.timeZone
  const from = typeof input.from === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(input.from)
    ? input.from
    : localDate(nowMs, timeZone)
  const days = Math.min(Math.max(Math.trunc(Number(input.days) || 60), 1), MAX_DAYS)

  /** @type {any[]} */
  const out = []
  let horizonTriggers = 0
  let horizonSkipped = 0
  let horizonExtras = 0
  const monthPrefix = from.slice(0, 7)
  let monthTriggers = 0
  /** @type {{at: number, iso: string, local: string, title: string} | null} */
  let nextRun = null
  const active = tasks.filter(task => task.enabled !== false)

  for (let offset = 0; offset < days; offset += 1) {
    const date = addDays(from, offset)
    const shape = classify(calendar, date)
    const weekday = isoWeekday(date)
    /** @type {any[]} */
    const triggers = []
    /** @type {any[]} */
    const skipped = []

    for (const task of active) {
      const rule = {
        dayKind: normalizeDayKind(task.dayKind),
        weekdays: task.weekdays ?? [1, 2, 3, 4, 5],
        skipHolidays: task.skipHolidays !== false,
        runOnMakeupWorkdays: task.runOnMakeupWorkdays !== false,
        fallbackWhenUnknown: task.fallbackWhenUnknown ?? config.fallbackWhenUnknown,
      }
      // A composable rule supersedes the legacy mode, exactly as it does in the engine.
      const selectors = Array.isArray(task.selectors) && task.selectors.length > 0
        ? task.selectors
        : undefined
      const verdict = selectors === undefined
        ? calendar.evaluate(date, rule)
        : evaluateSelectors(date, selectors, calendar, addDays)
      const at = zonedInstant(date, task.time, timeZone)
      if (verdict.allowed) {
        triggers.push({ id: task.id, title: task.title, time: task.time, at })
        horizonTriggers += 1
        if (date.startsWith(monthPrefix)) monthTriggers += 1
        // Days the base calendar cannot reach are the extra one-shot reminders.
        const base = selectors === undefined
          ? (rule.dayKind === 'restday' || rule.dayKind === 'restday-first' ? [6, 7] : rule.weekdays)
          : baseWeekdaysForSelectors(selectors)
        if (!base.includes(weekday)) horizonExtras += 1
        if (at > nowMs && (nextRun === null || at < nextRun.at)) {
          nextRun = { at, iso: new Date(at).toISOString(), local: `${date} ${task.time}`, title: task.title }
        }
      } else {
        const reason = verdict.reason
        // Only surface real exclusions, not "this day is not in the task's weekdays".
        if (reason.startsWith('holiday:') || reason === 'workday' || reason === 'unknown-calendar') {
          skipped.push({ id: task.id, title: task.title, time: task.time, reason, label: reasonLabel(reason) })
          horizonSkipped += 1
        }
      }
    }

    out.push({ date, weekday, ...shape, triggers, skipped })
  }

  // No hypothetical baseline is reported: comparing against "what if it ran every day"
  // measures a schedule nobody configured. The plan reports what the rule will actually
  // do, and the page pairs it with real deliveries instead.
  const status = calendar.status()
  return {
    from,
    days: out,
    stats: {
      taskCount: active.length,
      monthTriggers,
      monthPrefix,
      horizonTriggers,
      horizonSkipped,
      horizonExtras,
      nextRun,
    },
    calendar: {
      min: status.min,
      max: status.max,
      source: status.source,
      // A calendar that stops before today tells the page to warn instead of colouring.
      stale: status.max !== '' && status.max < localDate(nowMs, timeZone),
      holidayCount: status.holidayCount,
      makeupCount: status.makeupCount,
    },
    tasks: active.map(task => ({
      id: task.id,
      title: task.title,
      time: task.time,
      dayKind: normalizeDayKind(task.dayKind),
      weekdays: task.weekdays ?? [1, 2, 3, 4, 5],
      // Present only for a composable rule, so the page can show which selectors are set.
      selectors: Array.isArray(task.selectors) && task.selectors.length > 0 ? task.selectors : null,
      ruleText: describeRule(task),
      // The page lists tasks from the native catalog, whose ids differ from these task
      // ids, so it needs the native record ids to colour a row with the same colour the
      // calendar uses for the same task.
      nativeIds: [
        ...(typeof task.nativeId === 'string' ? [task.nativeId] : []),
        ...(task.extras ?? []).map(extra => extra.id).filter(id => typeof id === 'string'),
      ],
    })),
  }
}

/**
 * Human label for one exclusion reason.
 * @param {string} reason Evaluate reason.
 * @returns {string}
 */
function reasonLabel(reason) {
  if (reason.startsWith('holiday:')) return `节假日 ${reason.slice('holiday:'.length)}`
  if (reason === 'workday') return '工作日不执行'
  if (reason === 'unknown-calendar') return '节假日数据未覆盖'
  return reason
}
