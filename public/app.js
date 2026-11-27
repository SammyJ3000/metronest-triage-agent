const state = {
  selectedRequestId: null,
  requests: [],
  vendors: [],
  filter: "open",
  search: "",
  landlordSettings: {
    autoAcceptUrgent: false,
    autoAcceptLimit: 650,
    reviewRoutineQuotes: true,
  },
};

const views = {
  dashboard: document.querySelector("#dashboardView"),
  progress: document.querySelector("#progressView"),
  vendors: document.querySelector("#vendorsView"),
  settings: document.querySelector("#settingsView"),
  help: document.querySelector("#helpView"),
};

const requestList = document.querySelector("#requestList");
const detailPanel = document.querySelector("#detailPanel");
const metrics = document.querySelector("#metrics");
const progressBoard = document.querySelector("#progressBoard");
const vendorGrid = document.querySelector("#vendorGrid");
const autoAcceptUrgent = document.querySelector("#autoAcceptUrgent");
const autoAcceptLimit = document.querySelector("#autoAcceptLimit");
const settingsAutoAcceptUrgent = document.querySelector("#settingsAutoAcceptUrgent");
const settingsAutoAcceptLimit = document.querySelector("#settingsAutoAcceptLimit");

document.querySelectorAll("[data-view], [data-view-button]").forEach((button) => {
  button.addEventListener("click", () => setView(button.dataset.view || button.dataset.viewButton));
});

document.querySelector("#refreshButton").addEventListener("click", () => runAction(loadDashboard, "Requests refreshed"));
document.querySelector("#exportReportButton").addEventListener("click", exportReport);
document.querySelector("#logoutButton").addEventListener("click", () => { window.location.href = "/"; });
autoAcceptUrgent.addEventListener("change", () => runAction(saveSettings, "Approval rule saved"));
autoAcceptLimit.addEventListener("change", () => runAction(saveSettings, "Quote limit saved"));
settingsAutoAcceptUrgent.addEventListener("change", () => runAction(saveSettingsFromSettingsPage, "Approval rule saved"));
settingsAutoAcceptLimit.addEventListener("change", () => runAction(saveSettingsFromSettingsPage, "Quote limit saved"));
document.querySelector("#requestSearch").addEventListener("input", (event) => {
  state.search = event.target.value.toLowerCase().trim();
  renderRequests();
});
document.querySelector("#requestFilter").addEventListener("change", (event) => {
  state.filter = event.target.value;
  renderRequests();
});

const viewTitles = {
  dashboard: ["Maintenance", "Every repair, from first message to finished job."],
  progress: ["Progress", "Track repairs across your portfolio."],
  vendors: ["Contractors", "Your approved network, ready when you need it."],
  settings: ["Settings", "Set the rules for contractor approval."],
  help: ["Help", "Tenant intake and contractor coordination."],
};

let toastTimer;
let loading = false;
let busy = false;
let lastRequests = "";
let lastSettings = "";

function notify(message) {
  const toast = document.querySelector("#toast");
  toast.textContent = message;
  toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toast.hidden = true; }, 3500);
}

function showError(error) {
  const banner = document.querySelector("#errorBanner");
  banner.textContent = error.message || "Something went wrong. Please try again.";
  banner.hidden = false;
}

async function api(url, options) {
  const response = await fetch(url, { ...options, signal: AbortSignal.timeout(12000) });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || "Couldn't complete the action. Please try again.");
  return data;
}

async function runAction(action, message) {
  if (busy) return;
  busy = true;
  const controls = [...document.querySelectorAll("button:not(:disabled), input:not(:disabled), select:not(:disabled)")];
  controls.forEach((control) => { control.disabled = true; });
  try {
    await action();
    document.querySelector("#errorBanner").hidden = true;
    if (message) notify(message);
  } catch (error) {
    renderSettings();
    renderDetail();
    showError(error);
  } finally {
    controls.forEach((control) => { control.disabled = false; });
    busy = false;
  }
}

function setView(name) {
  Object.entries(views).forEach(([key, view]) => view.classList.toggle("active", key === name));
  document.querySelectorAll(".nav-item").forEach((button) => {
    button.classList.toggle("active", button.dataset.view === name);
    if (button.dataset.view === name) button.setAttribute("aria-current", "page");
    else button.removeAttribute("aria-current");
  });
  const [title, subtitle] = viewTitles[name];
  document.querySelector("#pageTitle").textContent = title;
  document.querySelector("#viewLabel").textContent = title;
  document.querySelector("#pageSubtitle").textContent = subtitle;
}

async function loadDashboard() {
  if (loading) return;
  loading = true;
  const connection = document.querySelector("#connectionStatus");
  try {
    const data = await api("/api/requests");
    const nextRequests = JSON.stringify(data.requests);
    const nextSettings = JSON.stringify(data.landlordSettings);
    state.requests = data.requests;
    state.landlordSettings = data.landlordSettings || state.landlordSettings;
    if (nextSettings !== lastSettings) {
      renderSettings();
      lastSettings = nextSettings;
    }
    if (nextRequests !== lastRequests) {
      if (!state.requests.some((request) => request.id === state.selectedRequestId)) {
        state.selectedRequestId = state.requests.find((request) => request.status !== "Resolved")?.id || state.requests[0]?.id;
      }
      renderMetrics(data.summary);
      renderRequests();
      renderProgressBoard();
      renderDetail();
      lastRequests = nextRequests;
    }
    connection.textContent = "Live updates";
    connection.dataset.connected = "true";
  } catch (error) {
    connection.textContent = "Reconnecting";
    connection.dataset.connected = "false";
    throw new Error("Can't reach MetroNest. Check the server is running, then refresh.", { cause: error });
  } finally {
    loading = false;
  }
}

function renderSettings() {
  autoAcceptUrgent.checked = Boolean(state.landlordSettings.autoAcceptUrgent);
  autoAcceptLimit.value = state.landlordSettings.autoAcceptLimit || 650;
  settingsAutoAcceptUrgent.checked = Boolean(state.landlordSettings.autoAcceptUrgent);
  settingsAutoAcceptLimit.value = state.landlordSettings.autoAcceptLimit || 650;
}

async function saveSettings() {
  if (!autoAcceptLimit.checkValidity() || Number(autoAcceptLimit.value) < 100) {
    renderSettings();
    throw new Error("Enter a quote limit of at least £100.");
  }
  const payload = {
    autoAcceptUrgent: autoAcceptUrgent.checked,
    autoAcceptLimit: Number(autoAcceptLimit.value || 650),
    reviewRoutineQuotes: true,
  };
  await api("/api/settings", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  await loadDashboard();
}

async function saveSettingsFromSettingsPage() {
  autoAcceptUrgent.checked = settingsAutoAcceptUrgent.checked;
  autoAcceptLimit.value = settingsAutoAcceptLimit.value;
  await saveSettings();
}

function exportReport() {
  const headers = ["Reference", "Tenant", "Address", "Category", "Urgency", "Status", "Estimate", "Vendor"];
  const rows = state.requests.map((request) => [
    request.reference,
    request.tenantName,
    request.address,
    request.category,
    request.urgency,
    request.status,
    request.roughPrice?.label || "",
    request.confirmedContractor?.vendor?.name || request.vendor?.name || "",
  ]);
  const csv = [headers, ...rows]
    .map((row) => row.map((cell) => `"${String(cell ?? "").replaceAll('"', '""')}"`).join(","))
    .join("\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = "maintenance-report.csv";
  link.click();
  URL.revokeObjectURL(url);
}

async function loadVendors() {
  const data = await api("/api/vendors");
  state.vendors = data.vendors;
  vendorGrid.innerHTML = state.vendors.map((vendor) => `
    <article class="vendor-card">
      <span class="badge ready">${escapeHtml(vendor.trade)}</span>
      <h3>${escapeHtml(vendor.name)}</h3>
      <p>${escapeHtml(vendor.response)}</p>
      <p><strong>WhatsApp:</strong> ${escapeHtml(vendor.whatsapp || vendor.contact)}</p>
      <p><strong>Email:</strong> ${escapeHtml(vendor.email || "Not listed")}</p>
      <p><strong>Coverage:</strong> ${escapeHtml(vendor.coverage || "Not listed")}</p>
      <p><strong>Compliance:</strong> ${escapeHtml(vendor.compliance || "Not listed")}</p>
      <p><strong>Approved until:</strong> ${escapeHtml(vendor.approvedUntil || "Not listed")}</p>
    </article>
  `).join("");
}

function renderMetrics(summary) {
  const items = [
    ["Open", summary.open, "Active issues"],
    ["Urgent", summary.urgent, "Needs attention"],
    ["Ready", summary.ready, "Awaiting approval"],
    ["Waiting", summary.pending, "Tenant info needed"],
  ];
  metrics.innerHTML = items.map(([label, value, note], index) => `
    <button type="button" class="metric metric-${index}" data-filter="${["open", "urgent", "ready", "pending"][index]}">
      <strong>${value}</strong>
      <span>${label}</span>
      <p>${escapeHtml(note)}</p>
    </button>
  `).join("");
  metrics.querySelectorAll("[data-filter]").forEach((button) => {
    button.addEventListener("click", () => {
      state.filter = button.dataset.filter;
      document.querySelector("#requestFilter").value = state.filter;
      renderRequests();
    });
  });
}

function renderRequests() {
  const requests = state.requests.filter((request) => {
    const open = request.status !== "Resolved";
    const match = {
      all: true,
      open,
      urgent: open && ["Emergency", "High"].includes(request.urgency),
      ready: ["Needs manager review", "Ready for approval", "Awaiting landlord quote review", "Quote ready for landlord"].includes(request.status),
      pending: open && request.completeness !== "Ready",
      resolved: !open,
    }[state.filter];
    return match && [request.reference, request.tenantName, request.address, request.summary, request.category].join(" ").toLowerCase().includes(state.search);
  });
  document.querySelector("#requestCount").textContent = requests.length;
  if (!requests.length) {
    requestList.innerHTML = `
      <div class="empty-state">
        <span>${state.requests.length ? "No matching requests" : "Your queue is clear"}</span>
        <p>${state.requests.length ? "Try another search or choose All requests." : "New tenant reports will appear here automatically."}</p>
      </div>
    `;
    return;
  }

  requestList.innerHTML = requests.map((request) => `
    <button class="request-card ${request.id === state.selectedRequestId ? "active" : ""}" aria-pressed="${request.id === state.selectedRequestId}" data-request-id="${escapeHtml(request.id)}" type="button">
      <header>
        <div>
          <strong>${escapeHtml(request.reference)}</strong>
          <p>${escapeHtml(request.tenantName)} · ${escapeHtml(request.address || "Address pending")}</p>
        </div>
        <span class="badge ${badgeClass(request.urgency)}">${escapeHtml(request.urgency)}</span>
      </header>
      <p>${escapeHtml(request.summary)}</p>
      <div class="badges">
        <span class="badge">${escapeHtml(request.category)}</span>
        <span class="badge ${request.completeness === "Ready" ? "ready" : "needs-info"}">${escapeHtml(request.completeness)}</span>
        <span class="badge">${escapeHtml(request.status)}</span>
      </div>
    </button>
  `).join("");

  document.querySelectorAll(".request-card").forEach((card) => {
    card.addEventListener("click", () => {
      state.selectedRequestId = card.dataset.requestId;
      renderRequests();
      renderDetail();
      if (window.innerWidth <= 760) detailPanel.scrollIntoView({ behavior: "instant", block: "start" });
    });
  });
}

function renderProgressBoard() {
  const columns = [
    {
      title: "Intake",
      statuses: ["Waiting for tenant"],
      hint: "Missing details or photos",
    },
    {
      title: "Ready",
      statuses: ["Needs manager review", "Ready for approval", "Awaiting landlord quote review"],
      hint: "Needs manager or landlord action",
    },
    {
      title: "Quotes",
      statuses: ["Contractors contacted", "Quote ready for landlord", "No contractor accepted"],
      hint: "Contractors responding",
    },
    {
      title: "Booked",
      statuses: ["Contractor confirmed", "Vendor contacted", "Scheduled"],
      hint: "Work is being arranged",
    },
    {
      title: "Closed",
      statuses: ["Resolved"],
      hint: "Completed work",
    },
  ];

  progressBoard.innerHTML = columns.map((column) => {
    const requests = state.requests.filter((request) => column.statuses.includes(request.status));
    return `
      <section class="progress-column">
        <header>
          <div>
            <h3>${escapeHtml(column.title)}</h3>
            <p>${escapeHtml(column.hint)}</p>
          </div>
          <span>${requests.length}</span>
        </header>
        <div class="progress-items">
          ${requests.length ? requests.map(renderProgressCard).join("") : `
            <div class="progress-empty">Nothing here</div>
          `}
        </div>
      </section>
    `;
  }).join("");

  document.querySelectorAll("[data-progress-request]").forEach((card) => {
    card.addEventListener("click", () => {
      state.selectedRequestId = card.dataset.progressRequest;
      renderRequests();
      renderDetail();
      setView("dashboard");
    });
  });
}

function renderProgressCard(request) {
  const contractor = request.confirmedContractor?.vendor?.name || request.vendor?.name || "Vendor pending";
  return `
    <button class="progress-card" data-progress-request="${request.id}" type="button">
      <div class="progress-card-top">
        <strong>${escapeHtml(request.reference)}</strong>
        <span class="badge ${badgeClass(request.urgency)}">${escapeHtml(request.urgency)}</span>
      </div>
      <p>${escapeHtml(request.tenantName)} · ${escapeHtml(request.category)}</p>
      <p>${escapeHtml(request.address || "Address pending")}</p>
      <div class="progress-meta">
        <span>${escapeHtml(contractor)}</span>
        <span>${escapeHtml(request.roughPrice?.label || "Estimate pending")}</span>
      </div>
    </button>
  `;
}

function renderDetail() {
  const request = state.requests.find((item) => item.id === state.selectedRequestId);
  if (!request) {
    detailPanel.innerHTML = `
      <div class="empty-state">
        <span>Select a request</span>
        <p>Work order summaries, messages, and next actions will appear here.</p>
      </div>
    `;
    return;
  }

  detailPanel.innerHTML = `
    <div class="detail-title">
      <div>
        <p class="request-reference">${escapeHtml(request.reference)} · ${escapeHtml(request.source)}</p>
        <h2>${escapeHtml(request.category)} request</h2>
      </div>
      <span class="badge ${badgeClass(request.urgency)}">${escapeHtml(request.urgency)}</span>
    </div>

    <div class="badges">
      <span class="badge ${request.completeness === "Ready" ? "ready" : "needs-info"}">${escapeHtml(request.completeness)}</span>
      <span class="badge">${escapeHtml(request.status)}</span>
    </div>

    ${request.conversation?.length ? `<details class="detail-block" open>
      <summary>Conversation needing review</summary>
      ${request.conversation.map((message) => `<p><strong>${message.role === "tenant" ? "Tenant" : "Assistant"}:</strong> ${escapeHtml(message.text)}</p>`).join("")}
    </details>` : ""}

    <div class="detail-block">
      <h3>Summary</h3>
      <p>${escapeHtml(request.summary)}</p>
      <p><strong>Rough price:</strong> ${escapeHtml(request.roughPrice?.label || "Not estimated")} <span class="muted-inline">${escapeHtml(request.roughPrice?.basis || "")}</span></p>
      <p><strong>Recommended action:</strong> ${escapeHtml(request.recommendedAction)}</p>
      <p><strong>Dispatch mode:</strong> ${escapeHtml(request.dispatchPlan?.mode || "Not planned")}</p>
    </div>

    <details class="detail-block">
      <summary>Tenant &amp; access details</summary>
      <p><strong>Name:</strong> ${escapeHtml(request.tenantName)}</p>
      <p><strong>Address:</strong> ${escapeHtml(request.address || "Missing")}</p>
      ${renderTenantProfile(request.tenantProfile)}
      <p><strong>Issue:</strong> ${escapeHtml(request.issueDescription || "Missing")}</p>
      <p><strong>Risk:</strong> ${escapeHtml(request.activeRisk || "Missing")}</p>
      <p><strong>Photos:</strong> ${escapeHtml(request.photoStatus || "Missing")}</p>
      <p><strong>Access approval for this job:</strong> ${escapeHtml(request.accessPermission || "Missing")}</p>
    </details>

    <div class="detail-block">
      <h3>Contractor dispatch</h3>
      ${renderContractorDispatch(request)}
    </div>

    <details class="detail-block">
      <summary>Message drafts</summary>
      <div class="draft-grid">
        ${renderDraft("Tenant", request.drafts?.tenant)}
        ${renderDraft("Contractor", request.drafts?.vendor)}
        ${renderDraft("Landlord", request.drafts?.landlord)}
      </div>
    </details>

    <div class="detail-actions">
      <select id="statusSelect" aria-label="Status">
        ${[...new Set([request.status, "Waiting for tenant", "Ready for approval", "Vendor contacted", "Scheduled", "Resolved"])].map((status) => `
          <option value="${status}" ${request.status === status ? "selected" : ""}>${status}</option>
        `).join("")}
      </select>
      <button class="ghost" id="copyVendor" type="button">Copy contractor brief</button>
      <button class="primary" id="dispatchContractors" type="button" ${request.confirmedContractor || request.contractorDispatches?.length || request.completeness !== "Ready" ? "disabled" : ""}>${request.contractorDispatches?.length ? "Outreach prepared" : "Prepare WhatsApp outreach"}</button>
    </div>
  `;

  document.querySelector("#statusSelect").addEventListener("change", async (event) => {
    await runAction(() => updateRequest(request.id, { status: event.target.value }), "Request status updated");
  });
  document.querySelector("#copyVendor").addEventListener("click", async () => {
    await runAction(() => navigator.clipboard.writeText(request.drafts?.vendor || ""), "Contractor brief copied");
  });
  document.querySelector("#dispatchContractors").addEventListener("click", async () => {
    await runAction(() => dispatchContractors(request.id), "Demo WhatsApp outreach prepared");
  });
  document.querySelectorAll("[data-contractor-accept]").forEach((button) => {
    button.addEventListener("click", async () => {
      await runAction(() => contractorResponse(request.id, button.dataset.contractorAccept, "accept"), "Contractor reply received");
    });
  });
  document.querySelectorAll("[data-contractor-decline]").forEach((button) => {
    button.addEventListener("click", async () => {
      await runAction(() => contractorResponse(request.id, button.dataset.contractorDecline, "decline"), "Contractor declined");
    });
  });
  document.querySelectorAll("[data-confirm-contractor]").forEach((button) => {
    button.addEventListener("click", async () => {
      await runAction(() => confirmContractor(request.id, button.dataset.confirmContractor), "Contractor confirmed");
    });
  });
}

function renderDraft(label, text) {
  return `
    <article class="draft">
      <strong>${escapeHtml(label)}</strong>
      <p>${escapeHtml(text)}</p>
    </article>
  `;
}

function renderTenantProfile(profile) {
  if (!profile) return "";
  return `
    <p><strong>Building:</strong> ${escapeHtml(profile.building || "Not listed")}</p>
    <p><strong>Landlord:</strong> ${escapeHtml(profile.landlord || "Not listed")}</p>
    <p><strong>Saved access preference:</strong> ${escapeHtml(profile.accessNotes || "Not listed")}</p>
  `;
}

function renderContractorDispatch(request) {
  const dispatches = request.contractorDispatches || [];
  const confirmed = request.confirmedContractor;

  if (confirmed) {
    return `
      <div class="draft">
        <strong>${escapeHtml(confirmed.vendor.name)} confirmed</strong>
        <p>Quote: £${escapeHtml(confirmed.quoteAmount)} · ETA: ${escapeHtml(confirmed.eta)} · ${escapeHtml(confirmed.confirmationMode)}</p>
      </div>
      ${renderContractorList(dispatches, true)}
    `;
  }

  if (!dispatches.length) {
    return `
      <p>${escapeHtml(request.dispatchPlan?.reason || "No contractor dispatch plan yet.")}</p>
      <p><strong>Suggested contractors:</strong> ${escapeHtml((request.dispatchPlan?.suggestedVendors || []).join(", ") || "None")}</p>
    `;
  }

  return renderContractorList(dispatches, false);
}

function renderContractorList(dispatches, readOnly) {
  return `
    <div class="contractor-list">
      ${dispatches.map((dispatch, index) => `
        <article class="contractor-card">
          <header>
            <div>
              <strong>${escapeHtml(dispatch.vendor.name)}</strong>
              <p>${escapeHtml(dispatch.channel || "WhatsApp")} · ${escapeHtml(dispatch.vendor.whatsapp || dispatch.vendor.contact)} · Callout £${escapeHtml(dispatch.vendor.calloutFee || "TBC")}</p>
            </div>
            <span class="badge ${badgeClass(dispatch.status)}">${escapeHtml(dispatch.status)}</span>
          </header>
          <p>${escapeHtml(dispatch.status === "Prepared" ? "WhatsApp message prepared for review." : "WhatsApp dispatch message sent in demo mode.")}</p>
          ${dispatch.quoteAmount ? `<p><strong>Quote:</strong> £${escapeHtml(dispatch.quoteAmount)} · <strong>ETA:</strong> ${escapeHtml(dispatch.eta)}</p>` : ""}
          ${readOnly ? "" : renderContractorActions(dispatch, index)}
        </article>
      `).join("")}
    </div>
  `;
}

function renderContractorActions(dispatch, index) {
  if (["Confirmed", "Unsuccessful", "Declined"].includes(dispatch.status)) return "";
  const demoQuotes = [520, 610, 740];
  const demoEtas = ["Today, 3:30pm", "Today, 5:00pm", "Tomorrow, 8:30am"];

  return `
    <div class="contractor-actions">
      ${dispatch.status !== "Accepted" ? `<button type="button" data-contractor-accept="${dispatch.id}">Demo reply: £${demoQuotes[index] || 580}</button>
      <button type="button" data-contractor-decline="${dispatch.id}">Demo: unavailable</button>` : ""}
      ${dispatch.status === "Accepted" ? `<button class="primary" type="button" data-confirm-contractor="${dispatch.id}">Confirm this contractor</button>` : ""}
    </div>
    <span hidden data-demo-quote="${demoQuotes[index] || 580}" data-demo-eta="${demoEtas[index] || "Today"}"></span>
  `;
}

async function updateRequest(id, payload) {
  await api(`/api/requests/${id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  await loadDashboard();
}

async function dispatchContractors(id) {
  await api(`/api/requests/${id}/dispatch`, { method: "POST" });
  await loadDashboard();
}

async function contractorResponse(id, dispatchId, outcome) {
  const buttons = [...document.querySelectorAll(`[data-contractor-accept="${dispatchId}"], [data-contractor-decline="${dispatchId}"]`)];
  const card = buttons[0]?.closest(".contractor-card");
  const quoteNode = card?.querySelector("[data-demo-quote]");
  const payload = {
    dispatchId,
    outcome,
    quoteAmount: Number(quoteNode?.dataset.demoQuote || 580),
    eta: quoteNode?.dataset.demoEta || "Today",
    contractorNote: outcome === "accept" ? "Available and can attend within the quoted window." : "No availability for this job.",
  };

  await api(`/api/requests/${id}/contractor-response`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  await loadDashboard();
}

async function confirmContractor(id, dispatchId) {
  await api(`/api/requests/${id}/confirm-contractor`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ dispatchId }),
  });
  await loadDashboard();
}

function badgeClass(value) {
  return String(value || "").toLowerCase().replace(/\s+/g, "-");
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

setView("dashboard");
await Promise.allSettled([loadDashboard().catch(showError), loadVendors().catch(showError)]);
// Background refresh. A failed poll already shows "Reconnecting" and is retried on the next tick.
setInterval(() => {
  if (!document.hidden && !busy) loadDashboard().catch(() => {});
}, 5000);
