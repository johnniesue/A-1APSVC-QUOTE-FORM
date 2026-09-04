import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.7";
import {
  canSafelyRetryEmail,
  createResendIdempotencyKeys,
  createSafeReference,
  deriveLegacyIdempotencyKey,
  enforceDatabaseRateLimit,
  escapeHtml,
  genericErrorBody,
  getPlatformClientAddress,
  hmacIdentifier,
  QUOTE_LEASE_SECONDS,
  QuoteSecurityError,
  sha256Hex,
  validateQuotePayload,
} from "./quote-security.mjs";

const ORGANIZATION_ID = "26727e0d-dbc8-4033-af51-dcaa3a50bc5d";
const RESEND_URL = "https://api.resend.com/emails";

const corsHeaders: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

const LOGO_URL =
  "https://a1apsvcblog.wordpress.com/wp-content/uploads/2025/07/cropped-a-1apsvc-logo-1.png";

function wrapInBrandedTemplate(
  title: string,
  bodyHtml: string,
  copyrightYear: number,
): string {
  return `
  <!DOCTYPE html>
  <html lang="en">
    <head>
      <meta charset="UTF-8" />
      <title>${title}</title>
    </head>
    <body style="margin:0;padding:0;background:#f4f6f9;font-family:Arial,Helvetica,sans-serif;">
      <table width="100%" cellspacing="0" cellpadding="0" style="padding:20px 0;background:#f4f6f9;">
        <tr>
          <td align="center">
            <table width="100%" cellspacing="0" cellpadding="0" style="max-width:640px;background:#ffffff;border-radius:8px;overflow:hidden;box-shadow:0 3px 10px rgba(0,0,0,0.06);">
              <tr>
                <td align="center" style="background:#002244;padding:20px;">
                  <img src="${LOGO_URL}" alt="A-1 Affordable Plumbing" style="max-height:70px;margin-bottom:8px;" />
                  <div style="color:#ffffff;font-size:18px;font-weight:bold;">
                    A-1 Affordable Plumbing Services
                  </div>
                  <div style="color:#c9d8ef;font-size:12px;">
                    Licensed • Insured • Serving Collin County & Beyond
                  </div>
                </td>
              </tr>
              <tr>
                <td style="padding:24px;color:#222;font-size:14px;line-height:1.6;">
                  ${bodyHtml}
                </td>
              </tr>
              <tr>
                <td style="padding:16px;background:#eef2f7;text-align:center;color:#6b7280;font-size:12px;line-height:1.5;">
                  © ${copyrightYear} A-1 Affordable Plumbing Services, LLC<br/>
                  Lucas, TX • (469) 900-5194 • https://a-1affordableplumbingservices.com
                </td>
              </tr>
            </table>
          </td>
        </tr>
      </table>
    </body>
  </html>
  `.trim();
}

async function updateOwnedGuard(
  admin: ReturnType<typeof createClient>,
  guardId: string,
  leaseToken: string,
  values: Record<string, unknown>,
) {
  const { data, error } = await admin
    .from("quote_form_submission_guards")
    .update({ ...values, updated_at: new Date().toISOString() })
    .eq("id", guardId)
    .eq("lease_token", leaseToken)
    .select("id")
    .maybeSingle();
  if (error || !data) throw new Error("Quote submission lease was lost");
}

async function renewLease(
  admin: ReturnType<typeof createClient>,
  guardId: string,
  leaseToken: string,
) {
  await updateOwnedGuard(admin, guardId, leaseToken, {
    lease_expires_at: new Date(Date.now() + QUOTE_LEASE_SECONDS * 1000).toISOString(),
  });
}

async function sendResendEmail(
  apiKey: string,
  idempotencyKey: string,
  body: Record<string, unknown>,
) {
  return fetch(RESEND_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "Idempotency-Key": idempotencyKey,
      "User-Agent": "A1-Quote-Form/1.0",
    },
    body: JSON.stringify(body),
  });
}

serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return jsonResponse(genericErrorBody(createSafeReference()), 405);
  }

  let safeReference = createSafeReference();
  let guardId: string | null = null;
  let leaseToken: string | null = null;
  let admin: ReturnType<typeof createClient> | null = null;

  try {
    const payload = await req.json();
    const quote = validateQuotePayload(payload);

    const resendApiKey = Deno.env.get("RESEND_API_KEY") ?? "";
    const rateLimitSecret = Deno.env.get("QUOTE_RATE_LIMIT_SECRET") ?? "";
    const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
    if (!resendApiKey || !rateLimitSecret || !supabaseUrl || !serviceRoleKey) {
      throw new QuoteSecurityError("Required server configuration is unavailable", {
        status: 503,
        code: "server_configuration_unavailable",
        reference: safeReference,
      });
    }

    admin = createClient(supabaseUrl, serviceRoleKey);

    // Supabase's Cloudflare edge supplies this header. Caller-provided forwarding
    // headers are intentionally ignored so they cannot select a rate-limit bucket.
    const platformAddress = getPlatformClientAddress(req.headers);
    const subjectHash = await hmacIdentifier(platformAddress, rateLimitSecret);
    const requestFingerprint = await hmacIdentifier(JSON.stringify({
      full_name: quote.full_name,
      email: quote.email,
      phone_number: quote.phone_number,
      address: quote.address,
      city: quote.city,
      state: quote.state,
      zip: quote.zip,
      property_type: quote.property_type,
      problem_start_date: quote.problem_start_date,
      problem_description: quote.problem_description,
    }), rateLimitSecret);
    const effectiveIdempotencyKey = quote.idempotency_key
      ?? deriveLegacyIdempotencyKey(requestFingerprint, subjectHash);
    const idempotencyKeyHash = await sha256Hex(effectiveIdempotencyKey);

    const { data: existingGuard, error: existingGuardError } = await admin
      .from("quote_form_submission_guards")
      .select("id")
      .eq("organization_id", ORGANIZATION_ID)
      .eq("idempotency_key_hash", idempotencyKeyHash)
      .gt("expires_at", new Date().toISOString())
      .maybeSingle();
    if (existingGuardError) throw new Error("Unable to inspect request state");

    if (!existingGuard) {
      await enforceDatabaseRateLimit(async ({
        subjectHash: hash,
        limit,
        windowSeconds,
      }: {
        subjectHash: string;
        limit: number;
        windowSeconds: number;
      }) => {
        const { data, error } = await admin!.rpc("consume_quote_form_rate_limit", {
          p_organization_id: ORGANIZATION_ID,
          p_subject_hash: hash,
          p_limit: limit,
          p_window_seconds: windowSeconds,
        });
        if (error) throw new Error("Unable to evaluate request rate limit");
        return Array.isArray(data) ? data[0] : data;
      }, {
        subjectHash,
        reference: safeReference,
      });
    }

    const proposedLeaseToken = crypto.randomUUID();
    const { data: claimRows, error: claimError } = await admin.rpc(
      "claim_quote_form_submission",
      {
        p_organization_id: ORGANIZATION_ID,
        p_idempotency_key_hash: idempotencyKeyHash,
        p_request_fingerprint: requestFingerprint,
        p_request_reference: safeReference,
        p_lease_token: proposedLeaseToken,
        p_lease_seconds: QUOTE_LEASE_SECONDS,
      },
    );
    if (claimError) throw new Error("Unable to claim request");
    const claim = Array.isArray(claimRows) ? claimRows[0] : claimRows;
    if (!claim) throw new Error("Request claim returned no state");

    safeReference = claim.request_reference;
    if (claim.outcome === "conflict") {
      throw new QuoteSecurityError("Request identifier conflict", {
        status: 409,
        code: "idempotency_conflict",
        reference: safeReference,
      });
    }
    if (claim.outcome === "replay") {
      return jsonResponse(claim.result, 200);
    }
    if (claim.outcome === "busy") {
      return jsonResponse({
        ...genericErrorBody(safeReference),
        pending: true,
      }, 202);
    }
    if (claim.outcome !== "owner") throw new Error("Unexpected request claim state");

    const ownedGuardId: string = claim.guard_id;
    const ownedLeaseToken: string = claim.lease_token;
    guardId = ownedGuardId;
    leaseToken = ownedLeaseToken;

    const nameParts = quote.full_name.split(/\s+/u);
    const firstName = nameParts.shift() ?? "";
    const lastName = nameParts.join(" ");

    await renewLease(admin, ownedGuardId, ownedLeaseToken);
    const { data: jobRows, error: jobError } = await admin.rpc(
      "prepare_quote_form_job",
      {
        p_guard_id: ownedGuardId,
        p_organization_id: ORGANIZATION_ID,
        p_lease_token: ownedLeaseToken,
        p_first_name: firstName,
        p_last_name: lastName,
        p_email: quote.email,
        p_phone_number: quote.phone_number,
        p_address: quote.address,
        p_city: quote.city,
        p_state: quote.state,
        p_zip: quote.zip,
        p_problem_description: quote.problem_description,
      },
    );
    if (jobError || !(Array.isArray(jobRows) ? jobRows[0] : jobRows)) {
      throw new Error("Unable to prepare quote records");
    }

    const deliveryKeys = createResendIdempotencyKeys(ownedGuardId);
    const escaped = {
      fullName: escapeHtml(quote.full_name),
      email: escapeHtml(quote.email),
      phoneNumber: escapeHtml(quote.phone_number),
      address: escapeHtml(quote.address),
      city: escapeHtml(quote.city),
      state: escapeHtml(quote.state),
      zip: escapeHtml(quote.zip),
      propertyType: escapeHtml(quote.property_type),
      startDate: escapeHtml(quote.problem_start_date ?? "N/A"),
      description: escapeHtml(quote.problem_description),
    };
    const escapedAddress = `${escaped.address}, ${escaped.city}, ${escaped.state} ${escaped.zip}`;

    const internalHtml = `
      <h2 style="color:#002244;margin:0 0 16px 0;">New Quote Request</h2>
      <p><strong>Name:</strong> ${escaped.fullName}</p>
      <p><strong>Email:</strong> ${escaped.email}</p>
      <p><strong>Phone:</strong> ${escaped.phoneNumber}</p>
      <p><strong>Address:</strong> ${escapedAddress}</p>
      <p><strong>Property Type:</strong> ${escaped.propertyType}</p>
      <p><strong>Problem Start Date:</strong> ${escaped.startDate}</p>
      <p style="margin-top:12px;"><strong>Description:</strong><br/>${escaped.description}</p>
    `.trim();

    if (claim.office_email_status !== "sent") {
      if (!canSafelyRetryEmail(claim.office_email_status, claim.office_email_attempted_at)) {
        throw new QuoteSecurityError("Office delivery requires manual review", {
          status: 503,
          code: "delivery_review_required",
          reference: safeReference,
        });
      }
      await renewLease(admin, ownedGuardId, ownedLeaseToken);
      const officeAttemptedAt = claim.office_email_attempted_at ?? new Date().toISOString();
      await updateOwnedGuard(admin, ownedGuardId, ownedLeaseToken, {
        office_email_status: "sending",
        office_email_attempted_at: officeAttemptedAt,
      });
      const internalResponse = await sendResendEmail(
        resendApiKey,
        deliveryKeys.office,
        {
          from: "A-1 Plumbing Quotes <quotes@a-1affordableplumbingservices.com>",
          to: [
            "johnniesue@a-1affordableplumbingservices.com",
            "johnniesue@gmail.com",
          ],
          reply_to: quote.email,
          subject: `New Quote Request — ${quote.full_name}`,
          html: internalHtml,
        },
      );
      if (!internalResponse.ok) {
        await updateOwnedGuard(admin, ownedGuardId, ownedLeaseToken, {
          state: "failed",
          office_email_status: "failed",
          error_reference: safeReference,
        });
        throw new QuoteSecurityError("Office notification failed", {
          status: 502,
          code: "office_notification_failed",
          reference: safeReference,
        });
      }
      await updateOwnedGuard(admin, ownedGuardId, ownedLeaseToken, {
        office_email_status: "sent",
      });
    }

    const confirmationBody = `
      <h2 style="color:#002244;margin-top:0;">Thanks, ${escaped.fullName}!</h2>
      <p>
        We’ve received your quote request and our office will review it shortly.
        One of our licensed technicians will reach out as soon as possible.
      </p>
      <h3 style="margin-bottom:6px;color:#111;">Your request summary</h3>
      <p><strong>Name:</strong> ${escaped.fullName}</p>
      <p><strong>Email:</strong> ${escaped.email}</p>
      <p><strong>Phone:</strong> ${escaped.phoneNumber}</p>
      <p><strong>Address:</strong> ${escapedAddress}</p>
      <p><strong>Property Type:</strong> ${escaped.propertyType}</p>
      <p><strong>Problem Start Date:</strong> ${escaped.startDate}</p>
      <h4 style="margin-top:16px;margin-bottom:6px;color:#111;">Issue Reported</h4>
      <p style="white-space:pre-line;">${escaped.description}</p>
      <p style="margin-top:18px;">
        If anything looks incorrect, just reply to this email and let us know.
      </p>
    `.trim();
    const confirmationHtml = wrapInBrandedTemplate(
      "Your A-1 Plumbing Quote Request",
      confirmationBody,
      new Date(claim.created_at).getUTCFullYear(),
    );

    if (claim.customer_email_status !== "sent") {
      if (!canSafelyRetryEmail(claim.customer_email_status, claim.customer_email_attempted_at)) {
        throw new QuoteSecurityError("Customer delivery requires manual review", {
          status: 503,
          code: "delivery_review_required",
          reference: safeReference,
        });
      }
      await renewLease(admin, ownedGuardId, ownedLeaseToken);
      const customerAttemptedAt = claim.customer_email_attempted_at ?? new Date().toISOString();
      await updateOwnedGuard(admin, ownedGuardId, ownedLeaseToken, {
        customer_email_status: "sending",
        customer_email_attempted_at: customerAttemptedAt,
      });
      const confirmationResponse = await sendResendEmail(
        resendApiKey,
        deliveryKeys.customer,
        {
          from: "A-1 Affordable Plumbing <quotes@a-1affordableplumbingservices.com>",
          to: [quote.email],
          subject: "We received your quote request — A-1 Plumbing",
          html: confirmationHtml,
        },
      );
      if (!confirmationResponse.ok) {
        await updateOwnedGuard(admin, ownedGuardId, ownedLeaseToken, {
          state: "failed",
          customer_email_status: "failed",
          error_reference: safeReference,
        });
        throw new QuoteSecurityError("Customer confirmation failed", {
          status: 502,
          code: "customer_notification_failed",
          reference: safeReference,
        });
      }
      await updateOwnedGuard(admin, ownedGuardId, ownedLeaseToken, {
        customer_email_status: "sent",
      });
    }

    const result = {
      success: true,
      message: "Emails sent to office and customer successfully",
      request_reference: safeReference,
    };
    await updateOwnedGuard(admin, ownedGuardId, ownedLeaseToken, {
      state: "completed",
      result,
      error_reference: null,
    });
    return jsonResponse(result, 200);
  } catch (error: unknown) {
    const reference = error instanceof QuoteSecurityError && error.reference
      ? error.reference
      : safeReference;
    if (guardId && leaseToken && admin) {
      try {
        await updateOwnedGuard(admin, guardId, leaseToken, {
          state: "failed",
          error_reference: reference,
        });
      } catch {
        // A newer lease owner is responsible for the guard; do not overwrite it.
      }
    }
    console.error("Quote submission failed", {
      reference,
      errorType: error instanceof Error ? error.name : "Error",
    });
    const status = error instanceof QuoteSecurityError ? error.status : 500;
    return jsonResponse(genericErrorBody(reference), status);
  }
});
