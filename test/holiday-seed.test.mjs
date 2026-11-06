/**
 * holiday-seed.test.mjs — 校验 src/seed-holidays.json 的真实日期判定
 *
 * 只依赖 node 内置 test runner：node --test test/holiday-seed.test.mjs
 * 不联网、不引入任何第三方依赖。
 *
 * 覆盖点：
 *   - 元信息（schema/source/日期区间）自洽
 *   - 结构不变量（扁平映射、升序、无重复、无假日×调休冲突、全部 YYYY-MM-DD）
 *   - 真实日期：2026 国庆、2026 调休补班日（周日上班）、2026 劳动节
 *   - 覆盖边界：2004-01-01 在内，2027-01-01 明确在外（「超范围」分支）
 *   - maxDate 与数据实际最大日期一致
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SEED_PATH = resolve(HERE, '..', 'src', 'seed-holidays.json');

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const raw = await readFile(SEED_PATH, 'utf8');
const seed = JSON.parse(raw);

const holidayDates = Object.keys(seed.holidays);
const makeupDates = seed.makeupWorkdays;

/** 0=周日 … 6=周六。日期是「中国时区语义的纯日期」，用 UTC 计算星期几最稳妥。 */
const weekdayOf = (date) => new Date(`${date}T00:00:00Z`).getUTCDay();

const allDates = [...holidayDates, ...makeupDates].sort();

test('元信息：schema / source / 区间字段齐备', () => {
  assert.equal(seed.schema, 1);
  // 版本会随上游发布推进（1.5.9 → 1.5.10 …），这里只校验来源形态，避免每次升级都要改测试。
  assert.match(seed.source, /^chinese-days@\d+\.\d+\.\d+$/);
  assert.match(seed.generatedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  assert.equal(seed.minDate, '2004-01-01');
});

test('结构：holidays 是「日期 → 中文节名」扁平对象，无嵌套无用字段', () => {
  assert.equal(typeof seed.holidays, 'object');
  assert.ok(!Array.isArray(seed.holidays));
  for (const [date, name] of Object.entries(seed.holidays)) {
    assert.match(date, DATE_RE, `非法日期键：${date}`);
    assert.equal(typeof name, 'string', `${date} 的节名不是字符串`);
    assert.ok(name.trim().length > 0, `${date} 的节名为空`);
    // 必须是中文名（name_cn 优先，兜底 name / "节假日"，上游均为中文）
    assert.match(name, /[\u4e00-\u9fa5]/, `${date} 的节名不是中文：${name}`);
  }
  assert.ok(holidayDates.length > 600, `假日条目过少：${holidayDates.length}`);
});

test('结构：makeupWorkdays 是升序字符串数组、无重复、日期合法', () => {
  assert.ok(Array.isArray(makeupDates));
  for (const d of makeupDates) assert.match(d, DATE_RE, `非法调休日期：${d}`);
  assert.deepEqual(makeupDates, [...makeupDates].sort(), '调休日未升序');
  assert.equal(new Set(makeupDates).size, makeupDates.length, '调休日有重复');
  assert.ok(makeupDates.length > 100, `调休日条目过少：${makeupDates.length}`);
});

test('结构：holidays 的键本身升序，且假日与调休日不重叠', () => {
  assert.deepEqual(holidayDates, [...holidayDates].sort(), 'holidays 键未升序');
  const overlap = makeupDates.filter((d) => d in seed.holidays);
  assert.deepEqual(overlap, [], '假日与调休上班日重叠');
});

test('真实日期：2026-10-01 是国庆节（法定节假日）', () => {
  assert.ok('2026-10-01' in seed.holidays, '2026-10-01 不在 holidays');
  assert.equal(seed.holidays['2026-10-01'], '国庆节');
});

test('真实日期：2026 国庆连休为 10-01..10-07，10-08 起为工作日', () => {
  for (const d of ['2026-10-02', '2026-10-03', '2026-10-04', '2026-10-05', '2026-10-06', '2026-10-07']) {
    assert.equal(seed.holidays[d], '国庆节', `${d} 应为国庆假期`);
  }
  assert.ok(!('2026-10-08' in seed.holidays), '2026-10-08 不应在 holidays');
  assert.ok(!('2026-10-09' in seed.holidays), '2026-10-09 不应在 holidays');
});

test('真实日期：2026-09-20 是调休补班日，且确实是周日上班', () => {
  assert.ok(makeupDates.includes('2026-09-20'), '2026-09-20 不在 makeupWorkdays');
  assert.equal(weekdayOf('2026-09-20'), 0, '2026-09-20 应为周日');
  // 补班日不是假日
  assert.ok(!('2026-09-20' in seed.holidays), '调休补班日不应同时是假日');
});

test('真实日期：2026-10-10（周六）也是国庆调休补班日', () => {
  assert.ok(makeupDates.includes('2026-10-10'), '2026-10-10 不在 makeupWorkdays');
  assert.equal(weekdayOf('2026-10-10'), 6, '2026-10-10 应为周六');
});

test('真实日期：2026-05-01 是劳动节，前后为五一假期', () => {
  assert.equal(seed.holidays['2026-05-01'], '劳动节', '2026-05-01 应为劳动节');
  // 核对该日前后：2026 劳动节为 05-01..05-05
  for (const d of ['2026-05-02', '2026-05-03', '2026-05-04', '2026-05-05']) {
    assert.equal(seed.holidays[d], '劳动节', `${d} 应为劳动节假期`);
  }
  // 节前最后一个工作日 2026-04-30 不是假日
  assert.ok(!('2026-04-30' in seed.holidays), '2026-04-30 不应是假日');
  // 2026-05-01 是周五
  assert.equal(weekdayOf('2026-05-01'), 5);
});

test('真实日期：2026 中秋为 09-25..09-27', () => {
  for (const d of ['2026-09-25', '2026-09-26', '2026-09-27']) {
    assert.equal(seed.holidays[d], '中秋', `${d} 应为中秋假期`);
  }
});

test('覆盖边界：2004-01-01 在范围内（元旦）', () => {
  assert.equal(seed.minDate, '2004-01-01');
  assert.ok('2004-01-01' in seed.holidays, '2004-01-01 不在 holidays');
  assert.equal(seed.holidays['2004-01-01'], '元旦');
  assert.ok('2004-01-01' >= seed.minDate && '2004-01-01' <= seed.maxDate);
});

test('覆盖边界：maxDate 之后第一天的日期不在覆盖范围内（触发「超范围」分支）', () => {
  // 上游每发布一次就多覆盖一年，所以这里不写死具体年份，而是从 maxDate 推出去。
  const beyond = new Date(Date.parse(`${seed.maxDate}T00:00:00Z`) + 86_400_000)
    .toISOString()
    .slice(0, 10);
  assert.ok(beyond > seed.maxDate);
  assert.ok(!(beyond in seed.holidays), `${beyond} 不应出现在 holidays`);
  assert.ok(!makeupDates.includes(beyond), `${beyond} 不应出现在 makeupWorkdays`);
  // 覆盖区间内最后一个日期之后的所有日期都算超范围
  assert.equal(allDates.at(-1), seed.maxDate);
  assert.ok(allDates.every((d) => d >= seed.minDate && d <= seed.maxDate));
});

test('区间自洽：minDate/maxDate 与数据实际最小/最大日期一致', () => {
  assert.equal(seed.minDate, allDates[0], 'minDate 应为全部日期的最小值');
  assert.equal(seed.maxDate, allDates.at(-1), 'maxDate 应为全部日期的最大值（含调休日）');

  // 假日自身的最大日期可能早于 maxDate（因为年末/假后补班日更晚），
  // 但必须落在区间内且不晚于 maxDate。
  // 假日自身的最大日期可能早于 maxDate（年末/假后补班日更晚），但必须落在区间内。
  const lastHoliday = holidayDates.at(-1);
  assert.ok(lastHoliday <= seed.maxDate, `holidays 最大日期 ${lastHoliday} 超出 maxDate`);
  assert.ok('2026-10-01' in seed.holidays, '应仍覆盖 2026 国庆');

  // 调休日同理
  assert.ok(makeupDates.at(-1) <= seed.maxDate);
  assert.equal(seed.maxDate, allDates.at(-1), 'maxDate 应等于并集最大日期');
  assert.ok(makeupDates.includes('2026-09-20'), '应仍覆盖 2026-09-20 这个调休周日');
});

test('文件体积受控（避免塞入无用字段）', () => {
  const bytes = Buffer.byteLength(raw, 'utf8');
  assert.ok(bytes < 64 * 1024, `seed 体积过大：${bytes}B`);
});

test('新鲜度：快照必须覆盖到未来，不能一发布就过期', () => {
  // 这是曾经踩过的坑：快照锁死在 1.5.9，覆盖到 2026-10-10，
  // 而当时今天已是 2026-11-06 —— 整个快照整段过期，离线时任何节假日都识别不了。
  const today = new Date().toISOString().slice(0, 10);
  assert.ok(
    seed.maxDate > today,
    `快照已过期：maxDate=${seed.maxDate} 不晚于今天 ${today}。请运行 node scripts/build-seed.mjs 重新生成。`,
  );
  // 至少还要有 90 天的前瞻覆盖，避免「明天就过期」。
  const horizon = new Date(Date.parse(`${today}T00:00:00Z`) + 90 * 86_400_000)
    .toISOString()
    .slice(0, 10);
  assert.ok(
    seed.maxDate >= horizon,
    `快照前瞻不足：maxDate=${seed.maxDate} 应至少覆盖到 ${horizon}`,
  );
});
