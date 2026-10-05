import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as cheerio from 'cheerio';
import { extractProducts, parseOrderDate } from '../src/index.js';
import { money, parsePurchaseMail, resolvePurchaseIds, productIdFromHtml, buildPurchase, enqueuePurchase, sendEvent, drainCapi, DATASET_ID } from '../src/meta-capi.js';

function fixture() {
  const html = `<table><tr data-product-id="FL_356" data-unit-price="2.02"><td><a href="https://www.foodland.sk/p/test/">Test</a></td><td>1 ks</td></tr><tr><td>Celkom k úhrade:</td><td>3,70 EUR</td></tr></table>`;
  return parsePurchaseMail({ html, plain: 'E-mail zákazníka: test@example.com', orderNumber: '202618457', orderedAt: new Date(), products: [{ product_url: 'https://www.foodland.sk/p/test/', quantity: 1 }] });
}
test('real CreativeSites nested layout: ordered quantity, row totals and customer block', async () => {
  const html=fs.readFileSync(new URL('./fixtures/creativesites-order.html',import.meta.url),'utf8');
  const $=cheerio.load(html);
  const products=extractProducts(html);
  assert.deepEqual(products.map(x=>x.quantity),[1,2]);
  const orderedAt=parseOrderDate('', $('body').text());
  assert.equal(orderedAt.toISOString(),'2026-09-16T06:13:07.000Z');
  const purchase=parsePurchaseMail({html,orderedAt,orderNumber:'202618457',products});
  assert.deepEqual(purchase.contents.map(x=>x.id),[null,null]);
  const resolved=await resolvePurchaseIds(purchase,async url=>({ok:true,text:async()=>`<script>gtag("event", "view_item", ${JSON.stringify({items:[{item_id:url.includes('udon-')?'FL_379':'FL_356'}]})});</script>`}));
  assert.deepEqual(resolved.contents,[{id:'FL_356',quantity:1,item_price:2.02},{id:'FL_379',quantity:2,item_price:0.83}]);
  assert.equal(purchase.value,3.70);
  const event=buildPurchase(resolved,new Date('2026-09-16T06:14:00Z').getTime());
  assert.equal(event.custom_data.num_items,3);
  assert.ok(!JSON.stringify(event).includes('customer@example.com'));
  assert.throws(()=>buildPurchase(purchase,new Date('2026-10-05T08:00:00Z').getTime()),/time-window/);
  const withoutCustomer=html.replace(/<a href="mailto:customer@example.com">customer@example.com<\/a>/,'');
  assert.deepEqual(parsePurchaseMail({html:withoutCustomer,products}).user_data,{});
});
test('final charged total is independent of product subtotal, with catalog ids and stable browser event id', () => {
  const event = buildPurchase(fixture());
  assert.equal(event.event_id, '202618457');
  assert.equal(event.custom_data.value, 3.70);
  assert.deepEqual(event.custom_data.contents, [{ id:'FL_356', quantity:1, item_price:2.02 }]);
  assert.match(event.user_data.em[0], /^[a-f0-9]{64}$/);
  assert.ok(!JSON.stringify(event).includes('test@example.com'));
});
test('ambiguous totals, missing prices/ids/customer and old events are blocked', () => {
  assert.throws(() => buildPurchase({ ...fixture(), value:null }), /missing-final-total/);
  assert.throws(() => buildPurchase({ ...fixture(), contents:[{ id:'356', quantity:1, item_price:2 }] }), /incomplete-items/);
  assert.throws(() => buildPurchase({ ...fixture(), user_data:{} }), /missing-customer/);
  assert.throws(() => buildPurchase({ ...fixture(), orderedAt:new Date(Date.now()-8*86400000) }), /time-window/);
  assert.equal(parsePurchaseMail({html:'<table><tr><td>Celkom</td><td>2 EUR</td></tr><tr><td>Celkom</td><td>3 EUR</td></tr></table>'}).value, null);
  assert.equal(money('1 234,56 EUR'),1234.56);
  assert.equal(money('2 EUR 3 EUR'),null);
});
test('enqueue uses transaction id uniqueness and never stores invalid events', async () => {
  const ids = new Set(); let calls = 0;
  const pool = { query: async (sql, args) => { calls++; assert.match(sql,/ON CONFLICT \(event_id\) DO NOTHING/); const exists=ids.has(args[0]); ids.add(args[0]); return {rows:exists?[]:[{event_id:args[0]}]}; } };
  assert.equal((await enqueuePurchase(pool,fixture())).queued,true);
  assert.equal((await enqueuePurchase(pool,fixture())).reason,'duplicate');
  await enqueuePurchase(pool,{...fixture(),value:null});
  assert.equal(calls,2);
});
test('sender uses fixed dataset and Bearer token; response must confirm one received event', async () => {
  const result = await sendEvent(buildPurchase(fixture()),{token:'secret',testCode:'TEST123',fetchImpl:async (url, options) => {
    assert.equal(url,`https://graph.facebook.com/v24.0/${DATASET_ID}/events`);
    assert.ok(!url.includes('secret'));
    assert.equal(options.headers.Authorization,'Bearer secret');
    assert.equal(JSON.parse(options.body).test_event_code,'TEST123');
    return {ok:true,json:async()=>({events_received:1})};
  }});
  assert.equal(result.events_received,1);
  await assert.rejects(sendEvent(buildPurchase(fixture()),{token:'secret',fetchImpl:async()=>({ok:false,status:400,json:async()=>({error:{code:190,message:'secret'}})})}),/^Error: meta-http-400-code-190$/);
});
test('disabled sender never accesses database or network', async () => {
  assert.deepEqual(await drainCapi({connect:()=>{throw new Error('must not connect');}},{}),{enabled:false,sent:0});
});
test('worker retries failures without secret logs and commits accepted events', async () => {
  const queries=[];
  const client={query:async(sql,args)=>{queries.push([sql,args]);return {rows:sql.startsWith('SELECT')?[{event_id:'202618457',payload:buildPurchase(fixture()),attempts:0}]:[]};},release(){}};
  await drainCapi({connect:async()=>client},{META_CAPI_ENABLED:'true',META_CAPI_ACCESS_TOKEN:'secret',META_CAPI_START_AT:new Date(Date.now()-60000).toISOString()},async()=>{throw new Error('secret');});
  assert.ok(queries.some(([sql,args])=>sql.includes('next_attempt_at=')&&args[1]==='capi-transport-error'));
  assert.equal(queries.at(-1)[0],'COMMIT');
  queries.length=0;
  const result=await drainCapi({connect:async()=>client},{META_CAPI_ENABLED:'true',META_CAPI_ACCESS_TOKEN:'secret',META_CAPI_START_AT:new Date(Date.now()-60000).toISOString()},async()=>({ok:true,json:async()=>({events_received:1})}));
  assert.equal(result.sent,1);
  assert.ok(queries.some(([sql])=>sql.includes("status='sent'")));
});

test('item ID lookup ignores recommendations and refuses conflicts, missing payloads and external URLs', async()=>{
  assert.equal(productIdFromHtml('gtag("event","view_item_list",{"items":[{"item_id":"FL_400"}]});'),null);
  assert.equal(productIdFromHtml('gtag("event","view_item",{"items":[{"item_id":"FL_379"}]}); gtag("event","view_item",{"items":[{"item_id":"FL_400"}]});'),null);
  await assert.rejects(resolvePurchaseIds({contents:[{id:null,product_url:'https://evil.example/'}]},()=>{throw Error('must not fetch');}),/invalid-product-url/);
  await assert.rejects(resolvePurchaseIds({contents:[{id:null,product_url:'https://www.foodland.sk/p/test/'}]},async()=>({ok:true,text:async()=>'<h1>Missing</h1>'})),/product-id-unavailable/);
});
