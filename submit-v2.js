// A-1 APSVC Quote Form Submission Script
// Uses Supabase Edge Function (SendGrid mailer)

// Update this if your function name or region changes
const ENDPOINT =
  "https://zzigzylypifjokskehkn.supabase.co/functions/v1/send-quote-email";

document.addEventListener("DOMContentLoaded", () => {
  const form = document.getElementById("quoteForm");
  const responseMessage = document.getElementById("responseMessage");
  const submitBtn = form.querySelector("button[type='submit']");

  async function handleSubmit(e) {
    e.preventDefault();
    responseMessage.textContent = "";
    responseMessage.classList.remove("hidden");

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
    "Authorization": "Bearer " + "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inp6aWd6eWx5cGlmam9rc2tlaGtuIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTIyODEzNDAsImV4cCI6MjA2Nzg1NzM0MH0.UjSODSs-tWPmXxKkyuaSIvSutx5dCnJsMhzslbFaBUg"
  },
  body: JSON.stringify(data)
});

      let msgColor = "red";
      let msgText;

      if (res.ok) {
        msgText = "✅ Quote request submitted successfully!";
        msgColor = "green";
        form.reset();
      } else {
        const errText = await res.text();
        console.error("Submission failed:", errText);
        msgText = "❌ Error submitting request. Please try again.";
      }

      responseMessage.textContent = msgText;
      responseMessage.style.color = msgColor;
      responseMessage.classList.remove("hidden");
      responseMessage.scrollIntoView({ behavior: "smooth", block: "center" });
    } catch (err) {
      console.error("Unexpected error:", err);
      responseMessage.textContent =
        "❌ Network error. Please check your connection and try again.";
      responseMessage.style.color = "red";
      responseMessage.classList.remove("hidden");
      responseMessage.scrollIntoView({ behavior: "smooth", block: "center" });
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = "Request Quote";
    }
  }

  form.addEventListener("submit", handleSubmit);
});
