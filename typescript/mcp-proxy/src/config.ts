export const DEFAULT_MCP_URL = "https://mcp.ko.io/mcp";

export interface ProxyConfig {
  /** Remote Streamable HTTP MCP endpoint. */
  url: string;
  /** ko.io API key; omitted -> remote serves demo mode. */
  apiKey?: string;
}

/** Parse configuration from environment variables. Pure — pass a custom env for tests. */
export function loadConfig(env: Record<string, string | undefined> = process.env): ProxyConfig {
  const raw = env.KO_MCP_URL?.trim() || DEFAULT_MCP_URL;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`KO_MCP_URL is not a valid URL: "${raw}"`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`KO_MCP_URL must be an http(s) URL, got "${parsed.protocol}//"`);
  }

  const apiKey = env.KO_API_KEY?.trim();
  const config: ProxyConfig = { url: parsed.toString() };
  if (apiKey) config.apiKey = apiKey;
  return config;
}

/** HTTP headers to send to the remote MCP server. */
export function requestHeaders(config: ProxyConfig): Record<string, string> {
  return config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {};
}
