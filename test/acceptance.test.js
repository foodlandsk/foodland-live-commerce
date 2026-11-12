import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import vm from 'node:vm';
import { app, refreshCustomerReviews } from '../src/index.js';

test('review API clamps invalid limits before querying Postgres', async t => {
  const original = pg.Pool.prototype.query;
  const limits = [];
  pg.Pool.prototype.query = async function(sql, values) {
    if (values) limits.push(values[0]);
    return { rows: [] };
  };
  const server = app.listen(0);
  t.after(() => { pg.Pool.prototype.query = original; server.close(); });
  await new Promise(resolve => server.once('listening', resolve));
  for (const value of ['abc', '999', '-5', '7.8']) {
    const response = await fetch('http://127.0.0.1:' + server.address().port + '/api/reviews?limit=' + value);
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json()).items, []);
  }
  assert.deepEqual(limits, [30, 30, 1, 7]);
});

test('review refresh persists zero percentages and computes missing-source stats', async t => {
  const oldQuery = pg.Pool.prototype.query, oldConnect = pg.Pool.prototype.connect, oldFetch = globalThis.fetch;
  const oldKey = process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;
  t.after(() => {
    pg.Pool.prototype.query = oldQuery; pg.Pool.prototype.connect = oldConnect; globalThis.fetch = oldFetch;
    if (oldKey === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = oldKey;
  });
  let sourceStats, writes = [], computedCalls = 0;
  globalThis.fetch = async () => ({ ok:true, status:200, json:async () => ({
    ok:true, stats:sourceStats, items:Array.from({length:10}, (_, i) => ({
      source_key:'test-' + i, name:'Customer', date:'12.11.2026', text:'Review', recommended:false
    }))
  }) });
  pg.Pool.prototype.query = async () => ({rows:[]});
  pg.Pool.prototype.connect = async () => ({
    release() {},
    async query(sql, values) {
      if (sql.includes('COUNT(*)::int AS total_reviews')) {
        computedCalls++;
        return {rows:[{total_reviews:10, recommendation_percent:0, recommendation_90d_percent:null}]};
      }
      if (sql.includes('UPDATE review_sync_state SET')) {
        assert.doesNotMatch(sql, /NULLIF/);
        writes.push(values);
      }
      return {rows:[]};
    }
  });
  sourceStats = {total_reviews:100, recommendation_percent:0, recommendation_90d_percent:0};
  await refreshCustomerReviews();
  assert.deepEqual(writes[0], [0,0,100]);
  assert.equal(computedCalls,0);
  sourceStats = undefined;
  await refreshCustomerReviews();
  assert.deepEqual(writes[1], [0,null,10]);
  assert.equal(computedCalls,1);
});

test('served review widget displays zero truthfully and unknown percentage without 98 fallback', async t => {
  const server = app.listen(0);
  t.after(() => server.close());
  await new Promise(resolve => server.once('listening', resolve));
  const script = await (await fetch('http://127.0.0.1:' + server.address().port + '/reviews-widget.js')).text();
  const expression = script.match(/var values=\{p:(.*?),n:items.length/)[1];
  assert.equal(vm.runInNewContext(expression, {data:{recommendation_percent:0}}),0);
  assert.equal(vm.runInNewContext(expression, {data:{recommendation_percent:null}}),'—');
});

