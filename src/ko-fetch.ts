export interface KoConfig {
  baseUrl: string;
  apiKey: string;
}

export async function koFetch<T = unknown>(
  config: KoConfig,
  path: string,
  params: Record<string, string | number | boolean | undefined> = {}
): Promise<T> {
  const url = new URL(path, config.baseUrl);

  // When no API key, use demo mode
  if (!config.apiKey) {
    url.searchParams.set("demo", "true");
  }

  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== "") {
      url.searchParams.set(key, String(value));
    }
  }

  const headers: Record<string, string> = {
    Accept: "application/json",
    "User-Agent": "ko-mcp-worker/1.0",
  };

  if (config.apiKey) {
    headers["X-API-Key"] = config.apiKey;
  }

  const res = await fetch(url.toString(), { headers });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `ko.io API error: ${res.status} ${res.statusText} — ${body.slice(0, 300)}`
    );
  }

  return res.json() as Promise<T>;
}
