export interface McpConfig {
  bridgeUrl: string
  apiKey: string
  sender: string
  sessionKey: string
}

function generateSessionKey(sender: string): string {
  const ts = Date.now().toString(36)
  const rand = Math.random().toString(36).slice(2, 8)
  return `${sender}-${ts}-${rand}`
}

export function loadConfig(): McpConfig {
  const bridgeUrl = process.env.BRIDGE_URL
  const apiKey = process.env.API_KEY
  const sender = process.env.SENDER

  if (!bridgeUrl) throw new Error('BRIDGE_URL environment variable is required')
  if (!apiKey) throw new Error('API_KEY environment variable is required')
  if (!sender) throw new Error('SENDER environment variable is required')

  return {
    bridgeUrl,
    apiKey,
    sender,
    sessionKey: process.env.SESSION_KEY || generateSessionKey(sender),
  }
}
