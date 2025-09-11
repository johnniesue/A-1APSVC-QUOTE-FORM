document.getElementById("quoteForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const form = e.target;
  const responseMessage = document.getElementById("responseMessage");

  const data = {
    name: form.name.value,
    phone: form.phone.value,
    email: form.email.value,
    address: form.address.value,
    property_type: form.property_type.value,
    details: form.problem_description.value,
    problem_start_date: form.problem_start_date.value,
    issue_types: [form.problem_description.value]
  };

  try {
    const res = await fetch("https://zzigzylypifjokskehkn.supabase.co/rest/v1/quote_requests", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "apikey": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inp6aWd6eWx5cGlmam9rc2tlaGtuIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTIyODEzNDAsImV4cCI6MjA2Nzg1NzM0MH0.UjSODSs-tWPmXxKkyuaSIvSutx5dCnJsMhzslbFaBUg",
        "Authorization": "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inp6aWd6eWx5cGlmam9rc2tlaGtuIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTIyODEzNDAsImV4cCI6MjA2Nzg1NzM0MH0.UjSODSs-tWPmXxKkyuaSIvSutx5dCnJsMhzslbFaBUg"
      },
      body: JSON.stringify(data)
    });

    if (res.ok) {
      responseMessage.textContent = "✅ Quote request submitted successfully!";
      responseMessage.classList.remove("hidden");
      responseMessage.style.color = "green";
      form.reset();
    } else {
      throw new Error("Submission failed");
    }
  } catch (err) {
    responseMessage.textContent = "❌ Error submitting request. Please try again.";
    responseMessage.classList.remove("hidden");
    responseMessage.style.color = "red";
  }
});

