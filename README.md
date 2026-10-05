# Foodland Live Commerce

Jeden GitHub projekt a jedna Railway služba pre:

- anonymizované Live nákupy z objednávkových e-mailov,
- 30 najnovších hodnotení z NajNakup.sk,
- automatické preklady recenzií do SK, CZ, DE, EN, PL, HU a VI,
- CreativeSites skripty a hotové jazykové moduly.

Aktuálna verzia: **1.7.0**

## Štruktúra

```text
foodland-live-commerce/
├── src/
│   ├── index.js
│   └── reviews.js
├── test/
├── modules/
│   ├── live-orders/       # plný ticker SK/CZ/DE/EN/PL/HU/VI
│   └── reviews/
├── proxy/
│   └── foodland-najnakup-reviews.php
├── .env.example
├── package.json
├── Procfile
└── railway.json
```

## Nasadenie

1. Nahrajte obsah tohto priečinka do koreňa jediného GitHub repozitára.
2. Railway pripojte k tomuto repozitáru.
3. V rovnakom Railway projekte ponechajte PostgreSQL.
4. Premenné nastavte podľa `.env.example`; heslá a tokeny patria iba do Railway, nikdy do GitHubu.
5. Súbor `proxy/foodland-najnakup-reviews.php` nahrajte na `foodland-express.sk`.

Recenzie sa obnovujú denne o **21:00 Europe/Bratislava**, automaticky podľa letného aj zimného času.

## Verejné endpointy

| Funkcia | Endpoint |
|---|---|
| Stav služby | `GET /health` |
| Najnovšie nákupy | `GET /api/live/recent` |
| Súhrn nákupov | `GET /api/live/summary` |
| Skript Live nákupov | `GET /widget.js` |
| Recenzie | `GET /api/reviews?lang=sk&limit=30` |
| Skript recenzií | `GET /reviews-widget.js` |
| Ručná obnova recenzií | `POST /admin/refresh-reviews` |
| Opätovné načítanie e-mailov | `POST /admin/rescan` |

Administrátorské endpointy vyžadujú hlavičku `x-admin-token`.

## CreativeSites

- Recenzie: vložte príslušný celý súbor z `modules/reviews/` do každej jazykovej mutácie.
- Live nákupy: vložte príslušný súbor `Foodland_Live_Ticker_<JAZYK>.html` z `modules/live-orders/`. Dynamické produkty aj pevné informačné texty budú v jazyku danej mutácie.
- Nepoužívajte pôvodný NajNakup iframe spolu s vlastným modulom recenzií.

## Kontrola

```bash
npm install
npm test
npm start
```

Po nasadení musí `/health` vrátiť `"version":"1.7.0"`.

## Ochrana údajov

Live widget neukladá meno zákazníka, e-mail, telefón ani adresu z objednávok. V jeho tabuľke je číslo objednávky iba hash. CAPI outbox uchováva číslo objednávky ako event_id pre deduplikáciu a SHA-256 hash normalizovaného zákazníckeho e-mailu; neuchováva pôvodný e-mail. Outbox nie je verejný. Pri recenziách sa ukladajú iba verejne zobrazené meno, dátum, text, odporúčanie a typ zákazníka.

## Meta CAPI Purchase

Používa výhradne existujúci dataset `698074744109995`. Predvolene je vypnutý.
Premenné sú v `.env.capi.example`; token patrí iba do zabezpečených Railway Variables.
`META_CAPI_START_AT` musí obsahovať ISO čas aktivácie. Staršie objednávky sa neodosielajú.
`event_id` je pôvodné číslo objednávky a musí byť zhodné s browser Purchase `eventID`.

Parser vyžaduje explicitnú konečnú sumu s menou EUR, zákaznícky e-mail a všetky položky s FL_* ID, množstvom a jednotkovou cenou.
Jednotkovú cenu číta z `data-unit-price`, označenia Cena za kus/Jednotková cena/Cena/ks alebo rovnomenného záhlavia tabuľky.
Neoznačené stĺpce neodhaduje. Pred zapnutím treba overiť skutočný CreativeSites objednávkový e-mail; automatické testy používajú reprezentatívnu vzorku.

Postup: nasadiť vypnutý worker, vložiť token, nastaviť test_event_code a čas aktivácie,
overiť čerstvú testovaciu objednávku a prijatie v Meta Test events, potom odstrániť test_event_code.
`GET /admin/capi-status` vyžaduje `x-admin-token` a vracia iba počty stavov, čas prijatia a konfiguráciu bez tokenu či osobných údajov.
Ochrana proti opakovaniu: unikátny event_id v PostgreSQL, zamykanie fronty medzi workermi a rovnaký event_id pri retry.
Pri chybe sieťovej požiadavky sa odoslanie opakuje s rastúcim odstupom; udalosti staršie ako sedem dní sa neodosielajú.
E-mail neobsahuje browser cookies ani používateľský agent. Worker ich nevymýšľa; toto obmedzuje kvalitu párovania a môže vyžadovať doplnenie checkout dát z CreativeSites.
