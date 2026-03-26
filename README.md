# Landing SEO locale – Réduction facture électricité Lyon

## 1) Déploiement rapide (Render)

1. Poussez ce repo sur GitHub.
2. Sur Render, créez un **New Web Service** depuis le repo.
3. Render détecte automatiquement `render.yaml`.
4. Renseignez les variables d'environnement:
   - `SITE_URL` (ex: `https://votre-domaine.fr`)
   - `ADMIN_PASSWORD`
   - `ADMIN_SESSION_SECRET`
   - `CRM_WEBHOOK_URL` (endpoint API du CRM acheteur)
   - `CRM_WEBHOOK_TOKEN` (optionnel, auth Bearer)
   - `CRM_WEBHOOK_SECRET` (optionnel, signature HMAC SHA-256)
5. Déployez puis connectez votre domaine personnalisé.

## 2) Checklist SEO immédiate (48h)

- Vérifier que `https://votre-domaine.fr/robots.txt` et `https://votre-domaine.fr/sitemap.xml` répondent.
- Ajouter la propriété dans Google Search Console.
- Soumettre le sitemap dans Search Console.
- Demander l'indexation de `/` et `/politique-confidentialite.html`.
- Vérifier la balise canonique et les rich snippets via l'outil Rich Results Test.

## 3) Acquisition de leads qualifiés

Le formulaire enregistre automatiquement:
- UTM (`utm_source`, `utm_medium`, `utm_campaign`, `utm_term`, `utm_content`)
- `landing_path`
- `referrer`

Dans l'admin (`/admin`), les leads remontent avec un indicateur de priorité:
- **Chaude**: propriétaire + Linky + facture >= 90€
- **À vérifier**: autres profils

## 4) Commandes locales

```bash
npm ci
npm run start
```

Variables recommandées en local: copier `.env.example` vers `.env`.

## 5) Push automatique vers CRM

Quand `CRM_WEBHOOK_URL` est configuré:
- chaque lead est d'abord enregistré en base SQLite,
- puis une livraison est ajoutée dans la table `lead_deliveries`,
- un worker tente la livraison en arrière-plan,
- en cas d'échec, des retries exponentiels sont appliqués.

Variables de contrôle:
- `DELIVERY_MAX_ATTEMPTS` (défaut: `5`)
- `DELIVERY_RETRY_BASE_SECONDS` (défaut: `60`)

Endpoints admin utiles:
- `GET /api/admin/deliveries?limit=50`
- `POST /api/admin/deliveries/:id/retry`

Endpoint de test local (hors production):
- `POST /api/dev/crm-mock`
