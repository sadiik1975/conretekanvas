"use strict";

const loginForm = document.getElementById("login");
const dashboard = document.getElementById("dashboard");
const statusMessage = document.getElementById("status");
const logout = document.getElementById("logout");

async function request(path, options = {}) {
  const response = await fetch(path, options);
  if (!response.ok) {
    const data = await response.json();
    throw new Error(data.message || "Request failed.");
  }
  return response;
}

function rowFor(values) {
  const row = document.createElement("tr");
  for (const value of values) {
    const cell = document.createElement("td");
    cell.textContent = value;
    row.appendChild(cell);
  }
  return row;
}

async function loadDashboard() {
  const [signupResponse, sendResponse] = await Promise.all([
    request("/api/synk/admin/signups"), request("/api/synk/admin/sends")
  ]);
  const signups = await signupResponse.json();
  const sends = await sendResponse.json();
  document.getElementById("total").textContent = signups.rows.length;
  const sourceList = document.getElementById("sources");
  sourceList.replaceChildren();
  for (const [source, count] of Object.entries(signups.sources)) {
    const line = document.createElement("p");
    line.textContent = `${source}: ${count}`;
    sourceList.appendChild(line);
  }
  if (!signups.rows.length) sourceList.textContent = "No sources yet.";
  const signupTable = document.getElementById("signups");
  signupTable.replaceChildren(...signups.rows.map(row => rowFor([
    row.email, row.source, new Date(row.created_at).toLocaleString(), row.is_subscribed ? "Subscribed" : "Unsubscribed"
  ])));
  document.getElementById("empty").hidden = signups.rows.length > 0;
  document.getElementById("sends").replaceChildren(...sends.map(row => rowFor([
    new Date(row.created_at).toLocaleString(), row.subject, row.recipient_count, row.attempted_count, row.failed_count, row.status
  ])));
  loginForm.hidden = true;
  logout.hidden = false;
  dashboard.hidden = false;
  statusMessage.textContent = "";
}

function showLogin() {
  dashboard.hidden = true;
  logout.hidden = true;
  loginForm.hidden = false;
}

loginForm.addEventListener("submit", async event => {
  event.preventDefault();
  const button = loginForm.querySelector("button");
  button.disabled = true;
  try {
    const response = await request("/api/synk/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: document.getElementById("login-email").value, password: document.getElementById("login-password").value })
    });
    await response.json();
    document.getElementById("login-password").value = "";
    await loadDashboard();
  } catch (error) {
    showLogin();
    statusMessage.textContent = error.message;
  } finally {
    button.disabled = false;
  }
});

logout.addEventListener("click", async () => {
  try {
    await request("/api/synk/logout", { method: "POST" });
  } finally {
    showLogin();
  }
});
document.getElementById("export").addEventListener("click", async () => {
  try {
    const response = await request("/api/synk/admin/export");
    const url = URL.createObjectURL(await response.blob());
    const link = document.createElement("a");
    link.href = url;
    link.download = "synk-early-access.csv";
    link.click();
    URL.revokeObjectURL(url);
  } catch (error) {
    statusMessage.textContent = error.message;
  }
});

document.getElementById("send-form").addEventListener("submit", async event => {
  event.preventDefault();
  if (!confirm("Send this email to all subscribed SYNK contacts?")) return;
  const button = event.currentTarget.querySelector("button");
  const sendStatus = document.getElementById("send-status");
  button.disabled = true;
  sendStatus.textContent = "Starting send…";
  try {
    const response = await request("/api/synk/admin/send", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ subject: document.getElementById("subject").value, body: document.getElementById("body").value })
    });
    await response.json();
    sendStatus.textContent = "Send started. Refresh this page to check send history; review any unknown or interrupted send in Resend before trying again.";
    await loadDashboard();
  } catch (error) {
    sendStatus.textContent = `${error.message} Check send history and Resend before trying again.`;
  } finally {
    button.disabled = false;
  }
});

loadDashboard().catch(() => showLogin());
