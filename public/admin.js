const rowsEl = document.getElementById("rows");
const countEl = document.getElementById("count");
const lastUpdatedEl = document.getElementById("last-updated");
const searchEl = document.getElementById("search");
const limitEl = document.getElementById("limit");
const refreshBtn = document.getElementById("refresh");
const logoutBtn = document.getElementById("logout");

const toBadge = (value) =>
  value
    ? '<span class="badge ok">Oui</span>'
    : '<span class="badge no">Non</span>';

const toPriority = (lead) => {
  const isQualified =
    lead.proprietaire_maison === "oui" &&
    lead.compteur_linky === "oui" &&
    Number(lead.facture_mensuelle || 0) >= 90;

  return isQualified
    ? '<span class="badge ok">Chaude</span>'
    : '<span class="badge no">À vérifier</span>';
};

const formatDate = (iso) => {
  try {
    return new Date(iso).toLocaleString("fr-FR");
  } catch {
    return iso;
  }
};

const escapeHtml = (value) =>
  String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");

const renderRows = (leads) => {
  if (!Array.isArray(leads) || leads.length === 0) {
    rowsEl.innerHTML = '<tr><td colspan="17" class="muted">Aucun lead trouvé.</td></tr>';
    return;
  }

  rowsEl.innerHTML = leads
    .map(
      (lead) => `
      <tr>
        <td>${formatDate(lead.created_at)}</td>
        <td>${escapeHtml(lead.nom)}</td>
        <td>${escapeHtml(lead.prenom)}</td>
        <td>${escapeHtml(lead.telephone)}</td>
        <td>${escapeHtml(lead.email)}</td>
        <td>${toPriority(lead)}</td>
        <td>${escapeHtml(lead.proprietaire_maison)}</td>
        <td>${escapeHtml(lead.compteur_linky)}</td>
        <td>${Number(lead.facture_mensuelle || 0).toFixed(0)} EUR</td>
        <td>${escapeHtml(lead.utm_source || lead.utm_medium || "direct")}</td>
        <td>${escapeHtml(lead.utm_campaign || "-")}</td>
        <td>${escapeHtml(lead.landing_path || "-")}</td>
        <td>${toBadge(Boolean(lead.consent_contact))}</td>
        <td>${toBadge(Boolean(lead.consent_partenaires_solaires))}</td>
        <td>${toBadge(Boolean(lead.consent_policy_ack))}</td>
        <td>${escapeHtml(lead.politique_version || "-")}</td>
        <td>${formatDate(lead.consented_at)}</td>
      </tr>
    `
    )
    .join("");
};

const loadLeads = async () => {
  const params = new URLSearchParams({
    search: searchEl.value.trim(),
    limit: limitEl.value
  });

  countEl.textContent = "Chargement...";

  try {
    const response = await fetch(`/api/admin/leads?${params.toString()}`);
    const payload = await response.json();

    if (!response.ok || !payload.ok) {
      throw new Error(payload.message || "Erreur de chargement");
    }

    renderRows(payload.leads);
    countEl.textContent = `${payload.count} lead(s)`;
    lastUpdatedEl.textContent = `Mis a jour : ${new Date().toLocaleTimeString("fr-FR")}`;
  } catch (error) {
    rowsEl.innerHTML = `<tr><td colspan="17">${escapeHtml(error.message)}</td></tr>`;
    countEl.textContent = "Erreur";
  }
};

if (refreshBtn && searchEl && limitEl && logoutBtn) {
  refreshBtn.addEventListener("click", loadLeads);
  searchEl.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      loadLeads();
    }
  });
  limitEl.addEventListener("change", loadLeads);
  logoutBtn.addEventListener("click", async () => {
    await fetch("/admin/logout", { method: "POST" });
    window.location.href = "/admin/login";
  });

  loadLeads();
}
