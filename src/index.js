import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import crypto from 'crypto';
import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import * as cheerio from 'cheerio';
import pg from 'pg';
import { pathToFileURL } from 'url';

const { Pool } = pg;

const VERSION = '1.4.2';

const PORT = Number(process.env.PORT || 3000);
const POLL_SECONDS = Math.max(30, Number(process.env.POLL_SECONDS || 60));
const MAIL_FOLDER = process.env.MAIL_FOLDER || 'INBOX';
const PROCESS_UNSEEN_ONLY = String(process.env.PROCESS_UNSEEN_ONLY || 'true').toLowerCase() === 'true';
const RECENT_MAX_AGE_HOURS = Math.max(1, Number(process.env.RECENT_MAX_AGE_HOURS || 48));
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';

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
  `);
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

            // Parsing succeeded, so a normal poll does not need to download the
            // same message again. Admin rescan uses seen and unseen messages.
            if (!msg.flags?.has('\\Seen')) {
              await client.messageFlagsAdd({ uid: msg.uid }, ['\\Seen'], { uid: true });
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
  const el = document.getElementById('foodland-live-commerce');
  if (!el) return;

  const api = (el.dataset.api || '').replace(/\/$/, '');
  if (!api) return;

  const interval = Math.max(8000, Number(el.dataset.interval || 12000));

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

  async function load() {
    try {
      const [recentRes, summaryRes] = await Promise.all([
        fetch(api + '/api/live/recent?limit=12&hours=48', { cache: 'no-store' }),
        fetch(api + '/api/live/summary', { cache: 'no-store' })
      ]);

      const recent = (await recentRes.json()).items || [];
      const summary = (await summaryRes.json()).items || [];

      const messages = [];

      recent.forEach(x => {
        messages.push({
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
          messages.push({
            href: x.product_url,
            html:
              '<strong>' + esc(x.product_name) + '</strong> ' +
              '<span style="opacity:.8">· ' +
              esc(dict.today.replace('{n}', Number(x.customers_24h))) +
              '</span>'
          });
        });

      if (!messages.length) return;

      let i = Math.floor(Math.random() * messages.length);

      function render() {
        const m = messages[i % messages.length];
        el.innerHTML =
          '<a href="' + esc(m.href) + '" style="color:inherit;text-decoration:none">' +
          m.html +
          '</a>';
        i++;
      }

      render();
      setInterval(render, interval);
    } catch (e) {
      console.warn('Foodland Live Commerce widget:', e);
    }
  }

  load();
})();
`);
});

async function main() {
  await initDb();

  app.listen(PORT, () => {
    console.log(`Foodland Live Commerce listening on :${PORT}`);
  });

  // First mailbox check shortly after start.
  setTimeout(() => {
    processMailbox({ unseenOnly: true }).then(r => console.log('Initial mailbox scan:', r)).catch(console.error);
  }, 5000);

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
  repairAmbiguousProductImages,
  saveOrder,
  VERSION
};
