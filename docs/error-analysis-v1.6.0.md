# Foodland Live Commerce v1.6.0 — analýza a mapovanie chýb

Dátum: 2026-09-08. Zdroj: aktuálny stav vetvy `main` tohto repozitára (verzia `1.6.0` podľa
`package.json` a `CHANGELOG.md`). Cieľom je architektonický/expertný audit backendu, PHP proxy a
klientskych widgetov — s presnými odkazmi na súbor a riadok, reprodukciou a odporúčaním opravy.

## Architektúra v skratke

```
IMAP mailbox (objednávkové e-maily)
  -> src/index.js: processMailbox() – parsovanie e-mailu (cheerio) -> purchase_events (Postgres)
  -> GET /api/live/recent, /api/live/summary -> widget.js (injektovaný do foodland.sk a sesterských shopov)

NajNakup.sk (externé recenzie)
  -> proxy/foodland-najnakup-reviews.php (cURL scraper, súborová cache)
  -> src/reviews.js: fetchNajnakupReviews() (proxy ako primárny zdroj, priamy scrape ako fallback)
  -> customer_reviews (Postgres) -> GET /api/reviews -> reviews-widget.js
```

7 jazykových mutácií (`sk cz de en pl hu vi`) zdieľa jeden backend a jeden JS klient na produkt
aj na recenzie. Toto je rozumný a kompaktný návrh; nájdené chyby sú prevažne v okrajových
prípadoch (chybné vstupy, DST, caching, cross-language fan-out), nie v základnej dátovej ceste.

Legenda závažnosti: 🔴 kritická (funkčný dopad na produkciu) · 🟠 stredná · 🟡 nízka/hardening.

---

## 🔴 1. Neošetrené chyby v `/api/live/recent` a `/api/live/summary` môžu request "zaseknúť"

**Súbor:** `src/index.js:706-756`

Obe route handlery volajú `pool.query(...)` bez `try/catch`, na rozdiel od `/api/reviews`,
`/admin/rescan` a `/admin/repair-images`, ktoré chybu explicitne chytajú a vrátia JSON s
`500`/`502`. Express 4 (použitá verzia: `^4.21.1`) **nezachytáva automaticky rejected Promise**
z async route handlera — bez vlastného try/catch alebo `express-async-errors` middleware taká
chyba skončí ako unhandled rejection a klient nedostane žiadnu odpoveď (visí do timeoutu).

Konkrétny reprodukovateľný prípad:

```js
// src/index.js:707-708
const limit = Math.min(30, Math.max(1, Number(req.query.limit || 10)));
const hours = Math.min(168, Math.max(1, Number(req.query.hours || RECENT_MAX_AGE_HOURS)));
```

`Number('abc')` je `NaN`; `Math.max(1, NaN)` aj `Math.min(30, NaN)` vrátia `NaN`. Request typu
`GET /api/live/recent?limit=abc` alebo `?hours=xx` teda pošle `LIMIT NaN` / `'NaN hours'::interval`
do Postgresu, dopyt zlyhá, chyba nie je zachytená a request visí bez odpovede. To isté platí pre
`hours` v `/api/live/summary` cez `queryLimit`.

**Dopad:** ktorýkoľvek klient (aj neúmyselne, cez zle nakonfigurovaný CDN/cache kľúč alebo bota)
môže spôsobiť visiace requesty na verejnom, neautentifikovanom endpointe.

**Odporúčanie:** obaliť oba handlery do `try/catch` (rovnako ako `/api/reviews`) a validovať
`Number.isFinite()` pred `Math.min/max`, nie až po.

---

## 🔴 2. Neobmedzený "fan-out" externých HTTP requestov pri preklade produktov (non-SK jazyky)

**Súbor:** `src/index.js:706-734` (najmä 710 a 726-730), v kontraste s `src/index.js:464-485`

```js
const queryLimit = lang === 'sk' ? limit : Math.min(90, limit * 3);   // až 90 riadkov
...
const items = lang === 'sk'
  ? rows
  : (await Promise.all(rows.map(row => localizeLiveProduct(row, lang))))  // až 90 paralelných fetchov
    .filter(Boolean)
    .slice(0, limit);
```

Pre CZ/DE/EN/PL/HU/VI storefronty sa pri studenej cache (`localizedProductCache`) spustí až 90
paralelných `fetch()` volaní na `foodland-express.cz/at/com/pl/hu` alebo `vn.foodland.sk`, každý
s 10 s timeoutom (`localizeLiveProduct`, riadok 431-434) — na **jeden jediný prichádzajúci
request** widgetu.

To je priamo v rozpore s princípom, ktorý si kód sám stanovil o pár desiatok riadkov nižšie pre
rovnaký typ operácie:

```js
// src/index.js:475-476
// Keep the product site load modest during a large 30-day admin rescan.
for (let i = 0; i < candidates.length; i += 4) { ... }
```

`repairAmbiguousProductImages` a `resolveProductPageImage` sú zámerne dávkované po 4, presne
preto, aby nezaťažili produktové stránky. `/api/live/recent` pre non-SK jazyky túto opatrnosť
nemá vôbec — a keďže widget.js volá tento endpoint z **každej** stránky, na ktorej je vložený,
raz za 60 s (`setInterval(load, 60000)`, `widget.js` riadok 1126), pri návštevnosti na
zahraničných shopoch sa toto môže znásobiť naprieč mnohými súčasnými návštevníkmi.

**Dopad:** riziko pomalých odpovedí (blokuje sa na najpomalšom z 90 fetchov), zbytočné zaťaženie
vlastnej infraštruktúry (jazykové Foodland weby) vlastným AI/social-proof widgetom.

**Odporúčanie:** dávkovať `localizeLiveProduct` rovnako ako `repairAmbiguousProductImages`
(napr. po 4-6), prípadne cachovať výsledok agresívnejšie a predpočítavať preklady on background
namiesto request-time.

---

## 🔴 3. Chybný výpočet letného/zimného času v `parseOrderDate` — posun objednávky až o 1 hodinu

**Súbor:** `src/index.js:220-234`

```js
const month = Number(mm);
const summer = month >= 4 && month <= 10;
const offset = summer ? '+02:00' : '+01:00';
```

Kód sám v komentári priznáva, že ide o heuristiku ("using JS local construction is unsafe...").
Problém: reálny prechod SELČ/SEČ v EÚ nastáva **posledná nedeľa marca** a **posledná nedeľa
októbra**, nie 1. apríla / 1. novembra. Konkrétne:

- V poslednom týždni marca (pred prechodom, napr. 1.–~28./29. 3.) je mesiac `3`, teda
  `summer = false` → kód správne použije `+01:00` (CET). To je v poriadku *do* prechodu, ale kód
  by pre marec od prechodu ďalej (napr. 30.–31. 3.) mal používať `+02:00` a nepoužíva — 2 dni v
  marci sú posunuté o hodinu.
- V poslednom týždni októbra (napr. 25.–31. 10., po prechode na zimný čas) je mesiac `10`, teda
  `summer = true` → kód nesprávne použije `+02:00` (CEST), hoci Slovensko je už na `+01:00`
  (CET). Toto sa opakuje **každý rok**, cca 4–6 dní na konci októbra.

**Dopad:** timestampy objednávok (`ordered_at`) sú v týchto oknách posunuté o hodinu, čo sa
priamo prejaví v social-proof texte "pred X min." / "pred X h" vo widgete — objednávka spred 5
minút sa môže zobraziť ako "pred 65 min." alebo naopak, počas presne tých dní v roku, kedy má
byť "živosť" widgetu najpresvedčivejšia.

**Odporúčanie:** namiesto ručnej heuristiky použiť `Intl.DateTimeFormat` s `timeZone:
'Europe/Bratislava'` na zistenie skutočného offsetu pre daný dátum (rovnaký prístup, aký už kód
používa v `millisecondsUntilReviewRefresh`, riadky 176-194) — eliminuje to celú triedu chýb bez
potreby externej knižnice.

---

## 🔴 4. `maskOrderNumber` v skutočnosti nemaskuje čísla objednávok bežnej dĺžky

**Súbor:** `src/index.js:205-209`

```js
function maskOrderNumber(orderNumber) {
  const s = String(orderNumber || '');
  if (s.length <= 4) return '****';
  return `${s.slice(0, 4)}***${s.slice(-2)}`;
}
```

`parseOrderNumber` (riadok 211-218) akceptuje čísla objednávok od dĺžky 5 znakov (`([0-9]{5,})`).
Pre 5-miestne číslo, napr. `"12345"`: `slice(0,4) = "1234"`, `slice(-2) = "45"` → výsledok
`"1234***45"`. Reálne odkryté číslice: index 0,1,2,3 (z prvej časti) + 3,4 (z druhej) — teda
**všetkých 5 číslic je viditeľných**, len s vloženými `***` uprostred, ktoré nič neskrývajú. Pre
6-miestne číslo (`"123456"` → `"1234***56"`) je situácia identická — zase je odhalených všetkých
6 číslic. Reálne maskovanie (skrytie aspoň jednej číslice) nastáva až od 7-miestnych čísel.

`SECURITY.md` deklaruje: *"The database stores only anonymized order/product events"* — funkcia
s názvom `order_number_masked` má tento sľub napĺňať a pri bežnej dĺžke objednávkových čísel
(5–6 číslic je pre rastúci e-shop realistické rozmedzie) ho nenapĺňa.

**Aktuálny dopad je obmedzený**, pretože `order_number_masked` sa dnes **nikde nevracia** cez
žiadny verejný endpoint (`/api/live/recent` aj `/api/live/summary` ho v `SELECT` zozname
vynechávajú) — ide teda o "mŕtvy, ale rozbitý" kus kódu v databáze, nie o aktívny únik. Je to
však latentná chyba: v momente, keď niekto v budúcnosti pridá pole do API odpovede (napr. pre
admin dashboard), sa maskovanie nebude správať tak, ako názov funkcie sľubuje.

**Odporúčanie:** opraviť masku (napr. ponechať len prvé 2 a posledné 1 znaky, alebo hashovať) a
pridať jednotkový test s reálnou dĺžkou (5–7 číslic), nie len hraničný prípad `≤4`.

---

## 🟠 5. Neobmedzené in-memory cache — pomalý memory leak a trvalé "zablokovanie" produktu

**Súbor:** `src/index.js:354, 409-410, 440-441`

```js
const productImageCache = new Map();       // riadok 354
const localizedProductCache = new Map();   // riadok 409
...
localizedProductCache.set(cacheKey, localized);   // aj keď localized === null
```

Obe mapy rastú neobmedzene po celú dobu behu procesu (žiadny TTL, žiadny max-size) — pri
dlhodobo bežiacej Railway inštancii ide o pomalý memory leak úmerný počtu unikátnych produktov.

Závažnejšie: keď `localizeLiveProduct` (riadok 411-442) zlyhá pri fetchovaní produktovej stránky
(sieťový výpadok, dočasný 5xx), zapíše sa `null` do cache **natrvalo** — na rozdiel od
`productImageCache`, ktorý má explicitnú cestu na invalidáciu cez `POST /admin/repair-images`
(riadok 841: `productImageCache.delete(productUrl)`). Pre `localizedProductCache` žiadny
ekvivalentný "repair" endpoint neexistuje — jediný spôsob obnovy je reštart procesu.

**Dopad:** jeden prechodný sieťový zádrhel pri lokalizácii produktu do cudzieho jazyka ho môže
"vyradiť" z lokalizovaného feedu (v `/api/live/recent` sa taký produkt kvôli `.filter(Boolean)`
jednoducho vynechá) na celé zvyšné behu služby.

**Odporúčanie:** TTL alebo LRU eviction na oboch mapách; negatívne výsledky necachovať trvalo
(napr. cachovať `null` len na niekoľko minút, nie navždy).

---

## 🟠 6. Konfiguračný drift: fallback hodina refreshu recenzií nezodpovedá zdokumentovanému zámeru

**Súbor:** `src/index.js:22-25` vs. `.env.example:15` a `CHANGELOG.md` (v1.6.0)

```js
const REVIEWS_REFRESH_HOUR_LOCAL = Number.isInteger(configuredReviewHour) && ...
  ? configuredReviewHour
  : 15;   // fallback v kóde
```

`.env.example` má `REVIEWS_REFRESH_HOUR_LOCAL=21` a `CHANGELOG.md` pre v1.6.0 explicitne
uvádza: *"set the review refresh to 21:00 Europe/Bratislava"*. Fallback hodnota v kóde (`15`) je
teda zvyškom staršej verzie (pravdepodobne z čias, keď defaultom bolo 13:00 UTC / 15:00 lokálne,
pozri `SECURITY.md`/`CHANGELOG` v1.5.3). Ak by na Railway z akéhokoľvek dôvodu (redeploy s
vymazanými env premennými, preklep v názve premennej) chýbala `REVIEWS_REFRESH_HOUR_LOCAL`,
služba sa potichu prepne na refresh o 15:00 namiesto zdokumentovaných 21:00 — bez akéhokoľvek
varovania alebo logu, ktorý by na tento rozdiel upozornil.

**Odporúčanie:** zosúladiť fallback v kóde s `.env.example` (21), prípadne logovať explicitné
varovanie pri páde na fallback hodnotu.

---

## 🟠 7. Duplicitná scraping logika NajNakup.sk na troch miestach — krehkosť voči zmene cudzej stránky

**Súbory:** `proxy/foodland-najnakup-reviews.php:66-123`, `src/reviews.js:47-84` (`parseNajnakupPage`),
`src/reviews.js:86-111` (`parseNajnakupWidgetPage`)

Existujú **tri nezávislé parsery** HTML/DOM štruktúry NajNakup.sk:

1. PHP (`DOMXPath`, triedy `.dis`, `.dis_logo`, `.dis_dt`, `.dis_plus`, `.rating_vyh/nev/desc`)
   — primárny zdroj cez `foodland-express.sk` proxy.
2. JS `parseNajnakupWidgetPage` (cheerio, identické CSS triedy ako PHP) — fallback #1, keď proxy
   zlyhá.
3. JS `parseNajnakupPage` (iné triedy: `.review-sec`, `.img-text2`, `.recommend_icon_detail_container`,
   `.very-gud-con`, `.yet-text`, `.sensor`) — fallback #2 pre inú stránku (verejný profil namiesto
   widgetu).

Celý zmysel troch úrovní fallbacku (proxy → widget scrape → profile scrape, `src/reviews.js:113-236`)
je odolnosť. Lenže widget-scrape (#1, #2) používajú **rovnaké CSS triedy**, len v dvoch rôznych
jazykoch (PHP/JS) — ak NajNakup.sk zmení triedu `.dis_plus` alebo `.rating_desc`, PHP proxy aj JS
fallback #1 zlyhajú **súčasne** (rovnaký markup, rovnaký bod zlyhania), a jediné, čo reálne
zostane funkčné, je fallback #2 (iná stránka, tretí, úplne odlišný parser). Redundancia teda v
najčastejšom scenári zmeny markupu (widget page) nefunguje tak, ako by architektúra "3 úrovne
fallbacku" naznačovala — v skutočnosti ide o "2 úrovne" (widget-markup-style vs. profile-markup-style),
pričom prvé dve zdroje sú korelované a padajú spolu.

Navyše ani jeden z troch parserov nemá test proti aktuálnemu živému HTML z najnakup.sk (testy v
`test/reviews.test.js:1-92` používajú ručne napísané, zjednodušené fixture HTML) — zmena
skutočnej stránky sa teda v CI nikdy neprejaví, kým reálne nespadne produkčný refresh.

**Odporúčanie:** zdieľať jeden parser (napr. preniesť PHP logiku aj do Node, alebo naopak) medzi
primárnym a prvým fallbackom, aby redundancia reálne kryla nezávislé zlyhania; zvážiť
snapshot/nahraté HTML fixture z produkcie pre regresné testy parserov.

---

## 🟡 8. `data-interval` je pre `data-layout="cards"` moduly "mŕtva" konfigurácia

**Súbory:** `modules/live-orders/prefooter-cards.html:3-8` (cards, bez `data-interval` — použije
sa JS default), `modules/live-orders/infowidget.html:5` a `Foodland_Live_Ticker_*.html:13`
(`data-interval="12000"`, ticker text mód), `widget.js` (`src/index.js:896, 1126`)

```js
const interval = Math.max(8000, Number(config.dataset.interval || 12000));   // src/index.js:896
...
if (cardTargets.length) setInterval(load, 60000);                            // src/index.js:1126 — natvrdo
```

Premenná `interval` sa reálne použije **len** pre rotáciu textového tickeru
(`messageTimer = setInterval(renderMessage, interval)`, riadok 1117) — teda len na stránkach s
`textTargets` (ticker bez `data-layout="cards"`, napr. `infowidget.html`, `Foodland_Live_Ticker_*.html`).
Pre karty (`cardTargets`, t. j. `prefooter-cards.html`) sa dáta vždy znovu načítajú natvrdo raz za
60 000 ms bez ohľadu na `data-interval` — a `prefooter-cards.html` dokonca tento atribút vôbec
nenastavuje, takže `config.dataset.interval` je `undefined` a použije sa JS default `12000`, ktorý
sa v tomto kontexte nikde nepoužije. Ak by niekto v budúcnosti pridal `data-interval="X"` do
`prefooter-cards.html` v snahe zrýchliť/spomaliť obnovu kariet (analogicky k tomu, ako
`data-interval` funguje na tickeri), nedosiahol by žiadny efekt.

**Odporúčanie:** buď `data-interval` reálne prepojiť aj na `setInterval(load, interval)` pre
karty, alebo v kóde/komentári jasne zdokumentovať, že tento atribút ovplyvňuje výhradne rotáciu
textového tickeru, nie obnovu dát kariet.

---

## 🟡 9. Ďalšie drobné nálezy (hardening)

- **`src/index.js:796, 807, 822`** — porovnanie admin tokenu `req.get('x-admin-token') !== ADMIN_TOKEN`
  nie je časovo konštantné (chýba `crypto.timingSafeEqual`); teoretický, nízko-prioritný
  timing-attack vektor na `/admin/*` endpointoch.
- **Chýba rate limiting** na verejných, neautentifikovaných endpointoch (`/api/live/recent`,
  `/api/live/summary`, `/api/reviews`, `/widget.js`, `/reviews-widget.js`) — pri zneužití
  (scraping, DoS) nič requesty nezastaví okrem samotného Express/Node.
- **`proxy/foodland-najnakup-reviews.php:220-244`** — cyklus `for ($pageNumber = 1; $pageNumber <= 3; ...)`
  na poslednej iterácii (`pageNumber == 3`) po spracovaní stránky ešte stihne odoslať POST
  request na stránku 4 (`fetchPage($fields, ...)`, priradí do `$page`), ktorého výsledok sa už
  nikdy nepoužije, pretože podmienka cyklu vzápätí zlyhá — zbytočný request voči najnakup.sk pri
  každom cache-miss refreshi.
- **`proxy/foodland-najnakup-reviews.php:15`** (`Cache-Control: public, max-age=300`) vs. vnútorná
  súborová cache `CACHE_TTL_SECONDS = 72000` (20 h) — HTTP hlavička sľubuje 5-minútovú
  čerstvosť, interná cache sa obnovuje raz za 20 hodín. Dnes to nevadí (proxy volá jediný interný
  klient, nie zdieľaná CDN cache), ale je to zavádzajúci signál, ak by pred proxy pribudol CDN.
- **`test/index.test.js:67-100`** — viacero regresných testov overuje historicky opravené chyby
  (IMAP deadlock, UPSERT NULL-safety, image row matching) hľadaním **doslovných reťazcov v
  zdrojovom kóde** (`assert.match(source, /.../ )`) namiesto skutočného behaviorálneho testu.
  Refaktoring, ktorý zachová správanie, ale zmení formuláciu, testy zbytočne rozbije; naopak
  zmena správania pri zachovaní rovnakých reťazcov testom prejde nepovšimnutá.

---

## Zhrnutie podľa priority

| # | Nález | Závažnosť | Súbor |
|---|-------|-----------|-------|
| 1 | Neošetrené chyby → visiace requesty pri zlom `limit`/`hours` | 🔴 | `src/index.js:706-756` |
| 2 | Neobmedzený paralelný fan-out pri lokalizácii produktov | 🔴 | `src/index.js:726-730` |
| 3 | Chybný DST offset v `parseOrderDate` (koniec marca/októbra) | 🔴 | `src/index.js:220-234` |
| 4 | `maskOrderNumber` nemaskuje 5–6-miestne čísla | 🔴 | `src/index.js:205-209` |
| 5 | Neobmedzené cache, trvalé cachovanie zlyhaní | 🟠 | `src/index.js:354,409,440` |
| 6 | Fallback hodina refreshu (15) nezodpovedá zámeru (21) | 🟠 | `src/index.js:22-25` |
| 7 | Duplicitné/korelované scraping parsery NajNakup.sk | 🟠 | `proxy/*.php`, `src/reviews.js` |
| 8 | `data-interval` na kartách je mŕtva konfigurácia | 🟡 | `modules/live-orders/*`, `src/index.js:1126` |
| 9 | Timing-safe token compare, rate limiting, testy na reťazce | 🟡 | viaceré |

Žiadny z nálezov nespochybňuje základný dátový tok (IMAP → Postgres → API → widget); ide o
okrajové prípady, ktoré sa prejavia pri chybnom vstupe, medzinárodnej prevádzke, prechode
letného/zimného času alebo dlhodobom behu procesu — presne tie situácie, ktoré v bežnom
prevádzkovom monitoringu ("funguje to na produkcii") ostávajú najdlhšie neodhalené.
