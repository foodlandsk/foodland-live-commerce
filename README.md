# Foodland Live Commerce

Jeden GitHub projekt a jedna Railway služba pre:

- anonymizované Live nákupy z objednávkových e-mailov,
- 30 najnovších hodnotení z NajNakup.sk,
- automatické preklady recenzií do SK, CZ, DE, EN, PL, HU a VI,
- CreativeSites skripty a hotové jazykové moduly.

Aktuálna verzia: **1.6.0**

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

Po nasadení musí `/health` vrátiť `"version":"1.6.0"`.

## Ochrana údajov

Projekt neukladá meno zákazníka, e-mail, telefón ani adresu z objednávok. Číslo objednávky sa ukladá iba ako hash. Pri recenziách sa ukladajú iba verejne zobrazené meno, dátum, text, odporúčanie a typ zákazníka.
