# Security

## Secrets

Never commit any of these values to GitHub:

- `MAIL_PASSWORD`
- `DATABASE_URL`
- `ADMIN_TOKEN`
- any mailbox credentials

Set them only in Railway Variables.

## Customer privacy

The application is intentionally designed not to persist customer names,
street addresses, telephone numbers or e-mail addresses.

The database stores only anonymized order/product events needed for
Foodland social proof and aggregate statistics.
