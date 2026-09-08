import crypto from 'crypto';
import * as cheerio from 'cheerio';

export const REVIEW_LANGUAGES = ['sk', 'cz', 'de', 'en', 'pl', 'hu', 'vi'];
export const NAJNAKUP_REVIEW_URL = 'https://www.najnakup.sk/foodland-sk';
export const NAJNAKUP_WIDGET_URL = 'https://www.najnakup.sk/dz_shop_opinions.aspx?w=8237';
export const DEFAULT_REVIEWS_PROXY_URL = 'https://foodland-express.sk/foodland-najnakup-reviews.php';

const browserHeaders = {
  'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36',
  accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'accept-language': 'sk-SK,sk;q=0.9,en;q=0.8',
  'cache-control': 'no-cache',
  pragma: 'no-cache',
  'upgrade-insecure-requests': '1'
};

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

export function parseNajnakupWidgetPage(html = '') {
  const $ = cheerio.load(html);
  const reviews = [];
  $('.dis').each((_, element) => {
    const block = $(element);
    const name = clean(block.find('.dis_logo').first().clone().find('img,br').remove().end().text());
    const dateTime = clean(block.find('.dis_dt').first().text());
    const date = dateTime.match(/\d{2}\.\d{2}\.\d{4}/)?.[0] || '';
    const recommendation = clean(block.find('.dis_plus').first().text()).toLocaleUpperCase('sk');
    const recommended = !recommendation.includes('NEODPORÚČAM');
    const positive = clean(block.find('.rating_vyh').first().text());
    const negative = clean(block.find('.rating_nev').first().text());
    const summary = clean(block.find('.rating_desc').first().text());
    const text = uniqueText([positive, negative, summary]).join(' ');
    if (!name || !date || !text) return;
    reviews.push({
      source_key: reviewKey({ name, date, text }),
      name,
      date,
      text,
      recommended,
      customer_type: /nakupujem pravidelne/i.test(summary) ? 'regular' : 'verified'
    });
  });
  return { stats: { recommendation_percent: 0, recommendation_90d_percent: 0, total_reviews: 0 }, reviews };
}

export async function fetchNajnakupReviews({ fetchImpl = fetch, pages = 2 } = {}) {
  const proxyUrl = process.env.REVIEWS_PROXY_URL || DEFAULT_REVIEWS_PROXY_URL;
  try {
    const response = await fetchImpl(proxyUrl, {
      signal: AbortSignal.timeout(45000),
      redirect: 'follow',
      headers: { accept: 'application/json', 'user-agent': browserHeaders['user-agent'] }
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = await response.json();
    if (payload?.ok !== true || !Array.isArray(payload.items) || payload.items.length < 10) {
      throw new Error('invalid or incomplete JSON');
    }
    const reviews = payload.items.slice(0, 30).map(review => ({
      source_key: clean(review.source_key) || reviewKey(review),
      name: clean(review.name),
      date: clean(review.date),
      text: clean(review.text),
      recommended: review.recommended !== false,
      customer_type: review.customer_type === 'regular' ? 'regular' : 'verified'
    })).filter(review => review.name && /^\d{2}\.\d{2}\.\d{4}$/.test(review.date) && review.text);
    if (reviews.length < 10) throw new Error('fewer than 10 valid reviews');
    return {
      stats: {
        recommendation_percent: Number(payload.stats?.recommendation_percent || 0),
        recommendation_90d_percent: Number(payload.stats?.recommendation_90d_percent || 0),
        total_reviews: Number(payload.stats?.total_reviews || 0)
      },
      reviews,
      source: 'foodland-express-proxy',
      diagnostics: [{
        source: 'foodland-express-proxy',
        status: response.status,
        reviews: reviews.length,
        stale: payload.stale === true,
        cache: payload.cache || null,
        error: null
      }]
    };
  } catch (error) {
    console.warn('Foodland reviews proxy unavailable, trying Najnakup directly:', error.message);
  }

  let cookie = '';
  const absorbCookies = response => {
    const values = typeof response.headers?.getSetCookie === 'function' ? response.headers.getSetCookie() : [];
    const additions = values.map(value => value.split(';', 1)[0]);
    if (additions.length) cookie = [...new Set([...cookie.split('; ').filter(Boolean), ...additions])].join('; ');
  };
  try {
    const warmup = await fetchImpl('https://www.najnakup.sk/', {
      signal: AbortSignal.timeout(15000),
      redirect: 'follow',
      headers: browserHeaders
    });
    absorbCookies(warmup);
  } catch {
    // The profile request can still succeed without a warm-up cookie.
  }

  const request = async (url, source, { method = 'GET', body, parser = parseNajnakupPage } = {}) => {
    const response = await fetchImpl(url, {
      signal: AbortSignal.timeout(30000),
      redirect: 'follow',
      method,
      body,
      headers: {
        ...browserHeaders,
        referer: source === 'widget' ? 'https://www.foodland.sk/' : 'https://www.najnakup.sk/',
        ...(method === 'POST' ? { 'content-type': 'application/x-www-form-urlencoded', origin: 'https://www.najnakup.sk' } : {}),
        ...(cookie ? { cookie } : {})
      }
    });
    absorbCookies(response);
    const html = await response.text();
    return { source, url, status: response.status, ok: response.ok, bytes: html.length, html, parsed: parser(html) };
  };

  const diagnostics = [];
  const widget = await request(NAJNAKUP_WIDGET_URL, 'widget', { parser: parseNajnakupWidgetPage }).catch(error => ({ source: 'widget', status: 0, ok: false, bytes: 0, error: error.message }));
  diagnostics.push({ source: widget.source, status: widget.status, bytes: widget.bytes, reviews: widget.parsed?.reviews.length || 0, error: widget.error || null });

  let documents = [];
  if (widget.ok && widget.parsed.reviews.length >= 10) {
    documents = [widget.parsed];
    let previousHtml = widget.html;
    for (let page = 2; page <= Math.max(3, pages); page++) {
      const $ = cheerio.load(previousHtml);
      const form = new URLSearchParams();
      $('form input[name]').each((_, input) => {
        const name = $(input).attr('name');
        if (name) form.set(name, $(input).attr('value') || '');
      });
      form.set('__EVENTTARGET', `ucShopRating1$DataPager1$ctl00$ctl0${page - 1}`);
      form.set('__EVENTARGUMENT', '');
      const result = await request(NAJNAKUP_WIDGET_URL, `widget-page-${page}`, {
        method: 'POST', body: form, parser: parseNajnakupWidgetPage
      }).catch(error => ({ source: `widget-page-${page}`, status: 0, ok: false, bytes: 0, error: error.message }));
      diagnostics.push({ source: result.source, status: result.status, bytes: result.bytes, reviews: result.parsed?.reviews.length || 0, error: result.error || null });
      if (!result.ok || !result.parsed.reviews.length) break;
      documents.push(result.parsed);
      previousHtml = result.html;
    }
  } else {
    for (let page = 1; page <= pages; page++) {
      const url = page === 1 ? NAJNAKUP_REVIEW_URL : `${NAJNAKUP_REVIEW_URL}/strana-${page}`;
      const result = await request(url, `profile-page-${page}`).catch(error => ({ source: `profile-page-${page}`, status: 0, ok: false, bytes: 0, error: error.message }));
      diagnostics.push({ source: result.source, status: result.status, bytes: result.bytes, reviews: result.parsed?.reviews.length || 0, error: result.error || null });
      if (!result.ok) break;
      documents.push(result.parsed);
    }
  }

  const seen = new Set();
  const reviews = documents.flatMap(x => x.reviews).filter(review => {
    if (seen.has(review.source_key)) return false;
    seen.add(review.source_key);
    return true;
  }).slice(0, 30);

  if (reviews.length < 10) {
    throw new Error(`Najnakup sources unavailable: ${diagnostics.map(x => `${x.source}=HTTP ${x.status}, ${x.bytes} bytes, ${x.reviews} reviews${x.error ? `, ${x.error}` : ''}`).join('; ')}`);
  }
  return { stats: documents[0].stats, reviews, source: documents[0] === widget.parsed ? 'widget' : 'profile', diagnostics };
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
