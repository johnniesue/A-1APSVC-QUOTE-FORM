document.getElementById("quoteForm").addEventListener("submit", async (e) => {
  e.preventDefault();

  const form = e.target;
  const responseMessage = document.getElementById("responseMessage");

  // Format date safely
  const rawDate = form.problem_start_date.value;
  const formattedDate = rawDate
    ? new Date(rawDate).toISOString().split("T")[0]
    : null;

  // Build payload
  const data = {
    full_name: form.name.value.trim(),
    phone_number: form.phone.value.trim(),
    email: form.email.value.trim(),
    address: form.address.value.trim(),
    property_type: form.property_type.value,
    problem_description: form.problem_description.value.trim(),
    problem_start_date: formattedDate,
    issue_types: [form.problem_description.value.trim()],
  };

  try {
    const res = await fetch("https://zzigzylypifjokskehkn.supabase.co/functions/v1/send-quote", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(data)
    });

    if (res.ok) {
      responseMessage.textContent = "✅ Quote request submitted successfully!";
      responseMessage.classList.remove("hidden");
      responseMessage.style.color = "green";
      form.reset();
    } else {
      const errorText = await res.text();
      console.error("Submission failed:", errorText);
      responseMessage.textContent =
        "❌ Error submitting request. Please try again.";
      responseMessage.classList.remove("hidden");
      responseMessage.style.color = "red";
    }
  } catch (err) {
    console.error("Unexpected error:", err);
    responseMessage.textContent =
      "❌ Network error. Please check your connection and try again.";
    responseMessage.classList.remove("hidden");
    responseMessage.style.color = "red";
  }
});

