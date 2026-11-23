"use strict";

const button = document.getElementById("unsubscribe");
const message = document.getElementById("message");
const params = new URLSearchParams(location.search);
button.addEventListener("click", async () => {
  button.disabled = true;
  try {
    const response = await fetch("/api/synk/unsubscribe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: params.get("id"), token: params.get("token") })
    });
    const result = await response.json();
    message.textContent = result.message;
    if (response.ok) button.hidden = true;
  } catch {
    message.textContent = "Something went wrong. Please try again.";
  } finally {
    button.disabled = false;
  }
});
