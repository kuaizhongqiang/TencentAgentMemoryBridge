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
  /** task_id（可选）：项目级区分；未配则从项目路径自动派生 */
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
 * MCP stdio 服务由 Claude Code 启动，process.cwd() 即当前项目目录，
 * 取目录名作为项目级 task_id（如 TencentAgentMemoryBridge）。
 */
function deriveTaskIdFromCwd(): string {
  const cwd = process.cwd()
  const base = cwd.split(/[\\/]/).filter(Boolean).pop()?.trim()
  return base || 'default'
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

  return {
    endpoint: endpoint!,
    apiKey: apiKey!,
    serviceId: serviceId!,
    teamId: teamId!,
    agentId: agentId!,
    userId: userId!,
    userKey: process.env.USER_KEY || undefined,
    taskId: process.env.TASK_ID || deriveTaskIdFromCwd(),
    sessionKey: process.env.SESSION_KEY || generateSessionKey(agentId!),
    timeoutMs,
  }
}
