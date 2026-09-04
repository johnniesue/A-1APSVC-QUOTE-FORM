import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.7";
import {
  createSafeReference,
  enforceDatabaseRateLimit,
  genericErrorBody,
  getClientIp,
  hmacIdentifier,
  isHoneypotTriggered,
  QuoteSecurityError,
  runIdempotentQuote,
  sha256Hex,
  validateIdempotencyKey,
} from "./quote-security.mjs";

const ORGANIZATION_ID = "26727e0d-dbc8-4033-af51-dcaa3a50bc5d";

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

// 🔥 Your real logo URL:
const LOGO_URL =
  "https://a1apsvcblog.wordpress.com/wp-content/uploads/2025/07/cropped-a-1apsvc-logo-1.png";

/* --------------------------------------------------------------------------
   Helper: Wrap customer email in branded HTML
-------------------------------------------------------------------------- */
function wrapInBrandedTemplate(title: string, bodyHtml: string): string {
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

              <!-- HEADER -->
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

              <!-- BODY -->
              <tr>
                <td style="padding:24px;color:#222;font-size:14px;line-height:1.6;">
                  ${bodyHtml}
                </td>
              </tr>

              <!-- FOOTER -->
              <tr>
                <td style="padding:16px;background:#eef2f7;text-align:center;color:#6b7280;font-size:12px;line-height:1.5;">
                  © ${new Date().getFullYear()} A-1 Affordable Plumbing Services, LLC<br/>
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

/* --------------------------------------------------------------------------
   MAIN FUNCTION
-------------------------------------------------------------------------- */
serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const safeReference = createSafeReference();
  let guardId: string | null = null;
  let supabase: ReturnType<typeof createClient> | null = null;

  try {
    const payload = await req.json();

    if (isHoneypotTriggered(payload)) {
      return jsonResponse(genericErrorBody(safeReference), 400);
    }

    // Required fields validation
    const required = [
      "full_name",
      "email",
      "phone_number",
      "address",
      "property_type",
      "problem_description",
      "idempotency_key",
    ];
    const missing = required.filter((k) => !payload?.[k]);

    if (missing.length) {
      return jsonResponse(genericErrorBody(safeReference), 400);
    }

    const {
      full_name,
      email,
      phone_number,
      address,
      city: submittedCity,
      state: submittedState,
      zip: submittedZip,
      property_type,
      problem_start_date,
      problem_description,
      idempotency_key,
    } = payload;

    // Keep older form submissions compatible while the frontend rolls forward.
    const city =
      typeof submittedCity === "string" && submittedCity.trim()
        ? submittedCity.trim()
        : "Lucas";
    const state =
      typeof submittedState === "string" && submittedState.trim()
        ? submittedState.trim().toUpperCase()
        : "TX";
    const zip =
      typeof submittedZip === "string" && submittedZip.trim()
        ? submittedZip.trim()
        : "75002";
    const formattedAddress = `${address}, ${city}, ${state} ${zip}`;

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

    const admin = createClient(supabaseUrl, serviceRoleKey);
    supabase = admin;

    const normalizedIdempotencyKey = validateIdempotencyKey(idempotency_key);
    const idempotencyKeyHash = await sha256Hex(normalizedIdempotencyKey);
    const requestFingerprint = await hmacIdentifier(JSON.stringify({
      full_name,
      email,
      phone_number,
      address,
      city,
      state,
      zip,
      property_type,
      problem_start_date: problem_start_date ?? null,
      problem_description,
    }), rateLimitSecret);

    const claimFromExisting = (existingGuard: any) => {
      if (existingGuard.request_fingerprint !== requestFingerprint) {
        throw new QuoteSecurityError("Request identifier conflict", {
          status: 409,
          code: "idempotency_conflict",
          reference: existingGuard.request_reference,
        });
      }
      if (existingGuard.state === "completed" && existingGuard.result) {
        return {
          kind: "replay",
          result: jsonResponse(existingGuard.result, 200),
        };
      }
      return {
        kind: "pending",
        reference: existingGuard.request_reference,
      };
    };

    const readExistingGuard = async () => {
      const { data, error } = await admin
        .from("quote_form_submission_guards")
        .select("id, request_fingerprint, state, request_reference, result")
        .eq("organization_id", ORGANIZATION_ID)
        .eq("idempotency_key_hash", idempotencyKeyHash)
        .maybeSingle();
      if (error) throw new Error("Unable to read the existing request guard");
      return data;
    };

    let claim;
    const existingGuard = await readExistingGuard();
    if (existingGuard) {
      claim = claimFromExisting(existingGuard);
    } else {
      const clientIp = getClientIp(req.headers);
      const subjectHash = await hmacIdentifier(clientIp, rateLimitSecret);
      await enforceDatabaseRateLimit(async ({ subjectHash, limit, windowSeconds }) => {
        const { data, error } = await admin.rpc("consume_quote_form_rate_limit", {
          p_organization_id: ORGANIZATION_ID,
          p_subject_hash: subjectHash,
          p_limit: limit,
          p_window_seconds: windowSeconds,
        });
        if (error) throw new Error("Unable to evaluate the request rate limit");
        return Array.isArray(data) ? data[0] : data;
      }, {
        subjectHash,
        reference: safeReference,
      });

      const { data: insertedGuard, error: insertGuardError } = await admin
        .from("quote_form_submission_guards")
        .insert({
          organization_id: ORGANIZATION_ID,
          idempotency_key_hash: idempotencyKeyHash,
          request_fingerprint: requestFingerprint,
          request_reference: safeReference,
        })
        .select("id, request_reference")
        .single();

      if (!insertGuardError && insertedGuard) {
        guardId = insertedGuard.id;
        claim = {
          kind: "owner",
          guardId,
          reference: insertedGuard.request_reference,
        };
      } else if (insertGuardError?.code === "23505") {
        const concurrentGuard = await readExistingGuard();
        if (!concurrentGuard) {
          throw new Error("Unable to read the concurrent request guard");
        }
        claim = claimFromExisting(concurrentGuard);
      } else {
        throw new Error("Unable to create the request guard");
      }
    }

    const response = await runIdempotentQuote({
      claim: async () => claim,
      execute: async (ownedClaim) => {
        guardId = ownedClaim.guardId;

    /* ----------------------------------------------------------------------
       INSERT CUSTOMER INTO SUPABASE
    ---------------------------------------------------------------------- */

// split full name
const nameParts = full_name.trim().split(" ");
const first_name = nameParts.shift() ?? "";
const last_name = nameParts.join(" ") ?? "";

/* ----------------------------------------------------------------------
   FIND OR CREATE CUSTOMER
---------------------------------------------------------------------- */

let customer;

// Check if customer already exists by phone OR email
const { data: existingCustomer, error: existingCustomerError } = await admin
  .from("customers")
  .select("*")
  .eq("organization_id", ORGANIZATION_ID)
  .or(`mobile_phone.eq.${phone_number},email.eq.${email}`)
  .limit(1)
  .maybeSingle();

if (existingCustomerError) {
  throw new Error(
    `Customer lookup failed: ${existingCustomerError.message}`,
  );
}

if (existingCustomer) {

  customer = existingCustomer;

} else {

  const { data: newCustomer, error: customerError } = await admin
    .from("customers")
    .insert({
      first_name,
      last_name,
      mobile_phone: phone_number,
      email,
      lead_source: "website_quote_form",
      organization_id: ORGANIZATION_ID
    })
    .select()
    .single();

  if (customerError || !newCustomer) {
    throw new Error(
      `Customer insert failed: ${customerError?.message ?? "No customer record returned"}`,
    );
  }

  customer = newCustomer;
}


/* ----------------------------------------------------------------------
   CREATE PROPERTY
---------------------------------------------------------------------- */

const { data: property, error: propertyError } = await admin
  .from("properties")
  .insert({
    customer_id: customer.id,
    organization_id: ORGANIZATION_ID,
    name: "Primary Property",
    address,
    city,
    state,
    zip,
    is_primary: true
  })
  .select()
  .single();

if (propertyError || !property) {
  throw new Error(
    `Property insert failed: ${propertyError?.message ?? "No property record returned"}`,
  );
}


/* ----------------------------------------------------------------------
   CREATE ADDRESS
---------------------------------------------------------------------- */

const { data: addressRecord, error: addressError } = await admin
  .from("addresses")
  .insert({
    customer_id: customer.id,
    organization_id: ORGANIZATION_ID,

    address,
    street1: address,
    city,
    state,
    zip,
    address_type: "service",
    is_primary: true
  })
  .select()
  .single();

if (addressError || !addressRecord) {
  throw new Error(
    `Address insert failed: ${addressError?.message ?? "No address record returned"}`,
  );
}


/* ----------------------------------------------------------------------
   CREATE JOB
---------------------------------------------------------------------- */

const { data: job, error: jobError } = await admin
    .from("jobs")
    .insert({
      customer_id: customer.id,
      property_id: property.id,
      address_id: addressRecord.id,
      organization_id: ORGANIZATION_ID,
      job_type: "other",
      priority_level: "Normal",
      job_status: "Leads",
      assigned_technician: "Unassigned",
      scheduled_date: null,
      job_notes: problem_description
    })
    .select()
    .single();

if (jobError || !job) {
  throw new Error(
    `Job insert failed: ${jobError?.message ?? "No job record returned"}`,
  );
}

    const { error: linkGuardError } = await admin
      .from("quote_form_submission_guards")
      .update({
        customer_id: customer.id,
        property_id: property.id,
        address_id: addressRecord.id,
        job_id: job.id,
        office_email_status: "sending",
        updated_at: new Date().toISOString(),
      })
      .eq("id", guardId);
    if (linkGuardError) throw new Error("Unable to link the durable request guard");


    /* ----------------------------------------------------------------------
       1) INTERNAL EMAIL (to your office inboxes)
    ---------------------------------------------------------------------- */
    const internalHtml = `
      <h2 style="color:#002244;margin:0 0 16px 0;">New Quote Request</h2>

      <p><strong>Name:</strong> ${full_name}</p>
      <p><strong>Email:</strong> ${email}</p>
      <p><strong>Phone:</strong> ${phone_number}</p>
      <p><strong>Address:</strong> ${formattedAddress}</p>
      <p><strong>Property Type:</strong> ${property_type}</p>
      <p><strong>Problem Start Date:</strong> ${problem_start_date ?? "N/A"}</p>

      <p style="margin-top:12px;"><strong>Description:</strong><br/>${problem_description}</p>
    `.trim();

    const internalResponse = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${resendApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: "A-1 Plumbing Quotes <quotes@a-1affordableplumbingservices.com>",
        to: [
          "johnniesue@a-1affordableplumbingservices.com",
          "johnniesue@gmail.com",
        ],
        reply_to: email,
        subject: `New Quote Request — ${full_name}`,
        html: internalHtml,
      }),
    });

    if (!internalResponse.ok) {
      console.error("Office quote email failed", {
        reference: ownedClaim.reference,
        status: internalResponse.status,
      });
      await admin
        .from("quote_form_submission_guards")
        .update({
          state: "failed",
          office_email_status: "failed",
          error_reference: ownedClaim.reference,
          updated_at: new Date().toISOString(),
        })
        .eq("id", guardId);
      throw new QuoteSecurityError("Office notification failed", {
        status: 502,
        code: "office_notification_failed",
        reference: ownedClaim.reference,
      });
    }

    const { error: officeStatusError } = await admin
      .from("quote_form_submission_guards")
      .update({
        office_email_status: "sent",
        customer_email_status: "sending",
        updated_at: new Date().toISOString(),
      })
      .eq("id", guardId);
    if (officeStatusError) throw new Error("Unable to record office email delivery");

    /* ----------------------------------------------------------------------
       2) CUSTOMER CONFIRMATION EMAIL (branded)
    ---------------------------------------------------------------------- */
    const confirmationBody = `
      <h2 style="color:#002244;margin-top:0;">Thanks, ${full_name}!</h2>

      <p>
        We’ve received your quote request and our office will review it shortly.
        One of our licensed technicians will reach out as soon as possible.
      </p>

      <h3 style="margin-bottom:6px;color:#111;">Your request summary</h3>

      <p><strong>Name:</strong> ${full_name}</p>
      <p><strong>Email:</strong> ${email}</p>
      <p><strong>Phone:</strong> ${phone_number}</p>
      <p><strong>Address:</strong> ${formattedAddress}</p>
      <p><strong>Property Type:</strong> ${property_type}</p>
      <p><strong>Problem Start Date:</strong> ${problem_start_date ?? "N/A"}</p>

      <h4 style="margin-top:16px;margin-bottom:6px;color:#111;">Issue Reported</h4>
      <p style="white-space:pre-line;">${problem_description}</p>

      <p style="margin-top:18px;">
        If anything looks incorrect, just reply to this email and let us know.
      </p>
    `.trim();

    const confirmationHtml = wrapInBrandedTemplate(
      "Your A-1 Plumbing Quote Request",
      confirmationBody,
    );

    const confirmationResponse = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${resendApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: "A-1 Affordable Plumbing <quotes@a-1affordableplumbingservices.com>",
        to: [email],
        subject: "We received your quote request — A-1 Plumbing",
        html: confirmationHtml,
      }),
    });

    if (!confirmationResponse.ok) {
      console.error("Customer quote email failed", {
        reference: ownedClaim.reference,
        status: confirmationResponse.status,
      });
      await admin
        .from("quote_form_submission_guards")
        .update({
          state: "failed",
          customer_email_status: "failed",
          error_reference: ownedClaim.reference,
          updated_at: new Date().toISOString(),
        })
        .eq("id", guardId);
      throw new QuoteSecurityError("Customer confirmation failed", {
        status: 502,
        code: "customer_notification_failed",
        reference: ownedClaim.reference,
      });
    }

    /* ----------------------------------------------------------------------
       SUCCESS
    ---------------------------------------------------------------------- */
    const result = {
      success: true,
      message: "Emails sent to office and customer successfully",
      request_reference: ownedClaim.reference,
    };
    const { error: completionError } = await admin
      .from("quote_form_submission_guards")
      .update({
        state: "completed",
        customer_email_status: "sent",
        result,
        updated_at: new Date().toISOString(),
      })
      .eq("id", guardId);
    if (completionError) throw new Error("Unable to record quote completion");

    return jsonResponse(result, 200);
      },
    });

    return response;

  } catch (err: any) {
    const reference = err instanceof QuoteSecurityError && err.reference
      ? err.reference
      : safeReference;
    if (guardId && supabase) {
      await supabase
        .from("quote_form_submission_guards")
        .update({
          state: "failed",
          error_reference: reference,
          updated_at: new Date().toISOString(),
        })
        .eq("id", guardId);
    }
    console.error("Quote submission failed", {
      reference,
      errorType: err?.name ?? "Error",
    });
    const status = err instanceof QuoteSecurityError ? err.status : 500;
    return jsonResponse(genericErrorBody(reference), status);
  }
});
