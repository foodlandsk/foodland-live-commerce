import test from 'node:test';
import assert from 'node:assert/strict';
import { app, extractProducts, extractProductPageImage, VERSION } from '../src/index.js';

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
  assert.match(body, /Vừa được mua/);
  assert.match(body, /api\/live\/recent/);
  assert.equal(VERSION, '1.4.1');
});
