"use strict";

const form = document.getElementById("signup-form");
const message = document.getElementById("message");
form.addEventListener("submit", async event => {
  event.preventDefault();
  const email = document.getElementById("email");
  if (!email.checkValidity()) {
    email.reportValidity();
    return;
  }
  const button = form.querySelector("button");
  button.disabled = true;
  message.textContent = "";
  try {
    const response = await fetch("/api/synk/signup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: email.value, source: new URLSearchParams(location.search).get("src") })
    });
    const result = await response.json();
    message.textContent = result.message;
    if (response.ok && result.message.startsWith("You're in.")) form.hidden = true;
  } catch {
    message.textContent = "Something went wrong. Please try again.";
  } finally {
    button.disabled = false;
  }
});
