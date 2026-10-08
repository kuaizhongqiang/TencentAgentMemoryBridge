#!/usr/bin/env node
/**
 * Octop 自动入库守护：Octop（agent harness）→ MemoryCore（默认提交、按需取回）。
 *
 * 原理：读 Octop 主库（默认 ~/.octop/octop.db，SQLite）的 thread_messages + threads，
 *       把每个"用户一轮 → 助手最终回复"配对成一只 turn，
 *       POST 到 MemoryCore /v3/conversation/add（与 mcp-bridge 同一数据面协议）。
 *       与 dsh-memory-autostore.mjs 同构：DSH 读会话日志，Octop 读 SQLite。
 *
 * 为什么需要它：mcp-bridge 的 `store_memory` 只有模型显式调用才写入，
 *       而 Octop 没有 Stop hook。用本守护兜底，保证"对话生成完成后自动沉淀 L0"。
 *
 * 身份/项目：
 *   - 身份（team/agent/user + 网关门禁 key）读环境变量，或 `MEMORY_CONFIG` 指向的 JSON 文件
 *     （默认 ~/.config/octop-memory/agent-memory.json，建议 chmod 600）。
 *   - task_id 默认 `octop`（本 agent 的工作区标签），与 identity id 严格分离；
 *     绝不能把 AGENT_ID（agt-*）/ TEAM_ID（team-*）/ USER_ID（usr-*）/ key 填进 TASK_ID。
 *
 * 去重：按 thread_id 记游标（最后提交的 assistant seq），状态写
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
 *   OCTOP_DB                  Octop 主库路径（默认 <OCTOP_HOME>/octop.db）
 *   OCTOP_HOME                Octop 数据目录（默认 ~/.octop）
 *   OCTOP_AUTOSTORE_STATE     游标文件路径
 *   OCTOP_AUTOSTORE_AGENTS    只采集这些 agent_id（逗号分隔；缺省=全部）
 *   OCTOP_AUTOSTORE_SESSION_MODE  session_id 取法：key（默认，用 threads.session_key，跨 thread 连续）
 *                                 | thread（用 thread_id，一对话一 session）
 *   OCTOP_AUTOSTORE_POLL_MS   轮询间隔（默认 10000）
 *   MEMORY_CONFIG             凭据 JSON 路径（默认 ~/.config/octop-memory/agent-memory.json）
 *   MEMORY_ENDPOINT / API_KEY / SERVICE_ID / TEAM_ID / AGENT_ID / USER_ID / USER_KEY / TASK_ID
 *
 * 任何提交失败只记 stderr、不退出守护；重启后从游标继续。
 */
import { readFileSync, existsSync, mkdirSync, writeFileSync, openSync, closeSync, unlinkSync, writeSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'

const OCTOP_HOME = process.env.OCTOP_HOME || join(homedir(), '.octop')
const OCTOP_DB = process.env.OCTOP_DB || join(OCTOP_HOME, 'octop.db')
const STATE_PATH = process.env.OCTOP_AUTOSTORE_STATE || join(OCTOP_HOME, '.octop-memory-autostore-state.json')
const LOCK_PATH = STATE_PATH + '.lock'
const CRED_FILE = process.env.MEMORY_CONFIG || join(homedir(), '.config', 'octop-memory', 'agent-memory.json')
const SESSION_MODE = (process.env.OCTOP_AUTOSTORE_SESSION_MODE || 'key').toLowerCase()
const AGENT_FILTER = (process.env.OCTOP_AUTOSTORE_AGENTS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)
/** 身份 id 前缀：出现在 TASK_ID 里说明配错了（task_id 是项目级标签，不是身份） */
const IDENTITY_PREFIXES = /^(agt-|team-|usr-|uky-|sk-mem-|sk-|key-)/i

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

// ---------- 2. 读 Octop 主库（node:sqlite，只读；零额外依赖） ----------
let DatabaseSync
try {
  ({ DatabaseSync } = await import('node:sqlite'))
} catch {
  console.error(
    '[octop-memory-autostore] 需要 Node ≥ 22.5 的 node:sqlite（Node 23+ 无需 flag）。' +
      '当前 Node 不支持，请升级或用 --once 跑在支持 node:sqlite 的 Node 上。',
  )
  process.exit(1)
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

/** 取出需要处理的 thread（有新增消息的），返回 [{thread_id, agent_id, session_key, rows}] */
function loadThreads(db, cursors) {
  const threads = db
    .prepare('SELECT thread_id, agent_id, channel_type, session_key FROM threads')
    .all()
  const maxSeqStmt = db.prepare('SELECT COALESCE(MAX(seq), 0) AS max_seq FROM thread_messages WHERE thread_id = ?')
  const rowsStmt = db.prepare('SELECT seq, role, message_json FROM thread_messages WHERE thread_id = ? ORDER BY seq ASC')
  const out = []
  for (const t of threads) {
    const threadId = String(t.thread_id)
    const agentId = String(t.agent_id ?? '')
    if (AGENT_FILTER.length && !AGENT_FILTER.includes(agentId)) continue
    let maxSeq = 0
    try {
      maxSeq = Number(maxSeqStmt.get(threadId)?.max_seq ?? 0)
    } catch { continue }
    if (maxSeq <= (cursors[threadId] ?? 0)) continue // 没有新消息，跳过
    let rows = []
    try {
      rows = rowsStmt.all(threadId)
    } catch { continue }
    out.push({
      threadId,
      agentId,
      sessionKey: String(t.session_key ?? ''),
      rows: rows.map((r) => ({ seq: Number(r.seq), role: String(r.role), messageJson: String(r.message_json) })),
    })
  }
  return out
}

// ---------- 3. 消息文本抽取 ----------
function textOf(messageJson) {
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

/**
 * 把一只 thread 的消息流配对成 turn 列表。
 * 规则：human 开一轮；该轮内最后一条有文本的 ai 消息 = 最终回复。
 * （中间过程 ai/tool 消息不算回复。）
 */
function extractTurns(rows) {
  const turns = []
  let user = null
  let assistant = null
  const flush = () => {
    if (user && assistant) {
      turns.push({
        userSeq: user.seq,
        userText: user.text,
        aiSeq: assistant.seq,
        assistantText: assistant.text,
      })
    }
  }
  for (const row of rows) {
    if (row.role === 'human') {
      flush()
      user = { seq: row.seq, text: textOf(row.messageJson) ?? '[非文本输入]' }
      assistant = null
    } else if (row.role === 'ai') {
      const text = textOf(row.messageJson)
      if (text) assistant = { seq: row.seq, text }
    }
  }
  flush()
  return turns
}

// ---------- 4. 游标 ----------
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

function sessionIdFor(thread) {
  if (SESSION_MODE === 'thread') return thread.threadId
  const key = thread.sessionKey || thread.threadId
  // 会话 key 可能含路径分隔符/冒号，清掉以防落到不安全的名字上
  return key.replace(/[\\/]/g, '_')
}

// ---------- 5. 提交 ----------
async function postTurn(creds, thread, turn) {
  const body = {
    team_id: creds.teamId,
    agent_id: creds.agentId,
    user_id: creds.userId,
    task_id: creds.taskId,
    session_id: sessionIdFor(thread),
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
        `[octop-memory-autostore] POST 失败 ${res.status}: ${text.slice(0, 200)} ` +
          `(thread=${thread.threadId} seq=${turn.aiSeq})`,
      )
      return false
    }
    return true
  } catch (err) {
    console.error(
      `[octop-memory-autostore] 提交异常（将重试）: ${err.message} (thread=${thread.threadId} seq=${turn.aiSeq})`,
    )
    return false
  } finally {
    clearTimeout(timer)
  }
}

// ---------- 6. 扫描 + 提交 ----------
/**
 * mode: 'once'（增量）| 'baseline'（只记游标）| 'backfill'（补历史）
 * 返回 {submitted, turns}
 */
async function scanAndSubmit(creds, state, mode) {
  const db = openDb()
  if (!db) return { submitted: 0, turns: 0 }
  let threads = []
  try {
    threads = loadThreads(db, state)
  } finally {
    try { db.close() } catch { /* ignore */ }
  }
  let submitted = 0
  let seen = 0
  for (const thread of threads) {
    const cursor = state[thread.threadId] ?? 0
    const turns = extractTurns(thread.rows).filter((t) => t.aiSeq > cursor)
    if (!turns.length) continue
    seen += turns.length
    if (mode === 'baseline') {
      state[thread.threadId] = Math.max(...turns.map((t) => t.aiSeq))
      continue
    }
    for (const turn of turns) {
      const ok = await postTurn(creds, thread, turn)
      if (ok) {
        // 增量/回填都只在成功后推进游标；失败停在该 thread 当前轮，下次重试
        state[thread.threadId] = turn.aiSeq
        submitted += 1
      } else if (mode !== 'backfill') {
        break
      }
    }
  }
  saveState(state)
  return { submitted, turns: seen }
}

// ---------- 7. 主流程 ----------
const args = process.argv.slice(2)
const dryRun = args.includes('--dry-run')
const backfill = args.includes('--backfill')
const once = args.includes('--once')
const baselineOnly = args.includes('--baseline-only')

const creds = loadCreds()
if (!creds) process.exit(1)

if (dryRun) {
  const db = openDb()
  if (!db) process.exit(1)
  const state = loadState()
  let total = 0
  try {
    for (const thread of loadThreads(db, {})) {
      const turns = extractTurns(thread.rows)
      if (!turns.length) continue
      total += turns.length
      const last = turns[turns.length - 1]
      console.log(
        `[dry-run] thread=${thread.threadId} agent=${thread.agentId} session=${sessionIdFor(thread)} ` +
          `task_id=${creds.taskId} turns=${turns.length} cursor=${state[thread.threadId] ?? 0} pending=` +
          `${turns.filter((t) => t.aiSeq > (state[thread.threadId] ?? 0)).length}`,
      )
      console.log(`  last turn seq=${last.aiSeq} user[${last.userText.length}] assistant[${last.assistantText.length}]`)
    }
  } finally {
    try { db.close() } catch { /* ignore */ }
  }
  console.log(`[dry-run] 共 ${total} 轮；未提交任何数据`)
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
  // 一次性建基线：把当前所有已配对轮次记为游标（跳过历史，不回溯提交）。
  const state = loadState()
  const { turns } = await scanAndSubmit(creds, state, 'baseline')
  console.log(`[octop-memory-autostore] 基线已建立：跳过 ${turns} 轮历史（不回溯提交），之后 --once 只提交增量`)
  process.exit(0)
}

if (once || backfill) {
  const mode = backfill ? 'backfill' : 'once'
  const state = loadState()
  const { submitted } = await scanAndSubmit(creds, state, mode)
  console.log(`[octop-memory-autostore] ${mode === 'backfill' ? '回填' : '增量'}提交 ${submitted} 轮（state=${STATE_PATH}）`)
  process.exit(0)
}

// 守护模式：先建基线（不回溯历史），再轮询增量
const baselineState = loadState()
const { turns: baselineTurns } = await scanAndSubmit(creds, baselineState, 'baseline')
console.log(
  `[octop-memory-autostore] 守护启动：已记录 ${baselineTurns} 轮历史基线（不回溯提交），` +
    `轮询 ${OCTOP_DB}（session_mode=${SESSION_MODE}, task_id=${creds.taskId}）`,
)

const POLL_MS = Number(process.env.OCTOP_AUTOSTORE_POLL_MS ?? 10000)
async function pollOnce() {
  try {
    const s = loadState()
    const { submitted } = await scanAndSubmit(creds, s, 'once')
    if (submitted > 0) console.log(`[octop-memory-autostore] 已提交 ${submitted} 轮`)
  } catch (err) {
    console.error(`[octop-memory-autostore] 轮询异常（继续）: ${err.message}`)
  }
}
await pollOnce()
setInterval(pollOnce, POLL_MS)
console.log('[octop-memory-autostore] 运行中（Ctrl+C 退出）')
