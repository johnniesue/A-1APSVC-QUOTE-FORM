export const QUOTE_RATE_LIMIT = 5;
export const QUOTE_RATE_WINDOW_SECONDS = 15 * 60;
export const QUOTE_LEASE_SECONDS = 2 * 60;
export const RESEND_RETRY_WINDOW_MS = 23 * 60 * 60 * 1000;

const ALLOWED_FIELDS = new Set([
  "full_name",
  "email",
  "phone_number",
  "address",
  "city",
  "state",
  "zip",
  "property_type",
  "problem_start_date",
  "problem_description",
  "website",
  "idempotency_key",
  // Accepted temporarily so a cached copy of the old frontend remains compatible.
  "issue_types",
]);

export class QuoteSecurityError extends Error {
  /**
   * @param {string} message
   * @param {{status?: number, code?: string, reference?: string | null}} options
   */
  constructor(message, { status = 400, code = "invalid_request", reference = null } = {}) {
    super(message);
    this.name = "QuoteSecurityError";
    this.status = status;
    this.code = code;
    this.reference = reference;
  }
}

function invalidField(field) {
  throw new QuoteSecurityError(`Invalid ${field}`, {
    status: 400,
    code: "invalid_request",
  });
}

function cleanString(value, field, { min = 0, max, optional = false, multiline = false } = {}) {
  if (optional && (value == null || value === "")) return null;
  if (typeof value !== "string") invalidField(field);
  const cleaned = value.trim();
  const controlCharacters = multiline
    ? /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u
    : /[\u0000-\u001F\u007F]/u;
  if (cleaned.length < min || cleaned.length > max || controlCharacters.test(cleaned)) {
    invalidField(field);
  }
  return cleaned;
}

function validateDate(value) {
  const cleaned = cleanString(value, "problem_start_date", {
    max: 10,
    optional: true,
  });
  if (cleaned == null) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(cleaned);
  if (!match) invalidField("problem_start_date");
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const candidate = new Date(Date.UTC(year, month - 1, day));
  if (
    year < 2000
    || year > 2100
    || candidate.getUTCFullYear() !== year
    || candidate.getUTCMonth() !== month - 1
    || candidate.getUTCDate() !== day
  ) {
    invalidField("problem_start_date");
  }
  return cleaned;
}

export function validateQuotePayload(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new QuoteSecurityError("Invalid request body");
  }

  const unexpected = Object.keys(payload).filter((key) => !ALLOWED_FIELDS.has(key));
  if (unexpected.length > 0) {
    throw new QuoteSecurityError("Unexpected request fields", {
      status: 400,
      code: "unexpected_fields",
    });
  }

  const website = cleanString(payload.website, "website", {
    max: 200,
    optional: true,
  }) ?? "";
  if (website) {
    throw new QuoteSecurityError("Automated submission rejected", {
      status: 400,
      code: "honeypot_triggered",
    });
  }

  const fullName = cleanString(payload.full_name, "full_name", { min: 2, max: 100 });
  const email = cleanString(payload.email, "email", { min: 3, max: 254 }).toLowerCase();
  if (!/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/u.test(email)) {
    invalidField("email");
  }

  const phoneNumber = cleanString(payload.phone_number, "phone_number", { min: 7, max: 30 });
  const phoneDigits = phoneNumber.replace(/\D/gu, "");
  if (!/^[0-9+().\-\s]+$/u.test(phoneNumber) || phoneDigits.length < 10 || phoneDigits.length > 15) {
    invalidField("phone_number");
  }

  const address = cleanString(payload.address, "address", { min: 3, max: 200 });
  const city = cleanString(payload.city, "city", { min: 2, max: 80, optional: true }) ?? "Lucas";
  const state = (cleanString(payload.state, "state", { max: 2, optional: true }) ?? "TX").toUpperCase();
  if (!/^[A-Z]{2}$/u.test(state)) invalidField("state");
  const zip = cleanString(payload.zip, "zip", { max: 10, optional: true }) ?? "75002";
  if (!/^\d{5}(?:-\d{4})?$/u.test(zip)) invalidField("zip");

  const propertyType = cleanString(payload.property_type, "property_type", { min: 1, max: 20 });
  if (!new Set(["Residential", "Commercial"]).has(propertyType)) invalidField("property_type");

  const problemDescription = cleanString(payload.problem_description, "problem_description", {
    min: 5,
    max: 4000,
    multiline: true,
  });
  const problemStartDate = validateDate(payload.problem_start_date);

  if (payload.issue_types != null) {
    if (
      !Array.isArray(payload.issue_types)
      || payload.issue_types.length !== 1
      || typeof payload.issue_types[0] !== "string"
      || payload.issue_types[0].trim() !== problemDescription
    ) {
      invalidField("issue_types");
    }
  }

  let idempotencyKey = null;
  if (payload.idempotency_key != null && payload.idempotency_key !== "") {
    idempotencyKey = validateIdempotencyKey(payload.idempotency_key);
  }

  return {
    full_name: fullName,
    email,
    phone_number: phoneNumber,
    address,
    city,
    state,
    zip,
    property_type: propertyType,
    problem_start_date: problemStartDate,
    problem_description: problemDescription,
    idempotency_key: idempotencyKey,
    is_legacy_request: idempotencyKey == null,
  };
}

export function createSafeReference(randomUuid = () => crypto.randomUUID()) {
  return `QF-${randomUuid().replaceAll("-", "").slice(0, 12).toUpperCase()}`;
}

export function validateIdempotencyKey(value) {
  if (typeof value !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value)) {
    throw new QuoteSecurityError("Invalid request identifier");
  }
  return value.toLowerCase();
}

export function getPlatformClientAddress(headers) {
  const value = headers.get("cf-connecting-ip")?.trim() ?? "";
  const validIpv4 = /^(?:\d{1,3}\.){3}\d{1,3}$/u.test(value)
    && value.split(".").every((part) => Number(part) <= 255);
  let validIpv6 = false;
  if (value.includes(":") && /^[0-9a-f:.]{2,64}$/iu.test(value)) {
    try {
      validIpv6 = new URL(`http://[${value}]/`).hostname.length > 0;
    } catch {
      validIpv6 = false;
    }
  }
  if (!validIpv4 && !validIpv6) {
    throw new QuoteSecurityError("Platform network identity unavailable", {
      status: 503,
      code: "network_identity_unavailable",
    });
  }
  return value.toLowerCase();
}

export function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function createResendIdempotencyKeys(guardId) {
  if (typeof guardId !== "string" || !/^[0-9a-f-]{36}$/iu.test(guardId)) {
    throw new QuoteSecurityError("Invalid delivery identifier", { status: 500 });
  }
  return {
    office: `quote-office/${guardId}`,
    customer: `quote-customer/${guardId}`,
  };
}

export function canSafelyRetryEmail(status, attemptedAt, now = Date.now()) {
  if (status === "sent") return false;
  if (!attemptedAt) return true;
  const attemptedTime = Date.parse(attemptedAt);
  return Number.isFinite(attemptedTime)
    && now - attemptedTime >= 0
    && now - attemptedTime <= RESEND_RETRY_WINDOW_MS;
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

export function deriveLegacyIdempotencyKey(requestFingerprint, subjectHash) {
  return `legacy:${requestFingerprint}:${subjectHash}`;
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

export function genericErrorBody(reference) {
  return {
    success: false,
    error: "We could not submit your request. Please try again.",
    reference,
  };
}
