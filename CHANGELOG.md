# Changelog

## v1.4

- Replaced the purchase-event conflict no-op with an UPSERT.
- Admin rescan now repairs existing rows, including previously mismatched `image_url` values.
- A rescan never replaces an existing image with `NULL` when a message has no usable image.
- Admin rescan responses now report separate `inserted` and `updated` counts.
- Added regression tests for product-row image matching, UPSERT safety, and the Infowidget client.
- `/health` now reports version `1.4.0`.
- No Railway variable or database migration is required.

## v1.3

- Fixed product-image matching in Creative Sites order e-mails.
- Images are now resolved from the same HTML product row/table.
- Removed previous-sibling image fallback that caused images to shift by one product.
- `/api/live/recent` now returns integer `minutes_ago`.
- Widget now shows human-friendly relative time: minutes, hours, yesterday, or days.
- `/health` now reports version `1.3.0`.
- No Railway variable or database changes required.

## v1.2

- Removed explicit `NIXPACKS` builder override from `railway.json`.
- Railway now uses its current default build system.
- Set explicit Railway start command to `node src/index.js`.
- Updated `Procfile` to the same direct Node start command.
- Kept `npm start` compatible with the same command.
- No mailbox credentials or secrets are stored in the repository.

## v1.1

- Initial GitHub/Railway-ready package.
