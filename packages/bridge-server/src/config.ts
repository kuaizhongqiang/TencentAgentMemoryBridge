import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

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

function parseAgent(raw: unknown): AgentConfig | null {
  if (typeof raw !== 'object' || raw === null) return null
  const obj = raw as Record<string, unknown>
  if (typeof obj.name !== 'string' || typeof obj.apiKeyHash !== 'string') {
    console.warn('Skipping agent config: missing name or apiKeyHash', obj)
    return null
  }
  if (!Array.isArray(obj.allowedEndpoints)) {
    console.warn('Skipping agent config: allowedEndpoints is not an array', obj)
    return null
  }
  return {
    name: obj.name,
    apiKeyHash: obj.apiKeyHash,
    allowedEndpoints: obj.allowedEndpoints.filter((e): e is string => typeof e === 'string'),
  }
}

function loadAgentsFromFile(filePath: string): AgentConfig[] {
  try {
    const resolved = resolve(filePath)
    const raw = readFileSync(resolved, 'utf-8')
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) {
      console.error('AGENTS_FILE must contain a JSON array')
      return []
    }
    return parsed.map(parseAgent).filter((a): a is AgentConfig => a !== null)
  } catch (err) {
    console.error(`Failed to load agents file: ${filePath}`, err)
    return []
  }
}

function loadAgentsFromEnv(raw: string | undefined): AgentConfig[] {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) {
      console.error('AGENTS env var must contain a JSON array')
      return []
    }
    return parsed.map(parseAgent).filter((a): a is AgentConfig => a !== null)
  } catch {
    console.error('Failed to parse AGENTS env var as JSON')
    return []
  }
}

export function loadConfig(): AppConfig {
  const agents = process.env.AGENTS_FILE
    ? loadAgentsFromFile(process.env.AGENTS_FILE)
    : loadAgentsFromEnv(process.env.AGENTS)

  return {
    port: parseInt(process.env.PORT || '3000', 10),
    tencentDbUrl: process.env.TENCENTDB_URL || 'http://localhost:8080',
    agents,
  }
}
