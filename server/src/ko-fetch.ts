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
    headers["Authorization"] = `Bearer ${config.apiKey}`;
  }

  const res = await fetch(url.toString(), { headers });

  if (!res.ok) {
    // Surface a generic, status-based message — do NOT pass through ko-api's raw
    // error body (could contain internal/upstream detail) to the model/user.
    // Prefer the structured { error: { message } } field if ko-api provided one.
    let detail = "";
    try {
      const j = await res.json() as { error?: { message?: string } };
      if (typeof j?.error?.message === "string") detail = `: ${j.error.message}`;
    } catch { /* non-JSON body — ignore */ }
    const generic: Record<number, string> = {
      400: "Bad request", 401: "Authentication required", 403: "Access forbidden (check your plan)",
      404: "Not found", 429: "Rate limit exceeded", 500: "Upstream error", 502: "Upstream error", 503: "Service unavailable",
    };
    throw new Error(`ko.io API error (${res.status}): ${generic[res.status] ?? "Request failed"}${detail}`);
  }

  const json = await res.json() as Record<string, unknown>;
  // ko-api wraps responses in { data: ..., meta: ... } — unwrap automatically
  return (json.data !== undefined ? json.data : json) as T;
}
