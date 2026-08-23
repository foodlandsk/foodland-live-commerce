# Foodland Live Commerce v1

Service for Railway that:

1. Connects by IMAP to `orders-live@foodland.sk`.
2. Reads Foodland order confirmation e-mails.
3. Extracts only anonymized purchase data:
   - order hash
   - order date/time
   - product name
   - product URL
   - image URL (when available)
   - quantity
4. Stores the events in PostgreSQL.
5. Exposes public JSON endpoints for Foodland.
6. Serves `/widget.js` for the Foodland Infowidget.

## Railway setup

### 1. Create project
Deploy this repository to Railway.

### 2. Add PostgreSQL
In Railway:
- New -> Database -> PostgreSQL
- Railway will inject `DATABASE_URL`.

### 3. Variables
Set:

- `MAIL_HOST=imap.websupport.sk`
- `MAIL_PORT=993`
- `MAIL_SECURE=true`
- `MAIL_USER=orders-live@foodland.sk`
- `MAIL_PASSWORD=<password of the technical mailbox>`
- `MAIL_FOLDER=INBOX`
- `POLL_SECONDS=60`
- `PGSSL=true`
- `ALLOWED_ORIGINS=https://www.foodland.sk,https://foodland.sk`
- `ADMIN_TOKEN=<long random secret>`

Do not put the mailbox password into GitHub.

### 4. Test
Open:

- `/health`
- `/api/live/recent`
- `/api/live/summary`

The service creates its database tables automatically on startup.

## Foodland Infowidget

In the HTML source of the Infowidget insert:

```html
<span
  id="foodland-live-commerce"
  data-api="https://YOUR-RAILWAY-DOMAIN.up.railway.app"
  data-interval="12000">
  Práve obľúbené produkty našich zákazníkov
</span>

<script src="https://YOUR-RAILWAY-DOMAIN.up.railway.app/widget.js" defer></script>
```

The widget rotates recent anonymized purchases.

## Supported languages

The widget auto-detects:
SK, CZ/CS, DE, EN, PL, HU, VI.

## Privacy

The service deliberately does not store:
- customer name
- e-mail
- telephone
- street
- exact delivery address

Only purchase/product information is stored.

## Manual re-scan

POST `/admin/rescan` with header:

`x-admin-token: YOUR_ADMIN_TOKEN`

This is useful if you want to process older messages as well.
