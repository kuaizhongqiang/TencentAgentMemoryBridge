#!/usr/bin/env node
/**
 * memory-init：新项目记忆初始化（自包含，随 .claude 拷贝）。
 *
 * 场景：把 TencentAgentMemoryBridge 的 .claude 文件夹复制到新项目后，
 *       在新项目里执行本脚本，校验/打通/修复记忆接入。
 *
 * 职责：
 *   1. 校验 .claude/settings.local.json 的 agent-memory MCP 配置是否完整、无占位符
 *   2. 解析运行时身份（team / agent / user / gateway key），task_id 按目录名自动派生
 *   3. 只读健康检查：网关连通 + 数据面读取（/v3/core/read）；有 USER_KEY 时顺带 /v3/meta/auth/verify
 *   4. 修复 Stop hook：引用的脚本缺失时从 skill 内置种子补回；hooks.Stop 缺失时补写
 *   5. 汇报 JSON + 人读摘要；任何单项失败不中断，exit 0
 *
 * 用法：
 *   node <skill>/scripts/init.mjs [--project-dir <path>] [--verify-write] [--json]
 *   --verify-write  额外往 L0 写一条 bootstrap 标记，验证写路径（可选，会留一条测试数据）
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// ---------- 0. 参数与路径 ----------
const args = process.argv.slice(2)
const argVal = (name) => {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : undefined
}
const projectDir = argVal('--project-dir') || process.cwd()
const verifyWrite = args.includes('--verify-write')
const jsonOut = args.includes('--json')

const skillDir = path.dirname(path.dirname(fileURLToPath(import.meta.url))) // .../memory-init
const seedStopScript = path.join(skillDir, 'scripts', 'stop-memory-store.mjs')

const report = { ok: true, project_dir: projectDir, checks: [] }
const add = (name, ok, detail = '') => {
  report.checks.push({ name, ok: !!ok, detail })
  if (!ok) report.ok = false
}

// ---------- 1. 读取并校验 MCP 配置 ----------
const settingsPath = path.join(projectDir, '.claude', 'settings.local.json')
let mcpEnv = {}
if (fs.existsSync(settingsPath)) {
  try {
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'))
    mcpEnv = { ...(settings?.mcpServers?.['agent-memory']?.env ?? {}) }
  } catch (err) {
    add('config.valid', false, `settings.local.json 解析失败: ${err.message}`)
  }
} else {
  add('config.exists', false, `.claude/settings.local.json 不存在（请确认复制了完整 .claude 文件夹）`)
}

const env = { ...mcpEnv, ...process.env } // 环境变量覆盖
const required = ['MEMORY_ENDPOINT', 'API_KEY', 'SERVICE_ID', 'TEAM_ID', 'AGENT_ID', 'USER_ID']
const PLACEHOLDER = /<(.*)>|your-|xxx|sk-your|example/i
const missing = required.filter((k) => !env[k])
const placeholder = required.filter((k) => env[k] && PLACEHOLDER.test(env[k]))
if (missing.length) add('config.required', false, `缺失: ${missing.join(', ')}`)
else if (placeholder.length) add('config.required', false, `疑似占位符: ${placeholder.join(', ')}`)
else add('config.required', true, '必要项齐全')

// ---------- 2. 解析身份 + 派生 task_id ----------
const identity = {
  endpoint: env.MEMORY_ENDPOINT,
  apiKey: env.API_KEY,
  serviceId: env.SERVICE_ID,
  teamId: env.TEAM_ID,
  agentId: env.AGENT_ID,
  userId: env.USER_ID,
  userKey: env.USER_KEY,
}
const taskId = env.TASK_ID || path.basename(projectDir) || 'default' // 与 mcp-bridge deriveTaskIdFromCwd 一致
report.identity = identity
report.task_id = taskId

if (!missing.length) {
  // ---------- 3. 只读健康检查 ----------
  const base = `${identity.endpoint.replace(/\/+$/, '')}`
  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${identity.apiKey}`,
    'x-tdai-service-id': identity.serviceId,
  }
  const iso = { team_id: identity.teamId, agent_id: identity.agentId, user_id: identity.userId, task_id: taskId }

  const call = async (p, body) => {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), 15000)
    try {
      const res = await fetch(`${base}${p}`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: ctrl.signal,
      })
      const text = await res.text()
      let j = {}
      try {
        j = JSON.parse(text)
      } catch {}
      return { status: res.status, code: j.code, message: j.message || text.slice(0, 120) }
    } catch (err) {
      return { status: 0, code: -1, message: err.message }
    } finally {
      clearTimeout(timer)
    }
  }

  const read = await call('/v3/core/read', iso)
  add('gateway.read', read.code === 0, `${identity.endpoint} → /v3/core/read ${read.status} code=${read.code} ${read.message}`)

  if (identity.userKey) {
    const auth = await call('/v3/meta/auth/verify', { user_id: identity.userId, user_key: identity.userKey })
    add('gateway.auth', auth.code === 0, `/v3/meta/auth/verify code=${auth.code} ${auth.message}`)
  } else {
    add('gateway.auth', null, '未配置 USER_KEY，跳过 meta 面鉴权校验')
  }

  if (verifyWrite) {
    const w = await call('/v3/conversation/add', {
      ...iso,
      session_id: `memory-init-${Date.now()}`,
      messages: [
        { role: 'user', content: 'memory-init bootstrap（验证写路径）' },
        { role: 'assistant', content: 'ok' },
      ],
    })
    add('gateway.write', w.code === 0, `/v3/conversation/add code=${w.code} ${w.message}`)
  }
}

// ---------- 4. 修复 Stop hook（引用的脚本缺失则补回；hooks.Stop 缺失则补写） ----------
const stopScriptRef = 'scripts/stop-memory-store.mjs'
const settings = fs.existsSync(settingsPath) ? JSON.parse(fs.readFileSync(settingsPath, 'utf8')) : {}
const hooks = settings.hooks || {}
const stopHooks = (hooks.Stop || []).flatMap((g) => (g.hooks || []).filter((h) => h.type === 'command'))
const refs = stopHooks.map((h) => h.command).filter((c) => /^node\s+\S+/.test(c || '')).map((c) => c.replace(/^node\s+/, '').trim())

let hookStatus = '存在'
let repaired = []
if (!fs.existsSync(settingsPath)) {
  // settings.local.json 不存在（复制不完整）→ 不补写，交由 config 检查项报错
  hookStatus = '跳过（settings.local.json 缺失）'
} else if (!refs.length) {
  // 未配置 Stop hook → 补写
  hooks.Stop = [{ hooks: [{ type: 'command', command: `node ${stopScriptRef}`, timeout: 30, statusMessage: 'Storing conversation turn to memory…' }] }]
  settings.hooks = hooks
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n')
  refs.push(stopScriptRef)
  hookStatus = '已补写'
  repaired.push('hooks.Stop')
}
for (const ref of refs) {
  if (ref.includes('${') || /^[a-zA-Z]:[\\/]/.test(ref) || ref.startsWith('/')) continue // 占位符/绝对路径跳过
  const target = path.resolve(projectDir, ref)
  if (!fs.existsSync(target)) {
    if (fs.existsSync(seedStopScript)) {
      fs.mkdirSync(path.dirname(target), { recursive: true })
      fs.writeFileSync(target, fs.readFileSync(seedStopScript, 'utf8'))
      repaired.push(ref)
      add('hook.script', true, `${ref} 缺失，已从 skill 种子补回`)
    } else {
      add('hook.script', false, `${ref} 缺失，且 skill 内无种子可补（请复制完整 .claude）`)
    }
  }
}
if (!repaired.length && hookStatus === '存在') add('hook.script', true, 'Stop hook 脚本齐全')
report.hook = { status: hookStatus, repaired }

// ---------- 5. 确保 state 文件被 gitignore ----------
const gitignorePath = path.join(projectDir, '.gitignore')
if (fs.existsSync(gitignorePath)) {
  let gi = fs.readFileSync(gitignorePath, 'utf8')
  if (!gi.includes('.claude/.memory-store-state.json')) {
    fs.appendFileSync(gitignorePath, '\n.claude/.memory-store-state.json\n')
    report.hook.repaired.push('.gitignore: .claude/.memory-store-state.json')
  }
}

// ---------- 6. 输出 ----------
if (jsonOut) {
  console.log(JSON.stringify(report, null, 2))
} else {
  console.log('=== memory-init 结果 ===')
  console.log(`项目      : ${projectDir}`)
  console.log(`task_id   : ${taskId}（目录名自动派生${env.TASK_ID ? '，TASK_ID 覆盖' : ''}）`)
  console.log(`身份      : team=${identity.teamId} agent=${identity.agentId} user=${identity.userId}`)
  console.log(`网关      : ${identity.endpoint}${identity.userKey ? '' : '（无 USER_KEY）'}`)
  for (const c of report.checks) {
    const mark = c.ok === null ? '·' : c.ok ? '✅' : '❌'
    console.log(`${mark} ${c.name}: ${c.detail}`)
  }
  console.log(`Stop hook : ${report.hook.status}${report.hook.repaired.length ? '，修复: ' + report.hook.repaired.join(', ') : ''}`)
  if (!report.ok) {
    console.log('\n⚠️ 存在未通过项，按上面 ❌ 逐项处理；缺失脚本已自动补回。')
  } else {
    console.log('\n✅ 记忆接入就绪。recall_memory 按需调用，每轮对话由 Stop hook 自动入库。')
  }
}
process.exit(0)
