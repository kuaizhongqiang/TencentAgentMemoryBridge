export interface AgentConfig {
  name: string
  apiKeyHash: string
  allowedEndpoints: string[]
}

export interface AppConfig {
  port: number
  tencentDbUrl: string
  agents: AgentConfig[]
}

function parseAgents(raw: string | undefined): AgentConfig[] {
  if (!raw) return []
  try {
    return JSON.parse(raw) as AgentConfig[]
  } catch {
    console.error('Invalid AGENTS config JSON')
    return []
  }
}

export function loadConfig(): AppConfig {
  return {
    port: parseInt(process.env.PORT || '3000', 10),
    tencentDbUrl: process.env.TENCENTDB_URL || 'http://localhost:8080',
    agents: parseAgents(process.env.AGENTS),
  }
}
