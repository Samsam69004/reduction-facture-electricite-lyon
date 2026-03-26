const form = document.querySelector("#lead-form");
const formMessage = document.querySelector("#form-message");
const submitBtn = document.querySelector("#submit-btn");
const year = document.querySelector("#year");
const qualificationHint = document.querySelector("#qualification-hint");
const phoneInput = document.querySelector("#telephone");

// Phone number formatter (French format: 06 XX XX XX XX)
const formatPhoneNumber = (value) => {
  const cleaned = value.replace(/\D/g, "");
  if (cleaned.length === 0) return "";
  if (cleaned.length <= 2) return cleaned;
  if (cleaned.length <= 4) return `${cleaned.slice(0, 2)} ${cleaned.slice(2)}`;
  if (cleaned.length <= 6) return `${cleaned.slice(0, 2)} ${cleaned.slice(2, 4)} ${cleaned.slice(4)}`;
  if (cleaned.length <= 8) return `${cleaned.slice(0, 2)} ${cleaned.slice(2, 4)} ${cleaned.slice(4, 6)} ${cleaned.slice(6)}`;
  return `${cleaned.slice(0, 2)} ${cleaned.slice(2, 4)} ${cleaned.slice(4, 6)} ${cleaned.slice(6, 8)} ${cleaned.slice(8, 10)}`;
};

const isValidFrenchPhone = (value) => {
  const cleaned = value.replace(/\D/g, "");
  return cleaned.length === 10 && /^[0-9]{10}$/.test(cleaned);
};

// Add phone input masking
if (phoneInput) {
  phoneInput.addEventListener("input", (e) => {
    e.target.value = formatPhoneNumber(e.target.value);
  });
}

const seedTrackingFields = () => {
  const params = new URLSearchParams(window.location.search);
  const mapping = [
    ["utmSource", "utm_source"],
    ["utmMedium", "utm_medium"],
    ["utmCampaign", "utm_campaign"],
    ["utmTerm", "utm_term"],
    ["utmContent", "utm_content"]
  ];

  mapping.forEach(([fieldId, paramName]) => {
    const field = document.querySelector(`#${fieldId}`);
    if (!field) {
      return;
    }
    field.value = params.get(paramName) || "";
  });

  const landingPath = document.querySelector("#landingPath");
  if (landingPath) {
    landingPath.value = `${window.location.pathname}${window.location.search}`;
  }

  const referrer = document.querySelector("#referrer");
  if (referrer) {
    referrer.value = document.referrer || "direct";
  }
};

if (year) {
  year.textContent = new Date().getFullYear();
}

if (form) {
  seedTrackingFields();

  // Real-time field validation
  const validateField = (field) => {
    const value = field.value.trim();
    let isValid = true;
    let errorMsg = "";

    if (field.name === "telephone") {
      if (value && !isValidFrenchPhone(value)) {
        isValid = false;
        errorMsg = "Format: 06 XX XX XX XX";
      }
    } else if (field.name === "email" && value) {
      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!emailRegex.test(value)) {
        isValid = false;
        errorMsg = "Email invalide";
      }
    } else if (field.name === "factureMensuelle") {
      const bill = Number.parseFloat(value);
      if (value && (!Number.isFinite(bill) || bill <= 0)) {
        isValid = false;
        errorMsg = "Montant invalide";
      }
    } else if (field.type === "text" && field.hasAttribute("required")) {
      if (!value) {
        isValid = false;
        errorMsg = "Champ obligatoire";
      }
    }

    // Set ARIA attributes
    if (errorMsg) {
      field.setAttribute("aria-invalid", "true");
      field.setAttribute("aria-describedby", `${field.id}-error`);
    } else if (field.hasAttribute("required") && value) {
      field.setAttribute("aria-invalid", "false");
      if (field.hasAttribute("aria-describedby")) {
        field.removeAttribute("aria-describedby");
      }
    }

      // Update error message display
      const errorElement = document.querySelector(`#${field.id}-error`);
      if (errorElement) {
        errorElement.textContent = errorMsg;
      }

      return { isValid, errorMsg };
  };

  // Add real-time validation listeners
  form.querySelectorAll("input, textarea").forEach((field) => {
    if (field.type === "hidden") return;

    field.addEventListener("blur", () => {
      validateField(field);
    });

    field.addEventListener("input", () => {
      if (field.value) {
        validateField(field);
      }
    });
  });

  const updateQualificationHint = () => {
    const data = new FormData(form);
    const owner = data.get("proprietaireMaison");
    const linky = data.get("compteurLinky");
    const bill = Number.parseFloat(String(data.get("factureMensuelle") || ""));

    if (!owner || !linky || !Number.isFinite(bill) || bill <= 0) {
      qualificationHint.textContent = "Complétez ces critères pour voir votre potentiel.";
      qualificationHint.className = "qualification-hint";
      return;
    }

    const isQualified = owner === "oui" && linky === "oui" && bill >= 90;
    qualificationHint.textContent = isQualified
      ? "✅ Profil potentiellement éligible : étude prioritaire."
      : "ℹ️ Profil à analyser : une étude peut être utile.";
    qualificationHint.className = isQualified ? "qualification-hint qualified" : "qualification-hint";
  };

  form.addEventListener("input", updateQualificationHint);
  form.addEventListener("change", updateQualificationHint);
  updateQualificationHint();

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    formMessage.textContent = "";
    formMessage.className = "form-message";

    // Validate all fields before submit
    let hasErrors = false;
    form.querySelectorAll("input[required], textarea[required]").forEach((field) => {
      if (field.type === "hidden") return;
      const { isValid, errorMsg } = validateField(field);
      if (!isValid) {
        hasErrors = true;
        field.focus();
      }
    });

    if (hasErrors) {
      formMessage.textContent = "Veuillez corriger les erreurs ci-dessus.";
      formMessage.classList.add("error");
      return;
    }

    const formData = new FormData(form);
    const payload = Object.fromEntries(formData.entries());

    submitBtn.disabled = true;
    submitBtn.setAttribute("aria-busy", "true");
    submitBtn.textContent = "Envoi en cours...";

    try {
      const response = await fetch("/api/leads", {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify(payload)
      });

      const data = await response.json();

      if (!response.ok || !data.ok) {
        throw new Error(data.message || "Impossible d'envoyer votre demande.");
      }

      form.reset();
      seedTrackingFields();
      formMessage.textContent = "✓ Merci ! Un partenaire vous contactera rapidement pour votre étude.";
      formMessage.classList.add("success");
      qualificationHint.textContent = "";
    } catch (error) {
      formMessage.textContent = error.message || "Une erreur est survenue. Veuillez réessayer.";
      formMessage.classList.add("error");
    } finally {
      submitBtn.disabled = false;
      submitBtn.removeAttribute("aria-busy");
      submitBtn.textContent = "Recevoir mon étude gratuite";
    }
  });
}
