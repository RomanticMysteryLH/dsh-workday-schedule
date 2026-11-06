import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { HolidayCalendar } from '../src/holiday.js'
import { buildPlan } from '../src/plan.js'

const seedPath = new URL('../src/seed-holidays.json', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')

const config = {
  weekdays: [1, 2, 3, 4, 5],
  skipHolidays: true,
  runOnMakeupWorkdays: true,
  fallbackWhenUnknown: 'run',
  timeZone: 'Asia/Shanghai',
}

async function harness() {
  const dir = await mkdtemp(join(tmpdir(), 'plan-'))
  const calendar = new HolidayCalendar({ dataDir: dir, seedPath })
  await calendar.whenReady()
  return { calendar, dir }
}

const workdayTask = {
  id: 'w1', title: '午间提醒', time: '13:30', dayKind: 'workday',
  weekdays: [1, 2, 3, 4, 5], skipHolidays: true, runOnMakeupWorkdays: true, enabled: true,
}

test('plan: classifies days and lists every trigger', async () => {
  const { calendar, dir } = await harness()
  const plan = buildPlan({
    from: '2026-09-28', days: 10, tasks: [workdayTask], calendar, config,
    nowMs: Date.parse('2026-09-27T00:00:00+08:00'),
  })
  assert.equal(plan.days.length, 10)
  const byDate = new Map(plan.days.map(day => [day.date, day]))

  // Monday 09-28 is an ordinary working day.
  assert.equal(byDate.get('2026-09-28').kind, 'workday')
  assert.equal(byDate.get('2026-09-28').triggers.length, 1)

  // 2026-10-01 is National Day: classified as a holiday and no trigger fires.
  const holiday = byDate.get('2026-10-01')
  assert.equal(holiday.kind, 'holiday')
  assert.equal(holiday.holidayName, '国庆节')
  assert.equal(holiday.triggers.length, 0)
  assert.equal(holiday.skipped.length, 1)
  assert.match(holiday.skipped[0].label, /国庆节/)

  // Saturday 10-03 falls inside the National Day break, so it is a holiday day too.
  assert.equal(byDate.get('2026-10-03').kind, 'holiday')
  assert.equal(byDate.get('2026-10-03').weekday, 6)
  // A weekend outside any break is a plain rest day.
  assert.equal(byDate.get('2026-10-04').kind, 'holiday')
  await rm(dir, { recursive: true, force: true })
})

test('plan: a 调休 make-up weekend day is marked and triggers a workday task', async () => {
  const { calendar, dir } = await harness()
  const plan = buildPlan({
    from: '2026-09-19', days: 3, tasks: [workdayTask], calendar, config,
    nowMs: Date.parse('2026-09-18T00:00:00+08:00'),
  })
  const makeup = plan.days.find(day => day.date === '2026-09-20')
  assert.equal(makeup.kind, 'makeup')
  assert.equal(makeup.triggers.length, 1, 'a make-up workday must run the workday task')
  await rm(dir, { recursive: true, force: true })
})

test('plan: statistics count real triggers and real exclusions', async () => {
  const { calendar, dir } = await harness()
  const plan = buildPlan({
    from: '2026-11-02', days: 7, tasks: [workdayTask], calendar, config,
    nowMs: Date.parse('2026-11-01T00:00:00+08:00'),
  })
  assert.equal(plan.stats.taskCount, 1)
  assert.equal(plan.stats.horizonTriggers, 5, 'Mon-Fri only')
  // No hypothetical "runs every day" baseline is reported any more.
  // A weekend is not 'skipped' — it is simply outside the configured weekdays, so it
  // is not counted as an exclusion.
  assert.equal(plan.stats.horizonSkipped, 0)
  assert.ok(plan.stats.nextRun !== null)
  assert.equal(plan.stats.nextRun.title, '午间提醒')
  await rm(dir, { recursive: true, force: true })
})

test('plan: a rest-day task is skipped on working days with a reason', async () => {
  const { calendar, dir } = await harness()
  const restTask = { ...workdayTask, id: 'w2', dayKind: 'restday' }
  const plan = buildPlan({
    from: '2026-11-09', days: 3, tasks: [restTask], calendar, config,
    nowMs: Date.parse('2026-11-08T00:00:00+08:00'),
  })
  const monday = plan.days[0]
  assert.equal(monday.triggers.length, 0)
  assert.equal(monday.skipped.length, 1)
  assert.equal(monday.skipped[0].reason, 'workday')
  await rm(dir, { recursive: true, force: true })
})

test('plan: the calendar block reports coverage so the page can warn', async () => {
  const { calendar, dir } = await harness()
  const plan = buildPlan({ from: '2026-11-01', days: 5, tasks: [], calendar, config, nowMs: Date.now() })
  assert.match(plan.calendar.min, /^\d{4}-\d{2}-\d{2}$/)
  assert.match(plan.calendar.max, /^\d{4}-\d{2}-\d{2}$/)
  assert.equal(plan.calendar.stale, false)
  assert.equal(plan.days[0].triggers.length, 0)
  await rm(dir, { recursive: true, force: true })
})

test('plan: tasks expose native record ids so the list can reuse the calendar colours', async () => {
  const { calendar, dir } = await harness()
  const task = {
    ...workdayTask,
    nativeId: 'schedule-primary',
    extras: [{ id: 'schedule-extra-1', date: '2026-10-10' }],
  }
  const plan = buildPlan({
    from: '2026-10-01', days: 20, tasks: [task], calendar, config,
    nowMs: Date.parse('2026-09-30T00:00:00+08:00'),
  })
  const exposed = plan.tasks.find(entry => entry.id === task.id)
  assert.ok(exposed, 'the task must appear in plan.tasks')
  assert.deepEqual(exposed.nativeIds, ['schedule-primary', 'schedule-extra-1'])
  await rm(dir, { recursive: true, force: true })
})

test('plan: a task without native records still appears with an empty list', async () => {
  const { calendar, dir } = await harness()
  const plan = buildPlan({
    from: '2026-11-02', days: 3, tasks: [{ ...workdayTask, nativeId: null, extras: [] }], calendar, config,
    nowMs: Date.parse('2026-11-01T00:00:00+08:00'),
  })
  assert.deepEqual(plan.tasks[0].nativeIds, [])
  await rm(dir, { recursive: true, force: true })
})
