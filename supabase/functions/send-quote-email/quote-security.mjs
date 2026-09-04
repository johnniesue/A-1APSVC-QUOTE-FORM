export const QUOTE_RATE_LIMIT = 5;
export const QUOTE_RATE_WINDOW_SECONDS = 15 * 60;

export class QuoteSecurityError extends Error {
  constructor(message, { status = 400, code = "invalid_request", reference = null } = {}) {
    super(message);
    this.name = "QuoteSecurityError";
    this.status = status;
    this.code = code;
    this.reference = reference;
  }
}

export function createSafeReference(randomUuid = () => crypto.randomUUID()) {
  return `QF-${randomUuid().replaceAll("-", "").slice(0, 12).toUpperCase()}`;
}

export function isHoneypotTriggered(payload) {
  if (payload?.website == null) return false;
  if (typeof payload.website !== "string") return true;
  return payload.website.trim().length > 0;
}

export function validateIdempotencyKey(value) {
  if (typeof value !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value)) {
    throw new QuoteSecurityError("Invalid request identifier");
  }
  return value.toLowerCase();
}

export function getClientIp(headers) {
  const forwarded = headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return headers.get("cf-connecting-ip")?.trim()
    || headers.get("x-real-ip")?.trim()
    || forwarded
    || "unknown";
}

export async function sha256Hex(value) {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export async function hmacIdentifier(value, secret) {
  if (!secret) {
    throw new QuoteSecurityError("Security configuration unavailable", {
      status: 503,
      code: "security_configuration_unavailable",
    });
  }
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(value),
  );
  return [...new Uint8Array(signature)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export async function enforceDatabaseRateLimit(consume, options) {
  const result = await consume({
    subjectHash: options.subjectHash,
    limit: options.limit ?? QUOTE_RATE_LIMIT,
    windowSeconds: options.windowSeconds ?? QUOTE_RATE_WINDOW_SECONDS,
  });
  if (!result?.allowed) {
    throw new QuoteSecurityError("Too many requests", {
      status: 429,
      code: "rate_limited",
      reference: options.reference,
    });
  }
  return result;
}

export async function runIdempotentQuote({ claim, execute }) {
  const claimed = await claim();
  if (claimed.kind === "replay") return claimed.result;
  if (claimed.kind !== "owner") {
    throw new QuoteSecurityError("Request is already being processed", {
      status: 409,
      code: "request_in_progress",
      reference: claimed.reference,
    });
  }
  return execute(claimed);
}

export function genericErrorBody(reference) {
  return {
    success: false,
    error: "We could not submit your request. Please try again.",
    reference,
  };
}
