#!/usr/bin/env node
/**
 * build-seed.mjs — 从 chinese-days 生成 src/seed-holidays.json（中国法定节假日 / 调休数据）
 *
 * 零依赖：只用 node 内置模块（node >= 22，全局 fetch 可用）。
 * 用法：node scripts/build-seed.mjs        （在插件根目录执行）
 *       node scripts/build-seed.mjs --check （只校验源可用、不写文件）
 *
 * 数据源（按顺序尝试，主源失败自动降级备源）：
 *   0. resolve the `latest` dist-tag, so the snapshot never ships stale
 *   1. https://registry.npmmirror.com/chinese-days/<resolved>/files/dist/chinese-days.json
 *   2. https://unpkg.com/chinese-days@<resolved>/dist/chinese-days.json
 *   （cdn.jsdelivr.net / raw.githubusercontent.com 在目标环境不可用，故意不列入）
 *
 * 上游原始格式（注意：不是对象，是「逗号分隔字符串」）：
 *   { "holidays":  { "2026-10-01": "National Day,国庆节,3" },
 *     "workdays":  { "2026-10-10": "National Day,国庆节,3" },   // 调休上班日
 *     "inLieuDays": { ... } }                                    // 补休，本 seed 不使用
 *   字段顺序为 [英文名, 中文名, 假期天数]；兼容旧版对象形态 { name, name_cn }。
 *
 * 输出 seed（{schema:1}）字段说明：
 *   schema         格式版本，当前 1
 *   source         数据源版本标识
 *   generatedAt    ISO 时间戳 —— 【唯一非确定性字段】
 *                  默认取本次运行时间；重复运行除该字段外结果完全一致（幂等）。
 *                  需要可复现构建时用：SEED_GENERATED_AT=2026-01-01T00:00:00.000Z node scripts/build-seed.mjs
 *   minDate/maxDate 数据覆盖区间（= holidays 与 makeupWorkdays 全部日期的并集最小/最大）
 *                  注意：区间右端可能落在「调休上班日」而非「假日」上，例如
 *                  holidays 最大日期 2026-10-07，而调休日最晚到 2026-10-10，
 *                  因此 maxDate 取 2026-10-10（覆盖到那一天为止的判定都可靠）。
 *   holidays        { "YYYY-MM-DD": "国庆节" } 扁平映射，节名优先 name_cn →
 *                   name → "节假日"；同一天多义时保留第一个非空中文名
 *   makeupWorkdays  "YYYY-MM-DD" 升序数组（调休上班日）
 *
 * 体积：约 22KB，只保留消费侧需要的字段，无英文名/天数/冗余结构。
 */

import { writeFile, readFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PACKAGE_NAME = 'chinese-days';
/** Version used when the registry cannot be reached; keep in step with a known release. */
const FALLBACK_VERSION = '1.5.10';
const VERSION_PROBES = [
  `https://registry.npmmirror.com/${PACKAGE_NAME}/latest`,
  `https://unpkg.com/${PACKAGE_NAME}@latest/package.json`,
];
/** @param {string} version Upstream package version. @returns {string[]} Data URLs, best first. */
function sourcesFor(version) {
  return [
    `https://registry.npmmirror.com/${PACKAGE_NAME}/${version}/files/dist/chinese-days.json`,
    `https://unpkg.com/${PACKAGE_NAME}@${version}/dist/chinese-days.json`,
  ];
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const FALLBACK_NAME = '节假日';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const OUT_FILE = resolve(ROOT, 'src', 'seed-holidays.json');

const CHECK_ONLY = process.argv.includes('--check');
const FETCH_TIMEOUT_MS = 20_000;

/** 取一个条目里的中文节名；兼容字符串与对象两种上游形态。 */
function pickName(entry) {
  if (entry == null) return '';
  if (typeof entry === 'string') {
    const parts = entry.split(',');
    // "English,中文,wage" —— 中文名固定在第 2 段
    const cn = (parts[1] ?? '').trim();
    if (cn) return cn;
    const en = (parts[0] ?? '').trim();
    return en || '';
  }
  if (typeof entry === 'object') {
    for (const key of ['name_cn', 'name', 'cnName', 'title']) {
      const v = entry[key];
      if (typeof v === 'string' && v.trim()) return v.trim();
    }
  }
  return '';
}

async function fetchJson(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      signal: ctrl.signal,
      headers: { accept: 'application/json' },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
    const text = await res.text();
    // 校验是 JSON 而不是镜像站的 HTML 错误页
    return JSON.parse(text);
  } finally {
    clearTimeout(timer);
  }
}

/** 基本校验：必须有 holidays / workdays 两个键，且条目数 > 100。 */
function validate(raw, url) {
  if (!raw || typeof raw !== 'object') throw new Error(`响应不是对象（${url}）`);
  const { holidays, workdays } = raw;
  if (!holidays || typeof holidays !== 'object') throw new Error('缺少 holidays 键');
  if (!workdays || typeof workdays !== 'object') throw new Error('缺少 workdays 键');
  const h = Object.keys(holidays).length;
  const w = Object.keys(workdays).length;
  if (h <= 100) throw new Error(`holidays 条目过少：${h}（应 > 100）`);
  if (w <= 100) throw new Error(`workdays 条目过少：${w}（应 > 100）`);
  return { h, w };
}

async function resolveVersion() {
  for (const probe of VERSION_PROBES) {
    try {
      const doc = await fetchJson(probe);
      const version = typeof doc?.version === 'string' ? doc.version : doc?.['dist-tags']?.latest;
      if (typeof version === 'string' && /^\d+\.\d+\.\d+/.test(version)) {
        process.stderr.write(`[build-seed] 解析上游版本：${version}
`);
        return version;
      }
    } catch {
      /* probe the next endpoint */
    }
  }
  process.stderr.write(`[build-seed] 版本解析失败，退回 ${FALLBACK_VERSION}
`);
  return FALLBACK_VERSION;
}

async function download() {
  const errors = [];
  const version = await resolveVersion();
  const SOURCES = sourcesFor(version);
  for (const url of SOURCES) {
    process.stderr.write(`[build-seed] 尝试数据源：${url}\n`);
    try {
      const raw = await fetchJson(url);
      const counts = validate(raw, url);
      process.stderr.write(
        `[build-seed] 命中：holidays=${counts.h} workdays=${counts.w}\n`,
      );
      return { raw, url, counts, version };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(`${url} -> ${msg}`);
      process.stderr.write(`[build-seed] 失败：${msg}\n`);
    }
  }
  throw new Error(`全部数据源均不可用：\n  - ${errors.join('\n  - ')}`);
}

/** 原始数据 → seed 对象（纯函数，便于幂等与测试）。 */
export function buildSeed(raw, { generatedAt, version } = {}) {
  const holidays = {};
  const makeup = new Set();

  const holidayKeys = Object.keys(raw.holidays ?? {});
  const workdayKeys = Object.keys(raw.workdays ?? {});

  for (const date of holidayKeys) {
    if (!DATE_RE.test(date)) throw new Error(`非法假日日期：${date}`);
    const name = pickName(raw.holidays[date]);
    // 同一天多义时保留第一个非空中文名；重复键在对象里本来只有一次，这里防御合并源
    if (!(date in holidays)) holidays[date] = name || FALLBACK_NAME;
    else if (!holidays[date]) holidays[date] = name || FALLBACK_NAME;
  }

  for (const date of workdayKeys) {
    if (!DATE_RE.test(date)) throw new Error(`非法调休日期：${date}`);
    makeup.add(date);
  }

  // 调休日若同时也是假日则冲突，直接报错（上游目前无重叠）
  const clash = [...makeup].filter((d) => d in holidays);
  if (clash.length) throw new Error(`假日与调休日重叠：${clash.slice(0, 5).join(',')}`);

  const sortedHolidays = {};
  for (const date of Object.keys(holidays).sort()) sortedHolidays[date] = holidays[date];

  const all = [...Object.keys(sortedHolidays), ...makeup].sort();
  if (all.length === 0) throw new Error('生成结果为空');

  return {
    schema: 1,
    source: `${PACKAGE_NAME}@${version ?? FALLBACK_VERSION}`,
    generatedAt: generatedAt ?? new Date().toISOString(),
    minDate: all[0],
    maxDate: all[all.length - 1],
    holidays: sortedHolidays,
    makeupWorkdays: [...makeup].sort(),
  };
}

/**
 * 稳定排版：顶层字段一行一个，holidays 一天一行，makeupWorkdays 单行数组。
 * 输出是合法 JSON（JSON.parse 可直接消费），同时保持 diff 友好、体积紧凑。
 */
export function serializeSeed(seed) {
  const head = [
    ['schema', seed.schema],
    ['source', seed.source],
    ['generatedAt', seed.generatedAt],
    ['minDate', seed.minDate],
    ['maxDate', seed.maxDate],
  ].map(([k, v]) => `  ${JSON.stringify(k)}: ${JSON.stringify(v)}`);

  const holidayLines = Object.entries(seed.holidays).map(
    ([d, n]) => `    ${JSON.stringify(d)}: ${JSON.stringify(n)}`,
  );

  const makeupLines = seed.makeupWorkdays.map((d) => JSON.stringify(d));

  const body = [
    '{',
    head.join(',\n') + ',',
    '  "holidays": {',
    holidayLines.join(',\n'),
    '  },',
    '  "makeupWorkdays": [',
    '    ' + makeupLines.join(',\n    '),
    '  ]',
    '}',
    '',
  ].join('\n');

  return body;
}

async function main() {
  const t0 = Date.now();
  let raw;
  let usedUrl;
  let counts;
  let version;
  try {
    ({ raw, url: usedUrl, counts, version } = await download());
  } catch (err) {
    process.stderr.write(`\n[build-seed] 错误：${err.message}\n`);
    process.exitCode = 1;
    return;
  }

  const generatedAt =
    process.env.SEED_GENERATED_AT?.trim() || new Date().toISOString();

  const seed = buildSeed(raw, { generatedAt, version });
  const text = serializeSeed(seed);
  // 自检：序列化结果必须能被 JSON.parse 且语义等价
  const roundTrip = JSON.parse(text);
  if (
    roundTrip.maxDate !== seed.maxDate ||
    Object.keys(roundTrip.holidays).length !== Object.keys(seed.holidays).length ||
    roundTrip.makeupWorkdays.length !== seed.makeupWorkdays.length
  ) {
    throw new Error('序列化自检失败（JSON 往返不一致）');
  }

  const bytes = Buffer.byteLength(text, 'utf8');

  let changed = false;
  if (!CHECK_ONLY) {
    await mkdir(dirname(OUT_FILE), { recursive: true });
    // 幂等性说明：除 generatedAt 外的字段逐字节稳定；这里额外报告「数据是否变化」
    try {
      const prev = JSON.parse(await readFile(OUT_FILE, 'utf8'));
      changed =
        JSON.stringify({ ...prev, generatedAt: null }) !==
        JSON.stringify({ ...seed, generatedAt: null });
    } catch {
      changed = true;
    }
    await writeFile(OUT_FILE, text, 'utf8');
  }

  const holidayCount = Object.keys(seed.holidays).length;
  const makeupCount = seed.makeupWorkdays.length;
  process.stdout.write(
    `[build-seed] holidays=${holidayCount} makeupWorkdays=${makeupCount} ` +
      `range=${seed.minDate}..${seed.maxDate} ` +
      `size=${(bytes / 1024).toFixed(1)}KB(${bytes}B) ` +
      `src=${counts.h}/${counts.w} cost=${Date.now() - t0}ms ` +
      `${CHECK_ONLY ? '(check only)' : `wrote src/seed-holidays.json${changed ? ' (数据有变化)' : ' (数据无变化)'}`}\n`,
  );
}

// 仅在被直接执行时跑 main（被 import 时不触发网络）
const isDirectRun =
  process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isDirectRun) {
  main().catch((err) => {
    process.stderr.write(`[build-seed] 未预期错误：${err?.stack ?? err}\n`);
    process.exitCode = 1;
  });
}
