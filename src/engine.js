/**
 * Reconciliation between workday tasks and the built-in Schedule service.
 *
 * A task is represented natively by a *recurring* reminder whose weekdays are the
 * calendar base of the rule, so the automation-task page shows a truthful repeating
 * rule instead of a one-shot. Two corrections then make the calendar-only native rule
 * match the holiday-aware plugin rule:
 *
 * - **Suppression**: when the next native occurrence falls on an excluded day (a
 *   statutory holiday for a workday task, a 调休 make-up workday for a rest-day task),
 *   the reminder is paused and resumed afterwards. Pausing before the occurrence means
 *   the excluded day never wakes the model at all.
 * - **Extras**: days the rule wants but the base calendar cannot express (a 调休
 *   weekend workday, a holiday weekday for a rest-day task) get their own one-shot
 *   reminder, kept for a rolling horizon.
 *
 * When a recurring reminder cannot be created the engine degrades to the older
 * one-shot-per-occurrence behaviour rather than dropping the task.
 * @module dsh-workday-schedule/engine
 */

import { appendFile, mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'

import { nextOccurrence, describeRule, normalizeDayKind, normalizedSelectorsOf } from './rules.js'
import { baseWeekdaysForSelectors, evaluateSelectors } from './rule.js'
import { addDays, isoWeekday, localDate, zonedInstant } from './time.js'

/** Milliseconds between reconciliation passes. */
const TICK_MS = 30_000

/** How far ahead extras are materialised, in days. */
const EXTRA_HORIZON_DAYS = 60

/** How far ahead the next native occurrence is searched for, in days. */
const BASE_SEARCH_DAYS = 21

/** Weekend weekday numbers (ISO: 6=Saturday, 7=Sunday). */
const WEEKEND = [6, 7]

/** Title suffixes that mark a native record as holiday-aware. */
const MARKER_WORKDAY = ' · 工作日'
const MARKER_RESTDAY = ' · 休息日'
const MARKER_RESTDAY_FIRST = ' · 节假日首日'
const MARKER_RULE = ' · 组合规则'

/** Engine that keeps the built-in Schedule in agreement with the task store. */
export class WorkdayEngine {
  #running = false
  #catalog = new Map()
  /** Whether the last catalog read succeeded; a failed read must never look like a deletion. */
  #catalogOk = false
  /** Which Schedule create contract works: `timing` (newer) or `legacy` (older). */
  #createMode

  /**
   * @param {{ctx: any, config: any, calendar: import('./holiday.js').HolidayCalendar, store: import('./store.js').TaskStore, logger: any}} options Wiring.
   */
  constructor(options) {
    this.ctx = options.ctx
    this.config = options.config
    this.calendar = options.calendar
    this.store = options.store
    this.logger = options.logger
  }

  /**
   * Title shown on the automation-task page.
   *
   * The ` · 工作日` / ` · 休息日` suffix is the contract with the client page: a record
   * carrying it is a holiday-aware task the engine owns, and the suffix is how a record
   * created from the UI is adopted here without a second data channel.
   */
  #titleFor(task) {
    const base = String(task.title ?? '')
      .replace(/ · (工作日|休息日|节假日首日|组合规则)$/, '')
    // A composable rule needs its own marker: its dayKind is only a storage default, so
    // labelling it 工作日 would make the page report a rule the task does not have.
    if (Array.isArray(task.selectors) && task.selectors.length > 0) {
      return `${base}${MARKER_RULE}`.slice(0, 120)
    }
    const kind = normalizeDayKind(task.dayKind)
    const marker = kind === 'restday-first' ? MARKER_RESTDAY_FIRST : kind === 'restday' ? MARKER_RESTDAY : MARKER_WORKDAY
    return `${base}${marker}`.slice(0, 120)
  }

  /**
   * Read the holiday rule a native record declares, if any.
   *
   * A `· 组合规则` record is recognised so adoption can skip it deliberately: the
   * selectors live in the task store, and the title cannot carry them, so adopting it
   * would invent a rule that was never configured.
   * @param {{title?: string}} entry Catalog entry.
   * @returns {{dayKind: 'workday'|'restday'|'restday-first'|'rule', title: string} | undefined}
   */
  static readMarker(entry) {
    const title = typeof entry?.title === 'string' ? entry.title : ''
    if (title.endsWith(MARKER_RULE)) return { dayKind: 'rule', title: title.slice(0, -MARKER_RULE.length) }
    if (title.endsWith(MARKER_RESTDAY_FIRST)) return { dayKind: 'restday-first', title: title.slice(0, -MARKER_RESTDAY_FIRST.length) }
    if (title.endsWith(MARKER_RESTDAY)) return { dayKind: 'restday', title: title.slice(0, -MARKER_RESTDAY.length) }
    if (title.endsWith(MARKER_WORKDAY)) return { dayKind: 'workday', title: title.slice(0, -MARKER_WORKDAY.length) }
    return undefined
  }

  /**
   * Weekdays the native recurring reminder repeats on.
   * A rest-day rule is anchored to the weekend and completed by extras.
   * @param {any} task Task.
   * @returns {number[]}
   */
  #baseWeekdays(task) {
    // A composable rule decides its own base: the union of the weekday sets its selectors
    // can ever land on. Suppression then removes everything else, so the page still shows
    // one sensible repeat rule instead of a pile of one-shot records.
    const selectors = normalizedSelectorsOf(task)
    if (selectors !== undefined) return baseWeekdaysForSelectors(selectors)
    const kind = normalizeDayKind(task.dayKind)
    if (kind === 'restday' || kind === 'restday-first') return WEEKEND
    return task.weekdays ?? [1, 2, 3, 4, 5]
  }

  /** The rule in force for evaluation. */
  #ruleOf(task) {
    return {
      dayKind: normalizeDayKind(task.dayKind),
      weekdays: task.weekdays ?? [1, 2, 3, 4, 5],
      skipHolidays: task.skipHolidays !== false,
      runOnMakeupWorkdays: task.runOnMakeupWorkdays !== false,
      fallbackWhenUnknown: task.fallbackWhenUnknown ?? this.config.fallbackWhenUnknown,
    }
  }

  /** Next occurrence under the full holiday-aware rule. */
  nextRun(task, nowMs = Date.now()) {
    return nextOccurrence(task, nowMs, this.calendar, this.config)
  }

  /**
   * Append one diagnostic line to the plugin's own log file.
   * Delivery failures stay invisible in the UI, so the evidence lives here.
   * @param {string} line Message.
   */
  async #debug(line) {
    try {
      const path = join(homedir(), '.dsh', 'workday-schedule', 'debug.log')
      await mkdir(dirname(path), { recursive: true })
      await appendFile(path, `${new Date().toISOString()} ${line}\n`, 'utf8')
    } catch {
      /* diagnostics must never break scheduling */
    }
  }

  /** Resolve the built-in Schedule service from this plugin's context. */
  #scheduleService() {
    if (this.ctx?.schedule !== undefined) return this.ctx.schedule
    try {
      return typeof this.ctx?.get === 'function' ? this.ctx.get('schedule') : undefined
    } catch {
      return undefined
    }
  }

  /** Refresh the local catalog snapshot of built-in reminders. */
  async #refreshCatalog() {
    this.#catalog = new Map()
    this.#catalogOk = false
    try {
      const schedule = this.#scheduleService()
      if (schedule === undefined) return
      const entries = await schedule.catalog()
      for (const entry of entries ?? []) this.#catalog.set(entry.id, entry)
      this.#catalogOk = true
    } catch (error) {
      this.logger?.warn?.(`workday-schedule: catalog read failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /**
   * Create one built-in reminder under either management contract.
   * @param {any} schedule Schedule service.
   * @param {any} task Task owning the reminder.
   * @param {{kind: 'weekly'|'at', weekly?: any, at?: any}} timing Typed timing.
   * @returns {Promise<any>} Committed record or entry.
   */
  async #createRecord(schedule, task, timing) {
    const title = this.#titleFor(task)
    const modes = this.#createMode === undefined ? ['timing', 'legacy'] : [this.#createMode]
    let lastError
    for (const mode of modes) {
      try {
        if (mode === 'timing') {
          const entry = await schedule.create({
            title,
            prompt: task.prompt,
            timing,
            target: { kind: 'session', sessionId: task.sessionId },
          }, task.sessionId)
          this.#createMode = mode
          return entry
        }
        const legacy = timing.kind === 'weekly' ? { weekly: timing.weekly } : { at: timing.at }
        const record = await schedule.create(task.sessionId, { title, prompt: task.prompt, ...legacy })
        this.#createMode = mode
        return record
      } catch (error) {
        lastError = error
      }
    }
    throw lastError
  }

  /** Human `HH:MM` rule time as the `HH:mm:ss` the built-in local inputs require. */
  #clock(task) {
    return `${task.time}:00`
  }

  /**
   * Set the reminder's active flag, which is how a holiday window is skipped.
   * @param {any} schedule Schedule service.
   * @param {any} task Task.
   * @param {boolean} active Desired state.
   */
  async #setActive(schedule, task, active) {
    if (typeof schedule.edit !== 'function') return false
    await schedule.edit({ action: 'update', id: task.nativeId, patch: { active } }, task.sessionId)
    return true
  }

  /** Delete one reminder row under either contract. */
  async #deleteRecord(schedule, sessionId, id) {
    try {
      if (typeof schedule.edit === 'function') {
        await schedule.edit({ action: 'delete', id }, sessionId)
        return
      }
      await schedule.delete({ sessionId, id })
    } catch {
      /* an already-gone reminder is the desired state */
    }
  }

  /**
   * Next date the native recurring reminder would fire on, ignoring pause state.
   * @param {any} task Task.
   * @param {number} nowMs Current epoch milliseconds.
   * @returns {{date: string, at: number} | null}
   */
  #nextBaseOccurrence(task, nowMs) {
    const base = this.#baseWeekdays(task)
    const timeZone = this.config.timeZone
    const today = localDate(nowMs, timeZone)
    for (let offset = 0; offset <= BASE_SEARCH_DAYS; offset += 1) {
      const date = addDays(today, offset)
      if (!base.includes(isoWeekday(date))) continue
      const at = zonedInstant(date, task.time, timeZone)
      if (at > nowMs) return { date, at }
    }
    return null
  }

  /**
   * Dates the holiday-aware rule wants to run on, inside a window.
   * @param {any} task Task.
   * @param {string} fromDate `YYYY-MM-DD`
   * @param {number} days Window length.
   * @returns {Set<string>}
   */
  /**
   * Decide one date under whichever rule form the task carries.
   * @param {any} task Task.
   * @param {string} date `YYYY-MM-DD`
   * @returns {{allowed: boolean, reason: string}}
   */
  #verdict(task, date) {
    const selectors = normalizedSelectorsOf(task)
    if (selectors !== undefined) return evaluateSelectors(date, selectors, this.calendar, addDays)
    return this.calendar.evaluate(date, this.#ruleOf(task))
  }

  #desiredDates(task, fromDate, days) {
    const out = new Set()
    for (let offset = 0; offset < days; offset += 1) {
      const date = addDays(fromDate, offset)
      if (this.#verdict(task, date).allowed) out.add(date)
    }
    return out
  }

  /**
   * Make sure the recurring reminder exists with the right shape.
   * @param {any} schedule Schedule service.
   * @param {any} task Task.
   * @param {number} nowMs Current epoch milliseconds.
   * @returns {Promise<boolean>} Whether a usable recurring reminder is in place.
   */
  async #ensurePrimary(schedule, task, nowMs) {
    const base = this.#baseWeekdays(task)
    const time = this.#clock(task)
    const wanted = { kind: 'weekly', weekly: { time, time_zone: this.config.timeZone, weekdays: base } }

    if (typeof task.nativeId === 'string') {
      let entry = this.#catalog.get(task.nativeId)
      if (entry === undefined) {
        // The snapshot may simply predate this record: a tool call reconciles right
        // after creating it, before the next tick refreshes the catalog. Re-read once
        // before concluding the row is gone, otherwise the orphan would deliver again.
        await this.#refreshCatalog()
        entry = this.#catalog.get(task.nativeId)
      }
      if (entry !== undefined) {
        const wantedTitle = this.#titleFor(task)
        const shapeMatches = entry.kind === 'weekly'
          && JSON.stringify(entry.weekdays) === JSON.stringify([...base].sort((a, b) => a - b))
          && entry.time?.startsWith(task.time)
        if (shapeMatches) {
          // 休息日 and 节假日第一天 share the exact same calendar shape, so the title
          // suffix is the only thing that carries the difference. A stale title would
          // make the page show the wrong rule, so it is corrected here too.
          if (entry.title !== wantedTitle && typeof schedule.edit === 'function') {
            try {
              await schedule.edit({ action: 'update', id: task.nativeId, patch: { title: wantedTitle } }, task.sessionId)
            } catch (error) {
              await this.#debug(`retitle ${task.id} failed: ${error?.message ?? error}`)
            }
          }
          return 'ok'
        }
        if (typeof schedule.edit === 'function' && entry.kind === 'weekly') {
          try {
            await schedule.edit(
              { action: 'update', id: task.nativeId, patch: { timing: wanted, title: wantedTitle } },
              task.sessionId,
            )
            return 'ok'
          } catch (error) {
            await this.#debug(`retime ${task.id} failed: ${error?.message ?? error}`)
          }
        }
        await this.#deleteRecord(schedule, task.sessionId, task.nativeId)
        this.store.update(task.id, { nativeId: null, pausedByPlugin: false })
      } else {
        if (!this.#catalogOk) {
          // The catalog read failed; absence proves nothing, so keep the task as it is.
          return 'ok'
        }
        // The record is gone and the catalog read succeeded: the user deleted this task
        // on the automation page, so the plugin stops managing it instead of resurrecting it.
        this.store.remove(task.id)
        await this.store.save()
        return 'dropped'
      }
    }

    try {
      const created = await this.#createRecord(schedule, task, wanted)
      this.store.update(task.id, { nativeId: created.id, pausedByPlugin: false, armedAt: new Date(nowMs).toISOString() })
      await this.store.save()
      return 'ok'
    } catch (error) {
      // Fall back to one-shot materialisation so the task still runs.
      await this.#debug(`weekly create for ${task.id} failed, falling back to one-shot: ${error?.message ?? error}`)
      return 'fallback'
    }
  }

  /**
   * Keep the rolling set of one-shot reminders for days the base calendar misses.
   * @param {any} schedule Schedule service.
   * @param {any} task Task.
   * @param {number} nowMs Current epoch milliseconds.
   */
  async #syncExtras(schedule, task, nowMs) {
    const timeZone = this.config.timeZone
    const today = localDate(nowMs, timeZone)
    const base = this.#baseWeekdays(task)
    const desired = this.#desiredDates(task, today, EXTRA_HORIZON_DAYS)
    const wanted = new Set()
    for (const date of desired) {
      if (!base.includes(isoWeekday(date))) wanted.add(date)
    }

    const kept = []
    for (const extra of task.extras ?? []) {
      if (wanted.has(extra.date)) {
        wanted.delete(extra.date)
        kept.push(extra)
        continue
      }
      await this.#deleteRecord(schedule, task.sessionId, extra.id)
    }

    for (const date of [...wanted].sort()) {
      try {
        const created = await this.#createRecord(schedule, task, {
          kind: 'at',
          at: { date, time: this.#clock(task), time_zone: timeZone },
        })
        kept.push({ id: created.id, date })
      } catch (error) {
        await this.#debug(`extra create ${task.id} ${date} failed: ${error?.message ?? error}`)
        break
      }
    }
    this.store.update(task.id, { extras: kept })
    await this.store.save()
  }

  /**
   * Remove every native reminder a task owns.
   * @param {any} task Task.
   */
  async #teardown(task) {
    const schedule = this.#scheduleService()
    if (schedule === undefined) return
    if (typeof task.nativeId === 'string') await this.#deleteRecord(schedule, task.sessionId, task.nativeId)
    for (const extra of task.extras ?? []) await this.#deleteRecord(schedule, task.sessionId, extra.id)
    this.store.update(task.id, { nativeId: null, extras: [], pausedByPlugin: false })
    await this.store.save()
  }

  /**
   * Drop every native reminder owned by a task, without deleting the task.
   * @param {any} task Task.
   */
  async cancel(task) {
    await this.#teardown(task)
  }

  /**
   * Bring one task's native reminders in line with its holiday-aware rule.
   * @param {any} task Task.
   * @param {number} nowMs Current epoch milliseconds.
   */
  async reconcile(task, nowMs) {
    const schedule = this.#scheduleService()
    if (schedule === undefined) return
    // Every decision here reads the live status, and a pause applied in the previous
    // pass would otherwise be invisible. Re-read before reasoning about it.
    await this.#refreshCatalog()

    if (task.enabled === false) {
      // A task paused on the automation page must keep its record: deleting it would
      // destroy something the user deliberately kept. Only a task the plugin itself
      // switched off has its armed reminders removed.
      if (task.disabledReason === 'paused-on-automation-page') return
      await this.#teardown(task)
      return
    }

    const primary = await this.#ensurePrimary(schedule, task, nowMs)
    if (primary === 'dropped') return
    if (primary === 'fallback') {
      await this.#armOneShot(task, nowMs)
      return
    }
    await this.#syncExtras(schedule, task, nowMs)

    const entry = this.#catalog.get(task.nativeId)
    const status = entry?.status ?? 'active'

    // A reminder the user paused by hand is theirs: the task follows it instead of
    // being silently resumed or duplicated.
    if (status === 'paused' && task.pausedByPlugin !== true) {
      this.store.update(task.id, { enabled: false, disabledReason: 'paused-on-automation-page' })
      await this.store.save()
      return
    }

    const nextBase = this.#nextBaseOccurrence(task, nowMs)
    const suppressed = nextBase !== null && !this.#verdict(task, nextBase.date).allowed

    if (suppressed && status === 'active') {
      try {
        if (await this.#setActive(schedule, task, false)) {
          this.store.update(task.id, { pausedByPlugin: true, pausedFor: nextBase.date })
          await this.store.save()
          this.logger?.log?.(`workday-schedule: ${task.id} paused for ${nextBase.date}`)
        }
      } catch (error) {
        await this.#debug(`pause ${task.id} failed: ${error?.message ?? error}`)
      }
      return
    }

    if (!suppressed && status === 'paused' && task.pausedByPlugin === true) {
      try {
        if (await this.#setActive(schedule, task, true)) {
          this.store.update(task.id, { pausedByPlugin: false, pausedFor: null })
          await this.store.save()
          this.logger?.log?.(`workday-schedule: ${task.id} resumed`)
        }
      } catch (error) {
        await this.#debug(`resume ${task.id} failed: ${error?.message ?? error}`)
      }
    }
  }

  /**
   * Degraded path: materialise only the next occurrence as a one-shot reminder.
   * @param {any} task Task.
   * @param {number} nowMs Current epoch milliseconds.
   */
  async #armOneShot(task, nowMs) {
    const schedule = this.#scheduleService()
    if (schedule === undefined) return
    const next = this.nextRun(task, nowMs)
    if (next === null) return
    const entry = typeof task.nativeId === 'string' ? this.#catalog.get(task.nativeId) : undefined
    if (entry !== undefined) {
      const scheduledAt = Date.parse(entry.scheduledAt ?? '')
      if (Number.isFinite(scheduledAt) && Math.abs(scheduledAt - next.at) < 60_000 && entry.status === 'active') return
      await this.#deleteRecord(schedule, task.sessionId, task.nativeId)
    }
    try {
      const created = await this.#createRecord(schedule, task, {
        kind: 'at',
        at: { date: next.date, time: this.#clock(task), time_zone: this.config.timeZone },
      })
      this.store.update(task.id, { nativeId: created.id, armedFor: next.date, lastArmError: null })
      await this.store.save()
    } catch (error) {
      const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
      await this.#debug(`one-shot arm ${task.id} failed: ${message}`)
      this.store.update(task.id, { lastArmError: message })
      await this.store.save()
    }
  }

  /** One reconciliation pass over every task. */
  async tick() {
    if (this.#running) return
    this.#running = true
    try {
      await this.#refreshCatalog()
      await this.#adoptMarked()
      const now = Date.now()
      for (const task of [...this.store.tasks]) {
        try {
          await this.reconcile(task, now)
        } catch (error) {
          await this.#debug(`reconcile ${task.id} failed: ${error?.message ?? error}`)
          this.logger?.warn?.(`workday-schedule: reconcile ${task.id} failed: ${error instanceof Error ? error.message : String(error)}`)
        }
      }
    } finally {
      this.#running = false
    }
  }

  /**
   * Adopt native records whose title carries a holiday marker but that the store does
   * not know yet — this is how a task created on the client page joins the engine.
   *
   * The title suffix is the whole contract, so no second data channel is needed and a
   * record written by any caller (UI, tool, or agent) behaves the same.
   * @returns {Promise<void>}
   */
  async #adoptMarked() {
    if (!this.#catalogOk) return
    const known = new Set(this.store.tasks.map(task => task.nativeId).filter(id => typeof id === 'string'))
    let changed = false
    for (const entry of this.#catalog.values()) {
      if (known.has(entry.id)) continue
      const marker = WorkdayEngine.readMarker(entry)
      if (marker === undefined) continue
      // A composable rule cannot be reconstructed from the title, so a record carrying
      // that marker is skipped instead of being adopted as a rule it never had.
      if (marker.dayKind === 'rule') continue
      const weekdays = Array.isArray(entry.weekdays) && entry.weekdays.length > 0
        ? [...entry.weekdays]
        : (marker.dayKind === 'restday' ? [...WEEKEND] : [1, 2, 3, 4, 5])
      const time = typeof entry.time === 'string' ? entry.time.slice(0, 5) : '09:00'
      const sessionId = entry.target?.sessionId ?? entry.sessionId
      if (typeof sessionId !== 'string') continue
      this.store.add({
        title: marker.title,
        prompt: entry.prompt ?? '',
        time,
        dayKind: marker.dayKind,
        weekdays,
        skipHolidays: true,
        runOnMakeupWorkdays: true,
        sessionId,
        // Adopt as enabled and let reconcile decide: a record that is already paused is
        // recognised there as a user pause and keeps its row instead of being cleaned up.
        enabled: true,
        nativeId: entry.id,
        extras: [],
        scheduleId: null,
      })
      changed = true
    }
    if (changed) await this.store.save()
  }

  /**
   * Install the periodic pass as one context-owned effect.
   * @returns {() => void} Disposer.
   */
  start() {
    const initial = setTimeout(() => { void this.tick() }, 3000)
    const timer = setInterval(() => { void this.tick() }, TICK_MS)
    return () => {
      clearTimeout(initial)
      clearInterval(timer)
    }
  }

  /**
   * Preview for tool output: the task as the user thinks of it, not as storage holds it.
   * @param {any} task Task.
   * @param {number} [nowMs] Current epoch milliseconds.
   */
  preview(task, nowMs = Date.now()) {
    const next = this.nextRun(task, nowMs)
    return {
      id: task.id,
      title: task.title,
      rule: describeRule(task),
      enabled: task.enabled !== false,
      sessionId: task.sessionId,
      nextRun: next === null ? null : new Date(next.at).toISOString(),
      nextRunLocal: next === null ? null : `${next.date} ${next.time}`,
      nextRunReason: next === null ? null : next.reason,
      skippedAhead: next === null ? [] : next.skipped.slice(0, 6),
      nativeRecurring: this.#baseWeekdays(task),
      extraOneShots: (task.extras ?? []).map(extra => extra.date),
      pausedForHoliday: task.pausedFor ?? null,
      disabledReason: task.disabledReason ?? null,
      lastArmError: task.lastArmError ?? null,
    }
  }
}
