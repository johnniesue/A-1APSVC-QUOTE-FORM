// A-1 APSVC Quote Form Submission Script
// Uses Supabase Edge Function (Resend mailer)

const ENDPOINT =
  "https://zzigzylypifjokskehkn.functions.supabase.co/send-quote-email";
const IDEMPOTENCY_STORAGE_KEY = "a1_quote_form_idempotency_key";

function createIdempotencyKey() {
  return crypto.randomUUID();
}

document.addEventListener("DOMContentLoaded", () => {
  const form = document.getElementById("quoteForm");
  const responseMessage = document.getElementById("responseMessage");
  const submitBtn = form.querySelector("button[type='submit']");
  let idempotencyKey =
    sessionStorage.getItem(IDEMPOTENCY_STORAGE_KEY) || createIdempotencyKey();
  sessionStorage.setItem(IDEMPOTENCY_STORAGE_KEY, idempotencyKey);

  async function handleSubmit(e) {
    e.preventDefault();
    responseMessage.textContent = "";
    responseMessage.className = "hidden";

    submitBtn.disabled = true;
    submitBtn.textContent = "Sending…";

    const rawDate = form.problem_start_date?.value;
    const formattedDate = rawDate
      ? new Date(rawDate).toISOString().split("T")[0]
      : null;

    const data = {
      full_name: form.name.value.trim(),
      phone_number: form.phone.value.trim(),
      email: form.email.value.trim(),
      address: form.address.value.trim(),
      city: form.city.value.trim(),
      state: form.state.value.trim().toUpperCase(),
      zip: form.zip.value.trim(),
      property_type: form.property_type?.value || "",
      problem_description: form.problem_description.value.trim(),
      problem_start_date: formattedDate,
      website: form.website?.value || "",
      idempotency_key: idempotencyKey,
    };

    try {
      const res = await fetch(ENDPOINT, {
        method: "POST",
        mode: "cors",
        headers: {
          "Content-Type": "application/json",
          "Authorization": "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inp6aWd6eWx5cGlmam9rc2tlaGtuIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTIyODEzNDAsImV4cCI6MjA2Nzg1NzM0MH0.UjSODSs-tWPmXxKkyuaSIvSutx5dCnJsMhzslbFaBUg"
        },
        body: JSON.stringify(data),
      });

      const result = await res.json().catch(() => ({}));

      if (res.ok && result.success) {
        responseMessage.textContent = "✅ Quote request submitted successfully!";
        responseMessage.className = "success";
        form.reset();
        sessionStorage.removeItem(IDEMPOTENCY_STORAGE_KEY);
        idempotencyKey = createIdempotencyKey();
        sessionStorage.setItem(IDEMPOTENCY_STORAGE_KEY, idempotencyKey);
      } else {
        const reference = result.reference
          ? ` Reference: ${result.reference}`
          : "";
        responseMessage.textContent = `❌ We could not submit your request. Please try again.${reference}`;
        responseMessage.className = "error";
      }
    } catch (err) {
      responseMessage.textContent =
        "❌ Network error. Please check your connection and try again.";
      responseMessage.className = "error";
    } finally {
      responseMessage.classList.remove("hidden");
      responseMessage.scrollIntoView({ behavior: "smooth", block: "center" });
      submitBtn.disabled = false;
      submitBtn.textContent = "Request Quote";
    }
  }

  form.addEventListener("submit", handleSubmit);
});
