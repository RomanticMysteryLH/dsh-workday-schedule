/**
 * Workday-aware scheduling for DeepSeek Harness.
 *
 * The plugin never delivers a reminder itself. For every enabled task it keeps exactly
 * one future one-shot reminder in the built-in Schedule, so the shipped delivery, the
 * automation-task page, and restart behaviour all stay authoritative. After a reminder
 * fires, the next occurrence under the holiday / 调休 rule is armed automatically.
 *
 * Holiday data refreshes silently in the background: no setting, no notification, and a
 * failed refresh simply leaves the previous snapshot in force.
 * @module dsh-workday-schedule
 */

import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { HolidayCalendar } from './src/holiday.js'
import { TaskStore } from './src/store.js'
import { WorkdayEngine } from './src/engine.js'
import { buildTools } from './src/tools.js'
import { buildPlan } from './src/plan.js'
import { normalizeSelectors } from './src/rule.js'
import { describeRule, upcoming, normalizeDayKind } from './src/rules.js'
import { normalizeTime } from './src/time.js'
import { PACKAGE, PLAN_DESCRIPTORS, PLAN_MODEL, SERVICE as SERVICE_NAME } from './src/remote.js'

/** Cordis plugin name. */
export const name = 'workday-schedule'

/** Services that must exist before the plugin activates. */
export const inject = ['schedule', 'tools']

/**
 * Resolve the Schemastery module that ships with the running Harness.
 *
 * A bundle installed from a workspace directory is linked, not copied, so a bare
 * specifier resolves against the workspace rather than the profile. The profile's own
 * copy is therefore tried by absolute path. When nothing resolves the plugin still runs;
 * only the generated settings page is unavailable.
 * @returns {Promise<any | undefined>} The Schema factory, or undefined.
 */
async function loadSchema() {
  const candidates = []
  const profileDir = process.env.DSH_PROFILE_DIR
  if (typeof profileDir === 'string' && profileDir.trim() !== '') {
    candidates.push(join(profileDir, 'node_modules', '@deepseek-ai', 'schemastery', 'lib', 'index.mjs'))
  }
  const profileName = process.env.DSH_PROFILE
  if (typeof profileName === 'string' && profileName.trim() !== '') {
    candidates.push(join(homedir(), '.dsh', 'profiles', profileName, 'node_modules', '@deepseek-ai', 'schemastery', 'lib', 'index.mjs'))
  }
  try {
    const mod = await import('@deepseek-ai/schemastery')
    if (mod?.default) return mod.default
  } catch { /* fall through to absolute paths */ }
  for (const path of candidates) {
    try {
      const mod = await import(pathToFileURL(path).href)
      if (mod?.default) return mod.default
    } catch { /* try the next location */ }
  }
  return undefined
}

const Schema = await loadSchema()

/** Plugin configuration; rendered as this row's settings page when Schemastery resolved. */
export const Config = Schema?.object({
  weekdays: Schema.array(Schema.number()).default([1, 2, 3, 4, 5])
    .description('新建任务默认运行星期（1=周一 … 7=周日）。'),
  skipHolidays: Schema.boolean().default(true)
    .description('跳过中国法定节假日。'),
  runOnMakeupWorkdays: Schema.boolean().default(true)
    .description('调休补班日（周末上班）照常执行。'),
  fallbackWhenUnknown: Schema.union([Schema.const('run'), Schema.const('skip')]).default('run')
    .description('节假日数据还没覆盖到某个日期时：run=按周几照常执行，skip=跳过。'),
  timeZone: Schema.string().default('Asia/Shanghai')
    .description('判定工作日与计算执行时刻所用的时区。'),
  autoUpdate: Schema.boolean().default(true)
    .description('后台静默更新节假日数据（推荐开启）。'),
  updateIntervalHours: Schema.number().default(12)
    .description('后台更新间隔（小时）。'),
})

/** Defaults applied when a profile omits a field. */
const DEFAULTS = {
  weekdays: [1, 2, 3, 4, 5],
  skipHolidays: true,
  runOnMakeupWorkdays: true,
  fallbackWhenUnknown: 'run',
  timeZone: 'Asia/Shanghai',
  autoUpdate: true,
  updateIntervalHours: 12,
}

/**
 * Read one integer configuration field with a floor.
 * @param {any} config Row configuration.
 * @param {string} key Field name.
 * @param {number} fallback Default.
 * @param {number} min Lower bound.
 * @returns {number}
 */
function intField(config, key, fallback, min) {
  const value = Number(config?.[key])
  return Number.isFinite(value) && value >= min ? Math.floor(value) : fallback
}

/**
 * Resolve the effective configuration, defaulting every missing field.
 * @param {any} config Raw row configuration.
 * @param {{weekdays: number[]}} overrides Fallbacks supplied by the caller.
 */
function resolveConfig(config, overrides) {
  const weekdays = Array.isArray(config?.weekdays) && config.weekdays.length > 0
    ? [...new Set(config.weekdays.map(Number).filter(d => Number.isInteger(d) && d >= 1 && d <= 7))].sort((a, b) => a - b)
    : overrides.weekdays
  return {
    weekdays: weekdays.length > 0 ? weekdays : DEFAULTS.weekdays,
    skipHolidays: config?.skipHolidays !== false,
    runOnMakeupWorkdays: config?.runOnMakeupWorkdays !== false,
    fallbackWhenUnknown: config?.fallbackWhenUnknown === 'skip' ? 'skip' : 'run',
    timeZone: typeof config?.timeZone === 'string' && config.timeZone.trim() !== '' ? config.timeZone.trim() : DEFAULTS.timeZone,
    autoUpdate: config?.autoUpdate !== false,
    updateIntervalHours: intField(config, 'updateIntervalHours', DEFAULTS.updateIntervalHours, 1),
  }
}

/**
 * Plugin entry point.
 * @param {any} ctx Plugin context.
 * @param {any} rawConfig Row configuration validated against `Config`.
 */
export function apply(ctx, rawConfig) {
  const config = resolveConfig(rawConfig, { weekdays: DEFAULTS.weekdays })
  const dataDir = join(homedir(), '.dsh', 'workday-schedule')
  const seedPath = fileURLToPath(new URL('./src/seed-holidays.json', import.meta.url))
  const logger = ctx.logger

  const calendar = new HolidayCalendar({ dataDir, seedPath, logger })
  const store = new TaskStore({ dataDir })
  const engine = new WorkdayEngine({ ctx, config, calendar, store, logger })

  // Expose the configuration on the object handed to tools, which read schedule access
  // through the same context that owns the registrations.
  const toolDeps = { engine, store, calendar, config: { ...config, ctx } }

  // Loaded once and shared: a second `store.load()` would overwrite anything the first
  // pass had already written in memory.
  const ready = (async () => {
    await calendar.whenReady()
    await store.load()
  })()

  ctx.effect(() => {
    let disposed = false
    const disposers = []
    void (async () => {
      await ready
      if (disposed) return
      for (const definition of buildTools(toolDeps)) {
        if (disposed) break
        disposers.push(ctx.tools.register(definition))
      }
      disposers.push(engine.start())
      logger?.log?.(`workday-schedule: ready with ${store.tasks.length} task(s), calendar ${calendar.status().min}..${calendar.status().max}`)
    })()
    return () => {
      disposed = true
      for (const dispose of disposers) {
        try { dispose() } catch { /* already removed */ }
      }
    }
  })

  // Expose the page feed to the browser half.
  //
  // Only `typert` is injected: the Host has no `remote` service — the browser mounts the
  // contract, and the gateway resolves each invocation's `service` name against the live
  // Cordis services.
  //
  // The gateway additionally requires the service to carry a `typertRemote` binding
  // (`{ service, serviceKey, namespace }` where `service` is the object itself). Shipped
  // packages get it from the `@Remote` decorator, which lives inside the read-only app
  // bundle and cannot be imported here, so the binding is attached by hand. Methods sit
  // on the class prototype because the gateway resolves them through the prototype chain.
  ctx.inject(['typert'], (sub) => {
    class WorkdayFeed {
      /**
       * @param {{from?: string, days?: number}} request Window requested by the page.
       * @returns {Promise<any>} Plan document.
       */
      async plan(request) {
        await ready
        return buildPlan({
          from: request?.from,
          days: request?.days,
          tasks: store.tasks,
          calendar,
          config,
          nowMs: Date.now(),
        })
      }

      /**
       * Preview a rule without saving it, so the builder can show the real dates.
       * @param {{selectors?: any[], time?: string, count?: number}} request Draft rule.
       * @returns {Promise<any>} Rule text plus the next occurrences.
       */
      async previewRule(request) {
        await ready
        let selectors
        try {
          selectors = normalizeSelectors(request?.selectors)
        } catch (error) {
          return { ok: false, error: error instanceof Error ? error.message : String(error) }
        }
        const time = normalizeTime(request?.time) ?? '09:00'
        const count = Math.min(Math.max(Math.trunc(Number(request?.count) || 8), 1), 40)
        const draft = { time, selectors }
        const hits = upcoming(draft, Date.now(), calendar, config, count)
        return {
          ok: true,
          ruleText: describeRule(draft),
          occurrences: hits.map(hit => ({ local: `${hit.date} ${hit.time}`, at: new Date(hit.at).toISOString(), reason: hit.reason })),
        }
      }

      /**
       * Create a task from the page. The Host owns the rule, which is why this exists:
       * a composable rule has no title-suffix encoding to travel through.
       * @param {{title: string, prompt: string, time: string, sessionId: string, selectors?: any[], dayKind?: string, weekdays?: number[]}} request Task draft.
       * @returns {Promise<any>} The created task preview.
       */
      async createTask(request) {
        await ready
        const fail = (message) => ({ ok: false, error: message })
        const title = String(request?.title ?? '').trim()
        if (title === '') return fail('任务名称不能为空')
        const prompt = String(request?.prompt ?? '')
        if (prompt.trim() === '') return fail('任务内容不能为空')
        const time = normalizeTime(request?.time)
        if (time === undefined) return fail('执行时间必须是 HH:MM')
        const sessionId = typeof request?.sessionId === 'string' ? request.sessionId.trim() : ''
        if (sessionId === '') return fail('必须指定执行位置')
        let selectors
        if (request?.selectors !== undefined && request.selectors !== null) {
          try {
            selectors = normalizeSelectors(request.selectors)
          } catch (error) {
            return fail(error instanceof Error ? error.message : String(error))
          }
        }
        const task = store.add({
          title: title.slice(0, 120),
          prompt,
          time,
          dayKind: selectors === undefined ? normalizeDayKind(request?.dayKind) : 'workday',
          weekdays: Array.isArray(request?.weekdays) && request.weekdays.length > 0 ? request.weekdays : [1, 2, 3, 4, 5],
          selectors,
          skipHolidays: true,
          runOnMakeupWorkdays: true,
          sessionId,
          enabled: true,
          nativeId: null,
          extras: [],
          scheduleId: null,
        })
        await store.save()
        await engine.reconcile(task, Date.now())
        return { ok: true, task: engine.preview(task) }
      }

      /**
       * Update one task from the page; supply `selectors: null` to drop a composable rule.
       * @param {{id: string, patch: any}} request Target task and fields.
       * @returns {Promise<any>} The updated task preview.
       */
      async updateTask(request) {
        await ready
        const task = store.get(String(request?.id ?? ''))
        if (task === undefined) return { ok: false, error: '任务不存在' }
        const patch = {}
        const incoming = request?.patch ?? {}
        if (typeof incoming.title === 'string') patch.title = incoming.title.trim().slice(0, 120)
        if (typeof incoming.prompt === 'string') patch.prompt = incoming.prompt
        if (incoming.time !== undefined) {
          const time = normalizeTime(incoming.time)
          if (time === undefined) return { ok: false, error: '执行时间必须是 HH:MM' }
          patch.time = time
        }
        if (incoming.enabled !== undefined) {
          patch.enabled = incoming.enabled === true
          patch.disabledReason = patch.enabled ? null : 'paused-by-user'
        }
        if (incoming.selectors === null) {
          patch.selectors = undefined
        } else if (incoming.selectors !== undefined) {
          try {
            patch.selectors = normalizeSelectors(incoming.selectors)
          } catch (error) {
            return { ok: false, error: error instanceof Error ? error.message : String(error) }
          }
        }
        if (incoming.dayKind !== undefined) patch.dayKind = normalizeDayKind(incoming.dayKind)
        store.update(task.id, patch)
        await store.save()
        await engine.reconcile(task, Date.now())
        return { ok: true, task: engine.preview(task) }
      }

      /**
       * Delete one task and every reminder it owns.
       * @param {{id: string}} request Target task.
       * @returns {Promise<any>}
       */
      async deleteTask(request) {
        await ready
        const task = store.get(String(request?.id ?? ''))
        if (task === undefined) return { ok: false, error: '任务不存在' }
        await engine.cancel(task)
        store.remove(task.id)
        await store.save()
        return { ok: true, deleted: task.id }
      }
    }

    const feed = new WorkdayFeed()
    // The gateway compares `binding.service` against the object it resolved (which may be
    // an unproxied original), so the binding reports whichever object is asking for it.
    Object.defineProperty(feed, 'typertRemote', {
      enumerable: false,
      configurable: true,
      get() { return { service: this, serviceKey: SERVICE_NAME, namespace: SERVICE_NAME } },
    })
    sub.provide(SERVICE_NAME, feed)
    sub.typert.register({ package: PACKAGE, face: 'host', schemas: [], model: PLAN_MODEL, invocations: PLAN_DESCRIPTORS })
    logger?.log?.(`workday-schedule: page feed service ${SERVICE_NAME} registered`)
  })

  // Silent background refresh: first pass shortly after start, then on the configured
  // interval. Failures are swallowed by the calendar and never surface to the user.
  ctx.effect(() => {
    if (!config.autoUpdate) return () => {}
    const intervalMs = config.updateIntervalHours * 3_600_000
    let timer
    const run = () => {
      void calendar.refresh().then((result) => {
        if (result.updated) logger?.log?.(`workday-schedule: holiday data updated to ${result.max}`)
      })
    }
    const initial = setTimeout(run, 20_000)
    timer = setInterval(run, intervalMs)
    return () => {
      clearTimeout(initial)
      clearInterval(timer)
    }
  })
}
