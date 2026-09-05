import test from 'node:test';
import assert from 'node:assert/strict';
import { buildTranslations, fetchNajnakupReviews, localizeReview, parseNajnakupPage } from '../src/reviews.js';

const page = `
  <div>Nákup v obchode odporúča:<strong> 98 %</strong></div>
  <div>Nákup v obchode za posledných 90 dní odporúča:<strong> 96 %</strong></div>
  <div class="bus-store">Celkový počet hodnotení: <strong>6098</strong></div>
  <div class="reviews-page-append">
    <div class="recommend_icon_detail_container"><span>nákup odporúčam</span></div>
    <div class="review-sec">
      <div class="img-text2"><strong>Jana</strong><em>04.09.2026</em></div>
      <div class="very-gud-con">Rýchle dodanie.</div>
      <div class="yet-text">Žiadne mínusy.</div>
      <div class="sensor"><p>V tomto obchode nakupujem pravidelne.</p><div class="review_admin_info">IP adresa</div></div>
    </div>
    <div class="recommend_icon_detail_container"><span>nákup neodporúčam</span></div>
    <div class="review-sec">
      <div class="img-text2"><strong>Peter</strong><em>03.09.2026</em></div>
      <div class="sensor"><p>Objednávka prišla neskoro.</p></div>
    </div>
  </div>`;

test('parseNajnakupPage extracts public stats and faithful review data', () => {
  const result = parseNajnakupPage(page);
  assert.deepEqual(result.stats, {
    recommendation_percent: 98,
    recommendation_90d_percent: 96,
    total_reviews: 6098
  });
  assert.equal(result.reviews.length, 2);
  assert.equal(result.reviews[0].name, 'Jana');
  assert.equal(result.reviews[0].customer_type, 'regular');
  assert.equal(result.reviews[0].text, 'Rýchle dodanie. Žiadne mínusy. V tomto obchode nakupujem pravidelne.');
  assert.equal(result.reviews[1].recommended, false);
});

test('fetchNajnakupReviews rejects suspiciously small parser results', async () => {
  const fetchImpl = async () => ({ ok: true, text: async () => page });
  await assert.rejects(fetchNajnakupReviews({ fetchImpl, pages: 1 }), /only 2 reviews/);
});

test('translations safely fall back to Slovak when no API key is configured', async () => {
  const [review] = parseNajnakupPage(page).reviews;
  const translations = await buildTranslations([review]);
  assert.deepEqual(translations[review.source_key], { sk: review.text });
  assert.equal(localizeReview({
    customer_name: review.name,
    review_date: review.date,
    original_text: review.text,
    translations: translations[review.source_key],
    recommended: true,
    customer_type: 'regular'
  }, 'de').text, review.text);
});
