import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import crypto from 'crypto';
import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import * as cheerio from 'cheerio';
import pg from 'pg';
import { pathToFileURL } from 'url';
import { buildTranslations, fetchNajnakupReviews, localizeReview, REVIEW_LANGUAGES } from './reviews.js';

const { Pool } = pg;

const VERSION = '1.5.0';

const PORT = Number(process.env.PORT || 3000);
const POLL_SECONDS = Math.max(30, Number(process.env.POLL_SECONDS || 60));
const MAIL_FOLDER = process.env.MAIL_FOLDER || 'INBOX';
const PROCESS_UNSEEN_ONLY = String(process.env.PROCESS_UNSEEN_ONLY || 'true').toLowerCase() === 'true';
const RECENT_MAX_AGE_HOURS = Math.max(1, Number(process.env.RECENT_MAX_AGE_HOURS || 48));
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';
const REVIEWS_REFRESH_HOUR_UTC = Math.min(23, Math.max(0, Number(process.env.REVIEWS_REFRESH_HOUR_UTC || 3)));

const allowedOrigins = (process.env.ALLOWED_ORIGINS || 'https://www.foodland.sk,https://foodland.sk')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: String(process.env.PGSSL || 'true').toLowerCase() === 'true'
    ? { rejectUnauthorized: false }
    : false
});

const app = express();
app.use(express.json());
app.use(cors({
  origin(origin, cb) {
    if (!origin || allowedOrigins.includes(origin)) return cb(null, true);
    return cb(null, false);
  }
}));

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS purchase_events (
      id BIGSERIAL PRIMARY KEY,
      order_hash TEXT NOT NULL,
      order_number_masked TEXT,
      ordered_at TIMESTAMPTZ NOT NULL,
      product_name TEXT NOT NULL,
      product_url TEXT NOT NULL,
      image_url TEXT,
      quantity INTEGER NOT NULL DEFAULT 1,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(order_hash, product_url)
    );

    CREATE INDEX IF NOT EXISTS idx_purchase_events_ordered_at
      ON purchase_events(ordered_at DESC);

    CREATE INDEX IF NOT EXISTS idx_purchase_events_product_url
      ON purchase_events(product_url);

    CREATE TABLE IF NOT EXISTS customer_reviews (
      source_key TEXT PRIMARY KEY,
      customer_name TEXT NOT NULL,
      review_date DATE NOT NULL,
      original_text TEXT NOT NULL,
      translations JSONB NOT NULL DEFAULT '{}'::jsonb,
      recommended BOOLEAN NOT NULL,
      customer_type TEXT NOT NULL DEFAULT 'verified',
      fetched_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_customer_reviews_date
      ON customer_reviews(review_date DESC, fetched_at DESC);

    CREATE TABLE IF NOT EXISTS review_sync_state (
      singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton),
      recommendation_percent INTEGER,
      recommendation_90d_percent INTEGER,
      total_reviews INTEGER,
      last_success_at TIMESTAMPTZ,
      last_attempt_at TIMESTAMPTZ,
      last_error TEXT
    );

    INSERT INTO review_sync_state (singleton) VALUES (TRUE)
    ON CONFLICT (singleton) DO NOTHING;
  `);
}

let reviewSyncStatus = { running: false, last_result: null };

async function refreshCustomerReviews() {
  if (reviewSyncStatus.running) return { skipped: true, reason: 'already-running' };
  reviewSyncStatus.running = true;
  const startedAt = new Date().toISOString();
  try {
    await pool.query(`UPDATE review_sync_state SET last_attempt_at=NOW(), last_error=NULL WHERE singleton=TRUE`);
    const payload = await fetchNajnakupReviews();
    const translations = await buildTranslations(payload.reviews, {
      apiKey: process.env.OPENAI_API_KEY || '',
      model: process.env.REVIEWS_TRANSLATION_MODEL || 'gpt-4.1-mini'
    });
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      for (const review of payload.reviews) {
        await client.query(`
          INSERT INTO customer_reviews
            (source_key, customer_name, review_date, original_text, translations, recommended, customer_type, fetched_at)
          VALUES ($1,$2,TO_DATE($3,'DD.MM.YYYY'),$4,$5::jsonb,$6,$7,NOW())
          ON CONFLICT (source_key) DO UPDATE SET
            customer_name=EXCLUDED.customer_name,
            review_date=EXCLUDED.review_date,
            original_text=EXCLUDED.original_text,
            translations=customer_reviews.translations || EXCLUDED.translations,
            recommended=EXCLUDED.recommended,
            customer_type=EXCLUDED.customer_type,
            fetched_at=NOW()
        `, [review.source_key, review.name, review.date, review.text, JSON.stringify(translations[review.source_key]), review.recommended, review.customer_type]);
      }
      await client.query(`
        UPDATE review_sync_state SET
          recommendation_percent=$1,
          recommendation_90d_percent=$2,
          total_reviews=$3,
          last_success_at=NOW(),
          last_error=NULL
        WHERE singleton=TRUE
      `, [payload.stats.recommendation_percent, payload.stats.recommendation_90d_percent, payload.stats.total_reviews]);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
    const result = { ok: true, started_at: startedAt, reviews: payload.reviews.length, stats: payload.stats };
    reviewSyncStatus.last_result = result;
    return result;
  } catch (error) {
    console.error('Review refresh failed:', error);
    await pool.query(`UPDATE review_sync_state SET last_error=$1 WHERE singleton=TRUE`, [String(error.message).slice(0, 1000)]).catch(() => {});
    reviewSyncStatus.last_result = { ok: false, started_at: startedAt, error: error.message };
    throw error;
  } finally {
    reviewSyncStatus.running = false;
  }
}

function millisecondsUntilReviewRefresh(hourUtc = REVIEWS_REFRESH_HOUR_UTC) {
  const now = new Date();
  const next = new Date(now);
  next.setUTCHours(hourUtc, 0, 0, 0);
  if (next <= now) next.setUTCDate(next.getUTCDate() + 1);
  return next.getTime() - now.getTime();
}

function scheduleDailyReviewRefresh() {
  const delay = millisecondsUntilReviewRefresh();
  setTimeout(async () => {
    try { await refreshCustomerReviews(); } catch {}
    scheduleDailyReviewRefresh();
  }, delay).unref();
  return new Date(Date.now() + delay).toISOString();
}

function maskOrderNumber(orderNumber) {
  const s = String(orderNumber || '');
  if (s.length <= 4) return '****';
  return `${s.slice(0, 4)}***${s.slice(-2)}`;
}

function parseOrderNumber(subject = '', text = '') {
  const source = `${subject}\n${text}`;
  const m =
    source.match(/Potvrdenie objednávky č\.?\s*([0-9]+)/i) ||
    source.match(/Číslo Vašej objednávky:\s*([0-9]+)/i) ||
    source.match(/objednávk[ay]\s*(?:č\.?|#)?\s*([0-9]{5,})/i);
  return m?.[1] || null;
}

function parseOrderDate(subject = '', text = '', mailDate = null) {
  const source = `${subject}\n${text}`;
  const m = source.match(/Dátum a čas prijatia:\s*([0-3]?\d)\.\s*([01]?\d)\.\s*(20\d{2})\s+([0-2]?\d):([0-5]\d):([0-5]\d)/i);
  if (m) {
    const [, dd, mm, yyyy, hh, min, sec] = m;
    // Foodland / Slovakia local time. Store with Europe/Bratislava offset approximation
    // using JS local construction is unsafe on UTC servers, so use explicit +02:00/+01:00 heuristic.
    // For social proof, minute-level precision is sufficient.
    const month = Number(mm);
    const summer = month >= 4 && month <= 10;
    const offset = summer ? '+02:00' : '+01:00';
    return new Date(`${yyyy}-${String(mm).padStart(2,'0')}-${String(dd).padStart(2,'0')}T${String(hh).padStart(2,'0')}:${min}:${sec}${offset}`);
  }
  return mailDate ? new Date(mailDate) : new Date();
}

const excludedPathFragments = [
  '/nasa-ponuka',
  '/vypredaj',
  '/detail-objednavky',
  '/obchod-registracia',
  '/index.php',
  '/blog',
  '/recepty',
  '/hodnotenie-zakaznikov',
  '/kontakt',
  '/o-nas'
];

function normalizeFoodlandUrl(raw) {
  try {
    const u = new URL(raw, 'https://www.foodland.sk');
    if (!/(^|\.)foodland\.sk$/i.test(u.hostname)) return null;
    u.hash = '';
    return u.toString();
  } catch {
    return null;
  }
}

function isLikelyProductLink(href, text) {
  if (!href || !text) return false;
  const url = normalizeFoodlandUrl(href);
  if (!url) return false;
  const u = new URL(url);
  if (excludedPathFragments.some(x => u.pathname.toLowerCase().includes(x))) return false;
  const clean = text.replace(/\s+/g, ' ').trim();
  if (clean.length < 4) return false;
  const badText = [
    'zistiť aktuálny stav objednávky',
    'kliknite sem',
    'aktuálnu ponuku',
    'výhodný výpredaj',
    'foodland',
    'registrujte sa',
    'facebook',
    'instagram',
    'pinterest',
    'youtube',
    'google profil',
    'tiktok'
  ];
  if (badText.some(x => clean.toLowerCase().includes(x))) return false;

  // Product links typically have category/product path with at least two path segments.
  const segments = u.pathname.split('/').filter(Boolean);
  return segments.length >= 2;
}

function nearestContextText($, el) {
  let node = $(el);
  for (let i = 0; i < 4 && node.length; i++) {
    const text = node.text().replace(/\s+/g, ' ').trim();
    if (/Balenie:|(?:^|\s)\d+\s*ks(?:\s|$)/i.test(text)) return text;
    node = node.parent();
  }
  return $(el).parent().text().replace(/\s+/g, ' ').trim();
}

function parseQuantity(context) {
  const matches = [...context.matchAll(/(\d+)\s*ks\b/gi)].map(m => Number(m[1])).filter(n => Number.isFinite(n) && n > 0);
  if (matches.length) return Math.min(matches[matches.length - 1], 999);
  const m2 = context.match(/Balenie:\s*(\d+)\s*kus/i);
  if (m2) return Math.min(Number(m2[1]) || 1, 999);
  return 1;
}

function findImageForProduct($, a) {
  const anchor = $(a);

  // Prefer the exact table row containing this product title.
  // This prevents assigning the previous product's image to the next one.
  const row = anchor.closest('tr');
  if (row.length) {
    const imgs = row.find('img[src]').toArray();

    for (const img of imgs) {
      const src = $(img).attr('src');
      if (src && /foodland\.sk/i.test(src) && /product_order_mail_thumb/i.test(src)) {
        return src;
      }
    }

    for (const img of imgs) {
      const src = $(img).attr('src');
      if (src && /foodland\.sk/i.test(src)) return src;
    }
  }

  // Never fall back to the first image in the surrounding table. Some Creative
  // Sites e-mails use one large table for the complete order, which assigned
  // the first product image to every following product.
  return null;
}

function extractProductPageImage(html = '', productUrl = '') {
  if (!html) return null;
  const $ = cheerio.load(html);
  const raw =
    $('meta[property="og:image"]').attr('content') ||
    $('meta[name="twitter:image"]').attr('content') ||
    $('link[rel="image_src"]').attr('href');

  if (!raw) return null;

  try {
    const imageUrl = new URL(raw, productUrl);
    if (!/(^|\.)foodland\.sk$/i.test(imageUrl.hostname)) return null;
    return imageUrl.toString();
  } catch {
    return null;
  }
}

const productImageCache = new Map();

async function resolveProductPageImage(productUrl) {
  if (productImageCache.has(productUrl)) return productImageCache.get(productUrl);

  let imageUrl = null;
  try {
    const response = await fetch(productUrl, {
      signal: AbortSignal.timeout(10000),
      headers: { 'user-agent': `Foodland-Live-Commerce/${VERSION}` }
    });
    if (response.ok) {
      imageUrl = extractProductPageImage(await response.text(), productUrl);
    }
  } catch (e) {
    console.warn('Product image lookup failed:', { productUrl, error: e.message });
  }

  productImageCache.set(productUrl, imageUrl);
  return imageUrl;
}

async function repairAmbiguousProductImages(products) {
  const counts = new Map();
  for (const p of products) {
    if (p.image_url) counts.set(p.image_url, (counts.get(p.image_url) || 0) + 1);
  }

  const repaired = products.map(p => ({ ...p }));
  const candidates = repaired
    .map((product, index) => ({ product, index }))
    .filter(({ product }) => !product.image_url || (counts.get(product.image_url) || 0) > 1);

  // Keep the product site load modest during a large 30-day admin rescan.
  for (let i = 0; i < candidates.length; i += 4) {
    const batch = candidates.slice(i, i + 4);
    const images = await Promise.all(batch.map(({ product }) => resolveProductPageImage(product.product_url)));
    images.forEach((imageUrl, index) => {
      if (imageUrl) repaired[batch[index].index].image_url = imageUrl;
    });
  }

  return repaired;
}

function extractProducts(html = '') {
  if (!html) return [];
  const $ = cheerio.load(html);
  const seen = new Set();
  const products = [];

  $('a[href]').each((_, a) => {
    const href = $(a).attr('href');
    const text = $(a).text().replace(/\s+/g, ' ').trim();

    if (!isLikelyProductLink(href, text)) return;

    const productUrl = normalizeFoodlandUrl(href);
    if (!productUrl || seen.has(productUrl)) return;

    const context = nearestContextText($, a);
    // A product row in Foodland order mail should be near quantity/packing context.
    if (!/Balenie:|(?:^|\s)\d+\s*ks(?:\s|$)/i.test(context)) return;

    seen.add(productUrl);
    products.push({
      product_name: text,
      product_url: productUrl,
      image_url: findImageForProduct($, a),
      quantity: parseQuantity(context)
    });
  });

  return products;
}

async function saveOrder({ orderNumber, orderedAt, products }) {
  if (!orderNumber || !products.length) return { inserted: 0, updated: 0 };
  const orderHash = sha256(`foodland:${orderNumber}`);
  let inserted = 0;
  let updated = 0;

  for (const p of products) {
    const result = await pool.query(`
      INSERT INTO purchase_events
        (order_hash, order_number_masked, ordered_at, product_name, product_url, image_url, quantity)
      VALUES ($1,$2,$3,$4,$5,$6,$7)
      ON CONFLICT (order_hash, product_url) DO UPDATE SET
        order_number_masked = EXCLUDED.order_number_masked,
        ordered_at = EXCLUDED.ordered_at,
        product_name = EXCLUDED.product_name,
        image_url = COALESCE(EXCLUDED.image_url, purchase_events.image_url),
        quantity = EXCLUDED.quantity
      RETURNING (xmax = 0) AS inserted
    `, [
      orderHash,
      maskOrderNumber(orderNumber),
      orderedAt,
      p.product_name,
      p.product_url,
      p.image_url,
      p.quantity
    ]);
    if (result.rows[0]?.inserted === true) inserted++;
    else updated++;
  }

  return { inserted, updated };
}

function imapConfig() {
  if (!process.env.MAIL_HOST || !process.env.MAIL_USER || !process.env.MAIL_PASSWORD) {
    throw new Error('Missing MAIL_HOST / MAIL_USER / MAIL_PASSWORD');
  }

  return {
    host: process.env.MAIL_HOST,
    port: Number(process.env.MAIL_PORT || 993),
    secure: String(process.env.MAIL_SECURE || 'true').toLowerCase() === 'true',
    auth: {
      user: process.env.MAIL_USER,
      pass: process.env.MAIL_PASSWORD
    },
    logger: false
  };
}

let pollRunning = false;
let scanStatus = {
  running: false,
  phase: 'idle',
  started_at: null,
  completed_at: null,
  pending_orders: 0
};

async function processMailbox({ unseenOnly = PROCESS_UNSEEN_ONLY, lookbackDays = 2 } = {}) {
  if (pollRunning) return { skipped: true, reason: 'already-running', scan: scanStatus };
  pollRunning = true;
  scanStatus = {
    running: true,
    phase: 'imap',
    started_at: new Date().toISOString(),
    completed_at: null,
    pending_orders: 0
  };

  const client = new ImapFlow(imapConfig());
  const pendingOrders = [];
  const seenUids = [];
  let processed = 0;
  let inserted = 0;
  let updated = 0;

  // ImapFlow emits connection failures as EventEmitter errors in addition to
  // rejecting the active operation. Without a listener, a Websupport timeout
  // can terminate the complete Node process.
  client.on('error', error => {
    console.error('IMAP client error:', {
      code: error.code,
      message: error.message,
      connectionId: error._connId
    });
  });

  try {
    try {
      await client.connect();
      const lock = await client.getMailboxLock(MAIL_FOLDER);
      try {
        const query = unseenOnly
          ? { seen: false }
          : { since: new Date(Date.now() - lookbackDays * 24 * 3600 * 1000) };

        for await (const msg of client.fetch(query, { uid: true, envelope: true, source: true, flags: true })) {
          const subject = msg.envelope?.subject || '';

          if (!/Potvrdenie objednávky|objednávk/i.test(subject)) {
            continue;
          }

          const parsed = await simpleParser(msg.source);
          const plain = parsed.text || '';
          const html = typeof parsed.html === 'string' ? parsed.html : '';

          const orderNumber = parseOrderNumber(subject, plain);
          const orderedAt = parseOrderDate(subject, plain, parsed.date || msg.envelope?.date);
          const products = extractProducts(html);

          if (orderNumber && products.length) {
            // Store parsed data in memory and close IMAP before making product
            // page HTTP requests. This prevents the mailbox socket from idling
            // until Websupport terminates it during a large admin rescan.
            pendingOrders.push({ orderNumber, orderedAt, products });
            scanStatus.pending_orders = pendingOrders.length;

            // Never issue another IMAP command inside the active fetch stream.
            // ImapFlow can deadlock when messageFlagsAdd runs before the fetch
            // iterator finishes. Collect UIDs and mark them afterwards.
            if (!msg.flags?.has('\\Seen')) {
              seenUids.push(msg.uid);
            }
          } else {
            console.warn('Order mail not parsed:', {
              uid: msg.uid,
              subject,
              orderNumber,
              products: products.length
            });
          }
        }

        scanStatus.phase = 'mark-seen';
        for (const uid of seenUids) {
          await client.messageFlagsAdd({ uid }, ['\\Seen'], { uid: true });
        }
      } finally {
        lock.release();
      }
    } finally {
      try { await client.logout(); } catch {}
    }

    // Slow product-page lookups and database UPSERTs happen only after the
    // mailbox connection has been released.
    scanStatus.phase = 'images-and-upsert';
    for (const order of pendingOrders) {
      const products = await repairAmbiguousProductImages(order.products);
      const saved = await saveOrder({ ...order, products });
      inserted += saved.inserted;
      updated += saved.updated;
      processed++;
    }
  } finally {
    pollRunning = false;
    scanStatus = {
      ...scanStatus,
      running: false,
      phase: 'idle',
      completed_at: new Date().toISOString()
    };
  }

  return { processed, inserted, updated };
}

app.get('/health', async (_req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({
      ok: true,
      service: 'foodland-live-commerce',
      version: VERSION,
      mailbox: process.env.MAIL_USER ? 'configured' : 'missing',
      pollSeconds: POLL_SECONDS,
      scan: scanStatus,
      reviews: reviewSyncStatus,
      time: new Date().toISOString()
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get('/api/live/recent', async (req, res) => {
  const limit = Math.min(30, Math.max(1, Number(req.query.limit || 10)));
  const hours = Math.min(168, Math.max(1, Number(req.query.hours || RECENT_MAX_AGE_HOURS)));

  const { rows } = await pool.query(`
    SELECT
      product_name,
      product_url,
      image_url,
      quantity,
      ordered_at,
      GREATEST(0, ROUND(EXTRACT(EPOCH FROM (NOW() - ordered_at)) / 60))::int AS minutes_ago
    FROM purchase_events
    WHERE ordered_at >= NOW() - ($1::text || ' hours')::interval
    ORDER BY ordered_at DESC
    LIMIT $2
  `, [String(hours), limit]);

  res.set('Cache-Control', 'public, max-age=30');
  res.json({ items: rows });
});

app.get('/api/live/summary', async (_req, res) => {
  const { rows } = await pool.query(`
    SELECT
      product_name,
      product_url,
      MAX(image_url) AS image_url,
      SUM(quantity) FILTER (WHERE ordered_at >= NOW() - INTERVAL '24 hours')::int AS units_24h,
      COUNT(DISTINCT order_hash) FILTER (WHERE ordered_at >= NOW() - INTERVAL '24 hours')::int AS customers_24h,
      SUM(quantity) FILTER (WHERE ordered_at >= NOW() - INTERVAL '7 days')::int AS units_7d,
      COUNT(DISTINCT order_hash) FILTER (WHERE ordered_at >= NOW() - INTERVAL '7 days')::int AS customers_7d,
      MAX(ordered_at) AS last_purchase_at
    FROM purchase_events
    WHERE ordered_at >= NOW() - INTERVAL '7 days'
    GROUP BY product_name, product_url
    ORDER BY customers_24h DESC, units_24h DESC, customers_7d DESC
    LIMIT 30
  `);

  res.set('Cache-Control', 'public, max-age=60');
  res.json({ items: rows });
});

app.get('/api/reviews', async (req, res) => {
  try {
    const requestedLanguage = String(req.query.lang || 'sk').toLowerCase();
    const language = requestedLanguage === 'cs'
      ? 'cz'
      : (REVIEW_LANGUAGES.includes(requestedLanguage) ? requestedLanguage : 'sk');
    const limit = Math.min(30, Math.max(1, Number(req.query.limit || 30)));
    const [reviewsResult, stateResult] = await Promise.all([
      pool.query(`
        SELECT customer_name, TO_CHAR(review_date, 'DD.MM.YYYY') AS review_date,
               original_text, translations, recommended, customer_type
        FROM customer_reviews
        ORDER BY review_date DESC, fetched_at DESC
        LIMIT $1
      `, [limit]),
      pool.query(`
        SELECT recommendation_percent, recommendation_90d_percent, total_reviews,
               last_success_at, last_attempt_at
        FROM review_sync_state WHERE singleton=TRUE
      `)
    ]);
    const state = stateResult.rows[0] || {};
    res.set('Cache-Control', 'public, max-age=300, stale-while-revalidate=86400');
    res.json({
      language,
      recommendation_percent: state.recommendation_percent,
      recommendation_90d_percent: state.recommendation_90d_percent,
      total_reviews: state.total_reviews,
      updated_at: state.last_success_at,
      items: reviewsResult.rows.map(row => localizeReview(row, language))
    });
  } catch (error) {
    console.error('Reviews API failed:', error);
    res.status(500).json({ ok: false, error: 'reviews_unavailable' });
  }
});

app.post('/admin/refresh-reviews', async (req, res) => {
  if (!ADMIN_TOKEN || req.get('x-admin-token') !== ADMIN_TOKEN) {
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }
  try {
    res.json(await refreshCustomerReviews());
  } catch (error) {
    res.status(502).json({ ok: false, error: error.message });
  }
});

app.post('/admin/rescan', async (req, res) => {
  if (!ADMIN_TOKEN || req.get('x-admin-token') !== ADMIN_TOKEN) {
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }

  try {
    const days = Math.min(30, Math.max(1, Number(req.query.days || 2)));
    const result = await processMailbox({ unseenOnly: false, lookbackDays: days });
    res.json({ ok: true, ...result });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post('/admin/repair-images', async (req, res) => {
  if (!ADMIN_TOKEN || req.get('x-admin-token') !== ADMIN_TOKEN) {
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }

  try {
    const hours = Math.min(720, Math.max(1, Number(req.query.hours || 48)));
    const { rows } = await pool.query(`
      SELECT DISTINCT product_url
      FROM purchase_events
      WHERE ordered_at >= NOW() - ($1::text || ' hours')::interval
      ORDER BY product_url
    `, [String(hours)]);

    let productsRepaired = 0;
    let rowsUpdated = 0;
    const failedUrls = [];

    for (let i = 0; i < rows.length; i += 4) {
      const batch = rows.slice(i, i + 4);
      for (const { product_url: productUrl } of batch) productImageCache.delete(productUrl);
      const images = await Promise.all(batch.map(({ product_url: productUrl }) => resolveProductPageImage(productUrl)));

      for (let j = 0; j < batch.length; j++) {
        const productUrl = batch[j].product_url;
        const imageUrl = images[j];
        if (!imageUrl) {
          failedUrls.push(productUrl);
          continue;
        }

        const updated = await pool.query(`
          UPDATE purchase_events
          SET image_url = $1
          WHERE product_url = $2
            AND ordered_at >= NOW() - ($3::text || ' hours')::interval
        `, [imageUrl, productUrl, String(hours)]);
        productsRepaired++;
        rowsUpdated += updated.rowCount;
      }
    }

    res.json({
      ok: true,
      hours,
      products_scanned: rows.length,
      products_repaired: productsRepaired,
      rows_updated: rowsUpdated,
      failed_urls: failedUrls
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get('/widget.js', (_req, res) => {
  res.type('application/javascript');
  res.set('Cache-Control', 'public, max-age=300');
  res.send(String.raw`
(function () {
  function startWidget() {
    if (window.__foodlandLiveCommerceStarted) return true;

  const targets = Array.from(new Set([
    ...document.querySelectorAll('[data-foodland-live-commerce]'),
    ...document.querySelectorAll('#foodland-live-commerce')
  ]));
  if (!targets.length) return false;

  const config = targets.find(function (target) { return target.dataset.api; }) || targets[0];
  const api = (config.dataset.api || '').replace(/\/$/, '');
  if (!api) return false;
  window.__foodlandLiveCommerceStarted = true;

  const interval = Math.max(8000, Number(config.dataset.interval || 12000));
  const mode = config.dataset.mode === 'recent' ? 'recent' : 'mixed';
  const cardTargets = targets.filter(function (target) { return target.dataset.layout === 'cards'; });
  const textTargets = targets.filter(function (target) { return target.dataset.layout !== 'cards'; });

  const langRaw = (document.documentElement.lang || 'sk').toLowerCase();
  const lang = langRaw.startsWith('cs') ? 'cz' :
               langRaw.startsWith('de') ? 'de' :
               langRaw.startsWith('en') ? 'en' :
               langRaw.startsWith('pl') ? 'pl' :
               langRaw.startsWith('hu') ? 'hu' :
               langRaw.startsWith('vi') ? 'vi' : 'sk';

  const dict = {
    sk: { recent: 'Práve kúpené', ago: 'pred {n} min.', today: 'Dnes objednané {n}×' },
    cz: { recent: 'Právě koupeno', ago: 'před {n} min.', today: 'Dnes objednáno {n}×' },
    de: { recent: 'Gerade gekauft', ago: 'vor {n} Min.', today: 'Heute {n}× bestellt' },
    en: { recent: 'Just purchased', ago: '{n} min. ago', today: 'Ordered {n}× today' },
    pl: { recent: 'Właśnie kupiono', ago: '{n} min temu', today: 'Dziś zamówiono {n}×' },
    hu: { recent: 'Most vásárolták', ago: '{n} perce', today: 'Ma {n}× rendelték' },
    vi: { recent: 'Vừa được mua', ago: '{n} phút trước', today: 'Hôm nay đã đặt {n}×' }
  }[lang];

  function esc(s) {
    return String(s || '').replace(/[&<>"']/g, function(c) {
      return ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c];
    });
  }

  function relativeLabel(n) {
    const v = Math.max(1, Math.round(Number(n || 1)));

    if (v < 60) {
      return dict.ago.replace('{n}', v);
    }

    const hours = Math.round(v / 60);
    if (hours < 24) {
      const hourText = {
        sk: 'pred {n} h',
        cz: 'před {n} h',
        de: 'vor {n} Std.',
        en: '{n} h ago',
        pl: '{n} godz. temu',
        hu: '{n} órája',
        vi: '{n} giờ trước'
      }[lang];
      return hourText.replace('{n}', hours);
    }

    const days = Math.round(hours / 24);
    const dayText = {
      sk: days === 1 ? 'včera' : 'pred {n} dňami',
      cz: days === 1 ? 'včera' : 'před {n} dny',
      de: days === 1 ? 'gestern' : 'vor {n} Tagen',
      en: days === 1 ? 'yesterday' : '{n} days ago',
      pl: days === 1 ? 'wczoraj' : '{n} dni temu',
      hu: days === 1 ? 'tegnap' : '{n} napja',
      vi: days === 1 ? 'hôm qua' : '{n} ngày trước'
    }[lang];

    return dayText.replace('{n}', days);
  }

  let messages = [];
  let messageIndex = 0;
  let messageTimer = null;

  function setupCardControls(target) {
    const root = target.closest('.fl-live-prefooter');
    if (!root) return;

    const previous = root.querySelector('.fl-live-prefooter__arrow--prev');
    const next = root.querySelector('.fl-live-prefooter__arrow--next');
    if (!previous || !next) return;

    function sync() {
      const max = Math.max(0, target.scrollWidth - target.clientWidth);
      previous.disabled = target.scrollLeft <= 3;
      next.disabled = target.scrollLeft >= max - 3 || max <= 3;
      previous.setAttribute('aria-disabled', String(previous.disabled));
      next.setAttribute('aria-disabled', String(next.disabled));
    }

    if (target.dataset.flControlsBound !== 'true') {
      function move(direction) {
        const card = target.querySelector('.fl-live-cards__card');
        const cardWidth = card ? card.getBoundingClientRect().width : 220;
        const gap = parseFloat(getComputedStyle(target).columnGap || getComputedStyle(target).gap || 0);
        const page = Math.max(cardWidth + gap, target.clientWidth * 0.78);
        target.scrollBy({ left: direction * page, behavior: 'smooth' });
      }

      previous.addEventListener('click', function () { move(-1); });
      next.addEventListener('click', function () { move(1); });
      target.addEventListener('scroll', sync, { passive: true });
      window.addEventListener('resize', sync);
      target.dataset.flControlsBound = 'true';
    }

    requestAnimationFrame(sync);
  }

  function renderCards(recent) {
    if (!cardTargets.length) return;

    const cards = recent.slice(0, 12).map(function (x) {
      const media = x.image_url
        ? '<img src="' + esc(x.image_url) + '" alt="" loading="lazy" decoding="async">'
        : '<span class="fl-live-cards__placeholder" aria-hidden="true">🛒</span>';

      return (
        '<a class="fl-live-cards__card" href="' + esc(x.product_url) + '">' +
          '<span class="fl-live-cards__media">' + media + '</span>' +
          '<span class="fl-live-cards__copy">' +
            '<span class="fl-live-cards__meta">' + esc(dict.recent) + ' · ' + esc(relativeLabel(x.minutes_ago)) + '</span>' +
            '<strong class="fl-live-cards__name">' + esc(x.product_name) + '</strong>' +
          '</span>' +
        '</a>'
      );
    }).join('');

    if (!cards) return;
    cardTargets.forEach(function (target) {
      target.innerHTML = cards;
      setupCardControls(target);
    });
  }

  function renderMessage() {
    if (!messages.length || !textTargets.length) return;
    const m = messages[messageIndex % messages.length];
    textTargets.forEach(function (target) {
      target.innerHTML =
        '<a href="' + esc(m.href) + '" style="color:inherit;text-decoration:none">' +
        m.html +
        '</a>';
    });
    messageIndex++;
  }

  async function load() {
    try {
      const [recentRes, summaryRes] = await Promise.all([
        fetch(api + '/api/live/recent?limit=12&hours=48', { cache: 'no-store' }),
        mode === 'recent'
          ? Promise.resolve(null)
          : fetch(api + '/api/live/summary', { cache: 'no-store' })
      ]);

      const recent = (await recentRes.json()).items || [];
      const summary = summaryRes ? (await summaryRes.json()).items || [] : [];

      const nextMessages = [];

      renderCards(recent);

      recent.forEach(x => {
        nextMessages.push({
          href: x.product_url,
          html:
            '<strong>' + esc(dict.recent) + ':</strong> ' +
            esc(x.product_name) +
            ' <span style="opacity:.75">· ' + esc(relativeLabel(x.minutes_ago)) + '</span>'
        });
      });

      summary
        .filter(x => Number(x.customers_24h || 0) >= 4)
        .slice(0, 6)
        .forEach(x => {
          nextMessages.push({
            href: x.product_url,
            html:
              '<strong>' + esc(x.product_name) + '</strong> ' +
              '<span style="opacity:.8">· ' +
              esc(dict.today.replace('{n}', Number(x.customers_24h))) +
              '</span>'
          });
        });

      if (!nextMessages.length) return;

      messages = nextMessages;
      if (!messageTimer && textTargets.length) {
        messageIndex = Math.floor(Math.random() * messages.length);
        renderMessage();
        messageTimer = setInterval(renderMessage, interval);
      }
    } catch (e) {
      console.warn('Foodland Live Commerce widget:', e);
    }
  }

  load();
  cardTargets.forEach(setupCardControls);
  if (cardTargets.length) setInterval(load, 60000);
  return true;
  }

  if (startWidget()) return;

  const observer = new MutationObserver(function () {
    if (startWidget()) observer.disconnect();
  });

  observer.observe(document.documentElement, { childList: true, subtree: true });
  setTimeout(function () { observer.disconnect(); }, 30000);
})();
`);
});

app.get('/reviews-widget.js', (_req, res) => {
  res.type('application/javascript');
  res.set('Cache-Control', 'public, max-age=300');
  res.send(String.raw`
(function () {
  var script = document.currentScript;
  var api = script && script.src ? new URL(script.src).origin : '';
  var copies = {
    sk:{title:'{p} % zákazníkov odporúča FOODLAND',updated:'Najnovších {n} hodnotení z NajNakup.sk • {t} hodnotení celkom • Aktualizované: {d}',yes:'Odporúča obchod',no:'Neodporúča obchod'},
    cz:{title:'{p} % zákazníků doporučuje FOODLAND',updated:'Nejnovějších {n} hodnocení z NajNakup.sk • celkem {t} hodnocení • Aktualizováno: {d}',yes:'Doporučuje obchod',no:'Nedoporučuje obchod'},
    de:{title:'{p} % der Kunden empfehlen FOODLAND',updated:'Die neuesten {n} Bewertungen von NajNakup.sk • insgesamt {t} Bewertungen • Aktualisiert: {d}',yes:'Empfiehlt den Shop',no:'Empfiehlt den Shop nicht'},
    en:{title:'{p}% of customers recommend FOODLAND',updated:'Latest {n} reviews from NajNakup.sk • {t} reviews in total • Updated: {d}',yes:'Recommends the store',no:'Does not recommend the store'},
    pl:{title:'{p}% klientów poleca FOODLAND',updated:'{n} najnowszych opinii z NajNakup.sk • łącznie {t} opinii • Aktualizacja: {d}',yes:'Poleca sklep',no:'Nie poleca sklepu'},
    hu:{title:'A vásárlók {p}%-a ajánlja a FOODLAND-ot',updated:'A NajNakup.sk {n} legfrissebb értékelése • összesen {t} értékelés • Frissítve: {d}',yes:'Ajánlja az üzletet',no:'Nem ajánlja az üzletet'},
    vi:{title:'{p}% khách hàng giới thiệu FOODLAND',updated:'{n} đánh giá mới nhất từ NajNakup.sk • tổng cộng {t} đánh giá • Cập nhật: {d}',yes:'Giới thiệu cửa hàng',no:'Không giới thiệu cửa hàng'}
  };
  function fill(text, values) { return text.replace(/\{(\w+)\}/g, function (_, key) { return values[key]; }); }
  function start(root) {
    if (root.dataset.reviewsLoading === 'true' || root.dataset.reviewsLoaded === 'true') return;
    root.dataset.reviewsLoading = 'true';
    var lang = (root.dataset.lang || document.documentElement.lang || 'sk').toLowerCase();
    lang = lang.indexOf('cs') === 0 ? 'cz' : lang.slice(0,2);
    if (!copies[lang]) lang = 'sk';
    var c = copies[lang], track = root.querySelector('.foodland-review-track'), dots = root.querySelector('.foodland-review-dots');
    var title = root.querySelector('.foodland-review-title span'), updated = root.querySelector('.foodland-review-updated');
    if (!api || !track || !dots) return;
    fetch(api + '/api/reviews?lang=' + encodeURIComponent(lang) + '&limit=30', { cache:'no-store' })
      .then(function (response) { if (!response.ok) throw new Error('HTTP ' + response.status); return response.json(); })
      .then(function (data) {
        if (!Array.isArray(data.items) || !data.items.length) throw new Error('No reviews');
        var items = data.items, page = 0, perPage = window.innerWidth <= 768 ? 1 : 3;
        function card(review) {
          var el = document.createElement('div'); el.className = 'foodland-review-card';
          var top = document.createElement('div'); top.style.cssText = 'display:flex;justify-content:space-between;align-items:center;margin-bottom:.5rem;gap:.5rem';
          var badge = document.createElement('span'); badge.textContent = review.recommended ? '✓ ' + c.yes : '⚠ ' + c.no;
          badge.style.cssText = 'font-size:.82rem;font-weight:600;color:' + (review.recommended ? '#2e7d32' : '#c62828');
          var date = document.createElement('span'); date.textContent = review.date; date.style.cssText = 'font-size:.85rem;color:#999;white-space:nowrap';
          top.appendChild(badge); top.appendChild(date);
          var text = document.createElement('p'); text.textContent = review.text; text.style.cssText = 'font-style:italic;color:#444;margin:0 0 1rem;line-height:1.4;overflow:hidden;text-overflow:ellipsis;display:-webkit-box;-webkit-line-clamp:6;-webkit-box-orient:vertical';
          var author = document.createElement('p'); author.textContent = review.name; author.style.cssText = 'color:#222;font-weight:bold;margin-top:auto';
          var label = document.createElement('span'); label.textContent = review.label; label.style.cssText = 'display:block;color:#999;font-size:.82rem;font-weight:400;margin-top:2px'; author.appendChild(label);
          el.appendChild(top); el.appendChild(text); el.appendChild(author); return el;
        }
        function render() {
          var pages = Math.ceil(items.length / perPage); page = Math.max(0, Math.min(page, pages - 1)); track.textContent = ''; dots.textContent = '';
          items.slice(page * perPage, page * perPage + perPage).forEach(function (item) { track.appendChild(card(item)); });
          for (var i=0; i<pages; i++) { var dot=document.createElement('div'); dot.className='foodland-review-dot'+(i===page?' active':''); dot.textContent=i+1; dot.dataset.page=i; dot.onclick=function(){page=Number(this.dataset.page);render();}; dots.appendChild(dot); }
        }
        window.foodlandSlideReviews = function(direction) { page += direction; render(); };
        var onResize = function () { var next=window.innerWidth<=768?1:3; if(next!==perPage){perPage=next;page=0;render();} };
        window.addEventListener('resize', onResize);
        var values={p:data.recommendation_percent||98,n:items.length,t:Number(data.total_reviews||0).toLocaleString(lang==='cz'?'cs-CZ':lang),d:data.updated_at?new Date(data.updated_at).toLocaleDateString(lang==='cz'?'cs-CZ':lang):''};
        if(title) title.textContent='⭐ NajNakup.sk • '+fill(c.title,values); if(updated) updated.textContent=fill(c.updated,values);
        render(); root.dataset.reviewsLoaded='true'; root.dataset.reviewsLoading='false';
      }).catch(function (error) { root.dataset.reviewsLoading='false'; console.warn('Foodland reviews: using embedded fallback', error); });
  }
  function init() { document.querySelectorAll('[data-foodland-reviews]').forEach(start); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
  new MutationObserver(init).observe(document.documentElement,{childList:true,subtree:true});
})();
`);
});

async function main() {
  await initDb();
  const nextReviewRefresh = scheduleDailyReviewRefresh();

  app.listen(PORT, () => {
    console.log(`Foodland Live Commerce listening on :${PORT}`);
  });

  // First mailbox check shortly after start.
  setTimeout(() => {
    processMailbox({ unseenOnly: true }).then(r => console.log('Initial mailbox scan:', r)).catch(console.error);
  }, 5000);

  setTimeout(async () => {
    try {
      const { rows } = await pool.query('SELECT COUNT(*)::int AS count FROM customer_reviews');
      if (!rows[0]?.count) console.log('Initial review sync:', await refreshCustomerReviews());
    } catch (error) {
      console.error('Initial review sync failed:', error);
    }
  }, 10000);

  console.log(`Next daily review refresh: ${nextReviewRefresh}`);

  setInterval(() => {
    processMailbox({ unseenOnly: true }).then(r => {
      if (r?.processed || r?.inserted) console.log('Mailbox scan:', r);
    }).catch(console.error);
  }, POLL_SECONDS * 1000);
}

const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectRun) {
  main().catch(err => {
    console.error(err);
    process.exit(1);
  });
}

export {
  app,
  extractProducts,
  extractProductPageImage,
  findImageForProduct,
  millisecondsUntilReviewRefresh,
  repairAmbiguousProductImages,
  refreshCustomerReviews,
  saveOrder,
  VERSION
};
