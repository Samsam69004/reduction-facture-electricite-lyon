const express = require("express");
const path = require("path");
const fs = require("fs/promises");
const sqlite3 = require("sqlite3");
const crypto = require("crypto");

const app = express();
const port = process.env.PORT || 3000;
const publicDir = path.join(__dirname, "public");
const privateDir = path.join(__dirname, "private");
const dataDir = "/var/data";
const dbFile = process.env.DB_FILE ? path.resolve(process.env.DB_FILE) : path.join(dataDir, "leads.sqlite");
const siteUrl = process.env.SITE_URL || `http://localhost:${port}`;
const privacyPolicyVersion = "2026-03-25";
const leadRetentionDays = 365;
const crmWebhookUrl = String(process.env.CRM_WEBHOOK_URL || "").trim();
const crmWebhookToken = String(process.env.CRM_WEBHOOK_TOKEN || "").trim();
const crmWebhookSecret = String(process.env.CRM_WEBHOOK_SECRET || "").trim();
const deliveryMaxAttempts = Math.min(
  Math.max(Number.parseInt(String(process.env.DELIVERY_MAX_ATTEMPTS || "5"), 10) || 5, 1),
  10
);
const deliveryRetryBaseSeconds = Math.min(
  Math.max(Number.parseInt(String(process.env.DELIVERY_RETRY_BASE_SECONDS || "60"), 10) || 60, 10),
  3600
);
const deliveryPollIntervalMs = 10_000;
const adminPassword = process.env.ADMIN_PASSWORD || "change-me";
const adminSessionSecret = process.env.ADMIN_SESSION_SECRET || "change-session-secret";
const adminSessionDurationMs = 8 * 60 * 60 * 1000;
const htmlTemplateCache = new Map();
let deliveryWorkerTimer = null;
let isDeliveryWorkerRunning = false;

const runAsync = (db, sql, params = []) =>
  new Promise((resolve, reject) => {
    db.run(sql, params, function onRun(error) {
      if (error) {
        reject(error);
        return;
      }
      resolve(this);
    });
  });

const allAsync = (db, sql, params = []) =>
  new Promise((resolve, reject) => {
    db.all(sql, params, (error, rows) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(rows);
    });
  });

const getAsync = (db, sql, params = []) =>
  new Promise((resolve, reject) => {
    db.get(sql, params, (error, row) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(row);
    });
  });

const parseCookies = (cookieHeader) => {
  if (!cookieHeader) {
    return {};
  }

  return cookieHeader
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean)
    .reduce((acc, part) => {
      const separator = part.indexOf("=");
      if (separator < 0) {
        return acc;
      }
      const key = part.slice(0, separator).trim();
      const value = decodeURIComponent(part.slice(separator + 1));
      acc[key] = value;
      return acc;
    }, {});
};

const signSession = (payload) => {
  return crypto.createHmac("sha256", adminSessionSecret).update(payload).digest("hex");
};

const createAdminSessionToken = () => {
  const issuedAt = Date.now();
  const payload = `admin|${issuedAt}`;
  const signature = signSession(payload);
  return `${payload}|${signature}`;
};

const isValidAdminSessionToken = (token) => {
  if (typeof token !== "string") {
    return false;
  }

  const parts = token.split("|");
  if (parts.length !== 3) {
    return false;
  }

  const [scope, issuedAtRaw, signature] = parts;
  if (scope !== "admin") {
    return false;
  }

  const issuedAt = Number.parseInt(issuedAtRaw, 10);
  if (!Number.isFinite(issuedAt)) {
    return false;
  }

  const age = Date.now() - issuedAt;
  if (age < 0 || age > adminSessionDurationMs) {
    return false;
  }

  const expected = signSession(`${scope}|${issuedAtRaw}`);
  return expected === signature;
};

const requireAdminAuth = (req, res, next) => {
  const cookies = parseCookies(req.headers.cookie || "");
  if (isValidAdminSessionToken(cookies.admin_auth)) {
    return next();
  }

  if (req.path.startsWith("/api/")) {
    return res.status(401).json({ ok: false, message: "Authentification requise." });
  }

  return res.redirect("/admin/login");
};

let db;

const normalizeSiteUrl = (urlValue) => String(urlValue || "").replace(/\/+$/, "");

const loadHtmlTemplate = async (absolutePath) => {
  if (htmlTemplateCache.has(absolutePath)) {
    return htmlTemplateCache.get(absolutePath);
  }

  const template = await fs.readFile(absolutePath, "utf8");
  htmlTemplateCache.set(absolutePath, template);
  return template;
};

const renderPublicTemplate = async (fileName) => {
  const template = await loadHtmlTemplate(path.join(publicDir, fileName));
  return template.replaceAll("__SITE_URL__", normalizeSiteUrl(siteUrl));
};

const getRetentionCutoffIso = () => {
  return new Date(Date.now() - leadRetentionDays * 24 * 60 * 60 * 1000).toISOString();
};

const nameRegex = /^[A-Za-zÀ-ÖØ-öø-ÿ]+(?:['-][A-Za-zÀ-ÖØ-öø-ÿ]+)*$/;
const frenchPhoneRegex = /^0[1-9][0-9]{8}$/;
const emailRegex = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;

const purgeExpiredLeads = async () => {
  const cutoff = getRetentionCutoffIso();
  await runAsync(db, "DELETE FROM leads WHERE created_at < ?", [cutoff]);
};

const truncateText = (value, maxLength) => {
  const normalized = String(value || "");
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, maxLength)}...`;
};

const toIsoInSeconds = (secondsFromNow) => {
  return new Date(Date.now() + secondsFromNow * 1000).toISOString();
};

const computeRetryDelaySeconds = (attempt) => {
  const exponent = Math.max(attempt - 1, 0);
  return Math.min(deliveryRetryBaseSeconds * 2 ** exponent, 24 * 60 * 60);
};

const createCrmPayload = (leadId, lead) => ({
  external_id: `lead_${leadId}`,
  created_at: lead.createdAt,
  source: lead.source,
  contact: {
    nom: lead.nom,
    prenom: lead.prenom,
    telephone: lead.telephone,
    email: lead.email
  },
  qualification: {
    proprietaire_maison: lead.proprietaireMaison,
    compteur_linky: lead.compteurLinky,
    facture_mensuelle: lead.factureMensuelle
  },
  acquisition: {
    utm_source: lead.acquisition.utmSource,
    utm_medium: lead.acquisition.utmMedium,
    utm_campaign: lead.acquisition.utmCampaign,
    utm_term: lead.acquisition.utmTerm,
    utm_content: lead.acquisition.utmContent,
    landing_path: lead.acquisition.landingPath,
    referrer: lead.acquisition.referrer
  },
  compliance: {
    consent_partenaires_solaires: lead.consentement.partenairesSolaires,
    consent_policy_ack: lead.consentement.politiqueAcceptee,
    consented_at: lead.consentement.consentedAt,
    politique_version: lead.consentement.politiqueVersion,
    consent_scope_partenaires: lead.consentement.scopePartenaires
  }
});

const signCrmPayload = (payloadText) => {
  if (!crmWebhookSecret) {
    return "";
  }

  return crypto.createHmac("sha256", crmWebhookSecret).update(payloadText).digest("hex");
};

const queueLeadDelivery = async (leadId, lead) => {
  if (!crmWebhookUrl) {
    return false;
  }

  const payloadJson = JSON.stringify(createCrmPayload(leadId, lead));
  const now = new Date().toISOString();

  await runAsync(
    db,
    `INSERT INTO lead_deliveries (
      lead_id,
      destination,
      payload_json,
      status,
      attempts,
      max_attempts,
      next_attempt_at,
      created_at,
      updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [leadId, "crm-webhook", payloadJson, "pending", 0, deliveryMaxAttempts, now, now, now]
  );

  return true;
};

const postToCrmWebhook = async (payloadJson) => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  const signature = signCrmPayload(payloadJson);

  const headers = {
    "Content-Type": "application/json"
  };

  if (crmWebhookToken) {
    headers.Authorization = `Bearer ${crmWebhookToken}`;
  }

  if (signature) {
    headers["X-Signature-SHA256"] = signature;
  }

  try {
    const response = await fetch(crmWebhookUrl, {
      method: "POST",
      headers,
      body: payloadJson,
      signal: controller.signal
    });
    const responseText = await response.text();

    return {
      ok: response.ok,
      status: response.status,
      responseText: truncateText(responseText, 1200)
    };
  } finally {
    clearTimeout(timeout);
  }
};

const markDeliverySuccess = async (deliveryId, attemptCount, statusCode, responseText) => {
  const now = new Date().toISOString();
  await runAsync(
    db,
    `UPDATE lead_deliveries
     SET status = ?, attempts = ?, delivered_at = ?, response_status = ?, response_body = ?, last_error = ?, updated_at = ?
     WHERE id = ?`,
    ["delivered", attemptCount, now, statusCode, responseText, "", now, deliveryId]
  );
};

const markDeliveryFailure = async (delivery, attemptCount, errorMessage, statusCode, responseText) => {
  const exhausted = attemptCount >= delivery.max_attempts;
  const nextStatus = exhausted ? "failed" : "pending";
  const now = new Date().toISOString();
  const nextAttemptAt = exhausted ? delivery.next_attempt_at : toIsoInSeconds(computeRetryDelaySeconds(attemptCount));

  await runAsync(
    db,
    `UPDATE lead_deliveries
     SET status = ?, attempts = ?, next_attempt_at = ?, response_status = ?, response_body = ?, last_error = ?, updated_at = ?
     WHERE id = ?`,
    [
      nextStatus,
      attemptCount,
      nextAttemptAt,
      Number.isFinite(statusCode) ? statusCode : null,
      truncateText(responseText, 1200),
      truncateText(errorMessage, 500),
      now,
      delivery.id
    ]
  );
};

const processDelivery = async (delivery) => {
  const attemptCount = delivery.attempts + 1;

  try {
    const result = await postToCrmWebhook(delivery.payload_json);

    if (!result.ok) {
      await markDeliveryFailure(
        delivery,
        attemptCount,
        `CRM a repondu avec le code ${result.status}.`,
        result.status,
        result.responseText
      );
      return;
    }

    await markDeliverySuccess(delivery.id, attemptCount, result.status, result.responseText);
  } catch (error) {
    await markDeliveryFailure(delivery, attemptCount, error.message || "Echec de livraison CRM.", null, "");
  }
};

const processPendingDeliveries = async () => {
  if (!crmWebhookUrl || isDeliveryWorkerRunning) {
    return;
  }

  isDeliveryWorkerRunning = true;

  try {
    const now = new Date().toISOString();
    const deliveries = await allAsync(
      db,
      `SELECT id, payload_json, status, attempts, max_attempts, next_attempt_at
       FROM lead_deliveries
       WHERE status = ? AND next_attempt_at <= ?
       ORDER BY id ASC
       LIMIT 20`,
      ["pending", now]
    );

    for (const delivery of deliveries) {
      await processDelivery(delivery);
    }
  } finally {
    isDeliveryWorkerRunning = false;
  }
};

const startDeliveryWorker = () => {
  if (!crmWebhookUrl || deliveryWorkerTimer) {
    return;
  }

  deliveryWorkerTimer = setInterval(() => {
    processPendingDeliveries().catch((error) => {
      console.error("Erreur worker CRM:", error);
    });
  }, deliveryPollIntervalMs);

  processPendingDeliveries().catch((error) => {
    console.error("Erreur worker CRM:", error);
  });
};

const ensureLeadColumns = async () => {
  const rows = await allAsync(db, "PRAGMA table_info(leads)");
  const existingColumns = new Set(rows.map((row) => row.name));
  const columnsToAdd = [
    ["utm_source", "TEXT"],
    ["utm_medium", "TEXT"],
    ["utm_campaign", "TEXT"],
    ["utm_term", "TEXT"],
    ["utm_content", "TEXT"],
    ["landing_path", "TEXT"],
    ["referrer", "TEXT"],
    ["consent_policy_ack", "INTEGER NOT NULL DEFAULT 0"],
    ["consent_scope_contact", "TEXT"],
    ["consent_scope_partenaires", "TEXT"]
  ];

  for (const [columnName, columnType] of columnsToAdd) {
    if (existingColumns.has(columnName)) {
      continue;
    }

    await runAsync(db, `ALTER TABLE leads ADD COLUMN ${columnName} ${columnType}`);
  }
};

const initializeDatabase = async () => {
  await fs.mkdir(dataDir, { recursive: true });

  db = new sqlite3.Database(dbFile);

  await runAsync(
    db,
    `CREATE TABLE IF NOT EXISTS leads (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at TEXT NOT NULL,
      source TEXT NOT NULL,
      nom TEXT NOT NULL,
      prenom TEXT NOT NULL,
      telephone TEXT NOT NULL,
      email TEXT,
      proprietaire_maison TEXT NOT NULL,
      compteur_linky TEXT NOT NULL,
      facture_mensuelle REAL NOT NULL,
      consent_contact INTEGER NOT NULL,
      consent_partenaires_solaires INTEGER NOT NULL,
      politique_version TEXT NOT NULL,
      consented_at TEXT NOT NULL,
      ip TEXT,
      user_agent TEXT,
      utm_source TEXT,
      utm_medium TEXT,
      utm_campaign TEXT,
      utm_term TEXT,
      utm_content TEXT,
      landing_path TEXT,
      referrer TEXT,
      consent_policy_ack INTEGER NOT NULL DEFAULT 0,
      consent_scope_contact TEXT,
      consent_scope_partenaires TEXT
    )`
  );

  await ensureLeadColumns();
  await runAsync(
    db,
    `CREATE TABLE IF NOT EXISTS lead_deliveries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      lead_id INTEGER NOT NULL,
      destination TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      status TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      max_attempts INTEGER NOT NULL DEFAULT 5,
      next_attempt_at TEXT NOT NULL,
      delivered_at TEXT,
      response_status INTEGER,
      response_body TEXT,
      last_error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (lead_id) REFERENCES leads(id)
    )`
  );
  await runAsync(
    db,
    "CREATE INDEX IF NOT EXISTS idx_lead_deliveries_status_next_attempt ON lead_deliveries(status, next_attempt_at)"
  );
  await runAsync(db, "CREATE INDEX IF NOT EXISTS idx_lead_deliveries_lead_id ON lead_deliveries(lead_id)");
  await purgeExpiredLeads();
};

app.set("trust proxy", true);
app.disable("x-powered-by");

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Security headers middleware
app.use((req, res, next) => {
  // Prevent clickjacking attacks
  res.setHeader("X-Frame-Options", "DENY");

  // Prevent MIME type sniffing
  res.setHeader("X-Content-Type-Options", "nosniff");

  // Referrer-Policy
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");

  // Content Security Policy
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; script-src 'self'; style-src 'self' https://fonts.googleapis.com 'unsafe-inline'; font-src https://fonts.gstatic.com; img-src 'self' data:; frame-ancestors 'none'; base-uri 'self'; form-action 'self';"
  );

  // HSTS - only enable in production
  if (process.env.NODE_ENV === "production") {
    res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains; preload");
  }

  // Robots header for admin pages
  if (req.path.startsWith("/admin") || req.path.startsWith("/api/admin")) {
    res.setHeader("X-Robots-Tag", "noindex, nofollow, noarchive");
  }

  next();
});
app.use(
  express.static(publicDir, {
    index: false,
    maxAge: "7d"
  })
);

app.get("/", async (req, res) => {
  try {
    const html = await renderPublicTemplate("index.html");
    res.type("html").send(html);
  } catch (error) {
    res.status(500).type("text/plain").send("Erreur de chargement de la page.");
  }
});

app.get("/politique-confidentialite.html", async (req, res) => {
  try {
    const html = await renderPublicTemplate("politique-confidentialite.html");
    res.type("html").send(html);
  } catch (error) {
    res.status(500).type("text/plain").send("Erreur de chargement de la page.");
  }
});

app.get("/merci", async (req, res) => {
  try {
    const html = await renderPublicTemplate("merci.html");
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
    res.setHeader("Pragma", "no-cache");
    res.setHeader("Expires", "0");
    res.setHeader("Surrogate-Control", "no-store");
    res.type("html").send(html);
  } catch (error) {
    res.status(500).type("text/plain").send("Erreur de chargement de la page.");
  }
});

app.get("/robots.txt", (req, res) => {
  res.type("text/plain");
  res.send(
    `User-agent: *\nAllow: /\nDisallow: /admin\nDisallow: /api/admin\nSitemap: ${normalizeSiteUrl(siteUrl)}/sitemap.xml\n`
  );
});

app.get("/sitemap.xml", (req, res) => {
  const normalizedUrl = normalizeSiteUrl(siteUrl);
  const lastModified = new Date().toISOString();
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url>
    <loc>${normalizedUrl}/</loc>
    <lastmod>${lastModified}</lastmod>
    <changefreq>daily</changefreq>
    <priority>1.0</priority>
  </url>
  <url>
    <loc>${normalizedUrl}/politique-confidentialite.html</loc>
    <lastmod>${lastModified}</lastmod>
    <changefreq>monthly</changefreq>
    <priority>0.4</priority>
  </url>
  <url>
    <loc>${normalizedUrl}/merci</loc>
    <lastmod>${lastModified}</lastmod>
    <changefreq>monthly</changefreq>
    <priority>0.2</priority>
  </url>
</urlset>`;
  res.type("application/xml");
  res.send(xml);
});

app.post("/api/leads", async (req, res) => {
  const {
    nom,
    prenom,
    telephone,
    email,
    proprietaireMaison,
    compteurLinky,
    factureMensuelle,
    consentContact,
    consentPartners,
    consentPolicy,
    utmSource,
    utmMedium,
    utmCampaign,
    utmTerm,
    utmContent,
    landingPath,
    referrer
  } = req.body;

  const bill = Number.parseFloat(factureMensuelle);
  const normalizedPhone = typeof telephone === "string" ? telephone.replace(/\D/g, "") : "";
  const normalizedLastName = typeof nom === "string" ? nom.trim().normalize("NFC") : "";
  const normalizedFirstName = typeof prenom === "string" ? prenom.trim().normalize("NFC") : "";
  const normalizedEmail = typeof email === "string" ? email.trim() : "";
  const normalizedUtmSource = typeof utmSource === "string" ? utmSource.trim().slice(0, 120) : "";
  const normalizedUtmMedium = typeof utmMedium === "string" ? utmMedium.trim().slice(0, 120) : "";
  const normalizedUtmCampaign = typeof utmCampaign === "string" ? utmCampaign.trim().slice(0, 160) : "";
  const normalizedUtmTerm = typeof utmTerm === "string" ? utmTerm.trim().slice(0, 160) : "";
  const normalizedUtmContent = typeof utmContent === "string" ? utmContent.trim().slice(0, 160) : "";
  const normalizedLandingPath = typeof landingPath === "string" ? landingPath.trim().slice(0, 250) : "";
  const normalizedReferrer = typeof referrer === "string" ? referrer.trim().slice(0, 250) : "";
  const contactConsentGiven = consentContact === "oui";
  const partnersConsentGiven = consentPartners === "oui";
  const policyConsentGiven = consentPolicy === "oui";

  if (!normalizedLastName || !normalizedFirstName || !normalizedPhone) {
    return res.status(400).json({
      ok: false,
      message: "Nom, prénom et téléphone sont obligatoires."
    });
  }

  if (!nameRegex.test(normalizedLastName) || !nameRegex.test(normalizedFirstName)) {
    return res.status(400).json({
      ok: false,
      message: "Nom et prénom invalides. Utilisez uniquement des lettres, tirets ou apostrophes."
    });
  }

  if (!frenchPhoneRegex.test(normalizedPhone)) {
    return res.status(400).json({
      ok: false,
      message: "Numéro de téléphone invalide (format attendu: 10 chiffres français)."
    });
  }

  if (
    normalizedEmail &&
    (!emailRegex.test(normalizedEmail) ||
      normalizedEmail.includes("..") ||
      normalizedEmail.startsWith(".") ||
      normalizedEmail.endsWith("."))
  ) {
    return res.status(400).json({
      ok: false,
      message: "Adresse email invalide."
    });
  }

  if (!["oui", "non"].includes(proprietaireMaison) || !["oui", "non"].includes(compteurLinky)) {
    return res.status(400).json({
      ok: false,
      message: "Merci de renseigner le statut propriétaire et Linky."
    });
  }

  if (!Number.isFinite(bill) || bill <= 0) {
    return res.status(400).json({
      ok: false,
      message: "Merci de renseigner une facture mensuelle valide."
    });
  }

  if (!partnersConsentGiven) {
    return res.status(400).json({
      ok: false,
      message: "Le consentement de transmission à des partenaires est obligatoire."
    });
  }

  if (!policyConsentGiven) {
    return res.status(400).json({
      ok: false,
      message: "La validation de la politique de confidentialité est obligatoire."
    });
  }

  const lead = {
    createdAt: new Date().toISOString(),
    source: "landing-reduction-facture-lyon",
    nom: normalizedLastName,
    prenom: normalizedFirstName,
    telephone: normalizedPhone,
    email: normalizedEmail,
    proprietaireMaison,
    compteurLinky,
    factureMensuelle: bill,
    consentement: {
      contact: contactConsentGiven,
      partenairesSolaires: partnersConsentGiven,
      politiqueAcceptee: policyConsentGiven,
      politiqueVersion: privacyPolicyVersion,
      consentedAt: new Date().toISOString(),
      scopeContact: "aucun-contact-direct",
      scopePartenaires: "installateurs-solaires,societes-optimisation-energetique"
    },
    ip: req.headers["x-forwarded-for"] || req.socket.remoteAddress || "unknown",
    userAgent: req.headers["user-agent"] || "unknown",
    acquisition: {
      utmSource: normalizedUtmSource,
      utmMedium: normalizedUtmMedium,
      utmCampaign: normalizedUtmCampaign,
      utmTerm: normalizedUtmTerm,
      utmContent: normalizedUtmContent,
      landingPath: normalizedLandingPath,
      referrer: normalizedReferrer
    }
  };

  try {
    await purgeExpiredLeads();

    const insertResult = await runAsync(
      db,
      `INSERT INTO leads (
        created_at,
        source,
        nom,
        prenom,
        telephone,
        email,
        proprietaire_maison,
        compteur_linky,
        facture_mensuelle,
        consent_contact,
        consent_partenaires_solaires,
        politique_version,
        consented_at,
        ip,
        user_agent,
        utm_source,
        utm_medium,
        utm_campaign,
        utm_term,
        utm_content,
        landing_path,
        referrer,
        consent_policy_ack,
        consent_scope_contact,
        consent_scope_partenaires
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        lead.createdAt,
        lead.source,
        lead.nom,
        lead.prenom,
        lead.telephone,
        lead.email,
        lead.proprietaireMaison,
        lead.compteurLinky,
        lead.factureMensuelle,
        lead.consentement.contact ? 1 : 0,
        lead.consentement.partenairesSolaires ? 1 : 0,
        lead.consentement.politiqueVersion,
        lead.consentement.consentedAt,
        lead.ip,
        lead.userAgent,
        lead.acquisition.utmSource,
        lead.acquisition.utmMedium,
        lead.acquisition.utmCampaign,
        lead.acquisition.utmTerm,
        lead.acquisition.utmContent,
        lead.acquisition.landingPath,
        lead.acquisition.referrer,
        lead.consentement.politiqueAcceptee ? 1 : 0,
        lead.consentement.scopeContact,
        lead.consentement.scopePartenaires
      ]
    );

    const deliveryQueued = await queueLeadDelivery(insertResult.lastID, lead);

    return res.status(201).json({
      ok: true,
      message: "Votre demande a bien été envoyée.",
      deliveryQueued
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      message: "Erreur serveur, merci de réessayer dans quelques minutes."
    });
  }
});

app.get("/admin/login", (req, res) => {
  res.sendFile(path.join(privateDir, "admin-login.html"));
});

app.post("/admin/login", (req, res) => {
  const password = typeof req.body.password === "string" ? req.body.password : "";

  if (password !== adminPassword) {
    return res.status(401).json({ ok: false, message: "Mot de passe invalide." });
  }

  const token = createAdminSessionToken();
  res.setHeader(
    "Set-Cookie",
    `admin_auth=${encodeURIComponent(token)}; HttpOnly; Path=/; Max-Age=28800; SameSite=Lax`
  );

  return res.json({ ok: true });
});

app.post("/admin/logout", (req, res) => {
  res.setHeader("Set-Cookie", "admin_auth=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax");
  return res.json({ ok: true });
});

app.get("/admin", requireAdminAuth, (req, res) => {
  res.sendFile(path.join(privateDir, "admin.html"));
});

app.get("/api/admin/leads", requireAdminAuth, async (req, res) => {
  const rawSearch = typeof req.query.search === "string" ? req.query.search.trim() : "";
  const rawLimit = Number.parseInt(String(req.query.limit || "50"), 10);
  const limit = Number.isNaN(rawLimit) ? 50 : Math.min(Math.max(rawLimit, 1), 200);
  const wildcardSearch = `%${rawSearch}%`;

  try {
    await purgeExpiredLeads();

    const rows =
      rawSearch.length > 0
        ? await allAsync(
            db,
            `SELECT
              id,
              created_at,
              nom,
              prenom,
              telephone,
              email,
              proprietaire_maison,
              compteur_linky,
              facture_mensuelle,
              consent_contact,
              consent_partenaires_solaires,
              consent_policy_ack,
              politique_version,
              consented_at,
              utm_source,
              utm_medium,
              utm_campaign,
              landing_path,
              referrer
             FROM leads
             WHERE nom LIKE ? OR prenom LIKE ? OR telephone LIKE ? OR email LIKE ? OR utm_source LIKE ? OR utm_campaign LIKE ?
             ORDER BY id DESC
             LIMIT ?`,
            [
              wildcardSearch,
              wildcardSearch,
              wildcardSearch,
              wildcardSearch,
              wildcardSearch,
              wildcardSearch,
              limit
            ]
          )
        : await allAsync(
            db,
            `SELECT
              id,
              created_at,
              nom,
              prenom,
              telephone,
              email,
              proprietaire_maison,
              compteur_linky,
              facture_mensuelle,
              consent_contact,
              consent_partenaires_solaires,
              consent_policy_ack,
              politique_version,
              consented_at,
              utm_source,
              utm_medium,
              utm_campaign,
              landing_path,
              referrer
             FROM leads
             ORDER BY id DESC
             LIMIT ?`,
            [limit]
          );

    return res.json({ ok: true, leads: rows, count: rows.length });
  } catch (error) {
    return res.status(500).json({ ok: false, message: "Erreur de lecture des leads." });
  }
});

app.get("/api/admin/diagnostics", requireAdminAuth, async (req, res) => {
  try {
    await purgeExpiredLeads();

    const leadStats = await getAsync(
      db,
      `SELECT
        COUNT(*) AS total,
        MIN(created_at) AS oldest,
        MAX(created_at) AS newest
       FROM leads`
    );

    let dbFileExists = false;
    let dbFileSizeBytes = 0;

    try {
      const stat = await fs.stat(dbFile);
      dbFileExists = true;
      dbFileSizeBytes = stat.size;
    } catch (error) {
      if (error && error.code !== "ENOENT") {
        throw error;
      }
    }

    return res.json({
      ok: true,
      diagnostics: {
        dataDir,
        dbFile,
        dbFileExists,
        dbFileSizeBytes,
        leadRetentionDays,
        totalLeads: Number(leadStats?.total || 0),
        oldestLeadAt: leadStats?.oldest || null,
        newestLeadAt: leadStats?.newest || null
      }
    });
  } catch (error) {
    return res.status(500).json({ ok: false, message: "Erreur de lecture du diagnostic." });
  }
});

app.get("/api/admin/deliveries", requireAdminAuth, async (req, res) => {
  const rawLimit = Number.parseInt(String(req.query.limit || "50"), 10);
  const limit = Number.isNaN(rawLimit) ? 50 : Math.min(Math.max(rawLimit, 1), 200);

  try {
    const rows = await allAsync(
      db,
      `SELECT
        d.id,
        d.lead_id,
        d.destination,
        d.status,
        d.attempts,
        d.max_attempts,
        d.next_attempt_at,
        d.delivered_at,
        d.response_status,
        d.last_error,
        d.created_at,
        l.nom,
        l.prenom,
        l.telephone
       FROM lead_deliveries d
       LEFT JOIN leads l ON l.id = d.lead_id
       ORDER BY d.id DESC
       LIMIT ?`,
      [limit]
    );

    return res.json({ ok: true, deliveries: rows, count: rows.length });
  } catch (error) {
    return res.status(500).json({ ok: false, message: "Erreur de lecture des livraisons CRM." });
  }
});

app.post("/api/admin/deliveries/:id/retry", requireAdminAuth, async (req, res) => {
  const deliveryId = Number.parseInt(String(req.params.id || ""), 10);

  if (!Number.isFinite(deliveryId)) {
    return res.status(400).json({ ok: false, message: "Identifiant de livraison invalide." });
  }

  try {
    const existing = await getAsync(db, "SELECT id FROM lead_deliveries WHERE id = ?", [deliveryId]);
    if (!existing) {
      return res.status(404).json({ ok: false, message: "Livraison introuvable." });
    }

    const now = new Date().toISOString();
    await runAsync(
      db,
      `UPDATE lead_deliveries
       SET status = ?, attempts = 0, next_attempt_at = ?, last_error = ?, updated_at = ?
       WHERE id = ?`,
      ["pending", now, "", now, deliveryId]
    );

    processPendingDeliveries().catch((error) => {
      console.error("Erreur worker CRM:", error);
    });

    return res.json({ ok: true });
  } catch (error) {
    return res.status(500).json({ ok: false, message: "Erreur lors du retry de la livraison." });
  }
});

app.post("/api/dev/crm-mock", async (req, res) => {
  if (process.env.NODE_ENV === "production") {
    return res.status(404).json({ ok: false });
  }

  try {
    const entry = {
      received_at: new Date().toISOString(),
      signature: req.headers["x-signature-sha256"] || "",
      authorization: req.headers.authorization || "",
      payload: req.body
    };
    await fs.appendFile(path.join(dataDir, "crm-mock.ndjson"), `${JSON.stringify(entry)}\n`, "utf8");

    return res.status(201).json({ ok: true });
  } catch (error) {
    return res.status(500).json({ ok: false, message: "Erreur mock CRM." });
  }
});

app.get("*", (req, res) => {
  res.status(404).type("text/plain").send("Page introuvable.");
});

initializeDatabase()
  .then(() => {
    if (crmWebhookUrl) {
      startDeliveryWorker();
      console.log("Livraison CRM activee.");
    } else {
      console.log("Livraison CRM inactive: configurez CRM_WEBHOOK_URL pour pousser les leads.");
    }

    app.listen(port, () => {
      console.log(`Landing page en ligne sur ${siteUrl}`);
    });
  })
  .catch((error) => {
    console.error("Erreur d'initialisation de la base SQLite:", error);
    process.exit(1);
  });
