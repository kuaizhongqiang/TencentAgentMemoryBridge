export interface McpConfig {
  /** MemoryCore Gateway 地址，如 https://memory.kuai-private.top */
  endpoint: string
  /** 网关门禁 key（Authorization: Bearer），多 agent 共用 */
  apiKey: string
  /** memory 实例 id（x-tdai-service-id header），即 spaceId */
  serviceId: string
  /** v3 隔离：团队 id */
  teamId: string
  /** v3 隔离：agent id（每平台一个，如 agt-w7end3dcl9） */
  agentId: string
  /** v3 隔离：user id */
  userId: string
  /** 该 agent 的 user_key（可选，用于 meta 面鉴权） */
  userKey?: string
  /** task_id（可选）：项目级隔离标签（自由字符串，如项目目录名）。与身份 id（team/agent/user）严格分离，拒绝 agt-/team-/usr- 等身份前缀；未配则从项目路径自动派生 */
  taskId?: string
  /** 默认 session key；未配则按 agentId+日期生成 */
  sessionKey: string
  /** 单次请求超时（毫秒） */
  timeoutMs: number
}

function generateSessionKey(agentId: string): string {
  const today = new Date().toISOString().slice(0, 10)
  return `${agentId}-${today}`
}

/**
 * 按项目路径自动派生 task_id。
 * MCP stdio 服务由客户端（Claude Code / CodeBuddy / DeepSeek Harness 等）启动，
 * process.cwd() 即当前项目目录，取目录名作为项目级 task_id（如 TencentAgentMemoryBridge）。
 *
 * task_id 语义：**项目级隔离标签**（自由字符串），与身份 id 严格分离——
 *   - team_id / agent_id / user_id = 身份（meta 面注册实体，形如 agt-xxx / team-xxx / usr-xxx）
 *   - task_id = 项目级标签（目录名或显式 TASK_ID），绝不是身份 id
 */
function deriveTaskIdFromCwd(): string {
  const cwd = process.cwd()
  const base = cwd.split(/[\\/]/).filter(Boolean).pop()?.trim()
  return base || 'default'
}

/**
 * 身份 id 前缀白名单——这些前缀属于 meta 面实体，永远不能当 task_id 用。
 * 防止把 AGENT_ID（agt-...）/ TEAM_ID（team-...）/ USER_ID（usr-...）/
 * user_key（sk-mem-... / uky-...）/ 网关门禁 key 误配进 TASK_ID，造成项目级
 * 隔离被身份 id 污染（所有项目共享同一个"task"）。
 */
const IDENTITY_PREFIXES = /^(agt-|team-|usr-|uky-|sk-mem-|sk-|key-)/i

function assertValidTaskId(taskId: string, source: 'TASK_ID' | 'cwd'): string {
  const trimmed = taskId.trim()
  if (!trimmed) throw new Error('TASK_ID resolved to an empty string')
  if (IDENTITY_PREFIXES.test(trimmed)) {
    throw new Error(
      `Invalid task_id '${trimmed}' (from ${source}): task_id is a project-level label and must NOT be an identity id. ` +
        `Do not put AGENT_ID (agt-*), TEAM_ID (team-*), USER_ID (usr-*) or a key (sk-mem-*/uky-*) here. ` +
        `Use a project name, e.g. TASK_ID=my-project or the default cwd-derived name.`,
    )
  }
  return trimmed
}

export function loadConfig(): McpConfig {
  const endpoint = process.env.MEMORY_ENDPOINT
  const apiKey = process.env.API_KEY
  const serviceId = process.env.SERVICE_ID
  const teamId = process.env.TEAM_ID
  const agentId = process.env.AGENT_ID
  const userId = process.env.USER_ID

  const required: Array<[string, string | undefined]> = [
    ['MEMORY_ENDPOINT', endpoint],
    ['API_KEY', apiKey],
    ['SERVICE_ID', serviceId],
    ['TEAM_ID', teamId],
    ['AGENT_ID', agentId],
    ['USER_ID', userId],
  ]

  const missing = required.filter(([, v]) => !v).map(([name]) => name)
  if (missing.length > 0) {
    throw new Error(`Missing required environment variable(s): ${missing.join(', ')}`)
  }

  const timeoutRaw = Number(process.env.TIMEOUT_MS ?? 15000)
  const timeoutMs = Number.isFinite(timeoutRaw) && timeoutRaw > 0 ? timeoutRaw : 15000

  // task_id：显式 TASK_ID 优先，否则从项目路径（cwd 目录名）派生；两者都做防混用校验
  const taskId = assertValidTaskId(process.env.TASK_ID ?? deriveTaskIdFromCwd(), process.env.TASK_ID ? 'TASK_ID' : 'cwd')

  return {
    endpoint: endpoint!,
    apiKey: apiKey!,
    serviceId: serviceId!,
    teamId: teamId!,
    agentId: agentId!,
    userId: userId!,
    userKey: process.env.USER_KEY || undefined,
    taskId,
    sessionKey: process.env.SESSION_KEY || generateSessionKey(agentId!),
    timeoutMs,
  }
}
