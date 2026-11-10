/**
 * Engine smoke test: reconciliation against a fake Schedule service.
 * Run with `node --test test/engine.smoke.mjs`.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { HolidayCalendar } from '../src/holiday.js'
import { TaskStore } from '../src/store.js'
import { WorkdayEngine } from '../src/engine.js'
import { nextOccurrence, describeRule } from '../src/rules.js'
import { buildTools } from '../src/tools.js'

/**
 * Minimal stand-in for the built-in Schedule service.
 * @returns {any} Fake service with create/delete/catalog.
 */
function fakeSchedule() {
  const rows = new Map()
  let counter = 0
  return {
    rows,
    async create(sessionId, request) {
      // Legacy contract only: reject the typed request the way the old service did,
      // so the engine's probe falls through to this path.
      if (typeof sessionId === 'object' && sessionId !== null) {
        throw Object.assign(new Error('timing must contain exactly kind and its matching selector.'), { code: 'invalid_rule' })
      }
      counter += 1
      const id = `schedule-fake-${counter}`
      const record = {
        id,
        kind: 'at',
        title: request.title,
        prompt: request.prompt,
        scheduledAt: `${request.at.date}T${request.at.time}+08:00`,
      }
      rows.set(id, { id, sessionId, record, status: 'active' })
      return record
    },
    async delete(request) {
      const row = rows.get(request.id)
      if (row === undefined) return { id: request.id, deleted: false, code: 'schedule_not_found' }
      rows.delete(request.id)
      return { id: request.id, deleted: true }
    },
    async catalog() {
      return [...rows.values()]
    },
  }
}

const config = {
  weekdays: [1, 2, 3, 4, 5],
  skipHolidays: true,
  runOnMakeupWorkdays: true,
  fallbackWhenUnknown: 'run',
  timeZone: 'Asia/Shanghai',
  autoUpdate: false,
  updateIntervalHours: 12,
}

const seedPath = new URL('../src/seed-holidays.json', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')

/**
 * Assemble one isolated engine.
 * @returns {Promise<{engine: any, store: any, calendar: any, ctx: any, dir: string}>}
 */
async function harness() {
  const dir = await mkdtemp(join(tmpdir(), 'wds-'))
  const calendar = new HolidayCalendar({ dataDir: dir, seedPath })
  await calendar.whenReady()
  const store = new TaskStore({ dataDir: dir })
  await store.load()
  const ctx = { schedule: fakeSchedule(), logger: { warn() {}, log() {} } }
  const engine = new WorkdayEngine({ ctx, config, calendar, store, logger: ctx.logger })
  return { engine, store, calendar, ctx, dir }
}

/** A task shaped like the store's own records. */
function makeTask(overrides = {}) {
  return {
    id: 'wds-test',
    title: 'PMS 日报',
    prompt: 'fill the report',
    time: '09:00',
    weekdays: [1, 2, 3, 4, 5],
    skipHolidays: true,
    runOnMakeupWorkdays: true,
    sessionId: 'session-1',
    enabled: true,
    scheduleId: null,
    armedFor: null,
    armedAt: null,
    ...overrides,
  }
}


// ---------------------------------------------------------------------------
// Rule-level behaviour
// ---------------------------------------------------------------------------

test('rule: weekday label reads like an automation title', () => {
  assert.equal(describeRule(makeTask()), '工作日 09:00（跳过法定节假日，调休上班日执行）')
  assert.equal(
    describeRule(makeTask({ dayKind: 'restday' })),
    '每个休息日 09:00（周末与法定节假日执行，调休上班日不跑）',
  )
})

test('occurrence: skips a statutory holiday and lands on the next working day', async () => {
  const { calendar, dir } = await harness()
  const now = Date.parse('2026-09-30T11:00:00+08:00')
  const hit = nextOccurrence(makeTask({ time: '10:00' }), now, calendar, config)
  assert.ok(hit !== null)
  assert.ok(hit.date > '2026-10-01', `expected to skip the holiday, got ${hit.date}`)
  assert.ok(hit.skipped.length > 0)
  await rm(dir, { recursive: true, force: true })
})

test('occurrence: a 调休 make-up Saturday runs even though it is a weekend', async () => {
  const { calendar, dir } = await harness()
  const now = Date.parse('2026-09-19T10:00:00+08:00')
  const hit = nextOccurrence(makeTask({ time: '09:00' }), now, calendar, config)
  assert.ok(hit !== null)
  assert.equal(hit.date, '2026-09-20')
  assert.equal(hit.reason, 'makeup-workday')
  await rm(dir, { recursive: true, force: true })
})

test('occurrence: an ordinary weekend is skipped', async () => {
  const { calendar, dir } = await harness()
  const now = Date.parse('2026-11-07T08:00:00+08:00')
  const hit = nextOccurrence(makeTask({ time: '09:00' }), now, calendar, config)
  assert.ok(hit !== null)
  assert.equal(hit.date, '2026-11-09')
  await rm(dir, { recursive: true, force: true })
})

test('restday: fires on the first day of a statutory holiday, never on a make-up workday', async () => {
  const { calendar, dir } = await harness()
  const rest = makeTask({ dayKind: 'restday', time: '10:00' })

  const holiday = nextOccurrence(rest, Date.parse('2026-09-30T12:00:00+08:00'), calendar, config)
  assert.ok(holiday !== null)
  assert.equal(holiday.date, '2026-10-01')
  assert.equal(holiday.reason, 'holiday:国庆节')

  const afterMakeup = nextOccurrence(rest, Date.parse('2026-09-19T12:00:00+08:00'), calendar, config)
  assert.ok(afterMakeup !== null)
  assert.notEqual(afterMakeup.date, '2026-09-20', 'a make-up workday is not a rest day')
  await rm(dir, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// Native representation: recurring rule instead of one-shot
// ---------------------------------------------------------------------------

/**
 * Fake built-in Schedule supporting the newer typed-timing contract.
 * @returns {any}
 */
function scheduleNew() {
  const rows = new Map()
  const calls = []
  let counter = 0
  return {
    rows,
    calls,
    async create(request, actorSessionId) {
      counter += 1
      const id = `schedule-${request.timing.kind}-${counter}`
      calls.push({ request, actorSessionId })
      const timing = request.timing
      const row = {
        id,
        sessionId: request.target?.sessionId ?? actorSessionId,
        status: 'active',
        record: timing.kind === 'weekly'
          ? { id, kind: 'weekly', title: request.title, prompt: request.prompt, time: timing.weekly.time, timeZone: timing.weekly.time_zone, weekdays: timing.weekly.weekdays }
          : { id, kind: 'at', title: request.title, prompt: request.prompt, scheduledAt: `${timing.at.date}T${timing.at.time}+08:00` },
      }
      rows.set(id, row)
      return row.record
    },
    async edit(request) {
      if (request.action === 'delete') {
        rows.delete(request.id)
        return { id: request.id, deleted: true }
      }
      const row = rows.get(request.id)
      if (row === undefined) return { id: request.id, code: 'schedule_not_found' }
      if (typeof request.patch.title === 'string') row.record = { ...row.record, title: request.patch.title }
      if (request.patch.timing !== undefined && request.patch.timing.kind === 'weekly') {
        row.record = { ...row.record, kind: 'weekly', time: request.patch.timing.weekly.time, timeZone: request.patch.timing.weekly.time_zone, weekdays: request.patch.timing.weekly.weekdays }
      }
      if (request.patch.active === false) row.status = 'paused'
      if (request.patch.active === true) row.status = 'active'
      return row
    },
    // The real service flattens the record into the entry; mirror that shape.
    async catalog() { return [...rows.values()].map(row => ({ ...row.record, sessionId: row.sessionId, status: row.status })) }
  }
}

test('native: a workday task is represented as a weekly reminder, not a one-shot', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wds-'))
  const calendar = new HolidayCalendar({ dataDir: dir, seedPath })
  await calendar.whenReady()
  const store = new TaskStore({ dataDir: dir })
  await store.load()
  const ctx = { schedule: scheduleNew(), logger: { warn() {}, log() {} } }
  const engine = new WorkdayEngine({ ctx, config, calendar, store, logger: ctx.logger })
  const task = store.add(makeTask({ time: '13:30', weekdays: [1, 2, 3, 4, 5] }))
  await store.save()

  await engine.tick()

  const primary = [...ctx.schedule.rows.values()].find(row => row.record.kind === 'weekly')
  assert.ok(primary, 'the task must be carried by a weekly reminder')
  assert.deepEqual(primary.record.weekdays, [1, 2, 3, 4, 5])
  assert.equal(primary.record.time, '13:30:00')
  assert.equal(store.get(task.id).nativeId, primary.id)
  // The page renders `frequency.once` for kind 'at'; a weekly record is what makes the
  // automation-task page show a truthful repeating rule.
  assert.equal(primary.record.kind, 'weekly')
  await rm(dir, { recursive: true, force: true })
})

test('native: a rest-day task is anchored on the weekend', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wds-'))
  const calendar = new HolidayCalendar({ dataDir: dir, seedPath })
  await calendar.whenReady()
  const store = new TaskStore({ dataDir: dir })
  await store.load()
  const ctx = { schedule: scheduleNew(), logger: { warn() {}, log() {} } }
  const engine = new WorkdayEngine({ ctx, config, calendar, store, logger: ctx.logger })
  const task = store.add(makeTask({ dayKind: 'restday', time: '10:00' }))
  await store.save()

  await engine.tick()

  const primary = [...ctx.schedule.rows.values()].find(row => row.record.kind === 'weekly')
  assert.ok(primary)
  assert.deepEqual(primary.record.weekdays, [6, 7])
  await rm(dir, { recursive: true, force: true })
})

test('suppression: the weekly reminder is paused before a statutory holiday fits it', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wds-'))
  const calendar = new HolidayCalendar({ dataDir: dir, seedPath })
  await calendar.whenReady()
  const store = new TaskStore({ dataDir: dir })
  await store.load()
  const ctx = { schedule: scheduleNew(), logger: { warn() {}, log() {} } }
  const engine = new WorkdayEngine({ ctx, config, calendar, store, logger: ctx.logger })
  const task = store.add(makeTask({ time: '13:30', weekdays: [1, 2, 3, 4, 5] }))
  await store.save()

  // Thursday 2026-10-01 is a statutory holiday; the weekly Mon-Fri reminder would fire.
  const holidayEve = Date.parse('2026-09-30T18:00:00+08:00')
  await engine.tick()
  await engine.reconcile(task, holidayEve)

  const primary = ctx.schedule.rows.get(store.get(task.id).nativeId)
  assert.equal(primary.status, 'paused', 'the holiday occurrence must be suppressed')
  assert.equal(store.get(task.id).pausedFor, '2026-10-01')
  await rm(dir, { recursive: true, force: true })
})

test('suppression: the reminder resumes once the holiday window is over', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wds-'))
  const calendar = new HolidayCalendar({ dataDir: dir, seedPath })
  await calendar.whenReady()
  const store = new TaskStore({ dataDir: dir })
  await store.load()
  const ctx = { schedule: scheduleNew(), logger: { warn() {}, log() {} } }
  const engine = new WorkdayEngine({ ctx, config, calendar, store, logger: ctx.logger })
  const task = store.add(makeTask({ time: '13:30', weekdays: [1, 2, 3, 4, 5] }))
  await store.save()

  await engine.tick()
  await engine.reconcile(task, Date.parse('2026-09-30T18:00:00+08:00'))
  assert.equal(ctx.schedule.rows.get(store.get(task.id).nativeId).status, 'paused')

  // Back at work on 2026-10-08 (Thursday): the reminder must come back.
  await engine.reconcile(task, Date.parse('2026-10-08T08:00:00+08:00'))
  const primary = ctx.schedule.rows.get(store.get(task.id).nativeId)
  assert.equal(primary.status, 'active')
  assert.equal(store.get(task.id).pausedByPlugin, false)
  await rm(dir, { recursive: true, force: true })
})

test('extras: a 调休 weekend workday gets its own one-shot reminder', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wds-'))
  const calendar = new HolidayCalendar({ dataDir: dir, seedPath })
  await calendar.whenReady()
  const store = new TaskStore({ dataDir: dir })
  await store.load()
  const ctx = { schedule: scheduleNew(), logger: { warn() {}, log() {} } }
  const engine = new WorkdayEngine({ ctx, config, calendar, store, logger: ctx.logger })
  // 2026-10-10 is a Saturday make-up workday, which a Mon-Fri weekly rule cannot reach.
  const task = store.add(makeTask({ time: '13:30', weekdays: [1, 2, 3, 4, 5] }))
  await store.save()
  // Pin "now" before that date so the rolling horizon covers it; the wall clock is later.
  await engine.reconcile(task, Date.parse('2026-09-25T08:00:00+08:00'))

  const extras = (store.get(task.id).extras ?? []).map(extra => extra.date)
  assert.ok(extras.includes('2026-10-10'), `expected an extra for 2026-10-10, got ${extras.join(',')}`)
  const rows = [...ctx.schedule.rows.values()].filter(row => row.record.kind === 'at')
  assert.ok(rows.length > 0, 'extras must be materialised as one-shot reminders')
  await rm(dir, { recursive: true, force: true })
})

test('manual pause: a reminder paused by the user pauses the task instead of being resumed', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wds-'))
  const calendar = new HolidayCalendar({ dataDir: dir, seedPath })
  await calendar.whenReady()
  const store = new TaskStore({ dataDir: dir })
  await store.load()
  const ctx = { schedule: scheduleNew(), logger: { warn() {}, log() {} } }
  const engine = new WorkdayEngine({ ctx, config, calendar, store, logger: ctx.logger })
  const task = store.add(makeTask())
  await store.save()
  await engine.tick()

  const primary = ctx.schedule.rows.get(store.get(task.id).nativeId)
  primary.status = 'paused' // the user paused it by hand
  await engine.tick()

  const after = store.get(task.id)
  assert.equal(after.enabled, false)
  assert.equal(after.disabledReason, 'paused-on-automation-page')
  await rm(dir, { recursive: true, force: true })
})

test('contract: the typed timing request is used when the service supports it', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wds-'))
  const calendar = new HolidayCalendar({ dataDir: dir, seedPath })
  await calendar.whenReady()
  const store = new TaskStore({ dataDir: dir })
  await store.load()
  const schedule = scheduleNew()
  const ctx = { schedule, logger: { warn() {}, log() {} } }
  const engine = new WorkdayEngine({ ctx, config, calendar, store, logger: ctx.logger })
  store.add(makeTask({ time: '13:30' }))
  await store.save()
  await engine.tick()

  const weeklyCall = schedule.calls.find(call => call.request.timing.kind === 'weekly')
  assert.ok(weeklyCall, 'must create a weekly reminder')
  assert.deepEqual(Object.keys(weeklyCall.request.timing.weekly).sort(), ['time', 'time_zone', 'weekdays'])
  assert.match(weeklyCall.request.timing.weekly.time, /^\d{2}:\d{2}:\d{2}$/)
  assert.equal(weeklyCall.request.target.kind, 'session')
  assert.equal(weeklyCall.request.timing.weekly.time_zone, 'Asia/Shanghai')
  await rm(dir, { recursive: true, force: true })
})

test('contract: falls back to the older create(sessionId, request) shape', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wds-'))
  const calendar = new HolidayCalendar({ dataDir: dir, seedPath })
  await calendar.whenReady()
  const store = new TaskStore({ dataDir: dir })
  await store.load()
  const rows = new Map()
  const ctx = {
    schedule: {
      async create(first, second) {
        // The legacy shape is create(sessionId, request); anything else must be rejected, or
        // String.prototype.at would make an accidental probe silently succeed.
        if (second === undefined || typeof first !== 'string') {
          throw Object.assign(new Error('timing must contain exactly kind and its matching selector.'), { code: 'invalid_rule' })
        }
        const rec = second.weekly !== undefined
          ? { id: 'schedule-legacy-weekly', kind: 'weekly', title: second.title, prompt: second.prompt, time: second.weekly.time, timeZone: second.weekly.time_zone, weekdays: second.weekly.weekdays }
          : { id: 'schedule-legacy-at', kind: 'at', title: second.title, prompt: second.prompt, scheduledAt: `${second.at.date}T${second.at.time}+08:00` }
        rows.set(rec.id, { id: rec.id, sessionId: first, status: 'active', record: rec })
        return rec
      },
      async delete(request) { rows.delete(request.id); return { id: request.id, deleted: true } },
      // The real service flattens the record into the entry; mirror that shape.
      async catalog() { return [...rows.values()].map(row => ({ ...row.record, sessionId: row.sessionId, status: row.status })) }
    },
    logger: { warn() {}, log() {} },
  }
  const engine = new WorkdayEngine({ ctx, config, calendar, store, logger: ctx.logger })
  const task = store.add(makeTask())
  await store.save()
  await engine.tick()
  assert.equal(store.get(task.id).nativeId, 'schedule-legacy-weekly')
  await rm(dir, { recursive: true, force: true })
})

test('suppression: booting in the middle of a holiday keeps the reminder paused', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wds-'))
  const calendar = new HolidayCalendar({ dataDir: dir, seedPath })
  await calendar.whenReady()
  const store = new TaskStore({ dataDir: dir })
  await store.load()
  const ctx = { schedule: scheduleNew(), logger: { warn() {}, log() {} } }
  const engine = new WorkdayEngine({ ctx, config, calendar, store, logger: ctx.logger })
  const task = store.add(makeTask({ time: '13:30', weekdays: [1, 2, 3, 4, 5] }))
  await store.save()
  await engine.tick()
  // 2026-10-05 is inside National Day week; the next Mon-Fri base occurrence is 10-05.
  await engine.reconcile(task, Date.parse('2026-10-04T20:00:00+08:00'))
  assert.equal(store.get(task.id).pausedByPlugin, true)
  assert.equal(ctx.schedule.rows.get(store.get(task.id).nativeId).status, 'paused')
  await rm(dir, { recursive: true, force: true })
})

test('suppression: after a long pause the reminder returns on the first working day', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wds-'))
  const calendar = new HolidayCalendar({ dataDir: dir, seedPath })
  await calendar.whenReady()
  const store = new TaskStore({ dataDir: dir })
  await store.load()
  const ctx = { schedule: scheduleNew(), logger: { warn() {}, log() {} } }
  const engine = new WorkdayEngine({ ctx, config, calendar, store, logger: ctx.logger })
  const task = store.add(makeTask({ time: '13:30', weekdays: [1, 2, 3, 4, 5] }))
  await store.save()
  await engine.tick()
  await engine.reconcile(task, Date.parse('2026-10-04T20:00:00+08:00'))
  assert.equal(store.get(task.id).pausedByPlugin, true)

  // 2026-10-08 is the first working day after the holiday.
  await engine.reconcile(task, Date.parse('2026-10-08T09:00:00+08:00'))
  assert.equal(store.get(task.id).pausedByPlugin, false)
  assert.equal(ctx.schedule.rows.get(store.get(task.id).nativeId).status, 'active')
  await rm(dir, { recursive: true, force: true })
})

test('suppression: a rest-day task is paused on a 调休 make-up weekend', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wds-'))
  const calendar = new HolidayCalendar({ dataDir: dir, seedPath })
  await calendar.whenReady()
  const store = new TaskStore({ dataDir: dir })
  await store.load()
  const ctx = { schedule: scheduleNew(), logger: { warn() {}, log() {} } }
  const engine = new WorkdayEngine({ ctx, config, calendar, store, logger: ctx.logger })
  const task = store.add(makeTask({ dayKind: 'restday', time: '10:00' }))
  await store.save()
  await engine.tick()
  // 2026-09-20 is a Sunday make-up workday: the weekend reminder must not fire.
  await engine.reconcile(task, Date.parse('2026-09-19T20:00:00+08:00'))
  assert.equal(store.get(task.id).pausedByPlugin, true)
  assert.equal(store.get(task.id).pausedFor, '2026-09-20')
  await rm(dir, { recursive: true, force: true })
})

test('regression: reconciling right after creation must not orphan a duplicate reminder', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wds-'))
  const calendar = new HolidayCalendar({ dataDir: dir, seedPath })
  await calendar.whenReady()
  const store = new TaskStore({ dataDir: dir })
  await store.load()
  const ctx = { schedule: scheduleNew(), logger: { warn() {}, log() {} } }
  const engine = new WorkdayEngine({ ctx, config, calendar, store, logger: ctx.logger })
  const task = store.add(makeTask({ time: '13:30' }))
  await store.save()

  // Tool calls reconcile immediately with a catalog snapshot from the previous tick,
  // which cannot contain the record just created. That must not spawn a second one.
  await engine.reconcile(task, Date.now())
  await engine.reconcile(task, Date.now())

  const weekly = [...ctx.schedule.rows.values()].filter(row => row.record.kind === 'weekly')
  assert.equal(weekly.length, 1, `expected exactly one weekly reminder, got ${weekly.length}`)
  assert.equal(store.get(task.id).nativeId, weekly[0].id)
  await rm(dir, { recursive: true, force: true })
})

test('adoption: a marked native record created by the client page joins the engine', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wds-'))
  const calendar = new HolidayCalendar({ dataDir: dir, seedPath })
  await calendar.whenReady()
  const store = new TaskStore({ dataDir: dir })
  await store.load()
  const schedule = scheduleNew()
  // Simulate the client page: it creates the record directly through the public API,
  // with the rule encoded as a title suffix, and never talks to the host plugin.
  await schedule.create({
    title: '晨会提醒 · 工作日',
    prompt: 'standup',
    timing: { kind: 'weekly', weekly: { time: '09:30:00', time_zone: 'Asia/Shanghai', weekdays: [1, 2, 3, 4, 5] } },
    target: { kind: 'session', sessionId: 'session-ui' },
  }, 'session-ui')

  const ctx = { schedule, logger: { warn() {}, log() {} } }
  const engine = new WorkdayEngine({ ctx, config, calendar, store, logger: ctx.logger })
  await engine.tick()

  assert.equal(store.tasks.length, 1, 'the marked record must be adopted')
  const adopted = store.tasks[0]
  assert.equal(adopted.title, '晨会提醒', 'the marker must be stripped from the task title')
  assert.equal(adopted.dayKind, 'workday')
  assert.equal(adopted.time, '09:30')
  assert.equal(adopted.sessionId, 'session-ui')
  assert.ok(typeof adopted.nativeId === 'string')
  await rm(dir, { recursive: true, force: true })
})

test('adoption: an unmarked record is left alone', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wds-'))
  const calendar = new HolidayCalendar({ dataDir: dir, seedPath })
  await calendar.whenReady()
  const store = new TaskStore({ dataDir: dir })
  await store.load()
  const schedule = scheduleNew()
  await schedule.create({
    title: '普通任务',
    prompt: 'p',
    timing: { kind: 'weekly', weekly: { time: '09:00:00', time_zone: 'Asia/Shanghai', weekdays: [1, 2, 3] } },
    target: { kind: 'session', sessionId: 'session-x' },
  }, 'session-x')

  const ctx = { schedule, logger: { warn() {}, log() {} } }
  const engine = new WorkdayEngine({ ctx, config, calendar, store, logger: ctx.logger })
  await engine.tick()
  assert.equal(store.tasks.length, 0, 'records without a marker are not ours')
  await rm(dir, { recursive: true, force: true })
})

test('deletion: a record deleted outside the plugin stops being managed', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wds-'))
  const calendar = new HolidayCalendar({ dataDir: dir, seedPath })
  await calendar.whenReady()
  const store = new TaskStore({ dataDir: dir })
  await store.load()
  const schedule = scheduleNew()
  const ctx = { schedule, logger: { warn() {}, log() {} } }
  const engine = new WorkdayEngine({ ctx, config, calendar, store, logger: ctx.logger })
  const task = store.add(makeTask({ time: '13:30' }))
  await store.save()
  await engine.tick()
  assert.equal(store.tasks.length, 1)

  // Delete the native record behind the engine's back.
  schedule.rows.delete(store.get(task.id).nativeId)
  await engine.tick()
  assert.equal(store.tasks.length, 0, 'the task must be dropped, not resurrected')
  await rm(dir, { recursive: true, force: true })
})

test('safety: a task paused on the automation page keeps its record', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wds-'))
  const calendar = new HolidayCalendar({ dataDir: dir, seedPath })
  await calendar.whenReady()
  const store = new TaskStore({ dataDir: dir })
  await store.load()
  const ctx = { schedule: scheduleNew(), logger: { warn() {}, log() {} } }
  const engine = new WorkdayEngine({ ctx, config, calendar, store, logger: ctx.logger })
  const task = store.add(makeTask())
  await store.save()
  await engine.tick()

  const nativeId = store.get(task.id).nativeId
  ctx.schedule.rows.get(nativeId).status = 'paused'
  await engine.tick()   // detected as a user pause -> task disabled
  await engine.tick()   // the disabled pass must not delete the record

  assert.equal(store.get(task.id)?.enabled, false)
  assert.ok(ctx.schedule.rows.has(nativeId), 'the paused record must survive')
  await rm(dir, { recursive: true, force: true })
})

test('restday-first: fires on the first day of the National Day break only', async () => {
  const { calendar, dir } = await harness()
  const rule = { dayKind: 'restday-first', weekdays: [6, 7], skipHolidays: true, runOnMakeupWorkdays: true, fallbackWhenUnknown: 'run' }
  // 10-01 Thursday opens the break and 09-30 was a working day.
  assert.equal(calendar.evaluate('2026-10-01', rule).allowed, true)
  // 10-02 sits inside the same break, so it is not a first rest day.
  assert.equal(calendar.evaluate('2026-10-02', rule).allowed, false)
  assert.equal(calendar.evaluate('2026-10-02', rule).reason, 'not-first-rest-day')
  assert.equal(calendar.evaluate('2026-10-05', rule).allowed, false)
  await rm(dir, { recursive: true, force: true })
})

test('restday-first: a weekend fires on Saturday only', async () => {
  const { calendar, dir } = await harness()
  const rule = { dayKind: 'restday-first', weekdays: [6, 7], skipHolidays: true, runOnMakeupWorkdays: true, fallbackWhenUnknown: 'run' }
  assert.equal(calendar.evaluate('2026-11-07', rule).allowed, true, 'Saturday after a worked Friday')
  assert.equal(calendar.evaluate('2026-11-08', rule).allowed, false, 'Sunday follows a rest day')
  await rm(dir, { recursive: true, force: true })
})

test('restday-first: a 调休 workday is skipped and the next day starts a new stretch', async () => {
  const { calendar, dir } = await harness()
  const rule = { dayKind: 'restday-first', weekdays: [6, 7], skipHolidays: true, runOnMakeupWorkdays: true, fallbackWhenUnknown: 'run' }
  // 2026-10-10 is a Saturday make-up workday: it is worked, so it cannot fire.
  assert.equal(calendar.evaluate('2026-10-10', rule).allowed, false)
  assert.equal(calendar.evaluate('2026-10-10', rule).reason, 'workday')
  // Sunday 10-11 follows that worked Saturday, so it opens the next rest stretch.
  assert.equal(calendar.evaluate('2026-10-11', rule).allowed, true)
  await rm(dir, { recursive: true, force: true })
})

test('restday-first: nextOccurrence lands on the break opener, not on every break day', async () => {
  const { calendar, dir } = await harness()
  const task = makeTask({ dayKind: 'restday-first', time: '10:00' })
  const hit = nextOccurrence(task, Date.parse('2026-09-30T12:00:00+08:00'), calendar, config)
  assert.ok(hit !== null)
  assert.equal(hit.date, '2026-10-01')
  const next = nextOccurrence(task, hit.at, calendar, config)
  assert.ok(next !== null)
  assert.ok(next.date > '2026-10-07', 'must skip the rest of the break, got ' + next.date)
  await rm(dir, { recursive: true, force: true })
})

test('retitle: switching 休息日 → 节假日第一天 updates the native title', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wds-'))
  const calendar = new HolidayCalendar({ dataDir: dir, seedPath })
  await calendar.whenReady()
  const store = new TaskStore({ dataDir: dir })
  await store.load()
  const ctx = { schedule: scheduleNew(), logger: { warn() {}, log() {} } }
  const engine = new WorkdayEngine({ ctx, config, calendar, store, logger: ctx.logger })
  const task = store.add(makeTask({ dayKind: 'restday', time: '10:00' }))
  await store.save()
  await engine.tick()

  const nativeId = store.get(task.id).nativeId
  const before = ctx.schedule.rows.get(nativeId).record
  assert.ok(before.title.endsWith(' · 休息日'), 'initial marker')

  // Same calendar shape, different rule: the title is the only carrier.
  store.update(task.id, { dayKind: 'restday-first' })
  await store.save()
  await engine.tick()

  const after = ctx.schedule.rows.get(nativeId).record
  assert.ok(after.title.endsWith(' · 节假日首日'), 'title must follow the rule, got ' + after.title)
  assert.equal(after.kind, 'weekly')
  assert.deepEqual(after.weekdays, [6, 7], 'the calendar shape is unchanged')
  await rm(dir, { recursive: true, force: true })
})

test('marker: a composable rule gets its own title suffix and is never adopted by title', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wds-'))
  const calendar = new HolidayCalendar({ dataDir: dir, seedPath })
  await calendar.whenReady()
  const store = new TaskStore({ dataDir: dir })
  await store.load()
  const schedule = scheduleNew()
  const ctx = { schedule, logger: { warn() {}, log() {} } }
  const engine = new WorkdayEngine({ ctx, config, calendar, store, logger: ctx.logger })
  const task = store.add(makeTask({
    title: '组合测试',
    time: '10:00',
    selectors: [{ dayType: 'workday', anchor: 'stretch', ordinals: [2, 3], every: 1 }],
  }))
  await store.save()
  await engine.tick()

  const native = ctx.schedule.rows.get(store.get(task.id).nativeId).record
  assert.ok(native.title.endsWith(' · 组合规则'), 'must not be labelled 工作日, got ' + native.title)

  // A record with that marker must not be adopted into a rule it never had.
  const adopted = WorkdayEngine.readMarker({ title: '某任务 · 组合规则' })
  assert.equal(adopted.dayKind, 'rule')
  await rm(dir, { recursive: true, force: true })
})

test('report: the delivered prompt is untouched when the flag is off', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wds-'))
  const calendar = new HolidayCalendar({ dataDir: dir, seedPath })
  await calendar.whenReady()
  const store = new TaskStore({ dataDir: dir })
  await store.load()
  const ctx = { schedule: scheduleNew(), logger: { warn() {}, log() {} } }
  const engine = new WorkdayEngine({ ctx, config, calendar, store, logger: ctx.logger })
  const prompt = '原始任务内容，一个字都不该变'
  const task = store.add(makeTask({ prompt }))
  await store.save()
  await engine.tick()

  const row = [...ctx.schedule.rows.values()][0]
  assert.equal(row.record.prompt ?? row.prompt, prompt, 'delivered prompt must be exactly the user text')
  assert.equal(store.get(task.id).reportAfterRun, undefined)
  await rm(dir, { recursive: true, force: true })
})

test('report: enabling the flag appends the report request only', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wds-'))
  const calendar = new HolidayCalendar({ dataDir: dir, seedPath })
  await calendar.whenReady()
  const store = new TaskStore({ dataDir: dir })
  await store.load()
  const ctx = { schedule: scheduleNew(), logger: { warn() {}, log() {} } }
  const engine = new WorkdayEngine({ ctx, config, calendar, store, logger: ctx.logger })
  const prompt = '我的任务内容'
  const task = store.add(makeTask({ prompt, reportAfterRun: true }))
  await store.save()
  await engine.tick()

  const delivered = [...ctx.schedule.rows.values()][0]
  const text = delivered.record.prompt ?? delivered.prompt
  assert.ok(text.startsWith(prompt), 'user text must stay first and unchanged')
  assert.match(text, /【完成后请记录结果】/)
  assert.match(text, /workday_task_report/)
  assert.equal(engine.preview(store.get(task.id)).reportAfterRun, true)
  await rm(dir, { recursive: true, force: true })
})

test('report tool: a task records its own run outcome', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wds-'))
  const calendar = new HolidayCalendar({ dataDir: dir, seedPath })
  await calendar.whenReady()
  const store = new TaskStore({ dataDir: dir })
  await store.load()
  const ctx = { schedule: scheduleNew(), logger: { warn() {}, log() {} } }
  const engine = new WorkdayEngine({ ctx, config, calendar, store, logger: ctx.logger })
  const task = store.add(makeTask())
  await store.save()
  await engine.tick()

  const stored = store.addReport(task.id, { at: '2026-11-07T02:00:05Z', status: 'partial', summary: '填了 4 天，周五缺权限' })
  assert.ok(stored && stored.id)
  assert.equal(store.get(task.id).reports.length, 1)
  assert.equal(store.get(task.id).reports[0].status, 'partial')
  assert.match(store.get(task.id).reports[0].summary, /周五缺权限/)

  // A repeat with the same identity must not duplicate the row.
  store.addReport(task.id, { id: stored.id, summary: '重试后的结果' })
  assert.equal(store.get(task.id).reports.length, 1)
  await rm(dir, { recursive: true, force: true })
})

test('report tool: an unknown task is rejected instead of silently dropped', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wds-'))
  const store = new TaskStore({ dataDir: dir })
  await store.load()
  assert.equal(store.addReport('nope', { summary: 'x' }), undefined)
  await rm(dir, { recursive: true, force: true })
})
