#!/usr/bin/env node
/**
 * DSH 自动入库守护：DeepSeek Harness → MemoryCore（默认提交、按需取回）。
 *
 * 原理：监听 ~/.dsh/sessions 下各项目会话日志（session.jsonl.zstd，zstd 多帧 JSONL），
 *       每当一个回合结束（turn/end 事件），把该轮 user + assistant 文本
 *       POST 到 MemoryCore /v3/conversation/add（与 mcp-bridge 同一数据面协议）。
 *
 * 身份/项目：
 *   - 身份（team/agent/user + 网关门禁 key）复用 DSH 本机配置
 *     （~/.dsh/profiles/<profile>/cordis.patch.yml → mcp-agent-memory.env），
 *     也支持环境变量覆盖（MEMORY_ENDPOINT/API_KEY/SERVICE_ID/TEAM_ID/AGENT_ID/USER_ID/USER_KEY）。
 *   - task_id 从会话 header 的 cwd 自动派生（项目目录名），每项目独立；
 *     与 agent_id（平台身份）严格分离，绝不用身份 id 当 task_id。
 *
 * 去重：按 session_id + turn 号写 state 文件（.dsh-memory-autostore-state.json）；
 *       守护启动时把现有已完成轮次记为基线（不回溯提交历史），只提交之后新增的轮次。
 *
 * 用法：
 *   node scripts/dsh-memory-autostore.mjs            # 守护模式（默认，监听 + 增量提交）
 *   node scripts/dsh-memory-autostore.mjs --dry-run  # 扫描一次，只打印不提交
 *   node scripts/dsh-memory-autostore.mjs --backfill # 守护启动前先把历史轮次全部补提交
 *   node scripts/dsh-memory-autostore.mjs --once     # 扫描一次并提交增量（配合计划任务）
 *
 * 任何提交失败只记 stderr、不退出守护；重启后从 state 游标继续。
 */
import { readFileSync, readdirSync, statSync, existsSync, mkdirSync, writeFileSync, openSync, closeSync, unlinkSync, writeSync } from 'node:fs'
import { join, dirname, basename } from 'node:path'
import { homedir } from 'node:os'
import { zstdDecompressSync } from 'node:zlib'

const DSH_ROOT = process.env.DSH_ROOT || join(homedir(), '.dsh')
const SESSIONS_ROOT = process.env.DSH_SESSIONS_ROOT || join(DSH_ROOT, 'sessions')
const STATE_PATH = process.env.DSH_AUTOSTORE_STATE || join(DSH_ROOT, '.dsh-memory-autostore-state.json')
const LOCK_PATH = STATE_PATH + '.lock'

/**
 * 进程锁：防止计划任务/守护的多个实例并发扫描同一批轮次导致重复提交。
 * 用 'wx' 原子创建锁文件；拿不到锁说明已有实例在跑，直接退出。
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

const ZSTD_MAGIC = 4247762216

// ---------- 1. 凭据：DSH cordis.patch.yml（单一事实源）→ 环境变量覆盖 ----------
function loadCredsFromCordis(profileDir) {
  const env = {}
  const patchPath = join(profileDir, 'cordis.patch.yml')
  try {
    const yaml = readFileSync(patchPath, 'utf8')
    const m = yaml.match(/id:\s*mcp-agent-memory[\s\S]*?env:[\s\S]*?((?:[ \t]+[A-Z_]+:.*\n?)+)/)
    if (m) {
      for (const line of m[1].split('\n')) {
        const kv = line.match(/^\s+([A-Z_]+):\s*(.*?)\s*$/)
        if (kv && kv[2] && !kv[2].startsWith('<')) env[kv[1]] = kv[2]
      }
    }
  } catch { /* 找不到配置时回退环境变量 */ }
  return env
}
function loadCreds() {
  const profileDir = process.env.DSH_PROFILE_DIR || join(DSH_ROOT, 'profiles', 'web')
  const fromCordis = loadCredsFromCordis(profileDir)
  const env = { ...fromCordis, ...process.env } // 环境变量覆盖
  const required = ['MEMORY_ENDPOINT', 'API_KEY', 'SERVICE_ID', 'TEAM_ID', 'AGENT_ID', 'USER_ID']
  const missing = required.filter((k) => !env[k])
  if (missing.length) {
    console.error(`[dsh-memory-autostore] 缺少凭据: ${missing.join(', ')}（读 ${profileDir}/cordis.patch.yml 或环境变量）`)
    return null
  }
  return {
    endpoint: env.MEMORY_ENDPOINT.replace(/\/+$/, ''),
    apiKey: env.API_KEY,
    serviceId: env.SERVICE_ID,
    teamId: env.TEAM_ID,
    agentId: env.AGENT_ID,
    userId: env.USER_ID,
    userKey: env.USER_KEY || undefined,
  }
}

// ---------- 2. 会话日志解码（zstd 多帧容器，跳过不完整尾帧） ----------
function decodeZstd(buf) {
  const parts = []
  let pos = 0
  while (pos < buf.length) {
    if (buf.readUInt32LE(pos) !== ZSTD_MAGIC) break
    let o = pos + 4
    const d = buf.readUInt8(o); o += 1
    const ss = (d & 32) !== 0
    const csf = d >>> 6
    const df = d & 3
    const db = df === 3 ? 4 : df
    const csb = csf === 0 ? (ss ? 1 : 0) : 1 << csf
    o += (ss ? 0 : 1) + db + csb
    for (;;) {
      const bh = buf.readUIntLE(o, 3); o += 3
      const last = (bh & 1) !== 0
      const bt = (bh >>> 1) & 3
      const bs = bh >>> 3
      o += bt === 1 ? 1 : bs
      if (last) break
    }
    if ((d & 4) !== 0) o += 4
    parts.push(zstdDecompressSync(buf.subarray(pos, o)).toString('utf8'))
    pos = o
  }
  return parts.join('')
}

function textOf(content) {
  if (!Array.isArray(content)) return null
  const texts = content.filter((b) => b?.type === 'text' && typeof b?.text === 'string' && b.text.trim()).map((b) => b.text)
  return texts.length ? texts.join('\n') : null
}

/**
 * 解析会话文件 → { sessionId, cwd, parentSession, turns }
 * turns：已结束轮次列表 [{ turn, userText, assistantText }]，按 seq 顺序。
 * 归属规则：顺序遍历——user/message(source.kind==='user') 更新 pendingUser；
 * assistant/message 更新 pendingAssistant；turn/end 把 (pendingUser, pendingAssistant)
 * 记为该轮并提交候选（assistant 无文本的轮次跳过）。
 */
function parseSession(file) {
  const buf = readFileSync(file)
  const text = decodeZstd(buf)
  if (!text) return null
  const lines = text.split('\n').filter(Boolean)
  if (!lines.length) return null
  let header
  try { header = JSON.parse(lines[0]) } catch { return null }
  if (header?.type !== 'session' || !header.id) return null

  let pendingUser = null
  let pendingAssistant = null
  let pendingTurn = null
  const turns = []
  for (const line of lines.slice(1)) {
    let ev
    try { ev = JSON.parse(line) } catch { continue }
    const d = ev.data
    if (!d || typeof d !== 'object') continue
    if (ev.type === 'user/message' && d.source?.kind === 'user' && d.role === 'user') {
      const text = textOf(d.content)
      if (text) pendingUser = text
    } else if (ev.type === 'assistant/message' && d.message?.role === 'assistant') {
      const text = textOf(d.message.content)
      if (text) { pendingAssistant = text; pendingTurn = d.turn ?? pendingTurn }
    } else if (ev.type === 'turn/end') {
      const turn = d.turn ?? pendingTurn ?? turns.length + 1
      if (pendingAssistant) {
        turns.push({ turn, userText: pendingUser ?? '', assistantText: pendingAssistant })
      }
      pendingAssistant = null
      pendingTurn = null
      // pendingUser 保留给下一轮（下一轮首个 user/message 会覆盖）
    }
  }
  return { sessionId: header.id, cwd: header.cwd, parentSession: header.parentSession, turns }
}

// ---------- 3. state 去重游标 ----------
function loadState() {
  try { return JSON.parse(readFileSync(STATE_PATH, 'utf8')) } catch { return {} }
}
function saveState(state) {
  try {
    mkdirSync(dirname(STATE_PATH), { recursive: true })
    writeFileSync(STATE_PATH, JSON.stringify(state, null, 2))
  } catch (err) {
    console.error(`[dsh-memory-autostore] state 写入失败: ${err.message}`)
  }
}

// ---------- 4. 提交 ----------
async function postTurn(creds, sessionId, cwd, turn) {
  const taskId = basename(cwd) || 'default'
  const body = {
    team_id: creds.teamId,
    agent_id: creds.agentId,
    user_id: creds.userId,
    task_id: taskId,
    session_id: sessionId,
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
    if (!res.ok) {
      console.error(`[dsh-memory-autostore] POST 失败 ${res.status}: ${text.slice(0, 200)} (session=${sessionId} turn=${turn.turn})`)
      return false
    }
    return true
  } catch (err) {
    console.error(`[dsh-memory-autostore] 提交异常（将重试）: ${err.message} (session=${sessionId} turn=${turn.turn})`)
    return false
  } finally {
    clearTimeout(timer)
  }
}

// ---------- 5. 扫描 + 增量提交 ----------
function walkSessions(root, out = []) {
  if (!existsSync(root)) return out
  for (const name of readdirSync(root)) {
    const p = join(root, name)
    const st = statSync(p)
    if (st.isDirectory()) walkSessions(p, out)
    else if (name.startsWith('session.') && name.endsWith('.zstd')) out.push(p)
  }
  return out
}

/**
 * 文件变更缓存：按 size+mtime 跳过未变化的会话文件，轮询开销极低。
 * fileCache: { [filePath]: "size:mtimeMs" }
 */
const FILE_CACHE_PATH = STATE_PATH.replace(/\.json$/, '.files.json')
function loadFileCache() {
  try { return JSON.parse(readFileSync(FILE_CACHE_PATH, 'utf8')) } catch { return {} }
}
function saveFileCache(cache) {
  try { writeFileSync(FILE_CACHE_PATH, JSON.stringify(cache, null, 2)) } catch { /* 缓存失败不致命 */ }
}

/**
 * 扫描全部会话，提交 state 游标之后的已结束轮次。
 * mode: 'once'（提交增量） | 'baseline'（只记录游标，不提交） | 'backfill'（提交全部）
 * 返回提交成功的轮次数。
 */
async function scanAndSubmit(creds, state, mode) {
  const files = walkSessions(SESSIONS_ROOT)
  const cache = loadFileCache()
  let submitted = 0
  for (const file of files) {
    let sig
    try {
      const st = statSync(file)
      sig = `${st.size}:${Math.trunc(st.mtimeMs)}`
    } catch { continue }
    if (mode !== 'backfill' && cache[file] === sig) continue // 文件未变，跳过解析
    let parsed
    try { parsed = parseSession(file) } catch (err) { console.error(`[parse-fail] ${file}: ${err.message}`); cache[file] = sig; continue }
    if (!parsed) { cache[file] = sig; continue }
    const { sessionId, cwd, parentSession, turns } = parsed
    cache[file] = sig
    if (parentSession) continue // 子代理会话跳过（主会话已含上下文）
    if (!cwd) continue
    const cursor = state[sessionId] ?? 0
    const newTurns = turns.filter((t) => t.turn > cursor)
    if (!newTurns.length) continue
    if (mode === 'baseline') {
      state[sessionId] = turns.length ? Math.max(...turns.map((t) => t.turn)) : cursor
      continue
    }
    for (const turn of newTurns) {
      if (mode === 'backfill') {
        // 回填：失败也继续下一轮（一次性操作，可重跑），仅成功推进游标
        if (await postTurn(creds, sessionId, cwd, turn)) { state[sessionId] = turn.turn; submitted += 1 }
      } else {
        // 增量：失败停在当前轮，游标不推进，下次重试；保证顺序
        const ok = await postTurn(creds, sessionId, cwd, turn)
        if (ok) { state[sessionId] = turn.turn; submitted += 1 }
        else break
      }
    }
  }
  saveState(state)
  saveFileCache(cache)
  return submitted
}

// ---------- 6. 主流程 ----------
const args = process.argv.slice(2)
const dryRun = args.includes('--dry-run')
const backfill = args.includes('--backfill')
const once = args.includes('--once')
const baselineOnly = args.includes('--baseline-only')

const creds = loadCreds()
if (!creds) process.exit(1)

const releaseLock = acquireLock()
if (!releaseLock) {
  console.error('[dsh-memory-autostore] 已有实例在运行（锁文件存在），退出避免重复提交')
  process.exit(0)
}
process.on('exit', releaseLock)
process.on('SIGINT', () => { releaseLock(); process.exit(0) })
process.on('SIGTERM', () => { releaseLock(); process.exit(0) })

const state = loadState()

if (dryRun) {
  const files = walkSessions(SESSIONS_ROOT)
  for (const file of files) {
    const parsed = parseSession(file)
    if (!parsed || parsed.parentSession) continue
    const last = parsed.turns[parsed.turns.length - 1]
    if (!last) continue
    console.log(`[dry-run] session=${parsed.sessionId} cwd=${parsed.cwd} turns=${parsed.turns.length} task_id=${basename(parsed.cwd)}`)
    console.log(`  turn=${last.turn} user[${last.userText.length}] assistant[${last.assistantText.length}]`)
  }
  console.log('[dry-run] 未提交任何数据')
  process.exit(0)
}

if (baselineOnly) {
  // 一次性建基线：把当前所有已结束轮次记为游标（跳过历史，不提交）。
  // 部署时先跑一次 --baseline-only，之后计划任务 --once 只提交增量。
  let baselineTurns = 0
  for (const file of walkSessions(SESSIONS_ROOT)) {
    try {
      const parsed = parseSession(file)
      if (!parsed || parsed.parentSession) continue
      const cur = state[parsed.sessionId] ?? 0
      const maxTurn = parsed.turns.length ? Math.max(...parsed.turns.map((t) => t.turn)) : 0
      if (maxTurn > cur) { state[parsed.sessionId] = maxTurn; baselineTurns += maxTurn - cur }
    } catch { /* 忽略坏文件 */ }
  }
  saveState(state)
  console.log(`[dsh-memory-autostore] 基线已建立：跳过 ${baselineTurns} 轮历史（不回溯提交），之后 --once 只提交增量`)
  process.exit(0)
}

if (once || backfill) {
  const mode = backfill ? 'backfill' : 'once'
  const n = await scanAndSubmit(creds, state, mode)
  console.log(`[dsh-memory-autostore] ${mode === 'backfill' ? '回填' : '增量'}提交 ${n} 轮（state=${STATE_PATH}）`)
  process.exit(0)
}

// 守护模式：先建基线（不回溯历史），再轮询增量（10s；文件 mtime 缓存跳过未变文件）
const baselineState = loadState()
const baselineFiles = walkSessions(SESSIONS_ROOT)
let baselineTurns = 0
for (const file of baselineFiles) {
  try {
    const parsed = parseSession(file)
    if (!parsed || parsed.parentSession) continue
    const cur = baselineState[parsed.sessionId] ?? 0
    const maxTurn = parsed.turns.length ? Math.max(...parsed.turns.map((t) => t.turn)) : 0
    if (maxTurn > cur) { baselineState[parsed.sessionId] = maxTurn; baselineTurns += maxTurn - cur }
  } catch { /* 忽略坏文件 */ }
}
saveState(baselineState)
console.log(`[dsh-memory-autostore] 守护启动：已记录 ${baselineTurns} 轮历史基线（不回溯提交），轮询 ${SESSIONS_ROOT}（10s）`)

const POLL_MS = Number(process.env.DSH_AUTOSTORE_POLL_MS ?? 10000)
async function pollOnce() {
  try {
    const s = loadState()
    const n = await scanAndSubmit(creds, s, 'once')
    if (n > 0) console.log(`[dsh-memory-autostore] 已提交 ${n} 轮`)
  } catch (err) {
    console.error(`[dsh-memory-autostore] 轮询异常（继续）: ${err.message}`)
  }
}
await pollOnce() // 启动立即扫一次（处理守护运行期间漏掉的轮次）
setInterval(pollOnce, POLL_MS)
console.log('[dsh-memory-autostore] 运行中（Ctrl+C 退出）')
