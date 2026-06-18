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
  context?: {
    pluginConfig?: Record<string, unknown>;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

function generateSessionKey(sender: string): string {
  const uuid = crypto.randomUUID().slice(0, 8);
  return `${sender}-${uuid}`;
}

function readConfig(event: HookContext): PluginConfig {
  const raw = event.context?.pluginConfig ?? {};
  const bridgeUrl = raw["bridgeUrl"] as string | undefined;
  const apiKey = raw["apiKey"] as string | undefined;
  const sender = raw["sender"] as string | undefined;

  if (!bridgeUrl) throw new Error("config.bridgeUrl is required");
  if (!apiKey) throw new Error("config.apiKey is required");
  if (!sender) throw new Error("config.sender is required");

  return {
    bridgeUrl,
    apiKey,
    sender,
    sessionKey: raw["sessionKey"] as string | undefined,
  };
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
    api.on("before_prompt_build", async (event: HookContext) => {
      try {
        const config = readConfig(event);
        const sessionKey = resolveSession(config, event);
        const url = `${config.bridgeUrl}/recall`;
        return await httpPost(
          url,
          { query: event.userText ?? event.userInput ?? "", session_key: sessionKey, sender: config.sender },
          buildHeaders(config),
        );
      } catch (err) {
        console.error("[memory-bridge] recall failed (silent):", err);
        return null;
      }
    });

    api.on("agent_end", async (event: HookContext) => {
      try {
        const config = readConfig(event);
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
        const config = readConfig(event);
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
