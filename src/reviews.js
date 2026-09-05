import crypto from 'crypto';
import * as cheerio from 'cheerio';

export const REVIEW_LANGUAGES = ['sk', 'cz', 'de', 'en', 'pl', 'hu', 'vi'];
export const NAJNAKUP_REVIEW_URL = 'https://www.najnakup.sk/foodland-sk';

const ui = {
  sk: { verified: 'overený zákazník', regular: 'pravidelný zákazník' },
  cz: { verified: 'ověřený zákazník', regular: 'pravidelný zákazník' },
  de: { verified: 'Verifizierter Kunde', regular: 'Stammkunde' },
  en: { verified: 'verified customer', regular: 'regular customer' },
  pl: { verified: 'zweryfikowany klient', regular: 'stały klient' },
  hu: { verified: 'ellenőrzött vásárló', regular: 'rendszeres vásárló' },
  vi: { verified: 'khách hàng đã xác minh', regular: 'khách hàng thường xuyên' }
};

function clean(value = '') {
  return String(value).replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
}

function uniqueText(parts) {
  const seen = new Set();
  return parts.map(clean).filter(text => {
    if (!text) return false;
    const key = text.toLocaleLowerCase('sk');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function reviewKey({ name, date, text }) {
  return crypto.createHash('sha256').update(`${name}|${date}|${text}`).digest('hex');
}

export function parseNajnakupPage(html = '') {
  const $ = cheerio.load(html);
  const pageText = clean($.root().text());
  const overall = Number(pageText.match(/Nákup v obchode odporúča:\s*(\d+)\s*%/i)?.[1] || 0);
  const last90 = Number(pageText.match(/za posledných 90 dní odporúča:\s*(\d+)\s*%/i)?.[1] || 0);
  const totalBlock = $('.bus-store').toArray().map(el => clean($(el).text()))
    .find(text => /Celkový počet hodnotení:/i.test(text)) || '';
  const total = Number(totalBlock.match(/Celkový počet hodnotení:\s*([\d.]+)/i)?.[1]?.replace(/\D/g, '') || 0);
  const reviews = [];

  $('.reviews-page-append .review-sec').each((_, element) => {
    const block = $(element);
    const name = clean(block.find('.img-text2 strong').first().text());
    const date = clean(block.find('.img-text2 em').first().text());
    if (!name || !/^\d{2}\.\d{2}\.\d{4}$/.test(date)) return;

    const recommendationText = clean(block.prevAll('.recommend_icon_detail_container').first().text()).toLocaleLowerCase('sk');
    const recommended = !recommendationText.includes('neodporúčam');
    const positive = clean(block.find('.very-gud-con').first().text());
    const negative = clean(block.find('.yet-text').first().text());
    const summary = clean(block.find('.sensor > p').first().text());
    const parts = uniqueText([positive, negative, summary]);
    const text = parts.join(' ');
    if (!text) return;

    const regular = /nakupujem pravidelne/i.test(summary);
    reviews.push({
      source_key: reviewKey({ name, date, text }),
      name,
      date,
      text,
      recommended,
      customer_type: regular ? 'regular' : 'verified'
    });
  });

  return { stats: { recommendation_percent: overall, recommendation_90d_percent: last90, total_reviews: total }, reviews };
}

export async function fetchNajnakupReviews({ fetchImpl = fetch, pages = 2 } = {}) {
  const documents = [];
  for (let page = 1; page <= pages; page++) {
    const url = page === 1 ? NAJNAKUP_REVIEW_URL : `${NAJNAKUP_REVIEW_URL}/strana-${page}`;
    const response = await fetchImpl(url, {
      signal: AbortSignal.timeout(20000),
      headers: {
        'user-agent': 'Foodland-Reviews/1.0 (+https://www.foodland.sk)',
        accept: 'text/html,application/xhtml+xml'
      }
    });
    if (!response.ok) throw new Error(`Najnakup returned HTTP ${response.status} for page ${page}`);
    documents.push(parseNajnakupPage(await response.text()));
  }

  const seen = new Set();
  const reviews = documents.flatMap(x => x.reviews).filter(review => {
    if (seen.has(review.source_key)) return false;
    seen.add(review.source_key);
    return true;
  }).slice(0, 30);

  if (reviews.length < 10) throw new Error(`Najnakup parser returned only ${reviews.length} reviews`);
  return { stats: documents[0].stats, reviews };
}

async function translateWithOpenAI(texts, language, apiKey, model) {
  if (!texts.length || language === 'sk') return texts;
  const target = { cz: 'Czech', de: 'German', en: 'English', pl: 'Polish', hu: 'Hungarian', vi: 'Vietnamese' }[language];
  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    signal: AbortSignal.timeout(45000),
    headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      model,
      temperature: 0,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: `Translate Slovak customer reviews into ${target}. Preserve meaning, tone, names and product names. Return only JSON: {"translations":["..."]}.` },
        { role: 'user', content: JSON.stringify(texts) }
      ]
    })
  });
  if (!response.ok) throw new Error(`Translation API returned HTTP ${response.status}`);
  const body = await response.json();
  const parsed = JSON.parse(body.choices?.[0]?.message?.content || '{}');
  if (!Array.isArray(parsed.translations) || parsed.translations.length !== texts.length) {
    throw new Error('Translation API returned an invalid translation count');
  }
  return parsed.translations.map(clean);
}

export async function buildTranslations(reviews, { apiKey = '', model = 'gpt-4.1-mini' } = {}) {
  const translations = Object.fromEntries(reviews.map(r => [r.source_key, { sk: r.text }]));
  if (!apiKey) return translations;
  const texts = reviews.map(r => r.text);
  for (const language of REVIEW_LANGUAGES.filter(x => x !== 'sk')) {
    try {
      const translated = await translateWithOpenAI(texts, language, apiKey, model);
      reviews.forEach((review, index) => { translations[review.source_key][language] = translated[index]; });
    } catch (error) {
      console.warn(`Review translation to ${language} failed:`, error.message);
    }
  }
  return translations;
}

export function localizeReview(row, language = 'sk') {
  const lang = REVIEW_LANGUAGES.includes(language) ? language : 'sk';
  const translations = row.translations || {};
  return {
    name: row.customer_name,
    date: row.review_date,
    text: translations[lang] || translations.sk || row.original_text,
    recommended: row.recommended,
    label: ui[lang][row.customer_type] || ui[lang].verified
  };
}
