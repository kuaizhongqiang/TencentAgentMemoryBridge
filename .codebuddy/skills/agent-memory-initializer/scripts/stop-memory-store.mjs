#!/usr/bin/env node
/**
 * CodeBuddy Stop hook: 每轮对话完成后自动写入 L0 记忆。
 *
 * 数据流：
 *   CodeBuddy 在 Stop 事件把 { session_id, transcript_path, cwd } 通过 stdin JSON 传入
 *   -> 读 transcript JSONL，提取最后一轮 user + assistant 文本
 *   -> POST {MEMORY_ENDPOINT}/v3/conversation/add
 *
 * 去重：按 session_key + 最后 assistant 时间戳写 .codebuddy/.memory-store-state.json
 * 任何失败都 exit 0（记录到 stderr），绝不让 Stop hook 阻塞用户。
 */
import fs from 'node:fs'
import path from 'node:path'

// ---------- 1. 读取 hook 输入 ----------
var input = {}
try {
  input = JSON.parse(fs.readFileSync(0, 'utf8'))
} catch (e) {
  /* 手动运行 / 无 stdin 时忽略 */
}
var cwd = input.cwd || process.cwd()
var transcriptPath = input.transcript_path
var sessionId = input.session_id
var dryRun = process.argv.includes('--dry-run')

// ---------- 2. 从 .codebuddy/mcp.json 读取记忆配置 ----------
function loadMcpEnv(projectDir) {
  var env = {}
  var mcpPath = path.join(projectDir, '.codebuddy', 'mcp.json')
  try {
    var mcp = JSON.parse(fs.readFileSync(mcpPath, 'utf8'))
    Object.assign(env, mcp.mcpServers['agent-memory'].env || {})
  } catch (e) {
    /* mcp.json 不存在/不可读时回退环境变量 */
  }
  return env
}
var env = Object.assign({}, loadMcpEnv(cwd), process.env)

var endpoint = env.MEMORY_ENDPOINT
var apiKey = env.API_KEY
var serviceId = env.SERVICE_ID
var teamId = env.TEAM_ID
var agentId = env.AGENT_ID
var userId = env.USER_ID

if (!endpoint || !apiKey || !serviceId || !teamId || !agentId || !userId) {
  console.error('[memory-stop-hook] 缺少 MEMORY_ENDPOINT/API_KEY/SERVICE_ID/TEAM_ID/AGENT_ID/USER_ID 配置，跳过')
  process.exit(0)
}

// task_id 与身份 id 严格分离：显式 TASK_ID 优先，否则按项目目录名派生；
// 拒绝身份前缀（agt-/team-/usr-/uky-/sk-），防止把 AGENT_ID 等当 task_id 用。
var IDENTITY_PREFIX = /^(agt-|team-|usr-|uky-|sk-mem-|sk-|key-)/i
var taskIdRaw = env.TASK_ID || path.basename(cwd) || 'default'
var taskId = taskIdRaw.trim()
if (!taskId || IDENTITY_PREFIX.test(taskId)) {
  console.error('[memory-stop-hook] task_id 非法（\'' + taskIdRaw + '\'）：task_id 是项目级标签（如项目目录名），不能用身份 id（agt-/team-/usr-/sk- 前缀）。跳过')
  process.exit(0)
}
var sessionKey = env.SESSION_KEY || sessionId || (agentId + '-' + new Date().toISOString().slice(0, 10))

// ---------- 3. 从 transcript 提取最后一轮 ----------
function extractLastTurn(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return null
  var lastUserText = null
  var lastAssistantText = null
  var lastAssistantTs = null
  var lines = fs.readFileSync(filePath, 'utf8').split('\n')
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i]
    if (!line.trim()) continue
    var entry
    try {
      entry = JSON.parse(line)
    } catch (e) {
      continue
    }
    var msg = entry && entry.message
    if (!msg) continue

    if (entry.type === 'user' && msg.role === 'user') {
      var text = extractTextBlocks(msg.content)
      if (text) lastUserText = text
    } else if (entry.type === 'assistant') {
      var text2 = extractTextBlocks(msg.content)
      if (text2) {
        lastAssistantText = text2
        lastAssistantTs = msg.timestamp || entry.timestamp || null
      }
    }
  }
  return { user_content: lastUserText, assistant_content: lastAssistantText, assistant_ts: lastAssistantTs }
}

function extractTextBlocks(content) {
  if (Array.isArray(content)) {
    return content
      .filter(function (b) { return b && b.type === 'text' && b.text })
      .map(function (b) { return b.text })
      .join('\n')
  }
  return typeof content === 'string' && content.trim() ? content : null
}

var turn = extractLastTurn(transcriptPath)
if (!turn || !turn.assistant_content) {
  console.error('[memory-stop-hook] transcript 无完成的 assistant 文本（中断/空轮），跳过')
  process.exit(0)
}

// ---------- 4. 去重：同 session 同时间戳不重复入库 ----------
var statePath = path.join(cwd, '.codebuddy', '.memory-store-state.json')
var state = {}
try {
  state = JSON.parse(fs.readFileSync(statePath, 'utf8'))
} catch (e) {
  state = {}
}
var key = sessionKey
if (turn.assistant_ts && state[key] && state[key].lastTs === turn.assistant_ts) {
  console.error('[memory-stop-hook] 该轮已入库，跳过')
  process.exit(0)
}

// ---------- 5. 写入 MemoryCore /v3/conversation/add ----------
var body = {
  team_id: teamId,
  agent_id: agentId,
  user_id: userId,
  task_id: taskId,
  session_id: sessionKey,
  messages: [
    { role: 'user', content: turn.user_content || '' },
    { role: 'assistant', content: turn.assistant_content }
  ]
}

if (dryRun) {
  console.log(JSON.stringify({ endpoint: endpoint.replace(/\/+$/, '') + '/v3/conversation/add', body: body }, null, 2))
  process.exit(0)
}

async function post() {
  var controller = new AbortController()
  var timer = setTimeout(function () { controller.abort() }, 5000)
  try {
    var res = await fetch(endpoint.replace(/\/+$/, '') + '/v3/conversation/add', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + apiKey,
        'x-tdai-service-id': serviceId
      },
      body: JSON.stringify(body),
      signal: controller.signal
    })
    var text = await res.text()
    if (!res.ok) {
      console.error('[memory-stop-hook] MemoryCore 返回 ' + res.status + ': ' + text.slice(0, 300))
      return
    }
    // 记录去重标记（仅成功后）
    state[key] = { lastTs: turn.assistant_ts || null }
    try {
      fs.mkdirSync(path.dirname(statePath), { recursive: true })
      fs.writeFileSync(statePath, JSON.stringify(state, null, 2))
    } catch (err) {
      console.error('[memory-stop-hook] 状态写入失败（不影响存储）: ' + err.message)
    }
    console.error('[memory-stop-hook] 已写入 L0 session=' + sessionKey)
  } catch (err) {
    console.error('[memory-stop-hook] 写入失败（忽略，不阻塞）：' + err.message)
  } finally {
    clearTimeout(timer)
  }
}

post().then(function () { process.exit(0) })
