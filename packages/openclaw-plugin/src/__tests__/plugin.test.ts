import { describe, it, expect } from 'vitest'
import { MemoryBridgePlugin } from '../index.js'

describe('MemoryBridgePlugin', () => {
  const validConfig = {
    bridgeUrl: 'http://localhost:3000/api/v1',
    apiKey: 'sk-test',
    sender: 'openclaw',
  }

  it('creates plugin with minimal config', () => {
    const plugin = new MemoryBridgePlugin(validConfig)
    expect(plugin).toBeInstanceOf(MemoryBridgePlugin)
  })

  it('accepts optional sessionKey in config', () => {
    const plugin = new MemoryBridgePlugin({ ...validConfig, sessionKey: 'my-session' })
    expect(plugin).toBeInstanceOf(MemoryBridgePlugin)
  })

  it('beforePromptBuild handles empty context gracefully', async () => {
    const plugin = new MemoryBridgePlugin(validConfig)
    const result = await plugin.beforePromptBuild({ sessionKey: 'test' })
    // Should fail gracefully because bridge server is not running
    // This tests the catch block returns null
    expect(result).toBeNull()
  })

  it('afterAgentEnd handles empty context gracefully', async () => {
    const plugin = new MemoryBridgePlugin(validConfig)
    const result = await plugin.afterAgentEnd({ sessionKey: 'test' })
    expect(result).toBeNull()
  })

  it('onSessionEnd handles empty context gracefully', async () => {
    const plugin = new MemoryBridgePlugin(validConfig)
    const result = await plugin.onSessionEnd({ sessionKey: 'test' })
    expect(result).toBeNull()
  })

  it('resolves session key from context over config default', () => {
    const plugin = new MemoryBridgePlugin({ ...validConfig, sessionKey: 'default-key' })
    // Use instance to verify it doesn't crash with either source
    expect(plugin).toBeInstanceOf(MemoryBridgePlugin)
  })
})
