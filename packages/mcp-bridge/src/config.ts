export function loadConfig() {
  const bridgeUrl = process.env.BRIDGE_URL
  const apiKey = process.env.API_KEY
  const sender = process.env.SENDER

  if (!bridgeUrl) throw new Error('BRIDGE_URL environment variable is required')
  if (!apiKey) throw new Error('API_KEY environment variable is required')
  if (!sender) throw new Error('SENDER environment variable is required')

  return { bridgeUrl, apiKey, sender }
}
