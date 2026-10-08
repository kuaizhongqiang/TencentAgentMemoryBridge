#!/usr/bin/env node
/**
 * Octop 自动入库守护：Octop（agent harness）→ MemoryCore（默认提交、按需取回）。
 *
 * 默认数据源：**harness 会话日志** `~/.octop/workspaces/<ws>/<system_files>/sessions/YYYY-MM-DD.jsonl`
 *   （harness_agent 自带的 memory_jsonl sink，一行一条 {ts, role, content, thread_id, user, source, model?, usage?}）。
 *   它由 agent runtime 自己写，覆盖每一次真实对话——包括 Dashboard 新开对话、微信通道、
 *   以及 harness 内部会话（`octop.db.thread_messages` 是**客户端投影**，新开对话的轮次可能没落库）。
 *
 * 备选数据源：`--source sqlite` → 读 `~/.octop/octop.db` 的 `thread_messages` + `threads`（只读连接）。
 *
 * 配对规则（同一 thread 内）：
 *   - `user` 开一轮；
 *   - 该轮内**最后一条有文本的 assistant** = 最终回复（中间过程 assistant 多为空串，跳过）；
 *   - 一轮只有在**下一条 user 出现**（说明该轮已结束）或**源文件静默超过 IDLE_FLUSH 秒**时才提交，
 *     避免把"先说一句、再调工具、再说结论"里的前言当成最终回复提交。
 *
 * 身份/项目：
 *   - 身份（team/agent/user + 网关门禁 key）读环境变量，或 `MEMORY_CONFIG` 指向的 JSON 文件
 *     （默认 ~/.config/octop-memory/agent-memory.json，建议 chmod 600）。
 *   - task_id 默认 `octop`（本 agent 的工作区标签），与 identity id 严格分离；
 *     绝不能把 AGENT_ID（agt-*）/ TEAM_ID（team-*）/ USER_ID（usr-*）/ key 填进 TASK_ID。
 *
 * 去重：按 thread_id 记游标（最后提交的 assistant 时间戳），状态写
 *       ~/.octop/.octop-memory-autostore-state.json；失败不推进游标，下次自动重试。
 *
 * 用法：
 *   node scripts/octop-memory-autostore.mjs                 # 守护模式（默认，10s 轮询）
 *   node scripts/octop-memory-autostore.mjs --once          # 扫描一次并提交增量（配 systemd timer / cron）
 *   node scripts/octop-memory-autostore.mjs --baseline-only # 把现有轮次记为游标（不回溯提交）
 *   node scripts/octop-memory-autostore.mjs --backfill      # 补提交历史全部轮次
 *   node scripts/octop-memory-autostore.mjs --dry-run       # 只扫描打印，不提交
 *
 * 环境变量：
 *   OCTOP_HOME                  Octop 数据目录（默认 ~/.octop）
 *   OCTOP_SESSIONS_ROOT         会话日志根目录（默认 <OCTOP_HOME>/workspaces，递归找 sessions/*.jsonl）
 *   OCTOP_DB                    Octop 主库路径（--source sqlite 用；默认 <OCTOP_HOME>/octop.db）
 *   OCTOP_AUTOSTORE_SOURCE      数据源：jsonl（默认）| sqlite | auto
 *   OCTOP_AUTOSTORE_STATE       游标文件路径
 *   OCTOP_AUTOSTORE_IDLE_FLUSH  "未闭合轮次"判定静默秒数（默认 120）
 *   OCTOP_AUTOSTORE_SESSION_MODE session_id 取法：thread（默认，一对话一 session）| source（按通道归并）
 *   OCTOP_AUTOSTORE_AGENTS      只采集这些 agent（仅 sqlite 源有意义；逗号分隔）
 *   OCTOP_AUTOSTORE_POLL_MS     轮询间隔（默认 10000）
 *   MEMORY_CONFIG               凭据 JSON 路径（默认 ~/.config/octop-memory/agent-memory.json）
 *   MEMORY_ENDPOINT / API_KEY / SERVICE_ID / TEAM_ID / AGENT_ID / USER_ID / USER_KEY / TASK_ID
 *
 * 任何提交失败只记 stderr、不退出守护；重启后从游标继续。
 */
import { readFileSync, readdirSync, existsSync, mkdirSync, writeFileSync, statSync, openSync, closeSync, unlinkSync, writeSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'

const OCTOP_HOME = process.env.OCTOP_HOME || join(homedir(), '.octop')
const SESSIONS_ROOT = process.env.OCTOP_SESSIONS_ROOT || join(OCTOP_HOME, 'workspaces')
const OCTOP_DB = process.env.OCTOP_DB || join(OCTOP_HOME, 'octop.db')
const STATE_PATH = process.env.OCTOP_AUTOSTORE_STATE || join(OCTOP_HOME, '.octop-memory-autostore-state.json')
const LOCK_PATH = STATE_PATH + '.lock'
const CRED_FILE = process.env.MEMORY_CONFIG || join(homedir(), '.config', 'octop-memory', 'agent-memory.json')
const SOURCE = (process.env.OCTOP_AUTOSTORE_SOURCE || 'jsonl').toLowerCase()
const SESSION_MODE = (process.env.OCTOP_AUTOSTORE_SESSION_MODE || 'thread').toLowerCase()
const IDLE_FLUSH_MS = Number(process.env.OCTOP_AUTOSTORE_IDLE_FLUSH ?? 120) * 1000
const AGENT_FILTER = (process.env.OCTOP_AUTOSTORE_AGENTS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)
/** 身份 id 前缀：出现在 TASK_ID 里说明配错了（task_id 是项目级标签，不是身份） */
const IDENTITY_PREFIXES = /^(agt-|team-|usr-|uky-|sk-mem-|sk-|key-)/i

/**
 * 游标命名空间：JSONL 源用毫秒时间戳、SQLite 源用 seq，两种游标不可混用，
 * 所以 state 的 key 带上数据源前缀（换源不会把游标读歪）。
 */
let CURSOR_PREFIX = ''
const cursorKey = (threadId) => `${CURSOR_PREFIX}${threadId}`

/**
 * 进程锁：防止守护 + 计划任务并发扫描导致重复提交。
 * 用 'wx' 原子创建；拿不到锁说明已有实例在跑，直接退出。
 */
function acquireLock() {
  try {
    const fd = openSync(LOCK_PATH, 'wx')
    writeSync(fd, String(process.pid))
    return () => {
      try { closeSync(fd) } catch { /* 已关闭 */ }
      try { unlinkSync(LOCK_PATH) } catch { /* 已删除 */ }
    }
  } catch {
    return null
  }
}

// ---------- 1. 凭据：环境变量优先，其次 MEMORY_CONFIG JSON ----------
function loadCreds() {
  const env = { ...process.env }
  if (!env.API_KEY && existsSync(CRED_FILE)) {
    try {
      const file = JSON.parse(readFileSync(CRED_FILE, 'utf8'))
      for (const [k, v] of Object.entries(file)) {
        if (typeof v === 'string' && v && !env[k]) env[k] = v
      }
    } catch (err) {
      console.error(`[octop-memory-autostore] 凭据文件解析失败（忽略）: ${CRED_FILE}: ${err.message}`)
    }
  }
  const required = ['MEMORY_ENDPOINT', 'API_KEY', 'SERVICE_ID', 'TEAM_ID', 'AGENT_ID', 'USER_ID']
  const missing = required.filter((k) => !env[k])
  if (missing.length) {
    console.error(
      `[octop-memory-autostore] 缺少凭据: ${missing.join(', ')}（环境变量，或 ${CRED_FILE}）`,
    )
    return null
  }
  const taskId = (env.TASK_ID || 'octop').trim()
  if (IDENTITY_PREFIXES.test(taskId)) {
    console.error(
      `[octop-memory-autostore] TASK_ID '${taskId}' 是身份 id 前缀，拒绝启动：` +
        'task_id 是项目级标签（如 octop），不是 agent_id/team_id/user_id。',
    )
    return null
  }
  return {
    endpoint: env.MEMORY_ENDPOINT.replace(/\/+$/, ''),
    apiKey: env.API_KEY,
    serviceId: env.SERVICE_ID,
    teamId: env.TEAM_ID,
    agentId: env.AGENT_ID,
    userId: env.USER_ID,
    taskId,
  }
}

// ---------- 2. 游标 ----------
function loadState() {
  try { return JSON.parse(readFileSync(STATE_PATH, 'utf8')) } catch { return {} }
}
function saveState(state) {
  try {
    mkdirSync(dirname(STATE_PATH), { recursive: true })
    writeFileSync(STATE_PATH, JSON.stringify(state, null, 2))
  } catch (err) {
    console.error(`[octop-memory-autostore] state 写入失败: ${err.message}`)
  }
}

// ---------- 3. 数据源 A：harness 会话日志（JSONL，默认） ----------
/** 递归找出 <root>/**\/sessions/*.jsonl */
function findSessionLogs(root, out = [], depth = 0) {
  if (depth > 6 || !existsSync(root)) return out
  let entries = []
  try { entries = readdirSync(root, { withFileTypes: true }) } catch { return out }
  for (const e of entries) {
    const p = join(root, e.name)
    if (e.isDirectory()) {
      if (e.name === 'sessions') {
        try {
          for (const f of readdirSync(p)) if (f.endsWith('.jsonl')) out.push(join(p, f))
        } catch { /* ignore */ }
      } else {
        findSessionLogs(p, out, depth + 1)
      }
    }
  }
  return out
}

/**
 * 解析一只会话日志文件 → 各 thread 的 turn 列表。
 * turn = { threadId, source, userText, userTs, aiTs, assistantText, closed }
 * closed=false 表示该轮之后还没有新的 user（可能仍在进行中）。
 */
function parseSessionLog(file) {
  let text
  try { text = readFileSync(file, 'utf8') } catch { return null }
  const byThread = new Map()
  const lastTs = { value: 0 }
  for (const line of text.split('\n')) {
    const raw = line.trim()
    if (!raw) continue
    let row
    try { row = JSON.parse(raw) } catch { continue }
    const role = row.role
    const threadId = String(row.thread_id || '')
    if (!threadId || (role !== 'user' && role !== 'assistant')) continue
    const ts = Date.parse(row.ts || '') || 0
    if (ts > lastTs.value) lastTs.value = ts
    let turns = byThread.get(threadId)
    if (!turns) { turns = []; byThread.set(threadId, turns) }
    const source = String(row.source || '')
    const open = turns[turns.length - 1]
    if (role === 'user') {
      const content = typeof row.content === 'string' ? row.content.trim() : ''
      if (open && !open.closed) {
        // 上一条 user 之后没有新的 user —— 先闭合并起新一轮
        open.closed = true
      }
      turns.push({ threadId, source, userText: content || '[非文本输入]', userTs: ts, aiTs: 0, assistantText: '', closed: false })
    } else {
      const content = typeof row.content === 'string' ? row.content.trim() : ''
      if (content && open) { open.assistantText = content; open.aiTs = ts }
    }
  }
  return { byThread, lastTs: lastTs.value }
}

async function scanJsonl(creds, state, mode, dryRun) {
  const files = findSessionLogs(SESSIONS_ROOT)
  const now = Date.now()
  let submitted = 0
  let seen = 0
  if (!files.length) return { submitted, seen }
  for (const file of files) {
    const parsed = parseSessionLog(file)
    if (!parsed) continue
    // 文件静默多久了？（判定尾部未闭合轮次是否可以提交）
    let mtimeMs = 0
    try { mtimeMs = statSync(file).mtimeMs } catch { /* ignore */ }
    const idle = now - Math.max(mtimeMs, parsed.lastTs) > IDLE_FLUSH_MS
    for (const [threadId, turns] of parsed.byThread) {
      const key = cursorKey(threadId)
      const cursor = state[key] ?? 0
      const candidates = turns.filter((t) => t.assistantText && t.aiTs > cursor && (t.closed || idle))
      if (!candidates.length) continue
      seen += candidates.length
      if (mode === 'baseline') {
        state[key] = Math.max(...candidates.map((t) => t.aiTs))
        continue
      }
      for (const turn of candidates) {
        if (dryRun) { submitted += 1; continue }
        const ok = await postTurn(creds, threadId, turn.source, turn)
        if (ok) { state[key] = turn.aiTs; submitted += 1 }
        else if (mode !== 'backfill') break
      }
    }
  }
  if (!dryRun) saveState(state)
  return { submitted, seen }
}

// ---------- 4. 数据源 B：octop.db（SQLite，只读） ----------
let DatabaseSync
async function ensureSqlite() {
  if (DatabaseSync !== undefined) return DatabaseSync
  try {
    ({ DatabaseSync } = await import('node:sqlite'))
  } catch {
    DatabaseSync = null
  }
  return DatabaseSync
}

function openDb() {
  if (!existsSync(OCTOP_DB)) {
    console.error(`[octop-memory-autostore] Octop 主库不存在: ${OCTOP_DB}`)
    return null
  }
  try {
    // readOnly：Octop 正在写（WAL），只读连接不会阻塞它
    return new DatabaseSync(OCTOP_DB, { readOnly: true })
  } catch (err) {
    console.error(`[octop-memory-autostore] 打开主库失败: ${err.message}`)
    return null
  }
}

function loadSqliteThreads(db, cursors) {
  const threads = db.prepare('SELECT thread_id, agent_id, session_key FROM threads').all()
  const maxSeqStmt = db.prepare('SELECT COALESCE(MAX(seq), 0) AS max_seq FROM thread_messages WHERE thread_id = ?')
  const rowsStmt = db.prepare('SELECT seq, role, message_json FROM thread_messages WHERE thread_id = ? ORDER BY seq ASC')
  const out = []
  for (const t of threads) {
    const threadId = String(t.thread_id)
    const agentId = String(t.agent_id ?? '')
    if (AGENT_FILTER.length && !AGENT_FILTER.includes(agentId)) continue
    let maxSeq = 0
    try { maxSeq = Number(maxSeqStmt.get(threadId)?.max_seq ?? 0) } catch { continue }
    if (maxSeq <= (cursors[threadId] ?? 0)) continue
    let rows = []
    try { rows = rowsStmt.all(threadId) } catch { continue }
    out.push({
      threadId,
      source: String(t.session_key ?? ''),
      rows: rows.map((r) => ({ seq: Number(r.seq), role: String(r.role), messageJson: String(r.message_json) })),
    })
  }
  return out
}

function textOfMessage(messageJson) {
  let msg
  try { msg = JSON.parse(messageJson) } catch { return null }
  const data = msg?.data ?? msg
  const content = data?.content
  if (typeof content === 'string') return content.trim() || null
  if (Array.isArray(content)) {
    const texts = content
      .filter((b) => b && b.type === 'text' && typeof b.text === 'string' && b.text.trim())
      .map((b) => b.text)
    return texts.length ? texts.join('\n') : null
  }
  return null
}

/** SQLite 版配对：human 开一轮，该轮最后一条有文本的 ai = 最终回复 */
function extractSqliteTurns(rows) {
  const turns = []
  let user = null
  let assistant = null
  const flush = () => {
    if (user && assistant) {
      turns.push({ userText: user.text, aiTs: assistant.seq, assistantText: assistant.text, closed: true })
    }
  }
  for (const row of rows) {
    if (row.role === 'human') {
      flush()
      user = { seq: row.seq, text: textOfMessage(row.messageJson) ?? '[非文本输入]' }
      assistant = null
    } else if (row.role === 'ai') {
      const text = textOfMessage(row.messageJson)
      if (text) assistant = { seq: row.seq, text }
    }
  }
  flush()
  return turns
}

async function scanSqlite(creds, state, mode, dryRun) {
  if (!(await ensureSqlite())) {
    console.error('[octop-memory-autostore] 当前 Node 不支持 node:sqlite（需 Node ≥ 22.5，23+ 免 flag）')
    return { submitted: 0, seen: 0 }
  }
  const db = openDb()
  if (!db) return { submitted: 0, seen: 0 }
  let threads = []
  try { threads = loadSqliteThreads(db, state) } finally { try { db.close() } catch { /* ignore */ } }
  let submitted = 0
  let seen = 0
  for (const thread of threads) {
    const key = cursorKey(thread.threadId)
    const cursor = state[key] ?? 0
    const turns = extractSqliteTurns(thread.rows).filter((t) => t.aiTs > cursor)
    if (!turns.length) continue
    seen += turns.length
    if (mode === 'baseline') {
      state[key] = Math.max(...turns.map((t) => t.aiTs))
      continue
    }
    for (const turn of turns) {
      if (dryRun) { submitted += 1; continue }
      const ok = await postTurn(creds, thread.threadId, thread.source, turn)
      if (ok) { state[key] = turn.aiTs; submitted += 1 }
      else if (mode !== 'backfill') break
    }
  }
  if (!dryRun) saveState(state)
  return { submitted, seen }
}

// ---------- 5. 提交 ----------
function sessionIdFor(threadId, source) {
  if (SESSION_MODE === 'source' && source) return source.replace(/[\\/]/g, '_')
  return threadId
}

async function postTurn(creds, threadId, source, turn) {
  const body = {
    team_id: creds.teamId,
    agent_id: creds.agentId,
    user_id: creds.userId,
    task_id: creds.taskId,
    session_id: sessionIdFor(threadId, source),
    messages: [
      { role: 'user', content: turn.userText },
      { role: 'assistant', content: turn.assistantText },
    ],
  }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 10000)
  try {
    const res = await fetch(`${creds.endpoint}/v3/conversation/add`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${creds.apiKey}`,
        'x-tdai-service-id': creds.serviceId,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    })
    const text = await res.text()
    if (res.status >= 400) {
      console.error(
        `[octop-memory-autostore] POST 失败 ${res.status}: ${text.slice(0, 200)} (thread=${threadId})`,
      )
      return false
    }
    return true
  } catch (err) {
    console.error(`[octop-memory-autostore] 提交异常（将重试）: ${err.message} (thread=${threadId})`)
    return false
  } finally {
    clearTimeout(timer)
  }
}

// ---------- 6. 主流程 ----------
const args = process.argv.slice(2)
const dryRun = args.includes('--dry-run')
const backfill = args.includes('--backfill')
const once = args.includes('--once')
const baselineOnly = args.includes('--baseline-only')

const creds = loadCreds()
if (!creds) process.exit(1)

/** 数据源选择：--source / OCTOP_AUTOSTORE_SOURCE；auto = 有会话日志就用日志，否则回退 SQLite */
function pickSource() {
  if (SOURCE === 'sqlite') return 'sqlite'
  if (SOURCE === 'jsonl') return 'jsonl'
  return findSessionLogs(SESSIONS_ROOT).length ? 'jsonl' : 'sqlite'
}

const SOURCE_KIND = pickSource()
CURSOR_PREFIX = `${SOURCE_KIND}:`
const scan = SOURCE_KIND === 'jsonl' ? scanJsonl : scanSqlite
const modeOf = () => (backfill ? 'backfill' : once ? 'once' : 'daemon')

if (dryRun) {
  const state = loadState()
  const { submitted, seen } = await scan(creds, state, 'once', true)
  console.log(
    `[dry-run] source=${SOURCE_KIND} 根=${SOURCE_KIND === 'jsonl' ? SESSIONS_ROOT : OCTOP_DB} ` +
      `待提交 ${submitted} 轮（可配对 ${seen} 轮）task_id=${creds.taskId} session_mode=${SESSION_MODE}`,
  )
  console.log('[dry-run] 未提交任何数据')
  process.exit(0)
}

const releaseLock = acquireLock()
if (!releaseLock) {
  console.error('[octop-memory-autostore] 已有实例在运行（锁文件存在），退出避免重复提交')
  process.exit(0)
}
process.on('exit', releaseLock)
process.on('SIGINT', () => { releaseLock(); process.exit(0) })
process.on('SIGTERM', () => { releaseLock(); process.exit(0) })

if (baselineOnly) {
  const state = loadState()
  const { seen } = await scan(creds, state, 'baseline', false)
  console.log(`[octop-memory-autostore] 基线已建立：跳过 ${seen} 轮历史（不回溯提交），之后 --once 只提交增量`)
  process.exit(0)
}

if (once || backfill) {
  const mode = modeOf()
  const state = loadState()
  const { submitted } = await scan(creds, state, mode, false)
  console.log(
    `[octop-memory-autostore] ${mode === 'backfill' ? '回填' : '增量'}提交 ${submitted} 轮` +
      `（source=${SOURCE_KIND} state=${STATE_PATH}）`,
  )
  process.exit(0)
}

// 守护模式：先建基线（不回溯历史），再轮询增量
const baselineState = loadState()
const { seen: baselineTurns } = await scan(creds, baselineState, 'baseline', false)
console.log(
  `[octop-memory-autostore] 守护启动：已记录 ${baselineTurns} 轮历史基线（不回溯提交），` +
    `source=${SOURCE_KIND} 轮询 ${SOURCE_KIND === 'jsonl' ? SESSIONS_ROOT : OCTOP_DB} ` +
    `（session_mode=${SESSION_MODE}, task_id=${creds.taskId}）`,
)

const POLL_MS = Number(process.env.OCTOP_AUTOSTORE_POLL_MS ?? 10000)
async function pollOnce() {
  try {
    const s = loadState()
    const { submitted } = await scan(creds, s, 'once', false)
    if (submitted > 0) console.log(`[octop-memory-autostore] 已提交 ${submitted} 轮`)
  } catch (err) {
    console.error(`[octop-memory-autostore] 轮询异常（继续）: ${err.message}`)
  }
}
await pollOnce()
setInterval(pollOnce, POLL_MS)
console.log('[octop-memory-autostore] 运行中（Ctrl+C 退出）')
