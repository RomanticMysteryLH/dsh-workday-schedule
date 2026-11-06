/**
 * China statutory-holiday calendar with make-up workdays (调休补班).
 *
 * Three layers, newest wins: the bundled seed snapshot, an on-disk cache written by
 * background refresh, and nothing else. Refresh is deliberately silent: the user never
 * sees a prompt, a setting, or a failure — an unreachable source simply leaves the
 * previous layer in force.
 * @module dsh-workday-schedule/holiday
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import { addDays } from './time.js'

/** Sources tried in order; the first successful JSON wins. */
/** Cache document revision; bump when the stored shape changes meaning. */
const CACHE_SCHEMA = 2

const SOURCES = [
  'https://registry.npmmirror.com/chinese-days/latest/files/dist/chinese-days.json',
  'https://unpkg.com/chinese-days@latest/dist/chinese-days.json',
]

/** Weekend weekday numbers (ISO: 6=Saturday, 7=Sunday). */
const WEEKEND = new Set([6, 7])

/**
 * Extract a Chinese holiday name from one upstream entry.
 * The chinese-days document packs `"National Day,国庆节,3"`; the bundled seed stores
 * the bare name; older documents use an object.
 * @param {unknown} value Raw entry.
 * @returns {string}
 */
function holidayName(value) {
  if (typeof value === 'string') {
    const parts = value.split(',').map(part => part.trim()).filter(Boolean)
    return parts.find(part => /[一-鿿]/.test(part)) ?? parts[0] ?? '节假日'
  }
  return String(value?.name_cn ?? value?.name ?? '节假日')
}

/**
 * Flatten the upstream `chinese-days` document into the compact in-memory form.
 * @param {any} raw Upstream document.
 * @returns {{holidays: Map<string,string>, makeup: Set<string>}}
 */
function flatten(raw) {
  const holidays = new Map()
  for (const [date, value] of Object.entries(raw?.holidays ?? {})) {
    holidays.set(date, holidayName(value))
  }
  // Two accepted shapes: the bundled seed lists make-up workdays as an array,
  // the upstream chinese-days document lists them as object keys.
  //
  // `inLieuDays` is deliberately NOT read here: in chinese-days it enumerates the
  // 调休 *holiday* days (every one of them is already in `holidays`), not the
  // make-up workdays. Merging it would inflate the make-up set and could mark a
  // rest day as a working day. `workdays` is the only make-up source.
  const makeup = new Set()
  if (Array.isArray(raw?.makeupWorkdays)) {
    for (const date of raw.makeupWorkdays) if (typeof date === 'string') makeup.add(date)
  }
  for (const date of Object.keys(raw?.workdays ?? {})) makeup.add(date)
  // Defensive: a document written by an older revision may list a statutory holiday as a
  // make-up workday. A day cannot be both; the holiday wins, because running on a
  // statutory holiday is the failure the user actually notices.
  for (const date of makeup) if (holidays.has(date)) makeup.delete(date)
  return { holidays, makeup }
}

/**
 * Load one JSON document, returning undefined instead of throwing.
 * @param {string} path Absolute file path.
 * @returns {Promise<any>}
 */
async function readJsonSafe(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch {
    return undefined
  }
}

/** A loaded holiday calendar plus its silent refresh loop. */
export class HolidayCalendar {
  #holidays = new Map()
  #makeup = new Set()
  #range = { min: '', max: '' }
  #meta = { source: 'none', version: 'none', fetchedAt: 0 }

  /**
   * @param {{dataDir: string, seedPath: string, logger?: {warn: (...a: any[]) => void}}} options Wiring.
   */
  constructor(options) {
    this.dataDir = options.dataDir
    this.seedPath = options.seedPath
    this.logger = options.logger
    this.cachePath = join(options.dataDir, 'holiday-cache.json')
    this.#ready = this.#load()
  }

  #ready

  /** @returns {Promise<void>} Resolves once seed and cache are merged. */
  async whenReady() { await this.#ready }

  /** Merge one document into the calendar. @param {any} doc Seed, cache, or upstream document. */
  #merge(doc) {
    if (doc === undefined || doc === null) return
    const raw = doc.raw ?? doc
    const { holidays, makeup } = flatten(raw)
    for (const [date, name] of holidays) this.#holidays.set(date, name)
    for (const date of makeup) this.#makeup.add(date)
    const dates = [...this.#holidays.keys(), ...this.#makeup].sort()
    if (dates.length > 0) {
      this.#range = { min: dates[0], max: dates[dates.length - 1] }
    }
    if (typeof doc.version === 'string') this.#meta = { source: doc.source ?? 'cache', version: doc.version, fetchedAt: doc.fetchedAt ?? 0 }
  }

  async #load() {
    await mkdir(this.dataDir, { recursive: true }).catch(() => {})
    const seed = await readJsonSafe(this.seedPath)
    this.#merge(seed)
    const cache = await readJsonSafe(this.cachePath)
    // A cache written under an older revision may carry a wrong make-up list, so it is
    // ignored rather than merged. The seed and the next silent refresh cover the gap.
    if (cache !== undefined && cache.schema === CACHE_SCHEMA) this.#merge(cache)
  }

  /**
   * Describe one calendar date against the loaded data.
   * @param {string} date `YYYY-MM-DD`
   * @returns {{date: string, known: boolean, isHoliday: boolean, holidayName: string | null, isMakeup: boolean, isWeekend: boolean, isStatutoryWorkday: boolean}}
   */
  describe(date) {
    const isHoliday = this.#holidays.has(date)
    const isMakeup = this.#makeup.has(date)
    const weekday = new Date(`${date}T00:00:00Z`).getUTCDay()
    const isWeekend = weekday === 0 || weekday === 6
    const known = this.#range.min !== '' && date >= this.#range.min && date <= this.#range.max
    return {
      date,
      known,
      isHoliday,
      holidayName: isHoliday ? this.#holidays.get(date) : null,
      isMakeup,
      isWeekend,
      isStatutoryWorkday: !isHoliday && !isWeekend || isMakeup && !isHoliday,
    }
  }

  /**
   * Whether a date counts as a working day under the given rule.
   * @param {string} date `YYYY-MM-DD`
   * @param {{weekdays: number[], skipHolidays: boolean, runOnMakeupWorkdays: boolean, fallbackWhenUnknown: string}} rule Rule in force.
   * @returns {{allowed: boolean, reason: string, info: ReturnType<HolidayCalendar['describe']>}}
   */
  evaluate(date, rule) {
    const info = this.describe(date)
    const weekday = new Date(`${date}T00:00:00Z`).getUTCDay()
    const iso = weekday === 0 ? 7 : weekday

    // A rest-day rule is the exact complement of a working day: it fires on weekends
    // and statutory holidays, and never on a 调休 make-up workday. `weekdays` does not
    // apply, because "rest" is already the calendar's answer.
    if (rule.dayKind === 'restday' || rule.dayKind === 'restday-first') {
      const isWorkday = info.isStatutoryWorkday
      if (isWorkday) return { allowed: false, reason: 'workday', info }
      if (!info.known && rule.fallbackWhenUnknown !== 'run') {
        return { allowed: false, reason: 'unknown-calendar', info }
      }
      if (rule.dayKind === 'restday-first') {
        // Only the first day of a rest stretch: the day before it must have been worked.
        // This is what makes "fill the work stretch that just ended" land on the morning
        // after it ends, instead of on every day of a week-long break.
        const previous = this.describe(addDays(date, -1))
        const previousWasWork = previous.isStatutoryWorkday || !previous.known
        if (!previousWasWork) {
          return { allowed: false, reason: 'not-first-rest-day', info }
        }
      }
      return { allowed: true, reason: info.isHoliday ? `holiday:${info.holidayName ?? 'statutory'}` : 'rest-day', info }
    }

    let allowed = rule.weekdays.includes(iso)
    let reason = allowed ? 'weekday' : 'not-a-configured-weekday'

    if (info.isMakeup && rule.runOnMakeupWorkdays && !info.isHoliday) {
      allowed = true
      reason = 'makeup-workday'
    }
    if (info.isHoliday && rule.skipHolidays) {
      allowed = false
      reason = `holiday:${info.holidayName ?? 'statutory'}`
    }
    if (!info.known && rule.fallbackWhenUnknown !== 'run' && allowed) {
      allowed = false
      reason = 'unknown-calendar'
    }
    return { allowed, reason, info }
  }

  /** @returns {{source: string, version: string, fetchedAt: number, min: string, max: string, holidayCount: number, makeupCount: number}} */
  status() {
    return {
      ...this.#meta,
      min: this.#range.min,
      max: this.#range.max,
      holidayCount: this.#holidays.size,
      makeupCount: this.#makeup.size,
    }
  }

  /**
   * Fetch the newest upstream calendar and persist it. Never throws.
   * @param {{fetchImpl?: typeof fetch, timeoutMs?: number}} [options] Injection seams.
   * @returns {Promise<{updated: boolean, reason?: string, version?: string, max?: string}>}
   */
  async refresh(options = {}) {
    const fetchImpl = options.fetchImpl ?? globalThis.fetch
    if (typeof fetchImpl !== 'function') return { updated: false, reason: 'no-fetch' }
    for (const url of SOURCES) {
      try {
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 15000)
        const response = await fetchImpl(url, { signal: controller.signal, redirect: 'follow' })
        clearTimeout(timer)
        if (!response.ok) continue
        const raw = await response.json()
        if (raw === null || typeof raw !== 'object' || raw.holidays === undefined) continue
        const { holidays, makeup } = flatten(raw)
        if (holidays.size < 100) continue
        const dates = [...holidays.keys(), ...makeup].sort()
        const doc = {
          schema: CACHE_SCHEMA,
          source: url.includes('npmmirror') ? 'npmmirror' : 'unpkg',
          version: raw.version ?? 'latest',
          fetchedAt: Date.now(),
          minDate: dates[0],
          maxDate: dates[dates.length - 1],
          raw: { holidays: Object.fromEntries(holidays), workdays: Object.fromEntries([...makeup].map(d => [d, true])) },
        }
        await mkdir(dirname(this.cachePath), { recursive: true }).catch(() => {})
        await writeFile(this.cachePath, JSON.stringify(doc), 'utf8')
        this.#merge(doc)
        return { updated: true, version: doc.version, max: doc.maxDate }
      } catch (error) {
        this.logger?.warn?.(`holiday refresh from ${url} failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    return { updated: false, reason: 'all-sources-failed' }
  }
}
