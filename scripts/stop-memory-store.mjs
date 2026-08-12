#!/usr/bin/env node
/**
 * Stop hook: Claude 每轮对话生成完成后，把最后一轮 user/assistant 文本自动写入 L0 记忆。
 *
 * 数据流：
 *   Claude Code 在 Stop 事件把 { session_id, transcript_path, cwd } 通过 stdin JSON 传入
 *   → 读 transcript JSONL，提取最后一段 user 文本 + 最后一段 assistant 文本
 *   → POST {MEMORY_ENDPOINT}/v3/conversation/add（与 mcp-bridge 同一数据面协议）
 *
 * 凭据来源（按优先级）：
 *   1. 环境变量 MEMORY_ENDPOINT / API_KEY / SERVICE_ID / TEAM_ID / AGENT_ID / USER_ID / TASK_ID
 *   2. .claude/settings.local.json 里 mcpServers.agent-memory.env（单一事实源，避免复制密钥）
 *
 * 去重：按 session_id + 最后 assistant 时间戳写 .claude/.memory-store-state.json，
 *      防止 /compact、/resume 等重复入库同一轮。
 *
 * 任何失败都 exit 0（记录到 stderr），绝不让 Stop hook 阻塞用户。
 */
import fs from 'node:fs'
import path from 'node:path'

// ---------- 1. 读取 hook 输入 ----------
let input = {}
try {
  input = JSON.parse(fs.readFileSync(0, 'utf8'))
} catch {
  /* 手动运行 / 无 stdin 时忽略 */
}
const cwd = input.cwd || process.cwd()
const transcriptPath = input.transcript_path
const sessionId = input.session_id
const dryRun = process.argv.includes('--dry-run')

// ---------- 2. 解析记忆配置 ----------
function loadMcpEnv(projectDir) {
  const env = {}
  const settingsPath = path.join(projectDir, '.claude', 'settings.local.json')
  try {
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'))
    Object.assign(env, settings?.mcpServers?.['agent-memory']?.env ?? {})
  } catch {
    /* settings.local.json 不存在/不可读时回退环境变量 */
  }
  return env
}
const env = { ...loadMcpEnv(cwd), ...process.env }

const endpoint = env.MEMORY_ENDPOINT
const apiKey = env.API_KEY
const serviceId = env.SERVICE_ID
const teamId = env.TEAM_ID
const agentId = env.AGENT_ID
const userId = env.USER_ID

if (!endpoint || !apiKey || !serviceId || !teamId || !agentId || !userId) {
  console.error('[memory-stop-hook] 缺少 MEMORY_ENDPOINT/API_KEY/SERVICE_ID/TEAM_ID/AGENT_ID/USER_ID 配置，跳过')
  process.exit(0)
}

const taskId = env.TASK_ID || path.basename(cwd) || 'default'
const sessionKey = env.SESSION_KEY || sessionId || `${agentId}-${new Date().toISOString().slice(0, 10)}`

// ---------- 3. 从 transcript 提取最后一轮 ----------
function extractLastTurn(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return null
  let lastUserText = null
  let lastAssistantText = null
  let lastAssistantTs = null
  for (const line of fs.readFileSync(filePath, 'utf8').split('\n')) {
    if (!line.trim()) continue
    let entry
    try {
      entry = JSON.parse(line)
    } catch {
      continue
    }
    const msg = entry?.message
    if (!msg) continue

    if (entry.type === 'user' && msg.role === 'user') {
      const text = extractTextBlocks(msg.content)
      if (text) lastUserText = text
    } else if (entry.type === 'assistant') {
      const text = extractTextBlocks(msg.content)
      if (text) {
        lastAssistantText = text
        lastAssistantTs = msg.timestamp || entry.timestamp || null
      }
    }
  }
  return { user_content: lastUserText, assistant_content: lastAssistantText, assistant_ts: lastAssistantTs }
}

function extractTextBlocks(content) {
  if (Array.isArray(content)) {
    return content
      .filter((b) => b?.type === 'text' && b?.text)
      .map((b) => b.text)
      .join('\n')
  }
  return typeof content === 'string' && content.trim() ? content : null
}

const turn = extractLastTurn(transcriptPath)
if (!turn?.assistant_content) {
  console.error('[memory-stop-hook] transcript 无完成的 assistant 文本（中断/空轮），跳过')
  process.exit(0)
}

// ---------- 4. 去重：同 session 同时间戳不重复入库 ----------
const statePath = path.join(cwd, '.claude', '.memory-store-state.json')
let state = {}
try {
  state = JSON.parse(fs.readFileSync(statePath, 'utf8'))
} catch {
  state = {}
}
const key = sessionKey
if (turn.assistant_ts && state[key]?.lastTs === turn.assistant_ts) {
  console.error('[memory-stop-hook] 该轮已入库，跳过')
  process.exit(0)
}

// ---------- 5. 写入 MemoryCore /v3/conversation/add ----------
const body = {
  team_id: teamId,
  agent_id: agentId,
  user_id: userId,
  task_id: taskId,
  session_id: sessionKey,
  messages: [
    { role: 'user', content: turn.user_content ?? '' },
    { role: 'assistant', content: turn.assistant_content },
  ],
}

if (dryRun) {
  console.log(JSON.stringify({ endpoint: `${endpoint.replace(/\/+$/, '')}/v3/conversation/add`, body }, null, 2))
  process.exit(0)
}

async function post() {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 5000)
  try {
    const res = await fetch(`${endpoint.replace(/\/+$/, '')}/v3/conversation/add`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
        'x-tdai-service-id': serviceId,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    })
    const text = await res.text()
    if (!res.ok) {
      console.error(`[memory-stop-hook] MemoryCore 返回 ${res.status}: ${text.slice(0, 300)}`)
      return
    }
    // 记录去重标记（仅成功后）
    state[key] = { lastTs: turn.assistant_ts || null }
    try {
      fs.mkdirSync(path.dirname(statePath), { recursive: true })
      fs.writeFileSync(statePath, JSON.stringify(state, null, 2))
    } catch (err) {
      console.error(`[memory-stop-hook] 状态写入失败（不影响存储）: ${err.message}`)
    }
    console.error(`[memory-stop-hook] 已写入 L0 session=${sessionKey}`)
  } catch (err) {
    console.error(`[memory-stop-hook] 写入失败（忽略，不阻塞）：${err.message}`)
  } finally {
    clearTimeout(timer)
  }
}

await post()
process.exit(0)
