import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { HolidayCalendar } from '../src/holiday.js'
import { addDays } from '../src/time.js'
import { normalizeSelectors, evaluateSelectors, describeSelectors, baseWeekdaysForSelectors } from '../src/rule.js'

const seedPath = new URL('../src/seed-holidays.json', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')

async function harness() {
  const dir = await mkdtemp(join(tmpdir(), 'rule-'))
  const calendar = new HolidayCalendar({ dataDir: dir, seedPath })
  await calendar.whenReady()
  return { calendar, dir }
}

const check = (calendar, date, selectors) =>
  evaluateSelectors(date, normalizeSelectors(selectors), calendar, addDays).allowed

test('rule: first rest day of a break', async () => {
  const { calendar, dir } = await harness()
  const rule = [{ dayType: 'restday', anchor: 'stretch', ordinals: [1] }]
  assert.equal(check(calendar, '2026-10-01', rule), true, 'National Day opener')
  assert.equal(check(calendar, '2026-10-02', rule), false, 'inside the break')
  assert.equal(check(calendar, '2026-11-07', rule), true, 'Saturday after a worked Friday')
  assert.equal(check(calendar, '2026-11-08', rule), false, 'Sunday follows a rest day')
  await rm(dir, { recursive: true, force: true })
})

test('rule: last day of a break counts from the end', async () => {
  const { calendar, dir } = await harness()
  const rule = [{ dayType: 'restday', anchor: 'stretch', ordinals: [-1] }]
  assert.equal(check(calendar, '2026-10-07', rule), true, 'last day of National Day')
  assert.equal(check(calendar, '2026-10-01', rule), false)
  assert.equal(check(calendar, '2026-11-08', rule), true, 'Sunday ends the weekend')
  await rm(dir, { recursive: true, force: true })
})

test('rule: the 2nd and 3rd working day after a break, by stretch', async () => {
  const { calendar, dir } = await harness()
  const rule = [{ dayType: 'workday', anchor: 'stretch', ordinals: [2, 3] }]
  // 2026-10-08 is the first day back, so the 2nd and 3rd are 10-09 and 10-10.
  assert.equal(check(calendar, '2026-10-08', rule), false, 'first day back is excluded')
  assert.equal(check(calendar, '2026-10-09', rule), true)
  assert.equal(check(calendar, '2026-10-10', rule), true, 'make-up Saturday counts as a working day')
  assert.equal(check(calendar, '2026-10-11', rule), false, 'a rest day cannot match')
  await rm(dir, { recursive: true, force: true })
})

test('rule: the same ordinal by week means a weekday', async () => {
  const { calendar, dir } = await harness()
  const rule = [{ dayType: 'workday', anchor: 'week', ordinals: [2] }]
  assert.equal(check(calendar, '2026-11-10', rule), true, 'Tuesday is the 2nd working day')
  assert.equal(check(calendar, '2026-11-09', rule), false, 'Monday is the 1st')
  await rm(dir, { recursive: true, force: true })
})

test('rule: selectors combine as a union', async () => {
  const { calendar, dir } = await harness()
  const rule = [
    { dayType: 'workday', anchor: 'stretch', ordinals: [2, 3] },
    { dayType: 'restday', anchor: 'stretch', ordinals: [1] },
  ]
  assert.equal(check(calendar, '2026-10-09', rule), true, '2nd working day')
  assert.equal(check(calendar, '2026-11-07', rule), true, 'first rest day')
  assert.equal(check(calendar, '2026-11-08', rule), false, 'neither selector matches')
  await rm(dir, { recursive: true, force: true })
})

test('rule: last working day of the month', async () => {
  const { calendar, dir } = await harness()
  const rule = [{ dayType: 'workday', anchor: 'month', ordinals: [-1] }]
  assert.equal(check(calendar, '2026-11-30', rule), true, 'last Monday of November')
  assert.equal(check(calendar, '2026-11-27', rule), false)
  await rm(dir, { recursive: true, force: true })
})

test('rule: validation rejects unusable selectors', () => {
  assert.throws(() => normalizeSelectors([]), /non-empty/)
  assert.throws(() => normalizeSelectors([{ dayType: 'nope' }]), /dayType/)
  assert.throws(() => normalizeSelectors([{ dayType: 'workday', anchor: 'year' }]), /anchor/)
  assert.throws(() => normalizeSelectors([{ dayType: 'workday', ordinals: [0] }]), /ordinals/)
  assert.throws(() => normalizeSelectors([{ dayType: 'workday', every: 0 }]), /every/)
})

test('rule: base weekdays cover every selector', () => {
  assert.deepEqual(baseWeekdaysForSelectors(normalizeSelectors([{ dayType: 'workday' }])), [1, 2, 3, 4, 5])
  assert.deepEqual(baseWeekdaysForSelectors(normalizeSelectors([{ dayType: 'restday' }])), [6, 7])
  assert.deepEqual(
    baseWeekdaysForSelectors(normalizeSelectors([{ dayType: 'workday' }, { dayType: 'restday' }])),
    [1, 2, 3, 4, 5, 6, 7],
  )
})

test('rule: descriptions read as Chinese', () => {
  assert.equal(
    describeSelectors(normalizeSelectors([{ dayType: 'workday', anchor: 'stretch', ordinals: [2, 3] }])),
    '连续段第 2 个、第 3 个工作日',
  )
  assert.equal(
    describeSelectors(normalizeSelectors([{ dayType: 'restday', anchor: 'stretch', ordinals: [1] }])),
    '连续段第 1 个休息日',
  )
})
