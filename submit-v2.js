// submit-v2.js
console.log('Loaded submit-v2.js');

document
  .getElementById('quoteForm')
  .addEventListener('submit', async (e) => {
    e.preventDefault();

    const form = e.target;
    const responseMessage = document.getElementById('responseMessage');

    // 1) Format the date as YYYY-MM-DD or null
    const rawDate = form.problem_start_date.value;
    const formattedDate = rawDate
      ? new Date(rawDate).toISOString().split('T')[0]
      : null;

    // 2) Build payload
    const payload = {
      full_name:           form.name.value,
      phone_number:        form.phone.value,
      email:               form.email.value,
      address:             form.address.value,
      property_type:       form.property_type.value,
      problem_description: form.problem_description.value,
      problem_start_date:  formattedDate,
      issue_types:         [form.problem_description.value]
    };

    try {
      // 3) POST to your deployed Edge Function
      const res = await fetch(
        'https://zzigzylypifjokskehkn.functions.supabase.co/send-quote-email',
        {
          method:  'POST',
          mode:    'cors',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify(payload)
        }
      );

      // 4) Surface HTTP-level failures
      const text = await res.text();
      if (!res.ok) {
        console.error('HTTP Error:', res.status, text);
        responseMessage.textContent =
          '❌ Error submitting request. Please try again.';
        responseMessage.style.color = 'red';
        responseMessage.classList.remove('hidden');
        return;
      }

      // 5) Success path
      console.log('Submission succeeded:', text);
      responseMessage.textContent =
        '✅ Quote request submitted successfully!';
      responseMessage.style.color = 'green';
      responseMessage.classList.remove('hidden');
      form.reset();
    } catch (err) {
      // 6) Network / CORS failures
      console.error('Network error:', err);
      responseMessage.textContent =
        '❌ Network error. Please try again.';
      responseMessage.style.color = 'red';
      responseMessage.classList.remove('hidden');
    }
  });
