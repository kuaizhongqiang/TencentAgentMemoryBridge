// Type declarations for OpenClaw SDK (provided by the OpenClaw runtime)
// Not a direct dependency — consumers install openclaw themselves.

declare module "openclaw/plugin-sdk/plugin-entry" {
  interface PluginApi {
    on(event: string, handler: (event: any) => any): void;
  }

  interface PluginDefinition {
    id: string;
    name: string;
    version?: string;
    register: (api: PluginApi) => void;
  }

  export function definePluginEntry(def: PluginDefinition): PluginDefinition;
}
