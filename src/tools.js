/**
 * Agent-facing tools: create, inspect, edit, and delete workday tasks.
 * @module dsh-workday-schedule/tools
 */

import { normalizeTime } from './time.js'
import { describeRule, upcoming, normalizeDayKind, DAY_KINDS } from './rules.js'
import { normalizeSelectors } from './rule.js'

/** Render any tool value as pretty JSON text. */
const jsonRender = (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }]

/** Standard output envelope shared by every tool here. */
const OUTPUT = { schema: { type: 'object' }, render: jsonRender }

/**
 * Resolve the calling session, which owns every reminder this plugin arms.
 * @param {any} exec Tool execution context.
 * @returns {{sessionId: string, cwd?: string} | undefined}
 */
function caller(exec) {
  const session = exec?.agent?.session
  if (session === undefined || typeof session.id !== 'string') return undefined
  return { sessionId: session.id, cwd: session.header?.cwd }
}

/**
 * Normalize a weekday list to unique ISO numbers in `1..7`.
 * @param {unknown} value Candidate.
 * @returns {number[] | undefined}
 */
function normalizeWeekdays(value) {
  if (!Array.isArray(value) || value.length === 0) return undefined
  const days = [...new Set(value.map(Number).filter(d => Number.isInteger(d) && d >= 1 && d <= 7))].sort((a, b) => a - b)
  return days.length === 0 ? undefined : days
}

/**
 * Weekday name for a calendar date.
 * @param {string} date `YYYY-MM-DD`
 * @returns {string}
 */
function describeWeekday(date) {
  const names = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']
  return names[new Date(`${date}T00:00:00Z`).getUTCDay()]
}

/**
 * Next calendar date.
 * @param {string} date `YYYY-MM-DD`
 * @returns {string}
 */
function nextDate(date) {
  const d = new Date(Date.parse(`${date}T00:00:00Z`) + 86_400_000)
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`
}

/**
 * Build the tool definitions against one live engine.
 * @param {{engine: any, store: any, calendar: any, config: any}} deps Wiring.
 * @returns {any[]} Definitions ready for `ctx.tools.register`.
 */
export function buildTools(deps) {
  const { engine, store, calendar, config } = deps

  /** @param {any} task Task. @returns {Array<any>} Next occurrences for previews. */
  const previewUpcoming = task => upcoming(task, Date.now(), calendar, config, 3)
    .map(hit => ({ at: new Date(hit.at).toISOString(), local: `${hit.date} ${hit.time}`, reason: hit.reason }))

  return [

    {
      name: 'workday_task_create',
      description: 'Create a workday-aware scheduled task. It runs only on configured weekdays, skips China statutory holidays, and optionally runs on 调休 make-up workdays. Delivery goes to the target session (the current one by default) and the task is visible on the built-in automation-task page.',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Task name shown on the automation-task page (max 120 chars).' },
          prompt: { type: 'string', description: 'Self-contained prompt delivered when the task fires.' },
          time: { type: 'string', description: 'Local time of day, HH:MM in the plugin time zone.' },
          weekdays: { type: 'array', items: { type: 'number' }, description: 'ISO weekdays, 1=Mon .. 7=Sun. Defaults to Mon-Fri.' },
          skip_holidays: { type: 'boolean', description: 'Skip China statutory holidays. Defaults to true.' },
          run_on_makeup_workdays: { type: 'boolean', description: 'Also run on 调休 make-up workdays that fall on a weekend. Defaults to true.' },
          session_id: { type: 'string', description: 'Bind delivery to this existing session instead of the current one. Use only to migrate an existing automation task whose session differs.' },
          report_after_run: { type: 'boolean', description: 'Append a short post-run report request to the delivered prompt. Defaults to false: the delivered prompt is then exactly your text.' },
          rule: { type: 'array', items: { type: 'object' }, description: 'Composable rule: array of selectors {dayType: workday|restday, anchor: stretch|week|month, ordinals: [..], every}. Overrides day_kind/weekdays. Example: [{dayType:workday,anchor:stretch,ordinals:[2,3]},{dayType:restday,anchor:stretch,ordinals:[1]}].' },
          day_kind: { type: 'string', enum: ['workday', 'restday', 'restday-first'], description: 'workday (default) runs on working days; restday runs on weekends and statutory holidays and never on a 调休 make-up workday; restday-first runs only on the FIRST day of a rest stretch, for jobs that process the work stretch that just ended.' },
        },
        required: ['title', 'prompt', 'time'],
      },
      output: OUTPUT,
      timeoutMs: 30000,
      async execute(args, exec) {
        const who = caller(exec)
        if (who === undefined) return { ok: false, error: 'no-session', message: 'This tool needs a live session.' }
        const targetSessionId = typeof args.session_id === 'string' && args.session_id.trim() !== ''
          ? args.session_id.trim()
          : who.sessionId
        const time = normalizeTime(args.time)
        if (time === undefined) return { ok: false, error: 'invalid-time', message: 'time must be HH:MM.' }
        const weekdays = args.weekdays === undefined ? [1, 2, 3, 4, 5] : normalizeWeekdays(args.weekdays)
        if (weekdays === undefined) return { ok: false, error: 'invalid-weekdays', message: 'weekdays must list ISO days 1..7.' }
        // A composable rule supersedes day_kind/weekdays. Invalid rules are rejected here
        // rather than degraded, because a rule that silently lost a selector would run on
        // the wrong days.
        let selectors
        if (args.rule !== undefined) {
          try {
            selectors = normalizeSelectors(args.rule)
          } catch (error) {
            return { ok: false, error: 'invalid-rule', message: error instanceof Error ? error.message : String(error) }
          }
        }
        const task = store.add({
          title: String(args.title).slice(0, 120),
          prompt: String(args.prompt),
          time,
          dayKind: normalizeDayKind(args.day_kind),
          weekdays,
          selectors,
          reportAfterRun: args.report_after_run === true,
          skipHolidays: args.skip_holidays !== false,
          runOnMakeupWorkdays: args.run_on_makeup_workdays !== false,
          sessionId: targetSessionId,
          cwd: who.cwd ?? null,
          enabled: true,
          scheduleId: null,
          armedFor: null,
          armedAt: null,
        })
        await store.save()
        await engine.reconcile(task, Date.now())
        return { ok: true, task: engine.preview(task), upcoming: previewUpcoming(task) }
      },
    },

    {
      name: 'workday_task_list',
      description: 'List workday-aware scheduled tasks with their rule and next run time.',
      parameters: { type: 'object', properties: {} },
      output: OUTPUT,
      timeoutMs: 20000,
      async execute() {
        const now = Date.now()
        return {
          ok: true,
          count: store.tasks.length,
          calendar: calendar.status(),
          tasks: store.tasks.map(task => engine.preview(task, now)),
        }
      },
    },

    {
      name: 'workday_task_update',
      description: 'Edit a workday-aware scheduled task: title, prompt, time, weekdays, holiday behaviour, or enablement.',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Task id from workday_task_list.' },
          title: { type: 'string' },
          prompt: { type: 'string' },
          time: { type: 'string', description: 'HH:MM in the plugin time zone.' },
          weekdays: { type: 'array', items: { type: 'number' } },
          skip_holidays: { type: 'boolean' },
          run_on_makeup_workdays: { type: 'boolean' },
          enabled: { type: 'boolean', description: 'false pauses the task and removes its armed reminder.' },
          report_after_run: { type: 'boolean', description: 'Append a short post-run report request to the delivered prompt.' },
          day_kind: { type: 'string', enum: ['workday', 'restday', 'restday-first'], description: 'workday runs on working days; restday runs on weekends and statutory holidays; restday-first runs only on the first day of a rest stretch.' },
        },
        required: ['id'],
      },
      output: OUTPUT,
      timeoutMs: 30000,
      async execute(args) {
        const task = store.get(String(args.id))
        if (task === undefined) return { ok: false, error: 'not-found', message: `No task with id ${args.id}.` }
        const patch = {}
        if (args.title !== undefined) patch.title = String(args.title).slice(0, 120)
        if (args.prompt !== undefined) patch.prompt = String(args.prompt)
        if (args.time !== undefined) {
          const time = normalizeTime(args.time)
          if (time === undefined) return { ok: false, error: 'invalid-time', message: 'time must be HH:MM.' }
          patch.time = time
        }
        if (args.weekdays !== undefined) {
          const weekdays = normalizeWeekdays(args.weekdays)
          if (weekdays === undefined) return { ok: false, error: 'invalid-weekdays', message: 'weekdays must list ISO days 1..7.' }
          patch.weekdays = weekdays
        }
        if (args.skip_holidays !== undefined) patch.skipHolidays = args.skip_holidays !== false
        if (args.run_on_makeup_workdays !== undefined) patch.runOnMakeupWorkdays = args.run_on_makeup_workdays !== false
        if (args.enabled !== undefined) {
          patch.enabled = args.enabled !== false
          patch.disabledReason = patch.enabled ? null : 'paused-by-user'
        }
        if (args.report_after_run !== undefined) {
          patch.reportAfterRun = args.report_after_run === true
        }
        if (args.day_kind !== undefined) {
          if (!DAY_KINDS.includes(args.day_kind)) {
            return { ok: false, error: 'invalid-day-kind', message: 'day_kind must be one of ' + DAY_KINDS.join(', ') + '.' }
          }
          patch.dayKind = args.day_kind
          // Switching back to a simple mode must drop any composable rule, or it would
          // keep overriding day_kind.
          patch.selectors = undefined
        }
        if (args.rule !== undefined) {
          if (args.rule === null) {
            patch.selectors = undefined
          } else {
            try {
              patch.selectors = normalizeSelectors(args.rule)
            } catch (error) {
              return { ok: false, error: 'invalid-rule', message: error instanceof Error ? error.message : String(error) }
            }
          }
        }
        store.update(task.id, patch)
        await store.save()
        await engine.reconcile(task, Date.now())
        return { ok: true, task: engine.preview(task), upcoming: previewUpcoming(task) }
      },
    },

    {
      name: 'workday_task_report',
      description: 'Record the outcome of one run of a workday task, so the task page shows what happened instead of only when it fired. Call it once at the end of a run.',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Task id from workday_task_list.' },
          summary: { type: 'string', description: 'One sentence on what this run did and whether it worked. Shown as the row summary.' },
          status: { type: 'string', enum: ['ok', 'partial', 'failed', 'skipped'], description: 'ok = done, partial = partly done, failed = did not work, skipped = refused on purpose.' },
          detail: { type: 'string', description: 'Optional extra detail, a few lines at most.' },
          at: { type: 'string', description: 'ISO instant of the run. Defaults to now.' },
        },
        required: ['id', 'summary'],
      },
      output: OUTPUT,
      timeoutMs: 20000,
      async execute(args) {
        const task = store.get(String(args.id))
        if (task === undefined) return { ok: false, error: 'not-found', message: `No task with id ${args.id}.` }
        const summary = String(args.summary ?? '').trim()
        if (summary === '') return { ok: false, error: 'empty-summary', message: 'summary must not be empty.' }
        const report = store.addReport(task.id, {
          at: args.at,
          status: args.status,
          summary,
          detail: args.detail,
        })
        await store.save()
        return { ok: true, report }
      },
    },

    {
      name: 'workday_task_delete',
      description: 'Delete a workday-aware scheduled task together with its armed reminder.',
      parameters: {
        type: 'object',
        properties: { id: { type: 'string', description: 'Task id from workday_task_list.' } },
        required: ['id'],
      },
      output: OUTPUT,
      timeoutMs: 20000,
      async execute(args) {
        const task = store.get(String(args.id))
        if (task === undefined) return { ok: false, error: 'not-found', message: `No task with id ${args.id}.` }
        await engine.cancel(task)
        store.remove(task.id)
        await store.save()
        return { ok: true, deleted: task.id }
      },
    },

    {
      name: 'workday_check',
      description: 'Check whether one date or a date range is a working day (statutory holiday, 调休 make-up workday, weekend), or preview when a composable rule would fire.',
      parameters: {
        type: 'object',
        properties: {
          date: { type: 'string', description: 'Single date, YYYY-MM-DD. Defaults to today.' },
          start: { type: 'string', description: 'Range start, YYYY-MM-DD.' },
          end: { type: 'string', description: 'Range end, YYYY-MM-DD, inclusive.' },
          rule: { type: 'array', items: { type: 'object' }, description: 'Preview a composable rule instead of inspecting dates: returns the next occurrences and their rule text.' },
          time: { type: 'string', description: 'Time of day for a rule preview, HH:MM. Defaults to 09:00.' },
          count: { type: 'number', description: 'How many occurrences to preview. Defaults to 8.' },
        },
      },
      output: OUTPUT,
      timeoutMs: 20000,
      async execute(args) {
        const today = new Date().toISOString().slice(0, 10)
        if (Array.isArray(args.rule)) {
          // Preview exists because a composable rule is easy to misconfigure: seeing the
          // real dates is the only reliable way to confirm the ordinals mean what you think.
          let selectors
          try {
            selectors = normalizeSelectors(args.rule)
          } catch (error) {
            return { ok: false, error: 'invalid-rule', message: error instanceof Error ? error.message : String(error) }
          }
          const time = normalizeTime(args.time) ?? '09:00'
          const count = Math.min(Math.max(Math.trunc(Number(args.count) || 8), 1), 40)
          const preview = { time, selectors }
          const hits = upcoming(preview, Date.now(), calendar, config, count)
          return {
            ok: true,
            ruleText: describeRule(preview),
            occurrences: hits.map(hit => ({ local: `${hit.date} ${hit.time}`, at: new Date(hit.at).toISOString(), reason: hit.reason })),
          }
        }
        if (args.start !== undefined || args.end !== undefined) {
          const start = String(args.start ?? args.end)
          const end = String(args.end ?? args.start)
          const days = []
          let cursor = start
          for (let i = 0; i < 400 && cursor <= end; i += 1) {
            days.push({ ...calendar.describe(cursor), weekday: describeWeekday(cursor) })
            cursor = nextDate(cursor)
          }
          return { ok: true, days, calendar: calendar.status() }
        }
        const date = String(args.date ?? today)
        return { ok: true, ...calendar.describe(date), weekday: describeWeekday(date), calendar: calendar.status() }
      },
    },
  ]
}
