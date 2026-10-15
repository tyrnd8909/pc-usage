import type { EngineInterface, Register, Timer } from 'claude-code'

// Every session on this PC loads this mod. Each hour on the hour it records this PC's Claude Code
// token use (cumulative from 00:00 to that hour) into the dashboard artifact's database: slots 1..24,
// slot 24 being the whole day (up to the next day's 00:00), so it is only ever recorded the day after.
// Hours missed while no session was open are filled in the next time a session opens, computed for the
// hour itself from the transcripts' timestamps, so a late record holds the same value an on-time one would have.
// One document holds one PC's month, so 50 PCs stay far under the database's 25,000 documents:
// `months` (editors only) has every slot, `focusMonths` (viewers too) hours 9..17 as 08:00..h:00.
// Every 30 minutes it also writes `sessionDays` (editors only): one document per PC and day, one field per
// finished session, metadata only. No prompt, answer or summary goes there; the one free text is the
// session's title, from its title record.
// 0.7.0: every document also carries `ver` (this mod's version) and `site` (회사 or 외부, from config.json),
// and the marks of a dashboard other than the first one live in their own folder, so a PC pointed at a new
// dashboard (another account) records its last 7 days there again.

export const HOURS = Array.from({ length: 24 }, (_, i) => i + 1)
const CHECK_MS = 5 * 60 * 1000
const SCAN_MS = 30 * 60 * 1000
const IDLE_MINUTES = 30
const BACKFILL_DAYS = 7
const CALL_MS = 2 * 60 * 1000
// The name in plugin.json, as `next.origin.plugin` reads this mod's own calls.
const PLUGIN = 'pc-usage'
// Keep equal to plugin.json's version; the dashboard shows it per PC.
export const VERSION = '0.8.0'
// The dashboard 0.6.0 and before wrote to: its marks stay in the folders they were written in.
const LEGACY_ARTIFACT = 'AWvcFaQivhBzG4oDw54Ucv'
// Focus hours, for every viewer of the dashboard: 08:00 up to each of 09..17, never the hours before 08:00.
export const FOCUS_HOURS = [9, 10, 11, 12, 13, 14, 15, 16, 17]
export const FOCUS_BASE = 8
const MONTHS = 'months'
const FOCUS_MONTHS = 'focusMonths'
const SESSION_DAYS = 'sessionDays'
// The only collections this mod writes. The 0.5 ones (snapshots, focus, sessions) are no longer touched.
const COLLECTIONS = new Set([MONTHS, FOCUS_MONTHS, SESSION_DAYS])
// Per-model cells only at these hours in `months`; `focusMonths` keeps them for 17 alone.
export const MODEL_HOURS = [8, 17, 24]
const TITLE_MAX = 200
// A document may hold 256KB; a write whose data is longer than this is skipped with a warning.
const WRITE_MAX = 200_000

type Raw = Record<string, any>
type Total = { input: number; output: number; cacheRead: number; cacheWrite: number; messages: number }
const FIELDS = ['input', 'output', 'cacheRead', 'cacheWrite', 'messages'] as const

type Dirs = { data: string; user: string; pc: string; scripts: string }
let dirs: Dirs | null = null

/**
 * Where the files are, decided once per session. config.json from %ProgramData%\pc-usage when it is there
 * (a machine-wide install), else from <user home>\.claude\pc-usage; marks always per user.
 * The scripts ship in the plugin's own scripts folder (0.8.0), so an auto-update brings them along;
 * an install older than that kept them in the data folder, which is used when the plugin has none.
 */
async function paths($: EngineInterface): Promise<Dirs> {
  if (!dirs) {
    const home = (await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME')) ?? ''
    const user = `${home}\\.claude\\pc-usage`
    const programData = await $.env.get('ProgramData')
    const shared = programData ? `${programData}\\pc-usage` : null
    const has = (p: string) => $.fs.exists(p).catch(() => false)
    const isShared = !!shared && (await has(`${shared}\\config.json`))
    const data = isShared && shared ? shared : user
    const own = `${$.plugin.root}\\scripts`
    const pc = (await $.env.get('COMPUTERNAME')) ?? ''
    dirs = { data, user, pc, scripts: (await has(`${own}\\measure.ps1`)) ? own : data }
  }
  return dirs
}

const dataFile = async ($: EngineInterface, name: string) => `${(await paths($)).data}\\${name}`
const scriptFile = async ($: EngineInterface, name: string) => `${(await paths($)).scripts}\\${name}`
/** The artifact's id, the last part of its claude.ai URL. */
export const artifactId = (url: string) => url.replace(/\/+$/, '').split('/').pop() ?? ''

/**
 * The marks folder for a dashboard. The first dashboard keeps its folders: `marks`, or `marks2` for a PC whose
 * name needs pcKey's hash (before 0.5.1 those wrote colliding, garbled ids; a fresh folder recorded them again).
 * Any other dashboard gets `marks_<artifact id>`, so switching dashboards records the last 7 days there too.
 */
export function marksFolder(artifactUrl: string | undefined, pc: string): string {
  const id = artifactUrl ? artifactId(artifactUrl) : ''
  if (!id || id === LEGACY_ARTIFACT) return pcKey(pc) === pc ? 'marks' : 'marks2'
  return `marks_${id.replace(/[^A-Za-z0-9_-]/g, '-')}`
}

// $.fs.write creates the marks folder on the first mark.
const marksDir = async ($: EngineInterface) => {
  const p = await paths($)
  return `${p.user}\\${marksFolder((await readConfig($)).artifactUrl, p.pc)}`
}

export function localDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export const markName = (date: string, hour: number) => `${date}_${String(hour).padStart(2, '0')}`
// Focus marks are kept apart, so an hour already in `months` is still due for `focusMonths`.
export const focusMark = (date: string, hour: number) => `f_${markName(date, hour)}`

/** The hours not yet recorded, per date: today up to the last full hour passed, and the days before in full. */
function due(now: Date, done: Set<string>, days: number, hours: number[], name: (date: string, h: number) => string) {
  const out = new Map<string, number[]>()
  for (let back = days - 1; back >= 0; back--) {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - back)
    const date = localDate(d)
    const left = hours.filter(h => (back > 0 || now.getHours() >= h) && !done.has(name(date, h)))
    if (left.length) out.set(date, left)
  }
  return out
}

export const dueSlots = (now: Date, done: Set<string>, days = BACKFILL_DAYS) => due(now, done, days, HOURS, markName)
export const focusDue = (now: Date, done: Set<string>, days = BACKFILL_DAYS) => due(now, done, days, FOCUS_HOURS, focusMark)

type Slot = { total?: Partial<Total>; byModel?: Record<string, Partial<Total>> }

function minus(a: Partial<Total> | undefined, b: Partial<Total> | undefined): Total {
  const out = {} as Total
  for (const k of FIELDS) out[k] = Math.max(0, Number(a?.[k] ?? 0) - Number(b?.[k] ?? 0))
  return out
}

/**
 * A focus value: slot h less slot 8, so it holds 08:00..h:00 and nothing of the hours before 08:00.
 * Per model of slot h (a model missing from slot 8 is less 0); never negative; an all-zero model is left out.
 */
export function focusValue(slotH: Slot | undefined, slot8: Slot | undefined): { total: Total; byModel: Record<string, Total> } {
  const byModel: Record<string, Total> = {}
  for (const [model, v] of Object.entries(slotH?.byModel ?? {})) {
    const d = minus(v, slot8?.byModel?.[model])
    if (FIELDS.some(k => d[k] > 0)) byModel[model] = d
  }
  return { total: minus(slotH?.total, slot8?.total), byModel }
}

/**
 * The PC's part of a document id. A name of letters, digits, _ and - is used as it is. Any other name
 * (Korean, for one) has those characters as - plus ~ and the FNV-1a hash of the whole name, so two
 * names of the same length no longer share an id.
 */
export function pcKey(pc: string): string {
  const safe = pc.replace(/[^A-Za-z0-9_-]/g, '-')
  if (safe === pc) return pc
  let h = 0x811c9dc5
  for (let i = 0; i < pc.length; i++) h = Math.imul(h ^ pc.charCodeAt(i), 0x01000193) >>> 0
  return `${safe}~${h.toString(16).padStart(8, '0')}`
}

/** `months` and `focusMonths` id: YYYY-MM_<pcKey>, from a YYYY-MM-DD date. */
export const monthDocId = (date: string, pc: string) => `${date.slice(0, 7)}_${pcKey(pc)}`
/** `sessionDays` id: YYYY-MM-DD_<pcKey>, the day the sessions started. */
export const sessionDayDocId = (date: string, pc: string) => `${date}_${pcKey(pc)}`

const hh = (hour: number) => String(hour).padStart(2, '0')
/** A slot's field in a month document: t + day of month + hour, e.g. t1409. */
export const slotField = (date: string, hour: number) => `t${date.slice(8, 10)}${hh(hour)}`
/** The same slot's per-model field: m + day of month + hour. */
export const modelField = (date: string, hour: number) => `m${date.slice(8, 10)}${hh(hour)}`

type Arr = [number, number, number, number, number]
/** A total as [input, output, cacheRead, cacheWrite, messages]. */
export const toArr = (t: Partial<Total> | undefined): Arr => FIELDS.map(k => Number(t?.[k] ?? 0)) as Arr
const arrByModel = (by: Record<string, Partial<Total>> | undefined) =>
  Object.fromEntries(Object.entries(by ?? {}).map(([model, t]) => [model, toArr(t)]))

type Slots = Record<string, Slot | undefined>
const slotOf = (slots: Slots, h: number) => slots[hh(h)]

/** The `months` fields of one day's slots: tDDHH for each hour, and mDDHH at 08, 17 and 24. */
export function monthFields(date: string, slots: Slots, hours: number[]): Raw {
  const out: Raw = {}
  for (const h of hours) {
    out[slotField(date, h)] = toArr(slotOf(slots, h)?.total)
    if (MODEL_HOURS.includes(h)) out[modelField(date, h)] = arrByModel(slotOf(slots, h)?.byModel)
  }
  return out
}

/** The `focusMonths` fields of one day: tDDHH as slot h less slot 08 (never negative), and mDD17 per model. */
export function focusFields(date: string, slots: Slots, hours: number[]): Raw {
  const out: Raw = {}
  for (const h of hours) {
    const v = focusValue(slotOf(slots, h), slotOf(slots, FOCUS_BASE))
    out[slotField(date, h)] = toArr(v.total)
    if (h === 17) out[modelField(date, h)] = arrByModel(v.byModel)
  }
  return out
}

/** True for ArtifactData's answer to a get of a document that is not there: No document "<id>" in collection "<name>". */
export const isMissing = (text: string) => /^No document ".*" in collection ".*"\.?$/.test(text.trim())
// Holds the session's `end` as recorded, so a session that went on is written again.
export const sessionMark = (sessionId: string) => `s_${sessionId}`

export type ScannedSession = { sessionId: string; end: number } & Raw

/** New sessions (no mark) to create, and recorded ones whose last line is now later than the mark to update. */
export function sessionDue(scanned: ScannedSession[], marks: Map<string, number>) {
  const create: ScannedSession[] = []
  const update: ScannedSession[] = []
  for (const s of scanned) {
    const recorded = marks.get(s.sessionId)
    if (recorded === undefined) create.push(s)
    else if (s.end > recorded) update.push(s)
  }
  return { create, update }
}

/** The document's version from an ArtifactData get result; the data's own `version` is a string and never matches. */
export function parseVersion(text: string): number | null {
  const m = /"version"\s*:\s*(\d+)/.exec(text)
  return m ? Number(m[1]) : null
}

const SESSION_FIELDS = ['sessionId', 'date', 'start', 'end', 'project', 'gitBranch', 'title', 'turns', 'messages',
  'total', 'byModel', 'subagents', 'version', 'entrypoint'] as const

/** A session's field in its `sessionDays` document: only the listed fields pass, whatever else the scan carries; the title is cut at 200. */
export function sessionEntry(s: Raw, at: number): Raw {
  const d: Raw = {}
  for (const k of SESSION_FIELDS) d[k] = s[k] ?? null
  d.title = typeof s.title === 'string' && s.title.trim() ? s.title.slice(0, TITLE_MAX) : null
  d.subagents = s.subagents ?? { count: 0, total: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, messages: 0 } }
  d.recordedAt = at
  return d
}

type Config = { artifactUrl?: string; site?: string }

/** config.json's site as the dashboard shows it: 회사 or 외부, else null (the dashboard then goes by IP). */
export function siteOf(site: unknown): '회사' | '외부' | null {
  const s = typeof site === 'string' ? site.trim().toLowerCase() : ''
  if (['회사', 'office', 'company', 'work'].includes(s)) return '회사'
  if (['외부', 'external', 'home', 'remote'].includes(s)) return '외부'
  return null
}

/** The fields every write adds besides the data: ip, updatedAt, the mod's version, and the site when set. */
export function meta(ip: string | null, at: number, site: string | null): Raw {
  return site ? { ip, updatedAt: at, ver: VERSION, site } : { ip, updatedAt: at, ver: VERSION }
}

async function readConfig($: EngineInterface): Promise<Config> {
  try {
    return JSON.parse((await $.fs.read(await dataFile($, 'config.json'))).replace(/^﻿/, ''))
  } catch {
    return {}
  }
}

async function readMarks($: EngineInterface): Promise<Set<string>> {
  try {
    return new Set((await $.fs.list(await marksDir($))).map(e => e.name))
  } catch {
    return new Set()
  }
}

async function mark($: EngineInterface, names: string[], at: number) {
  const dir = await marksDir($)
  for (const n of names) await $.fs.write(`${dir}\\${n}`, String(at))
}

async function measure($: EngineInterface, date: string, hours: number[]): Promise<Raw | null> {
  try {
    const argv = ['powershell', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File',
      await scriptFile($, 'measure.ps1'), '-Date', date, '-Hours', hours.join(',')]
    const { stdout } = await $.process.run(argv, { timeoutMs: 180000 })
    const j = JSON.parse(stdout.trim())
    return j.ok ? j : null
  } catch {
    return null
  }
}

/** Lists this PC's finished sessions (sessions.ps1); null when the scan fails. */
async function scanSessions($: EngineInterface): Promise<{ pc: string; ip?: string | null; sessions: ScannedSession[] } | null> {
  try {
    const argv = ['powershell', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File',
      await scriptFile($, 'sessions.ps1'), '-Since', String(BACKFILL_DAYS), '-IdleMinutes', String(IDLE_MINUTES),
      '-MarksDir', await marksDir($)]
    const { stdout } = await $.process.run(argv, { timeoutMs: 300000 })
    const j = JSON.parse(stdout.trim())
    return j.ok && Array.isArray(j.sessions) ? j : null
  } catch {
    return null
  }
}

const isWrite = (w: unknown): w is Raw => !!w && typeof w === 'object'
const WRITE_OPS = new Set(['set', 'update'])

/**
 * True only for this mod's own ArtifactData call: raised by this plugin, to the configured dashboard,
 * a get, set or update of `months`, `focusMonths` or `sessionDays` (a batch only of sets and updates of them).
 * Anything else, deletes and the 0.5 collections included, is left to the engine.
 */
export function ownsCall(origin: { plugin: string } | null | undefined, input: unknown, artifactUrl: string | undefined): boolean {
  if (origin?.plugin !== PLUGIN || !artifactUrl) return false
  if (!input || typeof input !== 'object') return false
  const i = input as Raw
  if (i.url !== artifactUrl) return false
  if (i.action === 'batch')
    return Array.isArray(i.writes) && i.writes.length > 0 &&
      i.writes.every((w: unknown) => isWrite(w) && COLLECTIONS.has(w.collection) && WRITE_OPS.has(w.op))
  if (i.action === 'get' || WRITE_OPS.has(i.action)) return COLLECTIONS.has(i.collection)
  return false
}

type CallResult = { ok: boolean; text: string }

async function call($: EngineInterface, input: Raw): Promise<CallResult> {
  try {
    const r = (await $.tool.call({ tool: 'ArtifactData', ...input } as any)) as Raw
    if (r.deny) return { ok: false, text: String(r.deny) }
    return { ok: !r.isError, text: String(r.text ?? '') }
  } catch (err) {
    return { ok: false, text: String((err as Error)?.message ?? err) }
  }
}

/** One ArtifactData call, given up after CALL_MS so a stuck call cannot leave `running` set for good. */
async function artifact($: EngineInterface, input: Raw): Promise<CallResult> {
  let expire!: (r: CallResult) => void
  const timeout = new Promise<CallResult>(res => (expire = res))
  const timer = $.clock.after(CALL_MS, () => expire({ ok: false, text: 'ArtifactData 응답 없음(2분 초과)' }))
  try {
    return await Promise.race([call($, input), timeout])
  } finally {
    timer.cancel()
  }
}

type Write = { ok: boolean; text: string; tooBig?: boolean }

/**
 * Writes fields into one document: a get, then a set (no if_version) with `create` added when it is not there,
 * else an update over the version read, with `refresh` added. Another session writing in between makes the
 * update fail on its version; the caller leaves its marks unset, so the next check writes it again.
 */
async function writeDoc($: EngineInterface, url: string, collection: string, docId: string,
  fields: Raw, create: Raw, refresh: Raw): Promise<Write> {
  const g = await artifact($, { action: 'get', url, collection, doc_id: docId })
  const missing = isMissing(g.text)
  if (!missing && !g.ok) return g
  const data = missing ? { ...create, ...fields } : { ...fields, ...refresh }
  if (JSON.stringify(data).length > WRITE_MAX) return { ok: false, text: `${collection}/${docId} 200KB 초과로 건너뜀`, tooBig: true }
  if (missing) return artifact($, { action: 'set', url, collection, doc_id: docId, data })
  const version = parseVersion(g.text)
  if (version === null) return { ok: false, text: `${collection}/${docId} 버전을 읽지 못함` }
  return artifact($, { action: 'update', url, collection, doc_id: docId, if_version: version, data })
}

/** Failed writes for the one-line summary: a count, and the first reason (a size warning first). */
function failNote(fails: Write[]): string {
  if (!fails.length) return ''
  const first = fails.find(f => f.tooBig) ?? fails[0]
  return `, 실패 ${fails.length}개 문서(다음 확인 때 재시도): ${first.text.slice(0, 300)}`
}

let running = false
let lastResult = '아직 측정하지 않았습니다.'
let lastScan = 0

/** Records every due hour, and every SCAN_MS (or when forced) the finished sessions; returns a one-line summary. */
async function tick($: EngineInterface, force = false): Promise<string> {
  if (running) return '이미 측정 중입니다.'
  running = true
  try {
    const cfg = await readConfig($)
    const artifactUrl = cfg.artifactUrl
    if (!artifactUrl) return (lastResult = await saveLast($, 'config.json에 artifactUrl이 없어 기록하지 않았습니다.', cfg))
    const site = siteOf(cfg.site)
    let text = await recordHours($, artifactUrl, site)
    const now = await $.clock.now()
    if (force || now - lastScan >= SCAN_MS) {
      lastScan = now
      text += ` ${await recordSessions($, artifactUrl, site)}`
    }
    return (lastResult = await saveLast($, text, cfg))
  } finally {
    running = false
  }
}

/**
 * Keeps the last summary in <user>\.claude\pc-usage\last.json, so the installer's self-check and a person
 * looking at the PC can see whether recording works without opening a session; returns the text.
 */
async function saveLast($: EngineInterface, text: string, cfg: Config): Promise<string> {
  try {
    const at = await $.clock.now()
    await $.fs.write(`${(await paths($)).user}\\last.json`,
      JSON.stringify({ at, time: new Date(at).toISOString(), ver: VERSION, artifactUrl: cfg.artifactUrl ?? null, text }))
  } catch {}
  return text
}

/** Writes finished sessions into their start day's `sessionDays` document, one field each; new ones and those that went on alike. */
async function recordSessions($: EngineInterface, artifactUrl: string, site: string | null): Promise<string> {
  const scan = await scanSessions($)
  if (!scan) return '세션 스캔에 실패했습니다.'
  const dir = await marksDir($)
  const done = await readMarks($)
  const marks = new Map<string, number>()
  for (const s of scan.sessions) {
    const name = sessionMark(s.sessionId)
    if (done.has(name)) marks.set(s.sessionId, Number(await $.fs.read(`${dir}\\${name}`).catch(() => '0')) || 0)
  }
  const { create, update } = sessionDue(scan.sessions, marks)
  const at = await $.clock.now()
  const byDay = new Map<string, ScannedSession[]>()
  for (const s of [...create, ...update]) {
    const day = typeof s.date === 'string' ? s.date : localDate(new Date(Number(s.start)))
    byDay.set(day, [...(byDay.get(day) ?? []), s])
  }
  let written = 0
  const fails: Write[] = []
  for (const [day, list] of byDay) {
    const fields = Object.fromEntries(list.map(s => [sessionMark(s.sessionId), sessionEntry(s, at)]))
    const ip = scan.ip ?? null
    const r = await writeDoc($, artifactUrl, SESSION_DAYS, sessionDayDocId(day, scan.pc), fields,
      { date: day, pc: scan.pc, ...meta(ip, at, site) }, meta(ip, at, site))
    if (!r.ok) {
      fails.push(r)
      continue
    }
    for (const s of list) await $.fs.write(`${dir}\\${sessionMark(s.sessionId)}`, String(s.end))
    written += list.length
  }
  return `세션 ${written}건${failNote(fails)}.`
}

/** One document's pending fields, and the marks that its successful write sets. */
type Pending = { collection: string; docId: string; month: string; fields: Raw; marks: string[] }

/** Records every due hour into this PC's month documents; returns a one-line summary. */
async function recordHours($: EngineInterface, artifactUrl: string, site: string | null): Promise<string> {
  const now = new Date(await $.clock.now())
  const done = await readMarks($)
  const snapDue = dueSlots(now, done)
  const focDue = focusDue(now, done)
  const dates = [...new Set([...snapDue.keys(), ...focDue.keys()])].sort()
  if (!dates.length) return '기록할 시각이 없습니다 (모두 기록됨).'
  let skipped = 0
  let measureFail = ''
  let pc = ''
  let ip: string | null = null
  // All due days are measured first, then each month document is written once.
  const docs = new Map<string, Pending>()
  const add = (collection: string, date: string, fields: Raw, marks: string[]) => {
    const key = `${collection}/${monthDocId(date, pc)}`
    const d = docs.get(key) ?? { collection, docId: monthDocId(date, pc), month: date.slice(0, 7), fields: {}, marks: [] }
    Object.assign(d.fields, fields)
    d.marks.push(...marks)
    docs.set(key, d)
  }
  for (const date of dates) {
    const snapHours = snapDue.get(date) ?? []
    const focHours = focDue.get(date) ?? []
    // One measurement covers both collections; focus also needs slot 8 to subtract.
    const hours = [...new Set([...snapHours, ...focHours, ...(focHours.length ? [FOCUS_BASE] : [])])].sort((a, b) => a - b)
    const m = await measure($, date, hours)
    if (!m) {
      measureFail = ` ${date} 측정에 실패했습니다. 다음 확인 때 다시 시도합니다.`
      break
    }
    pc = m.pc
    ip = m.ip ?? null
    const slots = m.slots as Slots
    const isToday = date === localDate(now)
    // A past day with no use at all: nothing to show, just remember it was checked.
    const used = hours.some(h => (slotOf(slots, h)?.total?.messages ?? 0) > 0)
    if (!used && !isToday) {
      const marks = [...snapHours.map(h => markName(date, h)), ...focHours.map(h => focusMark(date, h))]
      await mark($, marks, await $.clock.now())
      skipped += marks.length
      continue
    }
    if (snapHours.length) add(MONTHS, date, monthFields(date, slots, snapHours), snapHours.map(h => markName(date, h)))
    if (focHours.length) add(FOCUS_MONTHS, date, focusFields(date, slots, focHours), focHours.map(h => focusMark(date, h)))
  }
  let written = 0
  const fails: Write[] = []
  for (const d of docs.values()) {
    const at = await $.clock.now()
    const r = await writeDoc($, artifactUrl, d.collection, d.docId, d.fields,
      { month: d.month, pc, ...meta(ip, at, site) }, meta(ip, at, site))
    if (!r.ok) {
      fails.push(r)
      continue
    }
    await mark($, d.marks, at)
    written += d.marks.length
  }
  const t = new Date(await $.clock.now()).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' })
  return `${t} 기록 ${written}칸${skipped ? `, 사용 없는 지난 시각 ${skipped}칸 건너뜀` : ''}${failNote(fails)}.${measureFail}`
}

let timer: Timer | null = null

function start($: EngineInterface) {
  if (timer) return
  // A small random delay keeps sessions opened together from measuring at the same moment.
  $.clock.after(5000 + Math.floor(Math.random() * 25000), () => void tick($))
  timer = $.clock.every(CHECK_MS, () => void tick($))
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await $.command.register({ name: 'pc-usage', description: '이 PC의 토큰 사용량과 끝난 세션 정보를 지금 대시보드에 기록합니다' })
    start($)
    return started
  })

  on('command.run', { command: 'pc-usage' }, async $ => {
    start($)
    return { text: await tick($, true) }
  })

  // In auto mode the classifier refuses a call no prompt asked for, and a settings rule did not get past it.
  // Allow this mod's own months/focusMonths/sessionDays calls here; every other ArtifactData call goes on unchanged.
  on('tool.check', { tool: 'ArtifactData' }, async ($, e, next) => {
    if (next.origin.plugin !== PLUGIN) return next(e)
    const { artifactUrl } = await readConfig($)
    if (!ownsCall(next.origin, e.input, artifactUrl)) return next(e)
    // A deny from the person's rules or the organization still stands.
    const verdict = await next(e)
    if (verdict.decision === 'deny') return verdict
    return { decision: 'allow', reason: 'pc-usage: 이 PC 사용량을 대시보드 months·focusMonths·sessionDays 에 기록' }
  })
}
