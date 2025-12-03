// A-1 APSVC Quote Form Submission Script
// Uses Supabase Edge Function (MailerSend mailer)

const ENDPOINT = "https://zzigzylypifjokskehkn.functions.supabase.co/send-quote-email";

// Replace with your actual anon key (safe for public use)
const SUPABASE_ANON_KEY = "sb_publishable_ei0eWX62jrS8MMq7odV4iQ_IW-9yqG6";

document.addEventListener("DOMContentLoaded", () => {
  const form = document.getElementById("quoteForm");
  const responseMessage = document.getElementById("responseMessage");
  const submitBtn = form.querySelector("button[type='submit']");

  async function handleSubmit(e) {
    e.preventDefault();
    responseMessage.textContent = "";
    responseMessage.className = "hidden"; // reset classes

    // Disable button to prevent double-clicks
    submitBtn.disabled = true;
    submitBtn.textContent = "Sending…";

    // Format date safely
    const rawDate = form.problem_start_date?.value;
    const formattedDate = rawDate
      ? new Date(rawDate).toISOString().split("T")[0]
      : null;

    // Build payload
    const data = {
      full_name: form.name.value.trim(),
      phone_number: form.phone.value.trim(),
      email: form.email.value.trim(),
      address: form.address.value.trim(),
      property_type: form.property_type?.value || "",
      problem_description: form.problem_description.value.trim(),
      problem_start_date: formattedDate,
      issue_types: [form.problem_description.value.trim()],
    };

    try {
      const res = await fetch(ENDPOINT, {
        method: "POST",
        mode: "cors",
        headers: {
          "Content-Type": "application/json",
          "apikey": SUPABASE_ANON_KEY, // ✅ use anon key here
        },
        body: JSON.stringify(data),
      });

      if (res.ok) {
        responseMessage.textContent = "✅ Quote request submitted successfully!";
        responseMessage.className = "success";
        form.reset();
      } else {
        const errText = await res.text();
        console.error("Submission failed:", errText);
        responseMessage.textContent =
          "❌ Error submitting request. Please try again.";
        responseMessage.className = "error";
      }
    } catch (err) {
      console.error("Unexpected error:", err);
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
