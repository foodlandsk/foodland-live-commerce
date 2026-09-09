import test from 'node:test';
import assert from 'node:assert/strict';
import {
  app,
  clampInt,
  createTtlCache,
  extractProducts,
  extractProductId,
  extractLocalizedProductPage,
  extractProductPageImage,
  mapWithConcurrency,
  maskOrderNumber,
  millisecondsUntilReviewRefresh,
  parseOrderDate,
  VERSION
} from '../src/index.js';

test('extractProducts keeps each image in its own product row', () => {
  const html = `
    <table>
      <tr>
        <td><img src="https://www.foodland.sk/sub/a/product_order_mail_thumb/pho-ga.jpg"></td>
        <td><a href="https://www.foodland.sk/polievky/pho-ga/">Pho Ga</a> Balenie: 1 kus 1 ks</td>
      </tr>
      <tr>
        <td><img src="https://www.foodland.sk/sub/a/product_order_mail_thumb/pho-bo.jpg"></td>
        <td><a href="https://www.foodland.sk/polievky/pho-bo/">Pho Bo</a> Balenie: 2 kus 2 ks</td>
      </tr>
    </table>`;

  const products = extractProducts(html);
  assert.equal(products.length, 2);
  assert.equal(products[0].image_url.endsWith('/pho-ga.jpg'), true);
  assert.equal(products[1].image_url.endsWith('/pho-bo.jpg'), true);
  assert.equal(products[1].quantity, 2);
});

test('extractProducts never reuses the first image from the whole order table', () => {
  const html = `
    <table>
      <tr><td><img src="https://www.foodland.sk/sub/a/product_order_mail_thumb/first.jpg"></td></tr>
      <tr><td><a href="https://www.foodland.sk/polievky/second/">Second product</a> Balenie: 1 kus 1 ks</td></tr>
    </table>`;

  const [product] = extractProducts(html);
  assert.equal(product.image_url, null);
});

test('extractProductPageImage reads a Foodland og:image safely', () => {
  const html = '<meta property="og:image" content="/sub/foodland.sk/shop/product/skorica-439.jpg">';
  assert.equal(
    extractProductPageImage(html, 'https://www.foodland.sk/koreniny/skorica/'),
    'https://www.foodland.sk/sub/foodland.sk/shop/product/skorica-439.jpg'
  );

  assert.equal(
    extractProductPageImage('<meta property="og:image" content="https://evil.example/image.jpg">', 'https://www.foodland.sk/p/x/'),
    null
  );
});

test('live products use the shared Foodland product id for localization', () => {
  assert.equal(extractProductId({
    image_url: 'https://www.foodland.sk/sub/foodland.sk/shop/product/pho-bo-vifon-120g-2561.jpg'
  }), '2561');
  assert.equal(extractProductId({
    product_url: 'https://www.foodland.at/index.php?product_id=2561'
  }), '2561');

  const localized = extractLocalizedProductPage(
    '<title>PHO BO Instant beef soup with meat HOANG GIA VIFON 120 g | Foodland</title>' +
    '<meta property="og:image" content="/sub/foodland.sk/shop/product/pho-bo-2561.jpg">',
    'https://www.foodland-express.com/index.php?product_id=2561'
  );
  assert.equal(localized.product_name, 'PHO BO Instant beef soup with meat HOANG GIA VIFON 120 g');
  assert.match(localized.product_url, /foodland-express\.com/);
  assert.match(localized.image_url, /foodland-express\.com/);
});

test('UPSERT repairs images and protects an existing image from NULL', async () => {
  const source = await import('node:fs/promises').then(fs => fs.readFile(new URL('../src/index.js', import.meta.url), 'utf8'));
  assert.match(source, /ON CONFLICT \(order_hash, product_url\) DO UPDATE SET/);
  assert.match(source, /image_url = COALESCE\(EXCLUDED\.image_url, purchase_events\.image_url\)/);
  assert.doesNotMatch(source, /ON CONFLICT \(order_hash, product_url\) DO NOTHING/);
});

test('mailbox is released before product-page image repair starts', async () => {
  const source = await import('node:fs/promises').then(fs => fs.readFile(new URL('../src/index.js', import.meta.url), 'utf8'));
  const logoutAt = source.indexOf('await client.logout()');
  const repairAt = source.indexOf('await repairAmbiguousProductImages(order.products)');
  assert.ok(logoutAt > 0);
  assert.ok(repairAt > logoutAt);
  assert.match(source, /client\.on\('error'/);
});

test('historical scans are bounded and stored images have a direct repair endpoint', async () => {
  const source = await import('node:fs/promises').then(fs => fs.readFile(new URL('../src/index.js', import.meta.url), 'utf8'));
  assert.match(source, /lookbackDays = 2/);
  assert.match(source, /app\.post\('\/admin\/repair-images'/);
  assert.match(source, /processMailbox\(\{ unseenOnly: true \}\)/);
  assert.match(source, /scan: scanStatus/);
});

test('messages are marked seen only after the IMAP fetch iterator finishes', async () => {
  const source = await import('node:fs/promises').then(fs => fs.readFile(new URL('../src/index.js', import.meta.url), 'utf8'));
  const fetchAt = source.indexOf('for await (const msg of client.fetch');
  const collectAt = source.indexOf('seenUids.push(msg.uid)');
  const markAt = source.indexOf('await client.messageFlagsAdd({ uid }');
  assert.ok(fetchAt > 0);
  assert.ok(collectAt > fetchAt);
  assert.ok(markAt > collectAt);
  assert.equal(source.slice(fetchAt, collectAt).includes('await client.messageFlagsAdd'), false);
});

test('reviews preserve source order inside the same date', async () => {
  const source = await import('node:fs/promises').then(fs => fs.readFile(new URL('../src/index.js', import.meta.url), 'utf8'));
  assert.match(source, /ADD COLUMN IF NOT EXISTS source_position INTEGER/);
  assert.match(source, /for \(const \[position, review\] of payload\.reviews\.entries\(\)\)/);
  assert.match(source, /ORDER BY customer_reviews\.review_date DESC, customer_reviews\.source_position ASC NULLS LAST, customer_reviews\.fetched_at DESC/);
});

test('Infowidget JavaScript is served and contains the multilingual client', async (t) => {
  const server = app.listen(0);
  t.after(() => server.close());
  await new Promise(resolve => server.once('listening', resolve));
  const { port } = server.address();

  const response = await fetch(`http://127.0.0.1:${port}/widget.js`);
  const body = await response.text();
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /javascript/);
  assert.match(body, /foodland-live-commerce/);
  assert.match(body, /data-foodland-live-commerce/);
  assert.match(body, /dataset\.mode/);
  assert.match(body, /dataset\.layout === 'cards'/);
  assert.match(body, /fl-live-cards__card/);
  assert.match(body, /image_url/);
  assert.match(body, /fl-live-prefooter__arrow--prev/);
  assert.match(body, /fl-live-prefooter__arrow--next/);
  assert.match(body, /scrollBy/);
  assert.match(body, /cardTargets\.forEach/);
  assert.match(body, /textTargets\.forEach/);
  assert.match(body, /Vừa được mua/);
  assert.match(body, /api\/live\/recent/);
  assert.match(body, /data-fl-live-copy/);
  assert.match(body, /encodeURIComponent\(lang\)/);
  assert.match(body, /window\.location\.hostname/);
  assert.match(body, /www\.foodland-express\.cz/);
  assert.match(body, /vn\.foodland\.sk/);
  assert.match(body, /MutationObserver/);
  assert.match(body, /__foodlandLiveCommerceStarted/);
  assert.equal(VERSION, '1.6.0');
});

test('Infowidget dict translates every data-fl-live-copy key in every language', async (t) => {
  const server = app.listen(0);
  t.after(() => server.close());
  await new Promise(resolve => server.once('listening', resolve));
  const { port } = server.address();

  const response = await fetch(`http://127.0.0.1:${port}/widget.js`);
  const body = await response.text();

  // These four keys (used by the card/sidebar HTML modules via
  // data-fl-live-copy="cardSubtitle" etc.) were previously missing from the
  // dict, so `if (dict[key])` silently skipped them and the elements kept
  // whatever placeholder text was hardcoded in the HTML (e.g. Slovak text
  // showing on the German storefront). Assert each language's translation
  // is present, not just Slovak's.
  const expectedByLanguage = {
    sk: ['Produkty, ktoré si zákazníci práve vybrali', 'Načítavam najnovšie objednávky…'],
    cz: ['Produkty, které si zákazníci právě vybrali', 'Načítám nejnovější objednávky…'],
    de: ['Produkte, die Kunden gerade ausgewählt haben', 'Neueste Bestellungen werden geladen…'],
    en: ['Products customers have just selected', 'Loading latest orders…'],
    pl: ['Produkty właśnie wybrane przez klientów', 'Ładowanie najnowszych zamówień…'],
    hu: ['A vásárlók által most kiválasztott termékek', 'A legújabb rendelések betöltése…'],
    vi: ['Những sản phẩm khách hàng vừa chọn', 'Đang tải đơn hàng mới nhất…']
  };
  for (const [language, phrases] of Object.entries(expectedByLanguage)) {
    for (const phrase of phrases) {
      assert.ok(body.includes(phrase), `expected ${language} translation "${phrase}" in widget.js`);
    }
  }
});

test('Infowidget replaces a stuck loading skeleton with a translated empty state', async (t) => {
  const server = app.listen(0);
  t.after(() => server.close());
  await new Promise(resolve => server.once('listening', resolve));
  const { port } = server.address();

  const response = await fetch(`http://127.0.0.1:${port}/widget.js`);
  const body = await response.text();

  // A card/ticker target used to keep its static "Loading…" placeholder
  // forever whenever a successful fetch resolved with zero items (renderCards
  // / renderMessage bailed out early on falsy content). Assert the module now
  // renders a translated empty state instead, and only before real content
  // has ever been shown (cardsRendered / messages.length guards).
  assert.match(body, /cardsRendered/);
  assert.match(body, /esc\(dict\.empty\)/);
  assert.match(body, /if \(!messages\.length && !messageTimer && textTargets\.length\)/);
  assert.match(body, /empty: 'Noch keine Bestellungen\.'/);
});

test('Review widget JavaScript is served independently from live orders', async (t) => {
  const server = app.listen(0);
  t.after(() => server.close());
  await new Promise(resolve => server.once('listening', resolve));
  const { port } = server.address();
  const response = await fetch(`http://127.0.0.1:${port}/reviews-widget.js`);
  const body = await response.text();
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /javascript/);
  assert.match(body, /data-foodland-reviews/);
  assert.match(body, /api\/reviews/);
  assert.match(body, /using embedded fallback/);
  assert.match(body, /Neodporúča obchod/);
});

test('parseOrderDate applies the correct Europe/Bratislava DST offset at the CET/CEST boundary', () => {
  const utcOf = ddmmyyyyHms => parseOrderDate('', `Dátum a čas prijatia: ${ddmmyyyyHms}`).toISOString();

  // 2026 DST transitions: CEST starts Sun 29 Mar, ends Sun 25 Oct (both 2026).
  // A fixed month>=4 && month<=10 heuristic gets both boundary weeks wrong.
  assert.equal(utcOf('28. 3. 2026 10:00:00'), '2026-03-28T09:00:00.000Z'); // still CET (+01:00)
  assert.equal(utcOf('31. 3. 2026 10:00:00'), '2026-03-31T08:00:00.000Z'); // already CEST (+02:00)
  assert.equal(utcOf('24. 10. 2026 10:00:00'), '2026-10-24T08:00:00.000Z'); // still CEST (+02:00)
  assert.equal(utcOf('30. 10. 2026 10:00:00'), '2026-10-30T09:00:00.000Z'); // already CET (+01:00)

  // Sanity checks well away from either transition.
  assert.equal(utcOf('15. 7. 2026 12:00:00'), '2026-07-15T10:00:00.000Z');
  assert.equal(utcOf('15. 1. 2026 12:00:00'), '2026-01-15T11:00:00.000Z');
});

test('parseOrderDate falls back to the mail date when the subject/body has no timestamp', () => {
  const mailDate = new Date('2026-05-01T00:00:00.000Z');
  assert.equal(parseOrderDate('no timestamp here', '', mailDate).getTime(), mailDate.getTime());
});

test('maskOrderNumber always hides at least one digit for real order numbers', () => {
  // parseOrderNumber only ever extracts 5+ digit order numbers.
  for (const orderNumber of ['12345', '123456', '1234567', '123456789012']) {
    const masked = maskOrderNumber(orderNumber);
    assert.notEqual(masked, orderNumber);
    assert.match(masked, /\*/);
    const digitsShown = masked.replace(/\*/g, '').length;
    assert.ok(digitsShown < orderNumber.length, `expected fewer than ${orderNumber.length} digits shown, got "${masked}"`);
  }
  assert.equal(maskOrderNumber('1234'), '****');
  assert.equal(maskOrderNumber(''), '****');
});

test('clampInt falls back to a finite default instead of propagating NaN', () => {
  assert.equal(clampInt('abc', 10, 1, 30), 10);
  assert.equal(clampInt(undefined, 10, 1, 30), 10);
  assert.equal(clampInt('5', 10, 1, 30), 5);
  assert.equal(clampInt('999', 10, 1, 30), 30);
  assert.equal(clampInt('-5', 10, 1, 30), 1);
  assert.equal(clampInt('7.8', 10, 1, 30), 7);
});

test('mapWithConcurrency preserves order and never runs more than batchSize mappers at once', async () => {
  let active = 0;
  let maxActive = 0;
  const items = [10, 20, 30, 40, 50, 60, 70];
  const results = await mapWithConcurrency(items, 3, async value => {
    active++;
    maxActive = Math.max(maxActive, active);
    await new Promise(resolve => setTimeout(resolve, 5));
    active--;
    return value * 2;
  });
  assert.deepEqual(results, [20, 40, 60, 80, 100, 120, 140]);
  assert.ok(maxActive <= 3, `expected at most 3 concurrent calls, saw ${maxActive}`);
});

test('createTtlCache expires a failed (falsy) lookup quickly but keeps a successful one', async () => {
  const cache = createTtlCache({ positiveTtlMs: 1000, negativeTtlMs: 20 });
  cache.set('miss', null);
  cache.set('hit', { ok: true });

  assert.equal(cache.has('miss'), true);
  assert.equal(cache.get('miss'), null);
  assert.equal(cache.has('hit'), true);
  assert.deepEqual(cache.get('hit'), { ok: true });

  await new Promise(resolve => setTimeout(resolve, 30));

  assert.equal(cache.has('miss'), false, 'a transient failure should not stay cached forever');
  assert.equal(cache.get('miss'), undefined);
  assert.equal(cache.has('hit'), true, 'a successful lookup should outlive the negative TTL');
});

test('createTtlCache.delete removes an entry before its TTL expires', () => {
  const cache = createTtlCache({ positiveTtlMs: 60000, negativeTtlMs: 60000 });
  cache.set('key', 'value');
  assert.equal(cache.has('key'), true);
  cache.delete('key');
  assert.equal(cache.has('key'), false);
  assert.equal(cache.get('key'), undefined);
});

test('review refresh hour falls back to the documented 21:00 default when unset', () => {
  // .env.example / CHANGELOG.md (v1.6.0) document 21:00 Europe/Bratislava;
  // this test runs without REVIEWS_REFRESH_HOUR_LOCAL set, so the module's
  // fallback constant applies.
  const delay = millisecondsUntilReviewRefresh();
  const next = new Date(Date.now() + delay);
  const hour = Number(new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Bratislava',
    hour: '2-digit',
    hourCycle: 'h23'
  }).format(next));
  assert.equal(hour, 21);
});

test('a known Foodland storefront origin is allowed by CORS', async (t) => {
  const server = app.listen(0);
  t.after(() => server.close());
  await new Promise(resolve => server.once('listening', resolve));
  const { port } = server.address();

  // Regression test for a production incident: this exact origin was
  // rejected because ALLOWED_ORIGINS on Railway didn't include it, silently
  // breaking the DE storefront's live-orders and reviews widgets with only
  // a browser-console CORS error to go on.
  const response = await fetch(`http://127.0.0.1:${port}/health`, {
    headers: { origin: 'https://www.foodland.at' }
  });

  assert.equal(response.headers.get('access-control-allow-origin'), 'https://www.foodland.at');
});

test('a disallowed CORS origin is rejected and logged for diagnosis', async (t) => {
  const server = app.listen(0);
  t.after(() => server.close());
  await new Promise(resolve => server.once('listening', resolve));
  const { port } = server.address();

  const originalWarn = console.warn;
  const warnings = [];
  console.warn = (...args) => { warnings.push(args.join(' ')); };
  t.after(() => { console.warn = originalWarn; });

  const response = await fetch(`http://127.0.0.1:${port}/health`, {
    headers: { origin: 'https://evil.example' }
  });

  assert.equal(response.headers.get('access-control-allow-origin'), null);
  assert.ok(
    warnings.some(w => w.includes('CORS rejected origin "https://evil.example"')),
    'expected a CORS rejection warning naming the origin, so a misconfiguration like this is diagnosable from server logs alone'
  );
});

test('/api/reviews sorts by the real review_date column, not by its DD.MM.YYYY display text', async () => {
  // Production incident: reviews came back sorted by day-of-month only
  // (e.g. 31.08, 30.08 x3, ... 24.08, then jumping back to 08.09, 07.09,
  // ...), completely ignoring month and year.
  //
  // Root cause: `SELECT ... TO_CHAR(review_date, 'DD.MM.YYYY') AS review_date
  // ... ORDER BY review_date DESC` — PostgreSQL resolves a bare ORDER BY
  // identifier to a matching SELECT-list alias *before* an input-table
  // column of the same name (documented behavior, the opposite of what
  // GROUP BY does). So `review_date` in ORDER BY bound to the TO_CHAR(...)
  // text alias, not the underlying DATE column, and sorted that text
  // lexicographically — which sorts by day-of-month first and ignores
  // month/year entirely, exactly reproducing the observed order.
  //
  // Fix: qualify the ORDER BY columns with the table name so they can only
  // resolve to the real input columns.
  const source = await import('node:fs/promises').then(fs => fs.readFile(new URL('../src/index.js', import.meta.url), 'utf8'));
  assert.match(
    source,
    /ORDER BY customer_reviews\.review_date DESC, customer_reviews\.source_position ASC NULLS LAST, customer_reviews\.fetched_at DESC/
  );

  // Directly demonstrate the bug this guards against: sorting the DD.MM.YYYY
  // display text (as the unqualified ORDER BY used to, in effect) produces a
  // materially different, wrong order versus sorting by the real date.
  const displayDates = [
    '31.08.2026', '30.08.2026', '29.08.2026', '24.08.2026',
    '08.09.2026', '07.09.2026', '01.09.2026'
  ];
  const sortedAsText = [...displayDates].sort((a, b) => b.localeCompare(a));
  const toDate = s => { const [d, m, y] = s.split('.'); return new Date(Number(y), Number(m) - 1, Number(d)); };
  const sortedByRealDate = [...displayDates].sort((a, b) => toDate(b) - toDate(a));
  assert.notDeepEqual(sortedAsText, sortedByRealDate, 'the two sort strategies must disagree for this fixture, or the regression would not be caught');
  assert.deepEqual(sortedByRealDate, [
    '08.09.2026', '07.09.2026', '01.09.2026', '31.08.2026', '30.08.2026', '29.08.2026', '24.08.2026'
  ]);
});
