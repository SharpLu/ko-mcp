/** Options accepted by every {@link KoError} constructor. */
export interface KoErrorOptions {
  status: number;
  code: string;
  requestId?: string;
  /** The API's `error.details` object, when the error body carries one. */
  details?: Record<string, unknown>;
}

/**
 * Base error for every failure raised by the ko.io SDK.
 *
 * `status` is the HTTP status (0 for timeouts / network failures),
 * `code` is the machine-readable API error code (e.g. `INVALID_API_KEY`),
 * `details` is the structured `error.details` object the API sent with it, if any
 * (e.g. `{ covered: ["se", "nl", "dk", "uk"] }` on an EU `COUNTRY_NOT_COVERED`).
 */
export class KoError extends Error {
  readonly status: number;
  readonly code: string;
  readonly requestId?: string;
  readonly details?: Record<string, unknown>;

  constructor(message: string, options: KoErrorOptions) {
    super(message);
    this.name = new.target.name;
    this.status = options.status;
    this.code = options.code;
    if (options.requestId !== undefined) this.requestId = options.requestId;
    if (options.details !== undefined) this.details = options.details;
  }
}

/** 401 — missing or invalid API key (`INVALID_API_KEY`). */
export class AuthenticationError extends KoError {}

/** 403 — endpoint requires a higher plan (`PLAN_REQUIRED`). */
export class PlanRequiredError extends KoError {}

/** 404 — resource not found (`NOT_FOUND`). */
export class NotFoundError extends KoError {}

/** 429 — rate limit exceeded. `retryAfter` mirrors the Retry-After header (seconds). */
export class RateLimitError extends KoError {
  readonly retryAfter?: number;

  constructor(message: string, options: KoErrorOptions & { retryAfter?: number }) {
    super(message, options);
    if (options.retryAfter !== undefined) this.retryAfter = options.retryAfter;
  }
}

/** 400 — invalid request parameters (`BAD_REQUEST`, `INVALID_QUARTER`). */
export class BadRequestError extends KoError {}

/** 5xx — server-side failure (`QUERY_ERROR`, `INTERNAL_ERROR`, `SERVICE_UNAVAILABLE`, `UPSTREAM_ERROR`). */
export class ServerError extends KoError {}

const FALLBACK_CODES: Record<number, string> = {
  400: "BAD_REQUEST",
  401: "INVALID_API_KEY",
  403: "PLAN_REQUIRED",
  404: "NOT_FOUND",
  429: "RATE_LIMIT_EXCEEDED",
  500: "INTERNAL_ERROR",
  502: "UPSTREAM_ERROR",
  503: "SERVICE_UNAVAILABLE",
  504: "UPSTREAM_ERROR",
};

/** Build the most specific error subclass for a non-2xx response. @internal */
export async function errorFromResponse(response: Response): Promise<KoError> {
  const status = response.status;
  let code = FALLBACK_CODES[status] ?? "HTTP_ERROR";
  let message = `HTTP ${status} from ko.io API`;
  let details: Record<string, unknown> | undefined;

  try {
    const body = (await response.json()) as {
      error?: { code?: string; message?: string; details?: unknown } | string;
      message?: string;
    };
    if (typeof body?.error === "string") {
      // Flat docs-style shape: { error: "CODE", message: "..." }
      if (body.error) code = body.error;
      if (typeof body.message === "string" && body.message) message = body.message;
    } else if (body?.error && typeof body.error === "object") {
      if (typeof body.error.code === "string" && body.error.code) code = body.error.code;
      if (typeof body.error.message === "string" && body.error.message) message = body.error.message;
      const d = body.error.details;
      if (d && typeof d === "object" && !Array.isArray(d)) details = d as Record<string, unknown>;
    }
  } catch {
    // Non-JSON body (e.g. proxy HTML error page): keep fallbacks.
  }

  const requestId = response.headers.get("x-request-id") ?? undefined;
  const options: KoErrorOptions = { status, code };
  if (requestId !== undefined) options.requestId = requestId;
  if (details !== undefined) options.details = details;

  switch (status) {
    case 400:
      return new BadRequestError(message, options);
    case 401:
      return new AuthenticationError(message, options);
    case 403:
      return new PlanRequiredError(message, options);
    case 404:
      return new NotFoundError(message, options);
    case 429: {
      // Only plain digit seconds; empty strings and HTTP-date forms yield undefined.
      const raw = response.headers.get("retry-after")?.trim();
      const retryAfter = raw && /^\d+$/.test(raw) ? Number(raw) : undefined;
      return new RateLimitError(message, { ...options, retryAfter });
    }
    default:
      return status >= 500 ? new ServerError(message, options) : new KoError(message, options);
  }
}
