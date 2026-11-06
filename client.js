/**
 * dsh-workday-schedule · 客户端 UI（任务列表 + 统计 + 月历 + 执行记录）
 *
 * 新增一个独立页面（不替换原生「自动化任务」页）：
 *   main 槽位 key = workday-schedules
 *   sidebar.panellist id = workday-schedules（label「工作日任务」，order 11）
 *
 * ── 数据来源（两条通道，各自独立降级）──────────────────────────────────────
 * 1) 规划数据：自挂载的 Remote `ctx.remote.workdaySchedule.plan({from, days})`
 *    → { workdays, 节假日、每天的 triggers/skipped、统计、数据覆盖范围 }
 *    月历、统计卡、执行记录的时间判定全部来自它。
 * 2) 任务 CRUD：原生 `ctx.remote.schedule.create / edit`（列表与编辑表单需要
 *    prompt / target / status 等 plan 里没有的字段）。
 *
 * ── 标题后缀契约（Host 据此识别节假日规则，逐字一致）────────────────────────
 *   工作日 → ' · 工作日'   休息日 → ' · 休息日'
 *
 * ── 集成 ──────────────────────────────────────────────────────────────────
 *   package.json 需声明 "exports" 的 "./client" 与 "dsh.client"（已由他人完成）。
 */

window.__ModuleLoader__.load({
  id: 'dsh-workday-schedule',
  factory(require) {
    var React = require('react')
    var h = React.createElement

    //#region Remote 契约（Host 侧已实现并测试通过）
    var SERVICE = 'workdaySchedule'
    var PACKAGE = 'dsh-workday-schedule'

    function codec(name) {
      return {
        mode: 'strict',
        typeSymbol: PACKAGE + '#' + name,
        create: function () { return { parse: function (v) { return v } } },
      }
    }

    var DESCRIPTORS = [{
      id: PACKAGE + '#' + SERVICE + '/plan',
      service: SERVICE,
      namespace: SERVICE,
      method: 'plan',
      invocation: { kind: 'direct' },
      result: codec('PlanResult'),
      parameters: [{ name: 'request', wire: 'request', source: 'json', codec: codec('PlanRequest') }],
    }]

    var WORKDAY_REMOTE = { package: PACKAGE, descriptors: DESCRIPTORS }
    //#endregion

    //#region 常量
    /** 本页在 main 槽位里的键；同时是侧边栏条目的 id，两处必须一致。 */
    var PANEL_KEY = 'workday-schedules'
    /** 侧边栏条目显示名。 */
    var PANEL_LABEL = '工作日任务'
    /** 侧边栏排序，排在原生「自动化任务」（order 10）之后。 */
    var PANEL_ORDER = 11
    /** 固定时区。 */
    var TIME_ZONE = 'Asia/Shanghai'
    /** 工作日标题后缀（契约）。 */
    var SUFFIX_WORKDAY = ' · 工作日'
    /** 休息日标题后缀（契约）。 */
    var SUFFIX_RESTDAY = ' · 休息日'
    /** 节假日第一天标题后缀（Host 识别契约）。 */
    var SUFFIX_RESTDAY_FIRST = ' · 节假日首日'
    /** 组合规则标题后缀（Host 写入，页面只用于识别）。 */
    var SUFFIX_RULE = ' · 组合规则'
    /** 工作日 = 周一至周五。 */
    var WORKDAYS = [1, 2, 3, 4, 5]
    /** 休息日 = 周六周日。 */
    var RESTDAYS = [6, 7]
    /** ISO 星期 → 中文数字。 */
    var WEEKDAY_NAMES = ['一', '二', '三', '四', '五', '六', '日']
    /** 标题长度上限。 */
    var MAX_TITLE = 120
    /** 月历取 42 天（6 行）覆盖整月视图。 */
    var GRID_DAYS = 42
    /** 每条原生记录取多少条投递历史。 */
    var HISTORY_LIMIT = 20
    /** 执行记录最多展示多少行。 */
    var HISTORY_ROW_LIMIT = 30
    /** 重复方式。 */
    var REPEAT_OPTIONS = [
      { value: 'once', label: '仅一次' },
      { value: 'daily', label: '每天' },
      { value: 'workday', label: '工作日' },
      { value: 'restday', label: '休息日' },
      { value: 'restday-first', label: '节假日第一天' },
      { value: 'rule', label: '组合规则（第几个工作日/休息日）' },
      { value: 'weekly', label: '每周' },
      { value: 'cron', label: '自定义' },
    ]
    /** 四种日期分类的中文名。 */
    var KIND_LABEL = {
      workday: '工作日',
      restday: '休息日',
      holiday: '法定节假日',
      makeup: '调休上班',
    }
    //#endregion

    //#region 主题色（半透明 / 继承色，浅深主题都成立）
    var C = {
      border: 'rgba(128,128,128,0.26)',
      borderStrong: 'rgba(128,128,128,0.45)',
      surface: 'rgba(128,128,128,0.07)',
      surfaceSoft: 'rgba(128,128,128,0.04)',
      accentBg: 'rgba(77,140,255,0.16)',
      accentBorder: 'rgba(77,140,255,0.55)',
      accentSolid: 'rgba(77,140,255,0.85)',
      dangerBg: 'rgba(255,96,96,0.14)',
      dangerBorder: 'rgba(255,96,96,0.5)',
      dangerSoft: 'rgba(255,96,96,0.10)',
      okBg: 'rgba(60,180,110,0.16)',
      okBorder: 'rgba(60,180,110,0.45)',
      warnBg: 'rgba(240,180,60,0.18)',
      warnBorder: 'rgba(240,180,60,0.45)',
      warnSoft: 'rgba(240,180,60,0.12)',
      restSoft: 'rgba(128,128,128,0.13)',
      workSoft: 'rgba(77,140,255,0.05)',
      // Calendar cell tints. The first version reused the faint surface colours above and
      // the four states were nearly indistinguishable on a dark theme, so these are
      // deliberately stronger and paired with an accent stripe.
      cellWork: 'rgba(77,140,255,0.10)',
      cellRest: 'rgba(150,158,176,0.20)',
      cellHoliday: 'rgba(255,92,92,0.26)',
      cellMakeup: 'rgba(255,176,48,0.26)',
      stripeHoliday: 'rgba(255,92,92,0.85)',
      stripeMakeup: 'rgba(255,176,48,0.90)',
      // Per-task dot colours: a fixed palette so a task keeps its colour across months.
      task: [
        'rgba(77,140,255,0.95)',
        'rgba(60,190,120,0.95)',
        'rgba(190,120,255,0.95)',
        'rgba(255,140,70,0.95)',
        'rgba(70,200,215,0.95)',
        'rgba(235,95,165,0.95)',
        'rgba(180,190,90,0.95)',
        'rgba(140,150,255,0.95)',
      ],
    }
    //#endregion

    //#region 样式
    var S = {
      page: {
        display: 'flex',
        flexDirection: 'column',
        gap: 16,
        width: '100%',
        // The main slot is a fixed-height panel that clips overflow, so the page itself
        // must own the scroll container or everything below the fold is unreachable.
        height: '100%',
        minHeight: 0,
        overflowY: 'auto',
        overflowX: 'hidden',
        boxSizing: 'border-box',
        padding: 16,
        color: 'inherit',
        background: 'transparent',
      },
      card: {
        border: '1px solid ' + C.border,
        borderRadius: 12,
        padding: 16,
        boxSizing: 'border-box',
        background: C.surfaceSoft,
        // Column flex children shrink by default, which would squash the calendar.
        flexShrink: 0,
      },
      topBar: {
        display: 'flex',
        flexWrap: 'wrap',
        alignItems: 'center',
        gap: 10,
        border: '1px solid ' + C.border,
        borderRadius: 12,
        padding: '12px 16px',
        background: C.surfaceSoft,
      },
      topBarMain: {
        flex: '1 1 220px',
        minWidth: 180,
      },
      title: {
        margin: 0,
        fontSize: 16,
        fontWeight: 600,
        lineHeight: 1.4,
      },
      subtitle: {
        fontSize: 12,
        opacity: 0.68,
        marginTop: 3,
        lineHeight: 1.5,
      },
      stale: {
        marginTop: 8,
        fontSize: 12,
        lineHeight: 1.5,
        border: '1px solid ' + C.warnBorder,
        background: C.warnBg,
        borderRadius: 8,
        padding: '6px 10px',
      },
      sectionHead: {
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        flexWrap: 'wrap',
        gap: 8,
        marginBottom: 10,
      },
      h3: {
        margin: 0,
        fontSize: 14,
        fontWeight: 600,
      },
      btn: {
        padding: '6px 12px',
        fontSize: 12.5,
        lineHeight: '18px',
        borderRadius: 8,
        border: '1px solid ' + C.border,
        background: 'transparent',
        color: 'inherit',
        font: 'inherit',
        cursor: 'pointer',
      },
      btnPrimary: {
        padding: '7px 14px',
        fontSize: 13,
        lineHeight: '18px',
        borderRadius: 8,
        border: '1px solid ' + C.accentBorder,
        background: C.accentBg,
        color: 'inherit',
        font: 'inherit',
        cursor: 'pointer',
      },
      btnDanger: {
        padding: '6px 12px',
        fontSize: 12.5,
        lineHeight: '18px',
        borderRadius: 8,
        border: '1px solid ' + C.dangerBorder,
        background: C.dangerBg,
        color: 'inherit',
        font: 'inherit',
        cursor: 'pointer',
      },
      btnOff: {
        opacity: 0.45,
        cursor: 'not-allowed',
      },
      // ── 统计卡 ──
      statRow: {
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))',
        gap: 12,
      },
      statCard: {
        border: '1px solid ' + C.border,
        borderRadius: 12,
        padding: '12px 14px',
        background: C.surfaceSoft,
        boxSizing: 'border-box',
        minWidth: 0,
      },
      statLabel: {
        fontSize: 12,
        opacity: 0.68,
        lineHeight: 1.4,
      },
      statValue: {
        fontSize: 20,
        fontWeight: 600,
        lineHeight: 1.35,
        marginTop: 4,
        fontVariantNumeric: 'tabular-nums',
        wordBreak: 'break-word',
      },
      statFoot: {
        fontSize: 11.5,
        opacity: 0.6,
        marginTop: 4,
        lineHeight: 1.45,
      },
      // ── 图例 ──
      legend: {
        display: 'flex',
        flexWrap: 'wrap',
        gap: 14,
        marginBottom: 10,
        fontSize: 12,
        opacity: 0.85,
      },
      legendItem: {
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
      },
      swatch: {
        width: 12,
        height: 12,
        borderRadius: 3,
        border: '1px solid ' + C.border,
        flex: 'none',
      },
      // ── 月历 ──
      calNav: {
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        flexWrap: 'wrap',
      },
      calMonth: {
        fontSize: 14,
        fontWeight: 600,
        minWidth: 110,
        textAlign: 'center',
        fontVariantNumeric: 'tabular-nums',
      },
      weekHeader: {
        display: 'grid',
        gridTemplateColumns: 'repeat(7, minmax(0, 1fr))',
        gap: 6,
        marginBottom: 6,
      },
      weekHeaderCell: {
        fontSize: 11.5,
        opacity: 0.6,
        textAlign: 'center',
        lineHeight: 1.6,
      },
      grid: {
        display: 'grid',
        gridTemplateColumns: 'repeat(7, minmax(0, 1fr))',
        gap: 6,
      },
      cell: {
        position: 'relative',
        minHeight: 76,
        border: '1px solid ' + C.border,
        borderRadius: 8,
        padding: '6px 7px',
        boxSizing: 'border-box',
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'space-between',
        gap: 4,
        cursor: 'pointer',
        color: 'inherit',
        font: 'inherit',
        textAlign: 'left',
        minWidth: 0,
        overflow: 'hidden',
      },
      cellOutMonth: {
        opacity: 0.42,
      },
      cellSelected: {
        border: '1px solid ' + C.accentBorder,
        boxShadow: 'inset 0 0 0 1px ' + C.accentBorder,
      },
      cellToday: {
        border: '2px solid ' + C.accentSolid,
      },
      cellTopRow: {
        display: 'flex',
        alignItems: 'flex-start',
        justifyContent: 'space-between',
        gap: 4,
        minWidth: 0,
      },
      dayNum: {
        fontSize: 12.5,
        fontWeight: 600,
        lineHeight: 1.3,
        fontVariantNumeric: 'tabular-nums',
        flex: 'none',
      },
      holidayTag: {
        fontSize: 10,
        lineHeight: '14px',
        borderRadius: 4,
        padding: '0 4px',
        background: 'rgba(255,96,96,0.20)',
        border: '1px solid ' + C.dangerBorder,
        maxWidth: '70%',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
        flex: '0 1 auto',
      },
      makeupTag: {
        fontSize: 10,
        lineHeight: '14px',
        borderRadius: 4,
        padding: '0 4px',
        background: C.warnBg,
        border: '1px solid ' + C.warnBorder,
        flex: 'none',
      },
      cellBottomRow: {
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 4,
        minHeight: 14,
        minWidth: 0,
      },
      dots: {
        display: 'flex',
        alignItems: 'center',
        gap: 3,
        minWidth: 0,
        overflow: 'hidden',
      },
      dot: {
        width: 8,
        height: 8,
        borderRadius: 999,
        background: C.accentSolid,
        flex: 'none',
        // A hairline ring keeps the dot readable on the holiday/makeup tints.
        boxShadow: '0 0 0 1px rgba(0,0,0,0.28)',
      },
      dotMore: {
        fontSize: 10,
        opacity: 0.72,
        lineHeight: '12px',
        whiteSpace: 'nowrap',
      },
      ruleRow: {
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        marginBottom: 6,
      },
      rulePreview: {
        marginTop: 10,
        padding: '8px 10px',
        borderRadius: 8,
        border: '1px solid ' + C.border,
        background: C.surface,
      },
      // ── 执行记录 ──
      historyRow: {
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '7px 2px',
        borderTop: '1px solid ' + C.border,
        fontSize: 12.5,
      },
      historyWhen: {
        flex: 'none',
        fontVariantNumeric: 'tabular-nums',
        opacity: 0.8,
        whiteSpace: 'nowrap',
      },
      historyTag: {
        flex: 'none',
        marginLeft: 'auto',
        padding: '1px 8px',
        borderRadius: 999,
        fontSize: 11,
        opacity: 0.95,
      },
      cellCount: {        fontSize: 10,
        opacity: 0.6,
        lineHeight: '12px',
        fontVariantNumeric: 'tabular-nums',
        flex: 'none',
      },
      // ── 当天详情 ──
      detailRow: {
        display: 'flex',
        alignItems: 'baseline',
        gap: 8,
        padding: '5px 0',
        borderBottom: '1px solid ' + C.surface,
        fontSize: 12.5,
        lineHeight: 1.5,
      },
      detailTime: {
        fontVariantNumeric: 'tabular-nums',
        opacity: 0.75,
        flex: 'none',
        minWidth: 42,
      },
      detailTitle: {
        flex: '1 1 auto',
        minWidth: 0,
        wordBreak: 'break-word',
      },
      detailTag: {
        flex: 'none',
        fontSize: 11,
        borderRadius: 999,
        padding: '0 7px',
        lineHeight: '17px',
        border: '1px solid ' + C.border,
      },
      // ── 任务列表 ──
      sectionToggle: {
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 8,
        width: '100%',
        background: 'transparent',
        border: 'none',
        color: 'inherit',
        font: 'inherit',
        padding: 0,
        cursor: 'pointer',
        textAlign: 'left',
      },
      row: {
        border: '1px solid ' + C.border,
        borderRadius: 10,
        padding: 12,
        marginBottom: 10,
        boxSizing: 'border-box',
      },
      rowMain: {
        display: 'block',
        width: '100%',
        textAlign: 'left',
        background: 'transparent',
        border: 'none',
        padding: 0,
        margin: 0,
        color: 'inherit',
        font: 'inherit',
        cursor: 'pointer',
      },
      rowTitle: {
        fontSize: 13.5,
        fontWeight: 600,
        lineHeight: 1.4,
        wordBreak: 'break-word',
      },
      rowRule: {
        fontSize: 12,
        opacity: 0.72,
        marginTop: 2,
        lineHeight: 1.5,
      },
      rowMeta: {
        fontSize: 11.5,
        opacity: 0.6,
        marginTop: 5,
      },
      rowActions: {
        display: 'flex',
        flexWrap: 'wrap',
        gap: 8,
        marginTop: 9,
      },
      badge: {
        display: 'inline-block',
        flex: 'none',
        fontSize: 11,
        lineHeight: '18px',
        padding: '0 8px',
        borderRadius: 999,
        border: '1px solid ' + C.border,
        whiteSpace: 'nowrap',
      },
      // ── 表单 ──
      field: {
        marginBottom: 14,
      },
      label: {
        display: 'block',
        fontSize: 12.5,
        fontWeight: 600,
        marginBottom: 6,
        lineHeight: 1.4,
      },
      required: {
        color: 'rgba(255,110,110,0.95)',
        marginLeft: 2,
      },
      input: {
        width: '100%',
        boxSizing: 'border-box',
        padding: '8px 10px',
        fontSize: 13,
        lineHeight: '20px',
        borderRadius: 8,
        border: '1px solid ' + C.border,
        background: 'transparent',
        color: 'inherit',
        font: 'inherit',
        outline: 'none',
      },
      select: {
        width: '100%',
        boxSizing: 'border-box',
        padding: '8px 10px',
        fontSize: 13,
        lineHeight: '20px',
        borderRadius: 8,
        border: '1px solid ' + C.border,
        // A native select paints its popup with the platform colours unless the control
        // declares a scheme, which is why the open list came out white on a dark page.
        background: 'transparent',
        color: 'inherit',
        font: 'inherit',
        outline: 'none',
        cursor: 'pointer',
      },
      textarea: {
        width: '100%',
        boxSizing: 'border-box',
        padding: '8px 10px',
        fontSize: 13,
        lineHeight: '20px',
        borderRadius: 8,
        border: '1px solid ' + C.border,
        background: 'transparent',
        color: 'inherit',
        font: 'inherit',
        outline: 'none',
        resize: 'vertical',
        minHeight: 92,
      },
      split: {
        display: 'flex',
        flexWrap: 'wrap',
        gap: 12,
      },
      splitItem: {
        flex: '1 1 160px',
        minWidth: 140,
        boxSizing: 'border-box',
      },
      pillRow: {
        display: 'flex',
        flexWrap: 'wrap',
        gap: 8,
      },
      pill: {
        padding: '4px 12px',
        fontSize: 12.5,
        lineHeight: '18px',
        borderRadius: 8,
        border: '1px solid ' + C.border,
        background: 'transparent',
        color: 'inherit',
        font: 'inherit',
        cursor: 'pointer',
      },
      pillOn: {
        padding: '4px 12px',
        fontSize: 12.5,
        lineHeight: '18px',
        borderRadius: 8,
        border: '1px solid ' + C.accentBorder,
        background: C.accentBg,
        color: 'inherit',
        font: 'inherit',
        cursor: 'pointer',
      },
      hint: {
        fontSize: 12,
        opacity: 0.68,
        marginTop: 4,
        lineHeight: 1.5,
      },
      error: {
        fontSize: 12.5,
        color: 'rgba(255,120,120,0.98)',
        background: C.dangerBg,
        border: '1px solid ' + C.dangerBorder,
        borderRadius: 8,
        padding: '8px 10px',
        marginBottom: 12,
        lineHeight: 1.5,
      },
      notice: {
        fontSize: 12.5,
        borderRadius: 8,
        padding: '8px 10px',
        marginBottom: 12,
        lineHeight: 1.5,
      },
      empty: {
        padding: '22px 12px',
        textAlign: 'center',
        fontSize: 12.5,
        opacity: 0.75,
        lineHeight: 1.7,
      },
      footer: {
        display: 'flex',
        flexWrap: 'wrap',
        gap: 10,
        alignItems: 'center',
        marginTop: 14,
      },
      loading: {
        padding: '18px 12px',
        textAlign: 'center',
        fontSize: 12.5,
        opacity: 0.7,
      },
      thin: {
        fontSize: 11.5,
        opacity: 0.55,
        lineHeight: 1.5,
        marginTop: 8,
      },
    }
    //#endregion

    //#region 纯工具

    function pad2(n) {
      return (n < 10 ? '0' : '') + n
    }

    /** 'HH:mm' → 'HH:mm:ss'；已带秒的保留。 */
    function toHms(value) {
      var raw = String(value === undefined || value === null ? '' : value).trim()
      var m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(raw)
      if (!m) return raw
      return pad2(Number(m[1])) + ':' + m[2] + ':' + (m[3] || '00')
    }

    /** 'HH:mm:ss.SSS' → 'HH:mm'。 */
    function formatClock(value) {
      var m = /^(\d{2}):(\d{2})/.exec(String(value || ''))
      return m ? m[1] + ':' + m[2] : String(value || '')
    }

    /** RFC3339 → Asia/Shanghai 的 'YYYY-MM-DD HH:mm'。 */
    function formatShanghai(iso) {
      if (!iso) return ''
      var d = new Date(iso)
      if (isNaN(d.getTime())) return String(iso)
      try {
        var parts = new Intl.DateTimeFormat('en-GB', {
          timeZone: TIME_ZONE,
          year: 'numeric',
          month: '2-digit',
          day: '2-digit',
          hour: '2-digit',
          minute: '2-digit',
          hour12: false,
        }).formatToParts(d)
        var map = {}
        for (var i = 0; i < parts.length; i += 1) map[parts[i].type] = parts[i].value
        var hour = map.hour === '24' ? '00' : map.hour
        return map.year + '-' + map.month + '-' + map.day + ' ' + hour + ':' + map.minute
      } catch (err) {
        return d.toISOString().slice(0, 16).replace('T', ' ')
      }
    }

    /** Asia/Shanghai 的今天 'YYYY-MM-DD'。 */
    function todayInShanghai() {
      var d = new Date()
      try {
        var parts = new Intl.DateTimeFormat('en-GB', {
          timeZone: TIME_ZONE,
          year: 'numeric',
          month: '2-digit',
          day: '2-digit',
        }).formatToParts(d)
        var map = {}
        for (var i = 0; i < parts.length; i += 1) map[parts[i].type] = parts[i].value
        return map.year + '-' + map.month + '-' + map.day
      } catch (err) {
        return d.toISOString().slice(0, 10)
      }
    }

    /** Date(UTC) → 'YYYY-MM-DD'。 */
    function isoOf(dateObj) {
      return dateObj.getUTCFullYear() + '-' + pad2(dateObj.getUTCMonth() + 1) + '-' + pad2(dateObj.getUTCDate())
    }

    /** 'YYYY-MM-DD' → Date(UTC 零点)。 */
    function parseIsoDate(text) {
      var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(text || ''))
      if (!m) return null
      return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])))
    }

    /** 'YYYY-MM-DD' 加 n 天。 */
    function addDaysIso(text, n) {
      var base = parseIsoDate(text)
      if (!base) return text
      return isoOf(new Date(base.getTime() + n * 86400000))
    }

    /** 'YYYY-MM-DD' 的 ISO 星期（1=周一 … 7=周日）。 */
    function isoWeekdayOf(text) {
      var base = parseIsoDate(text)
      if (!base) return 1
      var dow = base.getUTCDay()
      return dow === 0 ? 7 : dow
    }

    /** 某年某月（1-12）月历第一格：该月 1 号所在周的周一。 */
    function monthGridStart(year, month) {
      var first = new Date(Date.UTC(year, month - 1, 1))
      var back = isoWeekdayOf(isoOf(first)) - 1
      return isoOf(new Date(first.getTime() - back * 86400000))
    }

    /** 月份标题 'YYYY 年 M 月'。 */
    function monthTitle(year, month) {
      return year + ' 年 ' + month + ' 月'
    }

    /** 两个星期数组是否相同。 */
    function sameDays(a, b) {
      if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false
      for (var i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false
      return true
    }

    function weekdayName(day) {
      return WEEKDAY_NAMES[day - 1] || String(day)
    }

    function kindLabel(kind) {
      return KIND_LABEL[kind] || String(kind || '')
    }

    function isEndedStatus(status) {
      return status === 'ended' || status === 'inactive'
    }

    function statusLabel(status) {
      if (status === 'active') return '进行中'
      if (status === 'paused') return '已暂停'
      return '已结束'
    }

    function statusStyle(status) {
      if (status === 'active') return { background: C.okBg, borderColor: C.okBorder }
      if (status === 'paused') return { background: C.warnBg, borderColor: C.warnBorder }
      return { background: 'rgba(128,128,128,0.14)', borderColor: C.border }
    }

    /**
     * 本月已真实投递的次数。
     * @param {any[]} items 执行记录。
     * @param {string} monthPrefix `YYYY-MM`。
     * @returns {number}
     */
    function monthDoneCount(items, monthPrefix) {
      if (!monthPrefix || !Array.isArray(items)) return 0
      var count = 0
      for (var i = 0; i < items.length; i += 1) {
        var at = items[i] && items[i].deliveredAt
        if (typeof at === 'string' && at.slice(0, 7) === monthPrefix) count += 1
      }
      return count
    }

    /**
     * 弹出层选项的兜底配色。
     *
     * Chromium 按 `color-scheme` 绘制原生弹出层，已经够用；但部分环境仍会用默认浅色，
     * 这里再显式给一次前景/背景，保证深色主题下不出现白底黑字的跳色。
     * @returns {Object} React 内联样式。
     */
    function optionStyle() {
      var dark = detectColorScheme() === 'dark'
      return {
        background: dark ? '#1f1f22' : '#ffffff',
        color: dark ? '#e8e8ea' : '#1a1a1a',
      }
    }

    /**
     * 判断宿主当前是深色还是浅色主题。
     *
     * 原生 `<select>` 的弹出列表由浏览器绘制，不吃控件上的 CSS，只认 `color-scheme`。
     * 宿主没有声明它，所以弹出层默认按浅色渲染 —— 深色页面上就是一块白。这里按页面
     * 实际背景亮度判断，再给控件声明对应 scheme。
     * @returns {'dark'|'light'}
     */
    function detectColorScheme() {
      try {
        var probe = [document.body, document.documentElement]
        for (var i = 0; i < probe.length; i += 1) {
          var node = probe[i]
          if (!node) continue
          var bg = window.getComputedStyle(node).backgroundColor || ''
          var m = /rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/.exec(bg)
          if (!m) continue
          var alpha = /rgba\([^)]*,\s*([\d.]+)\s*\)/.exec(bg)
          if (alpha && Number(alpha[1]) < 0.5) continue
          var luminance = (Number(m[1]) * 0.299 + Number(m[2]) * 0.587 + Number(m[3]) * 0.114) / 255
          return luminance < 0.5 ? 'dark' : 'light'
        }
      } catch (err) { /* 取不到样式时退回系统偏好 */ }
      try {
        return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
      } catch (err) { return 'dark' }
    }

    /**
     * 计划时刻与实际投递时刻之差（秒）。
     * @param {string} scheduledAt ISO 时刻。
     * @param {string} deliveredAt ISO 时刻。
     * @returns {number|null} 延迟秒数；任一时刻无法解析时为 null。
     */
    function delaySeconds(scheduledAt, deliveredAt) {
      var planned = Date.parse(scheduledAt)
      var actual = Date.parse(deliveredAt)
      if (!isFinite(planned) || !isFinite(actual)) return null
      return Math.max(0, Math.round((actual - planned) / 1000))
    }

    /**
     * 执行记录的小结。
     * @param {any[]} items 记录。
     * @returns {{onTime: number, avgDelaySeconds: number|null}}
     */
    function historySummary(items) {
      var onTime = 0
      var total = 0
      var counted = 0
      for (var i = 0; i < items.length; i += 1) {
        var delay = delaySeconds(items[i].scheduledAt, items[i].deliveredAt)
        if (delay === null) continue
        counted += 1
        total += delay
        if (delay <= 60) onTime += 1
      }
      return { onTime: onTime, avgDelaySeconds: counted === 0 ? null : Math.round(total / counted) }
    }

    /** 日期格底色（按 kind 四分类）。 */
    function kindCellStyle(kind) {
      // Each state returns a complete `border` shorthand rather than `borderColor`: the
      // cell style sets `border` too, and mixing the two in inline styles leaves the result
      // up to how React expands the shorthand.
      if (kind === 'holiday') {
        return {
          background: C.cellHoliday,
          border: '1px solid rgba(255,92,92,0.55)',
          boxShadow: 'inset 3px 0 0 ' + C.stripeHoliday,
        }
      }
      if (kind === 'makeup') {
        return {
          background: C.cellMakeup,
          border: '1px solid rgba(255,176,48,0.55)',
          boxShadow: 'inset 3px 0 0 ' + C.stripeMakeup,
        }
      }
      if (kind === 'restday') return { background: C.cellRest }
      return { background: C.cellWork }
    }

    /**
     * 任务 → 颜色。按任务 id 稳定散列到固定调色板，保证同一个任务跨月同色。
     * @param {string} taskId 任务 id。
     * @returns {string} CSS 颜色。
     */
    function taskColor(taskId) {
      var text = String(taskId)
      var hash = 0
      for (var i = 0; i < text.length; i += 1) hash = (hash * 31 + text.charCodeAt(i)) % 100003
      return C.task[hash % C.task.length]
    }

    /** 图例色块。 */
    function kindSwatchStyle(kind) {
      var base = kindCellStyle(kind)
      return { background: base.background, border: '1px solid ' + C.borderStrong }
    }

    /** 由 catalog 条目生成规则文字。 */
    function describeRule(entry) {
      if (!entry || typeof entry !== 'object') return ''
      var clock = formatClock(entry.time)
      // The title suffix carries rules that share a calendar shape with another rule,
      // so it is read before the weekdays are interpreted.
      var titleText = typeof entry.title === 'string' ? entry.title : ''
      var firstRestDay = titleText.slice(-SUFFIX_RESTDAY_FIRST.length) === SUFFIX_RESTDAY_FIRST
      var isRuleTask = titleText.slice(-SUFFIX_RULE.length) === SUFFIX_RULE
      switch (entry.kind) {
        case 'at':
        case 'after':
          return '仅一次 ' + formatShanghai(entry.scheduledAt)
        case 'weekly': {
          var weekdays = Array.isArray(entry.weekdays)
            ? entry.weekdays.slice().sort(function (a, b) { return a - b })
            : []
          if (isRuleTask) return '组合规则 ' + clock
          if (firstRestDay) return '节假日第一天 ' + clock
          if (sameDays(weekdays, WORKDAYS)) return '工作日 ' + clock
          if (sameDays(weekdays, RESTDAYS)) return '休息日 ' + clock
          if (weekdays.length === 0) return '每周 ' + clock
          return '每周' + weekdays.map(weekdayName).join('、') + ' ' + clock
        }
        case 'daily':
          return '每天 ' + clock
        case 'cron':
          return '自定义：' + String(entry.expression || '')
        case 'every': {
          var seconds = Number(entry.everySeconds)
          if (!isFinite(seconds) || seconds <= 0) return '固定间隔'
          if (seconds % 3600 === 0) return '每 ' + (seconds / 3600) + ' 小时'
          if (seconds % 60 === 0) return '每 ' + (seconds / 60) + ' 分钟'
          return '每 ' + seconds + ' 秒'
        }
        case 'rrule':
          return '自定义：' + String(entry.rrule || '')
        default:
          return String(entry.kind || '')
      }
    }

    function sortEntries(list) {
      var copy = list.slice()
      copy.sort(function (a, b) {
        var ea = isEndedStatus(a.status) ? 1 : 0
        var eb = isEndedStatus(b.status) ? 1 : 0
        if (ea !== eb) return ea - eb
        var sa = String(a.scheduledAt || '')
        var sb = String(b.scheduledAt || '')
        if (sa === sb) return 0
        return sa < sb ? -1 : 1
      })
      return copy
    }

    function normalizeEntries(value) {
      if (Array.isArray(value)) return value
      if (value && Array.isArray(value.items)) return value.items
      if (value && typeof value === 'object' && value.kind) return [value]
      return []
    }

    /** RemoteResult → { ok, value } | { ok:false, message }。 */
    function unwrapRemote(result) {
      if (result && typeof result === 'object' && 'ok' in result) {
        if (result.ok) return { ok: true, value: result.value }
        return { ok: false, message: describeError(result.error) }
      }
      return { ok: true, value: result }
    }

    /** 错误 → 中文说明。 */
    function describeError(error) {
      if (!error) return '操作失败，请重试'
      if (typeof error === 'string') return error
      var code = error.code ? String(error.code) : ''
      var message = error.message ? String(error.message) : ''
      var table = {
        'schedule/input-invalid': '参数不合法，请检查时间与重复方式',
        invalid_prompt: '任务内容或名称为空',
        invalid_selector: '重复规则选择不合法',
        invalid_rule: '重复规则不合法',
        invalid_time_zone: '时区不合法',
        not_future: '执行时间必须晚于当前时间',
        time_out_of_range: '执行时间超出可表示范围',
        frequency_too_high: '重复频率过高',
        internal_error: '宿主内部错误',
        schedule_conflict: '任务已被其它地方修改，请刷新后重试',
        schedule_not_found: '任务已不存在',
        schedule_ended: '任务已结束，无法修改',
      }
      if (code && table[code]) return table[code]
      if (message) return message
      if (code) return code
      return '操作失败，请重试'
    }

    function describeEditMiss(value) {
      if (!value || typeof value !== 'object') return ''
      if (value.code) return describeError(value)
      if (value.updated === false) return '任务状态已变化，请刷新后重试'
      if (value.deleted === false) return '任务已不存在'
      return ''
    }

    function stripDaySuffix(title) {
      var text = String(title === undefined || title === null ? '' : title)
      if (text.slice(-SUFFIX_WORKDAY.length) === SUFFIX_WORKDAY) {
        return text.slice(0, text.length - SUFFIX_WORKDAY.length)
      }
      if (text.slice(-SUFFIX_RULE.length) === SUFFIX_RULE) {
        return text.slice(0, text.length - SUFFIX_RULE.length)
      }
      if (text.slice(-SUFFIX_RESTDAY_FIRST.length) === SUFFIX_RESTDAY_FIRST) {
        return text.slice(0, text.length - SUFFIX_RESTDAY_FIRST.length)
      }
      if (text.slice(-SUFFIX_RESTDAY.length) === SUFFIX_RESTDAY) {
        return text.slice(0, text.length - SUFFIX_RESTDAY.length)
      }
      return text
    }

    function applyDaySuffix(title, repeat) {
      var base = stripDaySuffix(String(title === undefined || title === null ? '' : title)).trim()
      if (repeat === 'workday') return base + SUFFIX_WORKDAY
      if (repeat === 'restday-first') return base + SUFFIX_RESTDAY_FIRST
    if (repeat === 'restday') return base + SUFFIX_RESTDAY
      return base
    }

    function repeatFromEntry(entry) {
      if (!entry || typeof entry !== 'object') return 'daily'
      if (entry.kind === 'weekly') {
        var weekdays = Array.isArray(entry.weekdays)
          ? entry.weekdays.slice().sort(function (a, b) { return a - b })
          : []
        // The title suffix decides first: 休息日 and 节假日第一天 share the same
        // weekdays [6,7], so the calendar shape alone cannot tell them apart.
        var title = typeof entry.title === 'string' ? entry.title : ''
        if (title.slice(-SUFFIX_RESTDAY_FIRST.length) === SUFFIX_RESTDAY_FIRST) return 'restday-first'
        if (sameDays(weekdays, WORKDAYS)) return 'workday'
        if (sameDays(weekdays, RESTDAYS)) return 'restday'
        return 'weekly'
      }
      if (entry.kind === 'daily') return 'daily'
      if (entry.kind === 'cron') return 'cron'
      if (entry.kind === 'at' || entry.kind === 'after') return 'once'
      return ''
    }

    function isValidClock(value) {
      return /^([01]\d|2[0-3]):[0-5]\d$/.test(String(value || '').trim())
    }

    function isValidDate(value) {
      var text = String(value || '').trim()
      var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text)
      if (!m) return false
      var y = Number(m[1])
      var mo = Number(m[2])
      var d = Number(m[3])
      if (mo < 1 || mo > 12 || d < 1 || d > 31) return false
      var date = new Date(Date.UTC(y, mo - 1, d))
      return date.getUTCFullYear() === y && date.getUTCMonth() === mo - 1 && date.getUTCDate() === d
    }

    function shortId(id) {
      var text = String(id || '')
      return text.length > 14 ? text.slice(0, 8) + '…' + text.slice(-4) : text
    }

    function assign(target) {
      for (var i = 1; i < arguments.length; i += 1) {
        var source = arguments[i]
        if (!source) continue
        for (var key in source) {
          if (Object.prototype.hasOwnProperty.call(source, key)) target[key] = source[key]
        }
      }
      return target
    }

    /** 倒计时文案。 */
    function countdownText(at) {
      var target = Number(at)
      if (!isFinite(target) || target <= 0) return ''
      var diff = target - Date.now()
      if (diff <= 0) return '即将执行'
      var mins = Math.floor(diff / 60000)
      if (mins < 1) return '不到 1 分钟后'
      if (mins < 60) return mins + ' 分钟后'
      var hours = Math.floor(mins / 60)
      if (hours < 24) return hours + ' 小时 ' + (mins % 60) + ' 分钟后'
      var days = Math.floor(hours / 24)
      return days + ' 天 ' + (hours % 24) + ' 小时后'
    }

    /** 把 plan 的某一天补全成稳定结构。 */
    function normalizeDay(day, date, weekday) {
      var base = day && typeof day === 'object' ? day : {}
      return {
        date: typeof base.date === 'string' && base.date ? base.date : date,
        weekday: typeof base.weekday === 'number' ? base.weekday : weekday,
        kind: typeof base.kind === 'string' && base.kind ? base.kind : 'workday',
        holidayName: typeof base.holidayName === 'string' && base.holidayName ? base.holidayName : null,
        known: base.known !== false,
        triggers: Array.isArray(base.triggers) ? base.triggers : [],
        skipped: Array.isArray(base.skipped) ? base.skipped : [],
      }
    }
    //#endregion

    //#region 服务解析（防御式）
    function resolveSchedule(ctx) {
      try {
        var direct = ctx && ctx.remote ? ctx.remote.schedule : null
        if (direct && typeof direct.catalog === 'function') return direct
      } catch (err) { /* ignore */ }
      try {
        if (ctx && typeof ctx.get === 'function') {
          var service = ctx.get('remote.schedule')
          if (service && typeof service.catalog === 'function') return service
        }
      } catch (err) { /* ignore */ }
      return null
    }

    function resolveSessionRemote(ctx) {
      try {
        var direct = ctx && ctx.remote ? ctx.remote.session : null
        if (direct && typeof direct.list === 'function') return direct
      } catch (err) { /* ignore */ }
      try {
        if (ctx && typeof ctx.get === 'function') {
          var service = ctx.get('remote.session')
          if (service && typeof service.list === 'function') return service
        }
      } catch (err) { /* ignore */ }
      return null
    }

    function resolveSessionsService(ctx) {
      try {
        if (ctx && ctx.sessions) return ctx.sessions
      } catch (err) { /* ignore */ }
      try {
        if (ctx && typeof ctx.get === 'function') return ctx.get('sessions')
      } catch (err) { /* ignore */ }
      return null
    }

    function currentSessionId(ctx, props) {
      try {
        if (props && typeof props.sessionId === 'string' && props.sessionId) return props.sessionId
      } catch (err) { /* ignore */ }
      try {
        if (ctx && ctx.session && typeof ctx.session.id === 'string') return ctx.session.id
      } catch (err) { /* ignore */ }
      try {
        if (ctx && typeof ctx.sessionId === 'string' && ctx.sessionId) return ctx.sessionId
      } catch (err) { /* ignore */ }
      return ''
    }

    function toSessionOption(raw) {
      if (!raw || typeof raw !== 'object') return null
      var id = raw.sessionId || raw.id
      if (!id) return null
      var title = ''
      if (typeof raw.title === 'string' && raw.title) {
        title = raw.title
      } else if (raw.projectionValues && typeof raw.projectionValues.title === 'string') {
        title = raw.projectionValues.title
      } else if (raw.projections && raw.projections.values && typeof raw.projections.values.title === 'string') {
        title = raw.projections.values.title
      }
      var label = title ? title : shortId(id)
      if (raw.origin === 'subagent') label += '（子代理）'
      return { id: String(id), label: label }
    }

    function loadSessionOptions(ctx) {
      var fromSnapshot = []
      try {
        var service = resolveSessionsService(ctx)
        if (service && service.list && typeof service.list.getSnapshot === 'function') {
          var snapshot = service.list.getSnapshot()
          if (snapshot && Array.isArray(snapshot.items)) {
            fromSnapshot = snapshot.items.map(toSessionOption).filter(Boolean)
          }
        }
      } catch (err) { /* ignore */ }
      if (fromSnapshot.length > 0) return Promise.resolve(fromSnapshot)
      var remote = resolveSessionRemote(ctx)
      if (!remote) return Promise.resolve([])
      return Promise.resolve()
        .then(function () { return remote.list({}) })
        .then(function (result) {
          var unwrapped = unwrapRemote(result)
          if (!unwrapped.ok) return []
          var value = unwrapped.value
          var items = value && Array.isArray(value.items) ? value.items : []
          return items.map(toSessionOption).filter(Boolean)
        })
        .catch(function () { return [] })
    }
    //#endregion

    //#region 表单模型
    function blankForm(defaultTarget) {
      return {
        title: '',
        prompt: '',
        target: defaultTarget || 'none',
        manualSessionId: '',
        time: '09:00',
        repeat: 'workday',
        date: todayInShanghai(),
        weekdays: WORKDAYS.slice(),
        cron: '30 13 * * 1-5',
        selectors: [{ dayType: 'workday', anchor: 'stretch', ordinals: '1', every: '1' }],
      }
    }

    function formFromEntry(entry, defaultTarget) {
      var form = blankForm(defaultTarget)
      if (!entry || typeof entry !== 'object') return form
      form.title = stripDaySuffix(entry.title || '')
      form.prompt = typeof entry.prompt === 'string' ? entry.prompt : ''
      form.time = formatClock(entry.time) || '09:00'
      form.repeat = repeatFromEntry(entry)
      if (entry.kind === 'at' || entry.kind === 'after') {
        var when = formatShanghai(entry.scheduledAt)
        if (/^\d{4}-\d{2}-\d{2} /.test(when)) {
          form.date = when.slice(0, 10)
          form.time = when.slice(11, 16)
        }
      }
      if (entry.kind === 'weekly' && Array.isArray(entry.weekdays)) {
        form.weekdays = entry.weekdays.slice().sort(function (a, b) { return a - b })
      }
      if (entry.kind === 'cron' && typeof entry.expression === 'string') {
        form.cron = entry.expression
      }
      var target = entry.target
      if (target && target.kind === 'session' && target.sessionId) {
        form.target = String(target.sessionId)
      } else {
        form.target = 'none'
      }
      return form
    }

    function buildTiming(form) {
      var time = toHms(form.time)
      switch (form.repeat) {
        case 'once':
          return { kind: 'at', at: { date: String(form.date || '').trim(), time: time, time_zone: TIME_ZONE } }
        case 'daily':
          return { kind: 'daily', daily: { time: time, time_zone: TIME_ZONE } }
        case 'workday':
          return { kind: 'weekly', weekly: { time: time, time_zone: TIME_ZONE, weekdays: WORKDAYS.slice() } }
        case 'restday':
          return { kind: 'weekly', weekly: { time: time, time_zone: TIME_ZONE, weekdays: RESTDAYS.slice() } }
        case 'restday-first':
          // Same native shape as 休息日; the rule itself lives in the title suffix and in
          // the host engine, which decides which of those days actually fires.
          return { kind: 'weekly', weekly: { time: time, time_zone: TIME_ZONE, weekdays: RESTDAYS.slice() } }
        case 'weekly': {
          var weekdays = (Array.isArray(form.weekdays) ? form.weekdays.slice() : [])
            .sort(function (a, b) { return a - b })
          return { kind: 'weekly', weekly: { time: time, time_zone: TIME_ZONE, weekdays: weekdays } }
        }
        case 'cron':
          return { kind: 'cron', cron: { expression: String(form.cron || '').trim(), time_zone: TIME_ZONE } }
        default:
          return null
      }
    }

    function resolveTargetSessionId(form) {
      if (form.target === 'manual') return String(form.manualSessionId || '').trim()
      if (form.target === 'none') return ''
      return String(form.target || '').trim()
    }

    function validateForm(form) {
      var baseTitle = String(form.title || '').trim()
      if (!baseTitle) return { error: '请填写任务名称' }
      var finalTitle = applyDaySuffix(baseTitle, form.repeat)
      if (finalTitle.length > MAX_TITLE) {
        return { error: '任务名称最多 ' + MAX_TITLE + ' 个字符（含自动追加的后缀共 ' + finalTitle.length + ' 个）' }
      }
      var prompt = String(form.prompt || '').trim()
      if (!prompt) return { error: '请填写任务内容（每次触发时发送的指令）' }
      if (!form.repeat) {
        return { error: '', title: finalTitle, prompt: prompt, timing: null, sessionId: resolveTargetSessionId(form) }
      }
      if (!isValidClock(form.time)) return { error: '时间格式应为 HH:mm，例如 09:30' }
      if (form.repeat === 'once' && !isValidDate(form.date)) return { error: '请选择「仅一次」的执行日期' }
      if (form.repeat === 'weekly') {
        var weekdays = Array.isArray(form.weekdays) ? form.weekdays : []
        if (weekdays.length === 0) return { error: '请至少选择一个星期几' }
      }
      if (form.repeat === 'cron') {
        var expression = String(form.cron || '').trim()
        if (!expression) return { error: '请填写 cron 表达式，例如 30 13 * * 1-5' }
        if (expression.split(/\s+/).length !== 5) return { error: 'cron 表达式需要 5 段：分 时 日 月 周' }
      }
      if (form.repeat === 'rule') {
        var selectors = selectorsFromForm()
        if (selectors === undefined) return { error: '请为每个条件填写序号，例如 2,3 或 -1' }
        // A composable rule is stored by the Host, so it travels as selectors rather than
        // as a native timing record.
        return {
          error: '',
          title: String(form.title || '').trim(),
          prompt: prompt,
          timing: null,
          selectors: selectors,
          sessionId: resolveTargetSessionId(form),
        }
      }
      var timing = buildTiming(form)
      if (!timing) return { error: '无法生成重复规则，请重新选择重复方式' }
      return { error: '', title: finalTitle, prompt: prompt, timing: timing, sessionId: resolveTargetSessionId(form) }
    }
    //#endregion

    //#region 页面组件
    function makePage(ctx, runtime) {
      return function WorkdayPage(props) {
        var viewState = React.useState(function () {
          var today = todayInShanghai()
          return { year: Number(today.slice(0, 4)), month: Number(today.slice(5, 7)) }
        })
        var view = viewState[0]
        var setView = viewState[1]

        var planState = React.useState(null)
        var plan = planState[0]
        var setPlan = planState[1]

        var planStatusState = React.useState('loading')
        var planStatus = planStatusState[0]
        var setPlanStatus = planStatusState[1]

        var planErrorState = React.useState('')
        var planError = planErrorState[0]
        var setPlanError = planErrorState[1]

        var selectedState = React.useState('')
        var selected = selectedState[0]
        var setSelected = selectedState[1]

        var tickState = React.useState(0)
        var setTick = tickState[1]

        var entriesState = React.useState([])
        var entries = entriesState[0]
        var setEntries = entriesState[1]

        var taskStatusState = React.useState('loading')
        var taskStatus = taskStatusState[0]
        var setTaskStatus = taskStatusState[1]

        var taskErrorState = React.useState('')
        var taskError = taskErrorState[0]
        var setTaskError = taskErrorState[1]

        var tasksOpenState = React.useState(false)
        var tasksOpen = tasksOpenState[0]
        var setTasksOpen = tasksOpenState[1]

        // 执行记录：来自宿主真实投递历史（计划时刻 vs 实际投递时刻），不是推算。
        var historyState = React.useState([])
        var historyItems = historyState[0]
        var setHistoryItems = historyState[1]

        var historyStatusState = React.useState('loading')
        var historyStatus = historyStatusState[0]
        var setHistoryStatus = historyStatusState[1]

        // 规则预览：调用 Host 计算真实触发日，null 表示当前不是组合规则模式。
        var rulePreviewState = React.useState(null)
        var rulePreview = rulePreviewState[0]
        var setRulePreview = rulePreviewState[1]

        var historyErrorState = React.useState('')
        var historyError = historyErrorState[0]
        var setHistoryError = historyErrorState[1]

        var modeState = React.useState('list')
        var mode = modeState[0]
        var setMode = modeState[1]

        var editingState = React.useState(null)
        var editing = editingState[0]
        var setEditing = editingState[1]

        var formState = React.useState(null)
        var form = formState[0]
        var setForm = formState[1]

        var formErrorState = React.useState('')
        var formError = formErrorState[0]
        var setFormError = formErrorState[1]

        var noticeState = React.useState(null)
        var notice = noticeState[0]
        var setNotice = noticeState[1]

        var busyIdState = React.useState('')
        var busyId = busyIdState[0]
        var setBusyId = busyIdState[1]

        var savingState = React.useState(false)
        var saving = savingState[0]
        var setSaving = savingState[1]

        var confirmIdState = React.useState('')
        var confirmId = confirmIdState[0]
        var setConfirmId = confirmIdState[1]

        var sessionsState = React.useState([])
        var sessions = sessionsState[0]
        var setSessions = sessionsState[1]

        var defaultTarget = currentSessionId(ctx, props)
        var today = todayInShanghai()

        /** 拉取规划数据（月历 / 统计的唯一来源）。 */
        var fetchPlan = React.useCallback(function (year, month) {
          var api = runtime.api
          if (!api || typeof api.plan !== 'function') {
            setPlanStatus('error')
            setPlanError(runtime.error || '规划接口不可用')
            return Promise.resolve()
          }
          var from = monthGridStart(year, month)
          setPlanStatus('loading')
          return Promise.resolve()
            .then(function () { return api.plan({ from: from, days: GRID_DAYS }) })
            .then(function (result) {
              var unwrapped = unwrapRemote(result)
              if (!unwrapped.ok) {
                setPlanStatus('error')
                setPlanError(unwrapped.message)
                return
              }
              setPlan(unwrapped.value || null)
              setPlanStatus('ready')
              setPlanError('')
            })
            .catch(function (err) {
              setPlanStatus('error')
              setPlanError(describeError(err))
            })
        }, [])

        /** 拉取任务列表（编辑表单需要 prompt / target / status）。 */
        var fetchTasks = React.useCallback(function () {
          var api = resolveSchedule(ctx)
          if (!api) {
            setTaskStatus('error')
            setTaskError('无法连接宿主的自动化任务接口')
            return Promise.resolve([])
          }
          return Promise.resolve()
            .then(function () { return api.catalog() })
            .then(function (result) {
              var unwrapped = unwrapRemote(result)
              if (!unwrapped.ok) {
                setTaskStatus('error')
                setTaskError(unwrapped.message)
                return
              }
              var normalized = sortEntries(normalizeEntries(unwrapped.value))
              setEntries(normalized)
              setTaskStatus('ready')
              setTaskError('')
              return normalized
            })
            .catch(function (err) {
              setTaskStatus('error')
              setTaskError(describeError(err))
              return []
            })
        }, [])

        /**
         * 拉取真实投递历史。
         *
         * 每个原生记录都保留自己的投递历史（计划时刻 + 实际投递时刻），所以这里对每条
         * 记录各取一页再合并。延迟、准时与否都由这两个时刻相减得到，不做任何推算。
         * @param {any[]} list catalog 条目。
         * @returns {Promise<void>}
         */
        var fetchHistory = React.useCallback(function (list) {
          var api = resolveSchedule(ctx)
          if (!api || typeof api.history !== 'function') {
            setHistoryStatus('error')
            setHistoryError('宿主的投递历史接口不可用')
            return Promise.resolve()
          }
          var targets = []
          for (var i = 0; i < list.length; i += 1) {
            var entry = list[i]
            var sessionId = entry && entry.target ? entry.target.sessionId : undefined
            if (typeof sessionId === 'string' && sessionId) {
              targets.push({ id: entry.id, sessionId: sessionId, title: entry.title, color: entry })
            }
          }
          if (targets.length === 0) {
            setHistoryItems([])
            setHistoryStatus('ready')
            return Promise.resolve()
          }
          setHistoryStatus('loading')
          return Promise.all(targets.map(function (target) {
            return Promise.resolve()
              .then(function () { return api.history({ id: target.id, sessionId: target.sessionId, limit: HISTORY_LIMIT }) })
              .then(function (result) {
                var unwrapped = unwrapRemote(result)
                if (!unwrapped.ok) return []
                var page = unwrapped.value
                if (!page || !Array.isArray(page.records)) return []
                return page.records.map(function (record) {
                  return {
                    id: target.id,
                    title: target.title,
                    scheduledAt: record.scheduledAt,
                    deliveredAt: record.deliveredAt,
                    messageId: record.messageId,
                  }
                })
              })
              .catch(function () { return [] })
          })).then(function (pages) {
            var merged = []
            for (var p = 0; p < pages.length; p += 1) {
              for (var r = 0; r < pages[p].length; r += 1) merged.push(pages[p][r])
            }
            merged.sort(function (a, b) {
              return String(b.deliveredAt || '').localeCompare(String(a.deliveredAt || ''))
            })
            setHistoryItems(merged.slice(0, HISTORY_ROW_LIMIT))
            setHistoryStatus('ready')
            setHistoryError('')
          }).catch(function (err) {
            setHistoryStatus('error')
            setHistoryError(describeError(err))
          })
        }, [])

        React.useEffect(function () {
          // Only a composable rule needs a preview; the simple modes are self-evident.
          if (!(form && form.repeat === 'rule')) {
            setRulePreview(null)
            return
          }
          var api = runtime.api
          if (!api || typeof api.previewRule !== 'function') {
            setRulePreview({ ok: false, error: '规划接口不可用，无法预览' })
            return
          }
          var selectors = selectorsFromForm()
          if (selectors === undefined) {
            setRulePreview({ ok: false, error: '请为每个条件填写序号，例如 2,3 或 -1' })
            return
          }
          var cancelled = false
          setRulePreview('loading')
          // A short delay keeps typing in the ordinals box from firing a request per key.
          var timer = setTimeout(function () {
            Promise.resolve()
              .then(function () { return api.previewRule({ selectors: selectors, time: form.time, count: 6 }) })
              .then(function (result) {
                if (cancelled) return
                var unwrapped = unwrapRemote(result)
                setRulePreview(unwrapped.ok ? unwrapped.value : { ok: false, error: unwrapped.message })
              })
              .catch(function (err) {
                if (!cancelled) setRulePreview({ ok: false, error: describeError(err) })
              })
          }, 250)
          return function () {
            cancelled = true
            clearTimeout(timer)
          }
        }, [form && form.repeat, form && form.time, form && JSON.stringify(form.selectors)])

        /** 写操作后：重新 plan 一次再重渲染，同时刷新任务列表与执行记录。 */
        var refreshAll = React.useCallback(function () {
          return Promise.all([
            fetchPlan(view.year, view.month),
            fetchTasks().then(function (list) { return fetchHistory(list) }),
          ])
        }, [fetchPlan, fetchTasks, fetchHistory, view.year, view.month])

        React.useEffect(function () {
          fetchTasks().then(function (list) { return fetchHistory(list) })
          loadSessionOptions(ctx).then(function (options) { setSessions(options) })
        }, [fetchTasks, fetchHistory])

        React.useEffect(function () {
          fetchPlan(view.year, view.month)
        }, [fetchPlan, view.year, view.month])

        // 统计卡里的倒计时每 30 秒走一格。
        React.useEffect(function () {
          var timer = setInterval(function () { setTick(function (v) { return v + 1 }) }, 30000)
          return function () { clearInterval(timer) }
        }, [])

        // 订阅宿主任务变化，避免暂停/补排后页面陈旧。
        React.useEffect(function () {
          var off = null
          try {
            var remote = ctx && ctx.remote ? ctx.remote : null
            if (remote && typeof remote.$on === 'function') {
              off = remote.$on('schedule/changed', function () { refreshAll() })
            }
          } catch (err) { /* 事件不可用时只能手动刷新 */ }
          return function () {
            try {
              if (typeof off === 'function') off()
            } catch (err) { /* ignore */ }
          }
        }, [refreshAll])

        //#region 交互
        function shiftMonth(delta) {
          var month = view.month + delta
          var year = view.year
          if (month < 1) { month = 12; year -= 1 }
          else if (month > 12) { month = 1; year += 1 }
          setView({ year: year, month: month })
          setSelected('')
        }

        function goToday() {
          setView({ year: Number(today.slice(0, 4)), month: Number(today.slice(5, 7)) })
          setSelected(today)
        }

        function selectDate(date) {
          setSelected(selected === date ? '' : date)
        }

        function openCreate() {
          setEditing(null)
          setForm(blankForm(defaultTarget || 'none'))
          setFormError('')
          setNotice(null)
          setMode('form')
          setTasksOpen(true)
        }

        function openEdit(entry) {
          setEditing(entry)
          var next = formFromEntry(entry, defaultTarget || 'none')
          // A task the Host owns carries a composable rule; backfill it so the editor can
          // show and modify the selectors instead of silently flattening them.
          var hostTask = findHostTask(entry)
          if (hostTask && Array.isArray(hostTask.selectors) && hostTask.selectors.length > 0) {
            next.repeat = 'rule'
            next.selectors = hostTask.selectors.map(function (selector) {
              return {
                dayType: selector.dayType === 'restday' ? 'restday' : 'workday',
                anchor: selector.anchor === 'week' ? 'week' : (selector.anchor === 'month' ? 'month' : 'stretch'),
                ordinals: (selector.ordinals || [1]).join(','),
                every: String(selector.every || 1),
              }
            })
            next.time = hostTask.time || next.time
          }
          setForm(next)
          setFormError('')
          setNotice(null)
          setConfirmId('')
          setMode('form')
          setTasksOpen(true)
        }

        /**
         * 原生记录 → Host 任务。
         *
         * 页面列表来自原生 catalog（id 形如 schedule-…），而组合规则存在 Host 侧
         * （id 形如 wds-…），两者靠 plan.tasks[].nativeIds 对上。找不到就当作新建。
         * @param {any} entry 原生条目。
         * @returns {any|null} Host 任务。
         */
        function findHostTask(entry) {
          if (!entry || !plan || !Array.isArray(plan.tasks)) return null
          for (var i = 0; i < plan.tasks.length; i += 1) {
            var ids = plan.tasks[i].nativeIds || []
            if (ids.indexOf(entry.id) >= 0) return plan.tasks[i]
          }
          return null
        }

        function closeForm() {
          setMode('list')
          setFormError('')
          setEditing(null)
        }

        function patchForm(patch) {
          setForm(function (prev) {
            var next = {}
            var key
            for (key in prev) if (Object.prototype.hasOwnProperty.call(prev, key)) next[key] = prev[key]
            for (key in patch) if (Object.prototype.hasOwnProperty.call(patch, key)) next[key] = patch[key]
            return next
          })
        }

        function toggleWeekday(day) {
          var current = Array.isArray(form.weekdays) ? form.weekdays.slice() : []
          var index = current.indexOf(day)
          if (index >= 0) current.splice(index, 1)
          else current.push(day)
          current.sort(function (a, b) { return a - b })
          patchForm({ weekdays: current })
        }

        function toggleActive(entry) {
          var api = resolveSchedule(ctx)
          if (!api || (busyId && busyId === entry.id)) return
          var nextActive = entry.status !== 'active'
          setBusyId(entry.id)
          setNotice(null)
          Promise.resolve()
            .then(function () {
              return api.edit({ id: entry.id, action: 'update', patch: { active: nextActive } })
            })
            .then(function (result) {
              var unwrapped = unwrapRemote(result)
              if (!unwrapped.ok) {
                setNotice({ tone: 'error', text: unwrapped.message })
              } else {
                var miss = describeEditMiss(unwrapped.value)
                setNotice({ tone: miss ? 'error' : 'info', text: miss || (nextActive ? '任务已启用' : '任务已暂停') })
              }
              return refreshAll()
            })
            .catch(function (err) { setNotice({ tone: 'error', text: describeError(err) }) })
            .then(function () { setBusyId('') })
        }

        function removeTask(entry) {
          var api = resolveSchedule(ctx)
          if (!api || (busyId && busyId === entry.id)) return
          setBusyId(entry.id)
          setNotice(null)
          Promise.resolve()
            .then(function () { return api.edit({ id: entry.id, action: 'delete' }) })
            .then(function (result) {
              var unwrapped = unwrapRemote(result)
              if (!unwrapped.ok) {
                setNotice({ tone: 'error', text: unwrapped.message })
              } else {
                var miss = describeEditMiss(unwrapped.value)
                setNotice({ tone: miss ? 'error' : 'info', text: miss || '任务已删除' })
              }
              setConfirmId('')
              if (editing && editing.id === entry.id) {
                setMode('list')
                setEditing(null)
              }
              return refreshAll()
            })
            .catch(function (err) { setNotice({ tone: 'error', text: describeError(err) }) })
            .then(function () { setBusyId('') })
        }

        function save() {
          if (saving) return
          var api = resolveSchedule(ctx)
          if (!api) {
            setFormError('无法连接宿主的自动化任务接口')
            return
          }
          var checked = validateForm(form)
          if (checked.error) {
            setFormError(checked.error)
            return
          }
          setSaving(true)
          setFormError('')
          setNotice(null)

          // A composable rule lives in the Host, not in a native timing record, so it
          // takes the task API instead of the Schedule one.
          if (checked.selectors !== undefined) {
            var host = runtime.api
            if (!host || typeof host.createTask !== 'function') {
              setSaving(false)
              setFormError('规划接口不可用，无法保存组合规则任务')
              return
            }
            var hostTask = editing ? findHostTask(editing) : null
            var payload = {
              title: checked.title,
              prompt: checked.prompt,
              time: form.time,
              sessionId: checked.sessionId,
              selectors: checked.selectors,
            }
            var action = hostTask
              ? Promise.resolve().then(function () { return host.updateTask({ id: hostTask.id, patch: payload }) })
              : Promise.resolve().then(function () { return host.createTask(payload) })
            action
              .then(function (result) {
                var unwrapped = unwrapRemote(result)
                if (!unwrapped.ok) {
                  setFormError(unwrapped.message)
                  return
                }
                if (unwrapped.value && unwrapped.value.ok === false) {
                  setFormError(String(unwrapped.value.error || '保存失败'))
                  return
                }
                setSaving(false)
                closeForm()
                setNotice({ tone: 'info', text: hostTask ? '任务已保存' : '任务已创建' })
                refreshAll()
              })
              .catch(function (err) {
                setSaving(false)
                setFormError(describeError(err))
              })
            return
          }

          var request
          if (editing) {
            request = { id: editing.id, action: 'update', patch: {} }
            request.patch.title = checked.title
            request.patch.prompt = checked.prompt
            if (checked.timing) request.patch.timing = checked.timing
            var storedTarget = editing.target || null
            var storedSessionId = storedTarget && storedTarget.kind === 'session'
              ? String(storedTarget.sessionId || '')
              : ''
            if (storedSessionId !== checked.sessionId) {
              request.patch.target = checked.sessionId
                ? { kind: 'session', sessionId: checked.sessionId }
                : { kind: 'new_once' }
            }
            if (editing.updatedAt) request.expectedUpdatedAt = editing.updatedAt
          } else {
            request = { title: checked.title, prompt: checked.prompt }
            if (checked.timing) request.timing = checked.timing
            if (checked.sessionId) request.target = { kind: 'session', sessionId: checked.sessionId }
          }

          var operation = editing
            ? Promise.resolve().then(function () { return api.edit(request) })
            : (typeof api.create === 'function'
              ? Promise.resolve().then(function () { return api.create(request) })
              : Promise.reject(new Error('当前宿主不支持从页面新建任务')))

          operation
            .then(function (result) {
              var unwrapped = unwrapRemote(result)
              if (!unwrapped.ok) {
                setFormError(unwrapped.message)
                return
              }
              var miss = describeEditMiss(unwrapped.value)
              if (miss) {
                setFormError(miss)
                return
              }
              setMode('list')
              setEditing(null)
              setNotice({ tone: 'info', text: editing ? '任务已保存' : '任务已创建' })
              return refreshAll()
            })
            .catch(function (err) { setFormError(describeError(err)) })
            .then(function () { setSaving(false) })
        }
        //#endregion

        //#region 数据派生
        /** plan.days 按日期建索引。 */
        function planIndex(source) {
          var map = {}
          if (source && Array.isArray(source.days)) {
            for (var i = 0; i < source.days.length; i += 1) {
              var day = source.days[i]
              if (day && typeof day.date === 'string') map[day.date] = day
            }
          }
          return map
        }

        /** 月历 42 格。 */
        function buildCells(source) {
          var from = source && typeof source.from === 'string' && source.from
            ? source.from
            : monthGridStart(view.year, view.month)
          var map = planIndex(source)
          var cells = []
          for (var i = 0; i < GRID_DAYS; i += 1) {
            var date = addDaysIso(from, i)
            var weekday = isoWeekdayOf(date)
            var raw = map[date]
            var day = normalizeDay(raw, date, weekday)
            cells.push({
              date: date,
              day: day,
              inMonth: Number(date.slice(5, 7)) === view.month && Number(date.slice(0, 4)) === view.year,
              missing: !raw,
            })
          }
          return cells
        }


        /** 统计字段的安全数字。 */
        function num(value) {
          var n = Number(value)
          return isFinite(n) ? n : 0
        }
        //#endregion

        //#region 渲染：顶部条
        function renderTopBar() {
          var calendar = plan && plan.calendar ? plan.calendar : null
          var rangeText = calendar && calendar.min && calendar.max
            ? '节假日数据 ' + calendar.min + ' ~ ' + calendar.max
            : '节假日数据范围未知'
          var children = [
            h(
              'div',
              { key: 'main', style: S.topBarMain },
              h('h2', { style: S.title }, PANEL_LABEL),
              h('div', { style: S.subtitle }, '这里管理按工作日 / 休息日执行的定时任务；其它任务仍在原生「自动化」页面。'),
              h('div', { style: S.subtitle }, rangeText),
              calendar && calendar.stale
                ? h('div', { style: S.stale }, '节假日数据已过期，日期判定按周几兜底')
                : null,
            ),
            h(
              'button',
              { key: 'refresh', type: 'button', style: S.btn, onClick: function () { refreshAll() } },
              '刷新',
            ),
            h(
              'button',
              { key: 'create', type: 'button', style: S.btnPrimary, onClick: openCreate },
              '新建任务',
            ),
          ]
          return h('div', { style: S.topBar }, children)
        }
        //#endregion
        //#region 渲染：执行记录
        /**
         * 执行记录：宿主真实投递历史，不是推算。
         *
         * 每一行是一次已经发生的投递：实际投递时刻，以及它与计划时刻的偏差。
         * 这比「未来时间线」更有用 —— 未来哪天跑不跑，在月历上点开某天就能看到。
         * @returns {any} 页面区块。
         */
        function renderHistory() {
          var summary = historySummary(historyItems)
          var head = h(
            'div',
            { style: S.sectionHead },
            h('h3', { style: S.h3 }, '执行记录（' + historyItems.length + '）'),
            historyItems.length > 0
              ? h('span', { style: S.hint },
                summary.onTime + '/' + historyItems.length + ' 准时'
                + (summary.avgDelaySeconds === null ? '' : ' · 平均延迟 ' + summary.avgDelaySeconds + 's'))
              : null,
          )

          var body
          if (historyStatus === 'loading' && historyItems.length === 0) {
            body = h('div', { style: S.loading }, '正在读取执行记录…')
          } else if (historyStatus === 'error' && historyItems.length === 0) {
            body = h('div', { style: S.empty }, historyError || '无法读取执行记录')
          } else if (historyItems.length === 0) {
            body = h('div', { style: S.empty }, '还没有执行过。任务触发一次后，这里会出现真实投递记录。')
          } else {
            var colorMap = nativeToTaskId()
            body = h('div', null, historyItems.map(function (item, index) {
              var delay = delaySeconds(item.scheduledAt, item.deliveredAt)
              var onTime = delay !== null && delay <= 60
              return h(
                'div',
                { key: item.messageId || (item.id + '-' + index), style: S.historyRow },
                h('span', {
                  style: assign({}, S.dot, {
                    background: entryColor({ id: item.id, title: item.title }, colorMap),
                    display: 'inline-block',
                    marginRight: 8,
                  }),
                }),
                h('span', { style: S.historyWhen }, formatShanghai(item.deliveredAt) || '—'),
                h('span', { style: S.detailTitle }, String(item.title || '（未命名任务）')),
                h('span', {
                  style: assign({}, S.historyTag, onTime
                    ? { border: '1px solid ' + C.okBorder, background: C.okBg }
                    : { border: '1px solid ' + C.warnBorder, background: C.warnBg }),
                }, onTime ? '准时' : (delay === null ? '时间未知' : '延迟 ' + delay + 's')),
              )
            }))
          }

          return h('div', { style: S.card }, head, body)
        }
        //#endregion


        //#region 渲染：统计
        function renderStats() {
          if (!plan || !plan.stats) {
            return h(
              'div',
              { style: S.statRow },
              [
                ['本月触发次数', '—', ''],
                ['本月已执行', '—', ''],
                ['下次执行', '—', ''],
                ['跳过 / 补排', '—', ''],
              ].map(function (item, index) {
                return h(
                  'div',
                  { key: index, style: S.statCard },
                  h('div', { style: S.statLabel }, item[0]),
                  h('div', { style: S.statValue }, item[1]),
                )
              }),
            )
          }
          var stats = plan.stats
          var nextRun = stats.nextRun || null
          var cards = []

          cards.push(h(
            'div',
            { key: 'c1', style: S.statCard },
            h('div', { style: S.statLabel }, '本月触发次数'),
            h('div', { style: S.statValue }, String(num(stats.monthTriggers))),
            h('div', { style: S.statFoot }, '共 ' + num(stats.taskCount) + ' 个任务' +
              (stats.monthPrefix ? '，统计月份起点 ' + stats.monthPrefix : '')),
          ))

          cards.push(h(
            'div',
            { key: 'c2', style: S.statCard },
            h('div', { style: S.statLabel }, '本月已执行'),
            h('div', { style: S.statValue }, String(num(monthDoneCount(historyItems, stats.monthPrefix)))),
            h('div', { style: S.statFoot }, '计划 ' + num(stats.monthTriggers) + ' 次'),
          ))

          cards.push(h(
            'div',
            { key: 'c3', style: S.statCard },
            h('div', { style: S.statLabel }, '下次执行'),
            h('div', { style: S.statValue }, nextRun && nextRun.local ? String(nextRun.local) : '暂无'),
            nextRun
              ? h('div', { style: S.statFoot },
                (nextRun.title ? String(nextRun.title) + ' · ' : '') + (countdownText(nextRun.at) || ''))
              : h('div', { style: S.statFoot }, '当前没有可执行的任务'),
          ))

          cards.push(h(
            'div',
            { key: 'c4', style: S.statCard },
            h('div', { style: S.statLabel }, '窗口内跳过 / 补排'),
            h('div', { style: S.statValue }, num(stats.horizonSkipped) + ' / ' + num(stats.horizonExtras)),
            h('div', { style: S.statFoot }, '窗口内共执行 ' + num(stats.horizonTriggers) + ' 次'),
          ))

          return h('div', { style: S.statRow }, cards)
        }
        //#endregion

        //#region 渲染：月历
        function renderLegend() {
          var kinds = ['workday', 'restday', 'holiday', 'makeup']
          return h(
            'div',
            { style: S.legend },
            kinds.map(function (kind) {
              return h(
                'span',
                { key: kind, style: S.legendItem },
                h('span', { style: assign({}, S.swatch, kindSwatchStyle(kind)) }),
                kindLabel(kind),
              )
            }),
          )
        }

        /**
         * 任务色点图例：让格子里的彩色点能对上具体任务。
         * @returns {any} 图例节点，没有任务时为 null。
         */
        function renderTaskColorLegend() {
          var tasks = (plan && plan.tasks) || []
          if (tasks.length === 0) return null
          return h(
            'div',
            { style: assign({}, S.legend, { marginTop: 8 }) },
            tasks.map(function (task) {
              return h(
                'span',
                { key: task.id, style: S.legendItem, title: task.title },
                h('span', { style: assign({}, S.swatch, { background: taskColor(task.id), borderRadius: 999, width: 8, height: 8 }) }),
                task.title,
              )
            }),
          )
        }

        function renderCell(cell) {
          var day = cell.day
          var triggers = day.triggers
          var isToday = cell.date === today
          var isSelected = cell.date === selected
          var style = assign({}, S.cell, kindCellStyle(day.kind))
          if (!cell.inMonth) style = assign(style, S.cellOutMonth)
          if (isToday) style = assign(style, S.cellToday)
          else if (isSelected) style = assign(style, S.cellSelected)

          var topRight = null
          if (day.kind === 'holiday' && day.holidayName) {
            topRight = h('span', { style: S.holidayTag, title: day.holidayName }, day.holidayName)
          } else if (day.kind === 'makeup') {
            topRight = h('span', { style: S.makeupTag }, '班')
          }

          var dots = []
          if (triggers.length > 0) {
            var shown = Math.min(triggers.length, 3)
            for (var i = 0; i < shown; i += 1) {
              dots.push(h('span', {
                key: 'd' + i,
                style: assign({}, S.dot, { background: taskColor(triggers[i].id) }),
                title: triggers[i].title + ' ' + triggers[i].time,
              }))
            }
            if (triggers.length > shown) {
              dots.push(h('span', { key: 'more', style: S.dotMore }, '+' + (triggers.length - shown)))
            }
          }

          return h(
            'button',
            {
              key: cell.date,
              type: 'button',
              style: style,
              onClick: function () { selectDate(cell.date) },
              title: cell.date + ' · ' + kindLabel(day.kind) +
                (day.holidayName ? ' ' + day.holidayName : '') +
                (triggers.length > 0 ? ' · ' + triggers.length + ' 个任务' : ''),
              'aria-pressed': isSelected,
            },
            h(
              'div',
              { style: S.cellTopRow },
              h('span', { style: S.dayNum }, String(Number(cell.date.slice(8, 10)))),
              topRight,
            ),
            h(
              'div',
              { style: S.cellBottomRow },
              h('span', { style: S.dots }, dots),
              triggers.length > 0 ? h('span', { style: S.cellCount }, '×' + triggers.length) : null,
            ),
          )
        }

        function renderCalendar() {
          if (planStatus === 'loading' && !plan) {
            return h('div', { style: S.card }, h('div', { style: S.loading }, '正在加载任务日历…'))
          }
          var cells = buildCells(plan)
          var weekHeaders = ['一', '二', '三', '四', '五', '六', '日'].map(function (name, index) {
            return h('div', { key: index, style: S.weekHeaderCell }, '周' + name)
          })
          return h(
            'div',
            { style: S.card },
            h(
              'div',
              { style: S.sectionHead },
              h('h3', { style: S.h3 }, '任务月历'),
              h(
                'div',
                { style: S.calNav },
                h('button', { type: 'button', style: S.btn, onClick: function () { shiftMonth(-1) } }, '上一月'),
                h('span', { style: S.calMonth }, monthTitle(view.year, view.month)),
                h('button', { type: 'button', style: S.btn, onClick: function () { shiftMonth(1) } }, '下一月'),
                h('button', { type: 'button', style: S.btn, onClick: goToday }, '回到今天'),
              ),
            ),
            renderLegend(),
            renderTaskColorLegend(),
            planError
              ? h('div', { style: S.error }, planError + '（月历按周几兜底显示）')
              : null,
            h('div', { style: S.weekHeader }, weekHeaders),
            h('div', { style: S.grid }, cells.map(renderCell)),
            h('div', { style: S.thin }, '点击某一天查看当天执行与被跳过的任务。'),
          )
        }
        //#endregion

        //#region 渲染：当天详情
        function renderDayDetail() {
          if (!selected) return null
          var cells = buildCells(plan)
          var found = null
          for (var i = 0; i < cells.length; i += 1) {
            if (cells[i].date === selected) { found = cells[i]; break }
          }
          if (!found) {
            return h(
              'div',
              { style: S.card },
              h('div', { style: S.sectionHead }, h('h3', { style: S.h3 }, selected)),
              h('div', { style: S.empty }, '该日期不在当前月历范围内。'),
            )
          }
          var day = found.day
          var rows = []
          var triggers = day.triggers.slice().sort(function (a, b) {
            return String(a.time || '') < String(b.time || '') ? -1 : 1
          })
          var skipped = day.skipped.slice().sort(function (a, b) {
            return String(a.time || '') < String(b.time || '') ? -1 : 1
          })
          for (var t = 0; t < triggers.length; t += 1) {
            rows.push(h(
              'div',
              { key: 't' + t, style: S.detailRow },
              h('span', { style: S.detailTime }, formatClock(triggers[t].time) || '—'),
              h('span', { style: S.detailTitle }, String(triggers[t].title || '（未命名任务）')),
              h('span', { style: assign({}, S.detailTag, { borderColor: C.okBorder, background: C.okBg }) }, '执行'),
            ))
          }
          for (var s = 0; s < skipped.length; s += 1) {
            rows.push(h(
              'div',
              { key: 's' + s, style: assign({}, S.detailRow, { opacity: 0.66 }) },
              h('span', { style: S.detailTime }, formatClock(skipped[s].time) || '—'),
              h('span', { style: S.detailTitle }, String(skipped[s].title || '（未命名任务）')),
              h('span', { style: assign({}, S.detailTag, { borderColor: C.border, background: 'transparent' }) },
                '跳过' + (skipped[s].label ? '：' + String(skipped[s].label) : '')),
            ))
          }

          return h(
            'div',
            { style: S.card },
            h(
              'div',
              { style: S.sectionHead },
              h('h3', { style: S.h3 },
                selected + ' 周' + weekdayName(day.weekday) + ' · ' + kindLabel(day.kind) +
                (day.holidayName ? ' ' + day.holidayName : '')),
              h('button', { type: 'button', style: S.btn, onClick: function () { setSelected('') } }, '收起'),
            ),
            !day.known ? h('div', { style: S.hint }, '该日期不在节假日数据覆盖范围内，判定按周几兜底。') : null,
            rows.length > 0 ? h('div', null, rows) : h('div', { style: S.empty }, '当天没有任务。'),
          )
        }
        //#endregion

        //#region 渲染：执行记录
        //#endregion

        //#region 渲染：任务列表与表单
        function renderBadge(entry) {
          var style = assign({}, S.badge, statusStyle(entry.status))
          return h('span', { style: style }, statusLabel(entry.status))
        }

        /**
         * 任务行 / 月历共用一套颜色：把原生记录 id 映射回插件任务 id。
         * 列表来自原生 catalog（id 形如 schedule-…），月历来自 plan（id 形如 wds-…），
         * 两者不是同一套 id，必须靠 plan.tasks[].nativeIds 搭桥。
         * @returns {Object<string, string>} 原生记录 id → 插件任务 id。
         */
        function nativeToTaskId() {
          var map = {}
          var tasks = (plan && plan.tasks) || []
          for (var i = 0; i < tasks.length; i += 1) {
            var ids = tasks[i].nativeIds || []
            for (var j = 0; j < ids.length; j += 1) map[ids[j]] = tasks[i].id
          }
          return map
        }

        /**
         * 一个原生任务的色点颜色。
         * 没有对应到 plan 任务时（例如不是本插件管理的任务）按标题取色，保证稳定。
         * @param {any} entry catalog 条目。
         * @param {Object<string, string>} map nativeToTaskId() 的结果。
         * @returns {string} CSS 颜色。
         */
        function entryColor(entry, map) {
          var taskId = map[entry.id]
          if (taskId !== undefined) return taskColor(taskId)
          return taskColor('title:' + (entry.title || ''))
        }

        function renderRow(entry, colorMap) {
          var ended = isEndedStatus(entry.status)
          var busy = busyId === entry.id
          var confirming = confirmId === entry.id
          return h(
            'div',
            { key: entry.id, style: S.row },
            h(
              'div',
              { style: { display: 'flex', alignItems: 'flex-start', gap: 10 } },
              h(
                'button',
                { type: 'button', style: S.rowMain, onClick: function () { openEdit(entry) }, title: '编辑任务' },
                h(
                  'div',
                  { style: S.rowTitle },
                  // The same dot the calendar draws on this task's days, so a row and its
                  // calendar marks are recognisably the same task.
                  h('span', {
                    style: assign({}, S.dot, {
                      background: entryColor(entry, colorMap),
                      display: 'inline-block',
                      marginRight: 6,
                      verticalAlign: 'middle',
                    }),
                  }),
                  entry.title || '（未命名任务）',
                ),
                h('div', { style: S.rowRule }, describeRule(entry)),
              ),
              renderBadge(entry),
            ),
            ended ? null : h('div', { style: S.rowMeta },
              '下次运行 ' + (formatShanghai(entry.scheduledAt) || '—')),
            h(
              'div',
              { style: S.rowActions },
              ended ? null : h(
                'button',
                {
                  type: 'button',
                  style: busy ? assign({}, S.btn, S.btnOff) : S.btn,
                  disabled: busy,
                  onClick: function () { toggleActive(entry) },
                },
                entry.status === 'active' ? '暂停' : '启用',
              ),
              h(
                'button',
                {
                  type: 'button',
                  style: busy ? assign({}, S.btnDanger, S.btnOff) : S.btnDanger,
                  disabled: busy,
                  onClick: function () {
                    if (confirming) removeTask(entry)
                    else setConfirmId(entry.id)
                  },
                },
                confirming ? '确认删除' : '删除',
              ),
              confirming ? h('button', {
                type: 'button',
                style: S.btn,
                onClick: function () { setConfirmId('') },
              }, '取消') : null,
            ),
          )
        }

        function renderInput(value, onChange, options) {
          var opts = options || {}
          if (opts.multiline) {
            return h('textarea', {
              style: S.textarea,
              value: value,
              placeholder: opts.placeholder || '',
              onChange: function (event) { onChange(event.target.value) },
            })
          }
          return h('input', {
            style: S.input,
            type: opts.type || 'text',
            value: value,
            placeholder: opts.placeholder || '',
            onChange: function (event) { onChange(event.target.value) },
          })
        }

        function renderField(labelText, control, options) {
          var opts = options || {}
          return h(
            'div',
            { style: opts.flex ? assign({}, S.field, S.splitItem) : S.field },
            h('label', { style: S.label }, labelText, opts.required ? h('span', { style: S.required }, '*') : null),
            control,
            opts.hint ? h('div', { style: S.hint }, opts.hint) : null,
          )
        }

        /**
         * 表单里的选择器（字符串字段）→ 提交用的整数结构。
         * @returns {Array|undefined} 规则数组；解析失败时 undefined。
         */
        function selectorsFromForm() {
          var rows = Array.isArray(form.selectors) ? form.selectors : []
          var out = []
          for (var i = 0; i < rows.length; i += 1) {
            var row = rows[i]
            var ordinals = String(row.ordinals == null ? '' : row.ordinals)
              .split(/[,，\s]+/)
              .filter(function (part) { return part !== '' })
              .map(Number)
              .filter(function (n) { return Number.isInteger(n) && n !== 0 })
            if (ordinals.length === 0) return undefined
            var every = Number(row.every)
            out.push({
              dayType: row.dayType === 'restday' ? 'restday' : 'workday',
              anchor: row.anchor === 'week' ? 'week' : (row.anchor === 'month' ? 'month' : 'stretch'),
              ordinals: ordinals,
              every: Number.isInteger(every) && every >= 1 && every <= 52 ? every : 1,
            })
          }
          return out.length > 0 ? out : undefined
        }

        /**
         * 改某一行的某个字段。
         * @param {number} index Row index.
         * @param {Object} patch Field patch.
         */
        function patchSelector(index, patch) {
          var rows = (Array.isArray(form.selectors) ? form.selectors : []).slice()
          rows[index] = assign({}, rows[index], patch)
          patchForm({ selectors: rows })
        }

        /** 规则编辑器：若干「哪类日子 + 按什么数 + 第几个」条件，加实时预览。 */
        function renderRuleEditor() {
          var rows = Array.isArray(form.selectors) ? form.selectors : []
          var dayTypeOptions = [
            { value: 'workday', label: '工作日' },
            { value: 'restday', label: '休息日' },
          ]
          var anchorOptions = [
            { value: 'stretch', label: '连续段内' },
            { value: 'week', label: '本周内' },
            { value: 'month', label: '本月内' },
          ]

          var list = rows.map(function (row, index) {
            return h(
              'div',
              { key: 'sel-' + index, style: S.ruleRow },
              h('select', {
                style: assign({}, S.select, { colorScheme: detectColorScheme(), flex: '0 0 96px' }),
                value: row.dayType,
                onChange: function (e) { patchSelector(index, { dayType: e.target.value }) },
              }, dayTypeOptions.map(function (o) {
                return h('option', { key: o.value, value: o.value, style: optionStyle() }, o.label)
              })),
              h('select', {
                style: assign({}, S.select, { colorScheme: detectColorScheme(), flex: '0 0 108px' }),
                value: row.anchor,
                onChange: function (e) { patchSelector(index, { anchor: e.target.value }) },
              }, anchorOptions.map(function (o) {
                return h('option', { key: o.value, value: o.value, style: optionStyle() }, o.label)
              })),
              h('input', {
                style: assign({}, S.input, { flex: '1 1 90px' }),
                value: row.ordinals,
                placeholder: '第几个，如 2,3 或 -1',
                onChange: function (e) { patchSelector(index, { ordinals: e.target.value }) },
              }),
              h('input', {
                style: assign({}, S.input, { flex: '0 0 78px' }),
                value: row.every,
                title: '每 N 个周期一次（仅「本周内」支持）',
                onChange: function (e) { patchSelector(index, { every: e.target.value }) },
              }),
              h('button', {
                type: 'button',
                style: S.btn,
                onClick: function () {
                  var next = rows.slice()
                  next.splice(index, 1)
                  patchForm({ selectors: next.length > 0 ? next : [rows[index]] })
                },
              }, '删'),
            )
          })

          return h(
            'div',
            { style: S.field },
            h('label', { style: S.label }, '规则条件', h('span', { style: S.required }, '*')),
            h('div', { style: S.hint }, '每个条件是「哪类日子 + 按什么数 + 第几个」，多个条件取并集。序号可用负数表示倒数（-1 = 最后一个）。'),
            list,
            h('div', { style: { marginTop: 8 } },
              h('button', {
                type: 'button',
                style: S.btn,
                onClick: function () {
                  patchForm({
                    selectors: rows.concat([{ dayType: 'workday', anchor: 'stretch', ordinals: '1', every: '1' }]),
                  })
                },
              }, '+ 添加条件')),
            renderRulePreview(),
          )
        }

        /** 规则预览：直接问 Host 接下来会在哪些日子触发。 */
        function renderRulePreview() {
          if (rulePreview === null) return null
          if (rulePreview === 'loading') return h('div', { style: S.hint }, '正在计算预览…')
          if (rulePreview.ok === false) return h('div', { style: S.error }, String(rulePreview.error || '规则无效'))
          return h(
            'div',
            { style: S.rulePreview },
            h('div', { style: S.hint }, '规则：' + rulePreview.ruleText),
            h('div', { style: S.hint },
              '接下来会在这几天触发：' + rulePreview.occurrences.map(function (o) { return o.local }).join('、')),
          )
        }

        function renderRepeatSelect() {
          var options = REPEAT_OPTIONS.slice()
          if (editing && !form.repeat) {
            options = [{ value: '', label: '保持原规则（当前规则无法在此编辑）' }].concat(options)
          }
          return h(
            'select',
            {
              style: assign({}, S.select, { colorScheme: detectColorScheme() }),
              value: form.repeat,
              onChange: function (event) { patchForm({ repeat: event.target.value }) },
            },
            options.map(function (option) {
              return h('option', {
                key: option.value,
                value: option.value,
                style: optionStyle(),
              }, option.label)
            }),
          )
        }

        function renderSuffixHint() {
          if (!form.repeat) return null
          if (form.repeat === 'rule') {
            return h('div', { style: S.hint }, '组合规则由宿主保存，不依赖标题后缀；标题保持你填的原样。')
          }
          var suffix = ''
          if (form.repeat === 'workday') suffix = SUFFIX_WORKDAY
          else if (form.repeat === 'restday') suffix = SUFFIX_RESTDAY
          else if (form.repeat === 'restday-first') suffix = SUFFIX_RESTDAY_FIRST
          if (!suffix) {
            return h('div', { style: S.hint }, '保存时会自动去掉标题里的「工作日 / 休息日」后缀。')
          }
          return h('div', { style: S.hint }, '保存时会自动追加后缀「' + suffix + '」，供宿主识别节假日规则。')
        }

        function renderTargetField() {
          var options = [{ value: 'none', label: '不指定（首次执行时新建会话）' }]
          var known = {}
          for (var i = 0; i < sessions.length; i += 1) {
            known[sessions[i].id] = true
            options.push({ value: sessions[i].id, label: sessions[i].label })
          }
          if (form.target && form.target !== 'none' && form.target !== 'manual' && !known[form.target]) {
            options.push({ value: form.target, label: shortId(form.target) })
          }
          options.push({ value: 'manual', label: '手动输入会话 ID…' })
          var parts = [
            h(
              'select',
              {
                key: 'select',
                style: assign({}, S.select, { colorScheme: detectColorScheme() }),
                value: form.target,
                onChange: function (event) { patchForm({ target: event.target.value }) },
              },
              options.map(function (option) {
                return h('option', {
                  key: option.value,
                  value: option.value,
                  style: optionStyle(),
                }, option.label)
              }),
            ),
          ]
          if (form.target === 'manual') {
            parts.push(h('div', { key: 'manual', style: { marginTop: 8 } },
              renderInput(form.manualSessionId, function (value) { patchForm({ manualSessionId: value }) },
                { placeholder: '粘贴会话 ID' })))
          }
          return h('div', null, parts)
        }

        function renderForm() {
          if (!form) return null
          var fields = []

          fields.push(h('div', { key: 'f-title' },
            renderField('任务名称', renderInput(form.title, function (value) { patchForm({ title: value }) },
              { placeholder: '例如：汇总今天的告警' }), { required: true })))
          fields.push(h('div', { key: 'f-suffix' }, renderSuffixHint()))
          fields.push(h('div', { key: 'f-prompt' },
            renderField('任务内容', renderInput(form.prompt, function (value) { patchForm({ prompt: value }) },
              { multiline: true, placeholder: '每次触发时发送给模型的指令' }), { required: true })))

          fields.push(h(
            'div',
            { key: 'f-repeat', style: S.split },
            renderField('重复方式', renderRepeatSelect(), { flex: true, required: true }),
            renderField(form.repeat === 'once' ? '时间' : '执行时间',
              renderInput(form.time, function (value) { patchForm({ time: value }) }, { placeholder: 'HH:mm' }),
              { flex: true, required: true, hint: '24 小时制，例如 09:30' }),
          ))

          if (form.repeat === 'once') {
            fields.push(h('div', { key: 'f-date' },
              renderField('执行日期',
                renderInput(form.date, function (value) { patchForm({ date: value }) }, { type: 'date' }),
                { required: true })))
          }

          if (form.repeat === 'workday' || form.repeat === 'restday') {
            fields.push(h('div', { key: 'f-summary' },
              h('div', { style: S.hint }, '规则：' + (form.repeat === 'workday'
                ? '每周一至周五 ' + form.time + '（自动跳过法定节假日，调休补班日照常执行）'
                : '每周六、周日 ' + form.time + '（自动跳过调休补班日）'))))
          }

          if (form.repeat === 'rule') {
            fields.push(h('div', { key: 'f-rule' }, renderRuleEditor()))
          }

          if (form.repeat === 'weekly') {
            fields.push(h(
              'div',
              { key: 'f-weekdays', style: S.field },
              h('label', { style: S.label }, '星期几', h('span', { style: S.required }, '*')),
              h('div', { style: S.pillRow }, [1, 2, 3, 4, 5, 6, 7].map(function (day) {
                var on = Array.isArray(form.weekdays) && form.weekdays.indexOf(day) >= 0
                return h('button', {
                  key: day,
                  type: 'button',
                  style: on ? S.pillOn : S.pill,
                  onClick: function () { toggleWeekday(day) },
                }, '周' + weekdayName(day))
              })),
            ))
          }

          if (form.repeat === 'cron') {
            fields.push(h('div', { key: 'f-cron' },
              renderField('cron 表达式',
                renderInput(form.cron, function (value) { patchForm({ cron: value }) }, { placeholder: '30 13 * * 1-5' }),
                { required: true, hint: '5 段：分 时 日 月 周，按 Asia/Shanghai 解释' })))
          }

          fields.push(h('div', { key: 'f-target' },
            renderField('执行位置', renderTargetField(), {
              hint: sessions.length > 0 ? '' : '暂时拿不到会话列表，可手动粘贴会话 ID',
            })))

          return h(
            'div',
            { style: S.card },
            h(
              'div',
              { style: S.sectionHead },
              h('h3', { style: S.h3 }, editing ? '编辑任务' : '新建任务'),
              h('button', { type: 'button', style: S.btn, onClick: closeForm }, '关闭'),
            ),
            formError ? h('div', { style: S.error }, formError) : null,
            fields,
            h(
              'div',
              { style: S.footer },
              h('button', {
                type: 'button',
                style: saving ? assign({}, S.btnPrimary, S.btnOff) : S.btnPrimary,
                disabled: saving,
                onClick: save,
              }, saving ? '正在保存…' : (editing ? '保存修改' : '创建任务')),
              editing ? h('button', {
                type: 'button',
                style: (busyId === editing.id) ? assign({}, S.btnDanger, S.btnOff) : S.btnDanger,
                disabled: busyId === editing.id,
                onClick: function () {
                  if (confirmId === editing.id) removeTask(editing)
                  else setConfirmId(editing.id)
                },
              }, confirmId === editing.id ? '确认删除任务' : '删除任务') : null,
              confirmId && editing && confirmId === editing.id
                ? h('span', { style: S.hint }, '再次点击「确认删除任务」将从宿主移除该任务。')
                : null,
            ),
          )
        }

        function renderTaskSection() {
          // The list leads the page and stays open; only a long list is capped, because
          // hiding the tasks the user came for behind a toggle was the wrong default.
          var LIMIT = 8
          var overLimit = entries.length > LIMIT
          var visible = overLimit && !tasksOpen ? entries.slice(0, LIMIT) : entries

          var header = h(
            'div',
            { style: S.sectionHead },
            h('span', { style: S.h3 }, '任务列表（' + entries.length + '）'),
            overLimit
              ? h('button', {
                type: 'button',
                style: S.btn,
                onClick: function () { setTasksOpen(!tasksOpen) },
              }, tasksOpen ? '只看前 ' + LIMIT + ' 个' : '显示全部 ' + entries.length + ' 个')
              : null,
          )

          var body
          if (taskStatus === 'loading' && entries.length === 0) {
            body = h('div', { style: S.loading }, '正在加载任务…')
          } else if (taskStatus === 'error' && entries.length === 0) {
            body = h('div', { style: S.empty },
              h('div', null, taskError || '无法加载任务'),
              h('div', { style: { marginTop: 10 } },
                h('button', { type: 'button', style: S.btn, onClick: function () { fetchTasks() } }, '重试')))
          } else if (entries.length === 0) {
            body = h('div', { style: S.empty },
              h('div', null, '还没有任何工作日 / 休息日任务'),
              h('div', { style: { marginTop: 10 } },
                h('button', { type: 'button', style: S.btnPrimary, onClick: openCreate }, '新建任务')))
          } else {
            var colorMap = nativeToTaskId()
            body = h('div', null, visible.map(function (entry) { return renderRow(entry, colorMap) }))
          }

          return h('div', { style: S.card }, header, body)
        }
        //#endregion

        var noticeStyle = notice
          ? assign({}, S.notice, notice.tone === 'error'
            ? { border: '1px solid ' + C.dangerBorder, background: C.dangerBg }
            : { border: '1px solid ' + C.okBorder, background: C.okBg })
          : null

        return h(
          'div',
          { style: S.page },
          renderTopBar(),
          notice ? h('div', { style: noticeStyle }, notice.text) : null,
          mode === 'form' ? renderForm() : null,
          // Tasks lead: they are what the user opens this page for.
          renderTaskSection(),
          renderStats(),
          renderCalendar(),
          renderDayDetail(),
          renderHistory(),
        )
      }
    }
    //#endregion

    //#region 侧边栏图标
    function WorkdayIcon() {
      return h(
        'svg',
        {
          viewBox: '0 0 24 24',
          width: 20,
          height: 20,
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.7,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': 'true',
          focusable: 'false',
          style: { display: 'block' },
        },
        h('rect', { x: 3, y: 5, width: 18, height: 16, rx: 3 }),
        h('path', { d: 'M3 10h18' }),
        h('path', { d: 'M8 3v4' }),
        h('path', { d: 'M16 3v4' }),
        h('path', { d: 'M9 15.5l2 2 4-4' }),
      )
    }
    //#endregion

    //#region 插件导出
    var inject = ['slots', 'remote']

    /** 解析挂载后的命名空间服务。 */
    function resolvePlanApi(ctx) {
      try {
        var direct = ctx && ctx.remote ? ctx.remote[SERVICE] : null
        if (direct && typeof direct.plan === 'function') return direct
      } catch (err) { /* ignore */ }
      try {
        if (ctx && typeof ctx.get === 'function') {
          var service = ctx.get('remote.' + SERVICE)
          if (service && typeof service.plan === 'function') return service
        }
      } catch (err) { /* ignore */ }
      return null
    }

    async function apply(ctx) {
      if (!ctx || !ctx.slots) return undefined
      var runtime = { api: null, error: '' }
      var disposeRemote = null

      try {
        disposeRemote = await ctx.remote.$mount(WORKDAY_REMOTE)
        runtime.api = resolvePlanApi(ctx)
        if (!runtime.api) runtime.error = '规划接口未发布（remote.' + SERVICE + ' 缺失）'
      } catch (err) {
        runtime.error = describeError(err)
      }

      var Page = makePage(ctx, runtime)
      ctx.slots.inject('main', function () {
        return ctx.slots.register({ name: 'main', key: PANEL_KEY }, Page)
      })
      ctx.slots.inject('sidebar.panellist', function () {
        return ctx.slots.register({
          name: 'sidebar.panellist',
          id: PANEL_KEY,
          order: PANEL_ORDER,
          label: function () { return PANEL_LABEL },
        }, WorkdayIcon)
      })

      return function () {
        try {
          if (typeof disposeRemote === 'function') disposeRemote()
        } catch (err) { /* ignore */ }
      }
    }

    var exportsObject = {
      name: 'workday-schedule',
      inject: inject,
      apply: apply,
      WORKDAY_REMOTE: WORKDAY_REMOTE,
    }

    return exportsObject
    //#endregion
  },
})
