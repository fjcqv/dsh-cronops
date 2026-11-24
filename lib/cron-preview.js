/**
 * Local cron preview.
 *
 * 青龙 2.24 has no preview endpoint: `/open/crons/preview` falls through to
 * `/open/crons/:id` and comes back as a bare `Validation failed`, which reads
 * like a bad expression and is impossible to act on. The panel's own parser is
 * therefore not a usable oracle, so the answer is computed here — no round
 * trip, one behaviour for every product, and the failing field can be named.
 *
 * Supported: 5 fields (minute hour day-of-month month day-of-week) and the
 * usual `@daily`-style macros. Six-field (seconds) expressions are rejected on
 * purpose: neither panel accepts them, so previewing one would promise a
 * schedule that cannot be saved.
 */

import { PanelError } from './panels/driver.js'

/** Named schedules an operator writes instead of five numbers. */
const MACROS = {
  '@yearly': '0 0 1 1 *',
  '@annually': '0 0 1 1 *',
  '@monthly': '0 0 1 * *',
  '@weekly': '0 0 * * 0',
  '@daily': '0 0 * * *',
  '@midnight': '0 0 * * *',
  '@hourly': '0 * * * *',
}

/** Human names for the day-of-week field, Sunday first. */
const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']

/** How far ahead to look before declaring a schedule unreachable. */
const MAX_SCAN_MINUTES = 4 * 366 * 24 * 60

/**
 * Parse one field into the set of values it allows.
 * @param field - raw field text.
 * @param min - lowest allowed value.
 * @param max - highest allowed value.
 * @param label - field name, used in the error message.
 * @returns the allowed values.
 */
function parseField(field, min, max, label) {
  const values = new Set()
  for (const part of field.split(',')) {
    const piece = part.trim()
    if (piece === '') throw new PanelError(`定时表达式不合法：${label}字段为空`)
    const [range, stepText] = piece.split('/')
    const step = stepText === undefined ? 1 : Number(stepText)
    if (!Number.isInteger(step) || step < 1) {
      throw new PanelError(`定时表达式不合法：${label}的步长「${stepText}」不是正整数`)
    }
    let from
    let to
    if (range === '*') {
      from = min
      to = max
    } else if (range.includes('-')) {
      const [a, b] = range.split('-')
      from = Number(a)
      to = Number(b)
      if (!Number.isInteger(from) || !Number.isInteger(to)) {
        throw new PanelError(`定时表达式不合法：${label}的区间「${range}」不是数字`)
      }
    } else {
      from = Number(range)
      to = stepText === undefined ? from : max
      if (!Number.isInteger(from)) {
        throw new PanelError(`定时表达式不合法：${label}的取值「${range}」不是数字`)
      }
    }
    if (from < min || to > max || from > to) {
      throw new PanelError(`定时表达式不合法：${label}的取值必须在 ${min}-${max} 之间（收到「${piece}」）`)
    }
    for (let value = from; value <= to; value += step) values.add(value)
  }
  return values
}

/**
 * Parse a five-field expression (or a macro) into per-field value sets.
 * @param expression - cron expression.
 * @returns `{minute, hour, day, month, weekday, source}`.
 */
export function parseCron(expression) {
  const raw = String(expression ?? '').trim()
  if (raw === '') throw new PanelError('定时表达式不能为空')
  const expanded = MACROS[raw.toLowerCase()] ?? raw
  const fields = expanded.split(/\s+/)
  if (fields.length === 6) {
    throw new PanelError('这个表达式有 6 段（含秒）：青龙与呆呆都只接受 5 段「分 时 日 月 周」')
  }
  if (fields.length !== 5) {
    throw new PanelError(`定时表达式需要 5 段「分 时 日 月 周」，收到 ${fields.length} 段：${raw}`)
  }
  const [minute, hour, day, month, weekday] = fields
  const weekdays = parseField(weekday, 0, 7, '周')
  // 7 and 0 both mean Sunday; drop 7 so "every day" stays a seven-value set
  // (otherwise `*` never reads as unrestricted and day/weekday stop OR-ing).
  if (weekdays.has(7)) {
    weekdays.delete(7)
    weekdays.add(0)
  }
  return {
    minute: parseField(minute, 0, 59, '分'),
    hour: parseField(hour, 0, 23, '时'),
    day: parseField(day, 1, 31, '日'),
    month: parseField(month, 1, 12, '月'),
    weekday: weekdays,
    source: raw,
  }
}

/** True when the whole field is unrestricted. */
function isWild(field, min, max) {
  if (field.size !== max - min + 1) return false
  for (let value = min; value <= max; value += 1) if (!field.has(value)) return false
  return true
}

/**
 * ISO timestamp carrying the local offset (`2026-11-25T00:00:00+08:00`).
 * `toISOString()` would hand back UTC, so a "每天 00:00" schedule previewed as
 * `16:00Z` — correct, and unreadable.
 * @param date - the moment to spell.
 * @returns an offset-qualified ISO string.
 */
export function localIso(date) {
  const pad = (value, size = 2) => String(Math.abs(value)).padStart(size, '0')
  const offset = -date.getTimezoneOffset()
  const sign = offset < 0 ? '-' : '+'
  const zone = `${sign}${pad(Math.floor(Math.abs(offset) / 60))}:${pad(Math.abs(offset) % 60)}`
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
    + `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}${zone}`
}

/** `07:00`-style time, local zone. */
function clock(date) {
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}

/**
 * One-line Chinese description of a parsed expression.
 * @param spec - the parsed fields.
 * @returns a short sentence.
 */
export function describeCron(spec) {
  const everyMinute = isWild(spec.minute, 0, 59)
  const everyHour = isWild(spec.hour, 0, 23)
  const everyDay = isWild(spec.day, 1, 31)
  const everyMonth = isWild(spec.month, 1, 12)
  const everyWeekday = isWild(spec.weekday, 0, 6)
  if (everyMinute && everyHour && everyDay && everyMonth && everyWeekday) return '每分钟'
  if (everyHour && everyDay && everyMonth && everyWeekday) {
    return spec.minute.size === 1 ? `每小时第 ${[...spec.minute][0]} 分` : `每小时 ${spec.minute.size} 次`
  }
  if (everyDay && everyMonth && everyWeekday && spec.hour.size === 1 && spec.minute.size === 1) {
    return `每天 ${clock(new Date(2000, 0, 1, [...spec.hour][0], [...spec.minute][0]))}`
  }
  if (everyDay && everyMonth && spec.weekday.size === 1 && spec.hour.size === 1 && spec.minute.size === 1) {
    const day = [...spec.weekday][0]
    return `每${WEEKDAYS[day] ?? `周${day}`} ${clock(new Date(2000, 0, 1, [...spec.hour][0], [...spec.minute][0]))}`
  }
  if (everyMonth && everyWeekday && spec.day.size === 1 && spec.hour.size === 1 && spec.minute.size === 1) {
    return `每月 ${[...spec.day][0]} 日 ${clock(new Date(2000, 0, 1, [...spec.hour][0], [...spec.minute][0]))}`
  }
  return '自定义周期'
}

/**
 * The next `count` times the expression fires, local zone.
 * @param expression - cron expression or macro.
 * @param options - `count` (default 5) and `from` (epoch ms, default now).
 * @returns `{times, description, format, valid, source}`.
 */
export function previewCron(expression, options = {}) {
  const count = Number.isInteger(options.count) && options.count > 0 ? options.count : 5
  const spec = parseCron(expression)
  const times = []
  const start = Number.isFinite(options.from) ? options.from : Date.now()
  const cursor = new Date(start)
  cursor.setSeconds(0, 0)
  let at = cursor.getTime() + 60_000
  // Both checks walk their whole value set, so they are decided once instead of
  // on every one of the (up to four years of) minutes scanned.
  const anyDayField = isWild(spec.day, 1, 31) || isWild(spec.weekday, 0, 6)
  for (let scanned = 0; times.length < count && scanned < MAX_SCAN_MINUTES; scanned += 1) {
    const when = new Date(at)
    const month = when.getMonth() + 1
    const day = when.getDate()
    const weekday = when.getDay()
    // Classic cron semantics: when both day fields are restricted, either one
    // matching is enough.
    const dayMatches = anyDayField
      ? spec.day.has(day) && spec.weekday.has(weekday)
      : spec.day.has(day) || spec.weekday.has(weekday)
    if (spec.month.has(month) && dayMatches && spec.hour.has(when.getHours()) && spec.minute.has(when.getMinutes())) {
      times.push(localIso(when))
    }
    at += 60_000
  }
  if (times.length === 0) {
    throw new PanelError(`「${spec.source}」在未来四年内一次都不会触发——检查「日」与「月」是否凑出了不存在的日期（例如 2 月 30 日）`)
  }
  return {
    times,
    description: describeCron(spec),
    format: '标准格式 (5位)',
    valid: true,
    source: spec.source,
  }
}
