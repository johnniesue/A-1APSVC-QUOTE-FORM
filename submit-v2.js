document.getElementById("quoteForm").addEventListener("submit", async (e) => {
  e.preventDefault();

  const form = e.target;
  const responseMessage = document.getElementById("responseMessage");

  const rawDate = form.problem_start_date.value;
  const formattedDate = rawDate ? new Date(rawDate).toISOString().split("T")[0] : null;

  const data = {
    full_name: form.name.value,
    phone_number: form.phone.value,
    email: form.email.value,
    address: form.address.value,
    property_type: form.property_type.value,
    problem_description: form.problem_description.value,
    problem_start_date: formattedDate,
    issue_types: [form.problem_description.value]
  };

  try {
    const res = await fetch("https://zzigzylypifjokskehkn.supabase.co/functions/v1/send-quote", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(data)
    });

    let result;
    const contentType = res.headers.get("content-type");
    let isJson = contentType && contentType.includes("application/json");
    if (isJson) {
      try {
        result = await res.json();
      } catch (jsonErr) {
        console.error("Failed to parse JSON response:", jsonErr);
        result = {};
      }
    } else {
      // fallback: get text response
      const text = await res.text();
      result = { success: false, message: text };
    }

    if (res.ok && result.success) {
      responseMessage.textContent = "✅ Quote request submitted successfully!";
      responseMessage.classList.remove("hidden");
      responseMessage.style.color = "green";
      form.reset();
    } else {
      console.error("Submission failed:", result);
      responseMessage.textContent =
        (result && typeof result === "object" && "message" in result && result.message)
          || "❌ Error submitting request. Please try again.";
      responseMessage.classList.remove("hidden");
      responseMessage.style.color = "red";
    }
  } catch (err) {
    console.error("Unexpected error:", err);
    responseMessage.textContent = "❌ Error submitting request. Please try again.";
    responseMessage.classList.remove("hidden");
    responseMessage.style.color = "red";
  }
});
