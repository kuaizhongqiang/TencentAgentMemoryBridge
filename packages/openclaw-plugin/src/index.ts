import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";

interface PluginConfig {
  bridgeUrl: string;
  apiKey: string;
  sender: string;
  sessionKey?: string;
}

interface HookContext {
  sessionKey?: string;
  userInput?: string;
  userText?: string;
  assistantOutput?: string;
}

function loadConfig(): PluginConfig {
  const bridgeUrl = process.env.BRIDGE_URL;
  const apiKey = process.env.API_KEY;
  const sender = process.env.SENDER;

  if (!bridgeUrl) throw new Error("BRIDGE_URL environment variable is required");
  if (!apiKey) throw new Error("API_KEY environment variable is required");
  if (!sender) throw new Error("SENDER environment variable is required");

  return { bridgeUrl, apiKey, sender, sessionKey: process.env.SESSION_KEY };
}

function generateSessionKey(sender: string): string {
  const uuid = crypto.randomUUID().slice(0, 8);
  return `${sender}-${uuid}`;
}

function resolveSession(config: PluginConfig, ctx: HookContext): string {
  return ctx.sessionKey || config.sessionKey || generateSessionKey(config.sender);
}

async function httpPost(url: string, body: unknown, headers: Record<string, string>): Promise<unknown> {
  const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(`Bridge server error (${res.status}): ${JSON.stringify(data)}`);
  }
  return data;
}

function buildHeaders(config: PluginConfig): Record<string, string> {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${config.apiKey}`,
    "X-Sender": config.sender,
  };
}

export default definePluginEntry({
  id: "memory-bridge",
  name: "Memory Bridge",
  version: "0.1.0",

  register(api) {
    let config: PluginConfig;

    try {
      config = loadConfig();
    } catch (err) {
      console.error("[memory-bridge] Config error:", err);
      return;
    }

    api.on("before_prompt_build", async (event: HookContext) => {
      try {
        const sessionKey = resolveSession(config, event);
        const url = `${config.bridgeUrl}/recall`;
        return await httpPost(
          url,
          { query: event.userText ?? event.userInput ?? "", session_key: sessionKey },
          buildHeaders(config),
        );
      } catch (err) {
        console.error("[memory-bridge] recall failed (silent):", err);
        return null;
      }
    });

    api.on("agent_end", async (event: HookContext) => {
      try {
        const sessionKey = resolveSession(config, event);
        const url = `${config.bridgeUrl}/capture`;
        return await httpPost(
          url,
          {
            user_content: event.userInput ?? "",
            assistant_content: event.assistantOutput ?? "",
            session_key: sessionKey,
          },
          buildHeaders(config),
        );
      } catch (err) {
        console.error("[memory-bridge] capture failed (silent):", err);
        return null;
      }
    });

    api.on("session_end", async (event: HookContext) => {
      try {
        const sessionKey = resolveSession(config, event);
        const url = `${config.bridgeUrl}/session/end`;
        return await httpPost(
          url,
          { session_key: sessionKey },
          buildHeaders(config),
        );
      } catch (err) {
        console.error("[memory-bridge] session/end failed (silent):", err);
        return null;
      }
    });
  },
});
