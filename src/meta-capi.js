import crypto from 'node:crypto';
import * as cheerio from 'cheerio';

export const DATASET_ID = '698074744109995';
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
export function money(value) {
  const raw = String(value ?? '').trim();
  if (!/^\d[\d\s\u00a0]*(?:[.,]\d{1,2})?\s*(?:EUR|€)?$/i.test(raw)) return null;
  const text = raw.replace(/[\s\u00a0]/g, '').replace(/(?:EUR|€)$/i, '');
  if (!/^\d+(?:[.,]\d{1,2})?$/.test(text)) return null;
  return Number(text.replace(',', '.'));
}

// Only use explicit customer fields; never hash the shop sender or a footer address.
export function parsePurchaseMail({ html = '', plain = '', orderNumber, orderedAt, products = [] }) {
  const $ = cheerio.load(html);
  const body = plain || $('body').text();
  const totals = [];
  $('tr').each((_, row) => {
    const cells = $(row).children('td,th').map((_, cell) => $(cell).text().trim()).get();
    if (cells.length >= 2 && /^(?:celkom\s*(?:k úhrade|s DPH)?|celková suma|suma k úhrade|spolu s DPH)\s*:?$/i.test(cells[0])) {
      const total = money(cells.at(-1));
      if (total !== null) totals.push(total);
    }
  });
  for (const match of body.matchAll(/(?:celkom k úhrade|celková suma|suma k úhrade|spolu s DPH)\s*:?\s*(\d[\d\s.,]*)\s*(?:EUR|€)/gi)) {
    const total = money(match[1]);
    if (total !== null) totals.push(total);
  }
  const uniqueTotals = [...new Set(totals)];
  const email = body.match(/(?:e-?mail zákazníka|zákaznícky e-?mail|e-?mail)\s*:\s*([^\s<>]+@[^\s<>]+)/i)?.[1]?.trim().toLowerCase();
  const user_data = email && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) ? { em: [hash(email)] } : {};
  const contents = products.map(product => {
    const anchors = $('a[href]').filter((_, a) => $(a).attr('href') === product.product_url);
    const row = anchors.first().closest('tr');
    const explicit = row.attr('data-product-id') || row.text().match(/\bFL_\d+\b/)?.[0];
    let numeric;
    try { numeric = new URL(product.product_url).searchParams.get('product_id'); } catch {}
    numeric ||= product.image_url?.match(/-(\d+)\.(?:jpg|png|webp)(?:\?|$)/i)?.[1];
    const id = /^FL_\d+$/.test(explicit || '') ? explicit : /^\d+$/.test(explicit || numeric || '') ? `FL_${explicit || numeric}` : null;
    // Do not guess whether an unlabelled last column means unit price or row total.
    const headers = row.closest('table').find('tr').filter((_, tr) => $(tr).find('th').length > 0).first().children('th,td').map((_, cell) => $(cell).text().trim()).get();
    const unitColumn = headers.findIndex(text => /^(?:cena za kus|jednotková cena|cena\/ks)(?:\s*\(.*\))?$/i.test(text));
    const priceText = row.attr('data-unit-price') || row.text().match(/(?:cena za kus|jednotková cena|cena\/ks)\s*:?\s*(\d[\d\s.,]*)\s*(?:EUR|€)/i)?.[1] || (unitColumn >= 0 ? row.children('td,th').eq(unitColumn).text() : null);
    const item_price = money(priceText);
    return { id, quantity: product.quantity, item_price };
  });
  return { transaction_id: String(orderNumber || ''), orderedAt, value: uniqueTotals.length === 1 ? uniqueTotals[0] : null, currency: 'EUR', contents, user_data };
}

export function buildPurchase(purchase, now = Date.now()) {
  const time = Math.floor(new Date(purchase.orderedAt).getTime() / 1000);
  const current = Math.floor(now / 1000);
  if (!/^\d{5,}$/.test(purchase.transaction_id)) throw new Error('missing-transaction-id');
  if (!Number.isFinite(time) || time > current || current - time > 7 * 86400) throw new Error('event-outside-time-window');
  if (!Number.isFinite(purchase.value) || purchase.value < 0 || purchase.currency !== 'EUR') throw new Error('missing-final-total');
  if (!purchase.contents.length || purchase.contents.some(x => !/^FL_\d+$/.test(x.id || '') || !Number.isInteger(x.quantity) || x.quantity < 1 || !Number.isFinite(x.item_price) || x.item_price < 0)) throw new Error('incomplete-items');
  const subtotal = purchase.contents.reduce((sum, x) => sum + x.quantity * x.item_price, 0);
  if (!Number.isFinite(subtotal)) throw new Error('invalid-subtotal');
  if (!purchase.user_data.em?.length) throw new Error('missing-customer-identifier');
  return {
    event_name: 'Purchase', event_time: time, event_id: purchase.transaction_id,
    action_source: 'website', event_source_url: 'https://www.foodland.sk/',
    user_data: purchase.user_data,
    custom_data: { currency: 'EUR', value: purchase.value, order_id: purchase.transaction_id, content_type: 'product',
      content_ids: purchase.contents.map(x => x.id), contents: purchase.contents, num_items: purchase.contents.reduce((n, x) => n + x.quantity, 0) }
  };
}

export async function initCapi(pool) {
  await pool.query(`CREATE TABLE IF NOT EXISTS meta_capi_outbox (
    event_id TEXT PRIMARY KEY, payload JSONB NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
    attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), sent_at TIMESTAMPTZ, last_error TEXT
  )`);
}
export async function enqueuePurchase(pool, purchase) {
  let event;
  try { event = buildPurchase(purchase); } catch (error) { return { queued: false, reason: error.message }; }
  const result = await pool.query(`INSERT INTO meta_capi_outbox (event_id,payload) VALUES ($1,$2::jsonb)
    ON CONFLICT (event_id) DO NOTHING RETURNING event_id`, [event.event_id, JSON.stringify(event)]);
  return { queued: result.rows.length === 1, reason: result.rows.length ? null : 'duplicate' };
}

export async function sendEvent(event, { token, version = 'v24.0', testCode = '', fetchImpl = fetch }) {
  if (!token || !/^v\d+\.0$/.test(version)) throw new Error('missing-or-invalid-capi-config');
  const body = { data: [event], ...(testCode ? { test_event_code: testCode } : {}) };
  const response = await fetchImpl(`https://graph.facebook.com/${version}/${DATASET_ID}/events`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body), signal: AbortSignal.timeout(15000), redirect: 'error'
  });
  const result = await response.json();
  if (!response.ok || result.events_received !== 1) {
    // Meta errors can echo request data. Persist only numeric error codes.
    throw new Error(`meta-http-${response.status}-code-${Number(result.error?.code || 0)}`);
  }
  return { events_received: result.events_received };
}

export async function drainCapi(pool, env = process.env, fetchImpl = fetch) {
  if (env.META_CAPI_ENABLED !== 'true' || !env.META_CAPI_ACCESS_TOKEN) return { enabled: false, sent: 0 };
  const startAt = new Date(env.META_CAPI_START_AT || '').getTime();
  if (!Number.isFinite(startAt)) return { enabled: false, sent: 0, reason: 'missing-start-time' };
  const client = await pool.connect();
  let sent = 0;
  try {
    await client.query('BEGIN');
    // Row lock makes simultaneous workers/restarts safe. Meta event_id also deduplicates a crash after delivery.
    const { rows } = await client.query(`SELECT event_id,payload,attempts FROM meta_capi_outbox
      WHERE status='pending' AND next_attempt_at<=NOW() ORDER BY created_at LIMIT 10 FOR UPDATE SKIP LOCKED`);
    for (const row of rows) {
      if (row.payload.event_time * 1000 < startAt || Math.floor(Date.now() / 1000) - row.payload.event_time > 7 * 86400) {
        await client.query(`UPDATE meta_capi_outbox SET status='expired',last_error='event-outside-time-window' WHERE event_id=$1`, [row.event_id]);
        continue;
      }
      try {
        await sendEvent(row.payload, { token: env.META_CAPI_ACCESS_TOKEN, version: env.META_CAPI_API_VERSION || 'v24.0', testCode: env.META_CAPI_TEST_EVENT_CODE || '', fetchImpl });
        await client.query(`UPDATE meta_capi_outbox SET status='sent',sent_at=NOW(),attempts=attempts+1,last_error=NULL WHERE event_id=$1`, [row.event_id]);
        sent++;
      } catch (error) {
        const safeError = /^meta-http-\d+-code-\d+$/.test(error.message) ? error.message : 'capi-transport-error';
        await client.query(`UPDATE meta_capi_outbox SET attempts=attempts+1,last_error=$2,next_attempt_at=NOW()+($3::text || ' seconds')::interval WHERE event_id=$1`,
          [row.event_id, safeError, Math.min(3600, 60 * 2 ** Math.min(row.attempts, 6))]);
      }
    }
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
  return { enabled: true, sent };
}
