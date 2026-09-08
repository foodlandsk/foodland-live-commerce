<?php
declare(strict_types=1);

/*
 * Foodland / Najnakup.sk reviews proxy
 * Public output contains only: name, date, text, recommendation and customer type.
 * It never returns IP addresses, email addresses or order numbers.
 */

const SOURCE_URL = 'https://www.najnakup.sk/dz_shop_opinions.aspx?w=8237';
const CACHE_TTL_SECONDS = 72000; // 20 hours
const MAX_REVIEWS = 30;

// NajNakup.sk serves this exact widget markup to both parseWidget() below and
// the JS fallback src/reviews.js's parseNajnakupWidgetPage()/WIDGET_SELECTORS
// (only reached if this proxy is unreachable). A class-name change on
// NajNakup's side breaks both parsers at once — if you update these, update
// WIDGET_SELECTORS in src/reviews.js to match.
const WIDGET_CLASS_REVIEW = 'dis';
const WIDGET_CLASS_NAME = 'dis_logo';
const WIDGET_CLASS_DATETIME = 'dis_dt';
const WIDGET_CLASS_RECOMMENDATION = 'dis_plus';
const WIDGET_CLASS_POSITIVE = 'rating_vyh';
const WIDGET_CLASS_NEGATIVE = 'rating_nev';
const WIDGET_CLASS_SUMMARY = 'rating_desc';

header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: public, max-age=300, stale-if-error=86400');
header('X-Content-Type-Options: nosniff');
header('Referrer-Policy: no-referrer');

function respond(array $payload, int $status = 200): never
{
    http_response_code($status);
    echo json_encode($payload, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_PRETTY_PRINT);
    exit;
}

function cleanText(?string $value): string
{
    $value = html_entity_decode((string) $value, ENT_QUOTES | ENT_HTML5, 'UTF-8');
    $value = str_replace("\xC2\xA0", ' ', $value);
    return trim((string) preg_replace('/\s+/u', ' ', $value));
}

function classQuery(string $class): string
{
    return './/*[contains(concat(" ", normalize-space(@class), " "), " ' . $class . ' ")]';
}

function firstText(DOMXPath $xpath, DOMNode $context, string $class): string
{
    $nodes = $xpath->query(classQuery($class), $context);
    if ($nodes === false || $nodes->length === 0) {
        return '';
    }
    return cleanText($nodes->item(0)?->textContent);
}

function uniqueParts(array $parts): array
{
    $result = [];
    $seen = [];
    foreach ($parts as $part) {
        $text = cleanText($part);
        if ($text === '') {
            continue;
        }
        $key = function_exists('mb_strtolower') ? mb_strtolower($text, 'UTF-8') : strtolower($text);
        if (isset($seen[$key])) {
            continue;
        }
        $seen[$key] = true;
        $result[] = $text;
    }
    return $result;
}

function parseWidget(string $html): array
{
    if (!class_exists('DOMDocument')) {
        throw new RuntimeException('PHP DOM extension is not available.');
    }

    $previous = libxml_use_internal_errors(true);
    $document = new DOMDocument();
    $loaded = $document->loadHTML('<?xml encoding="utf-8" ?>' . $html, LIBXML_NOWARNING | LIBXML_NOERROR | LIBXML_NONET);
    libxml_clear_errors();
    libxml_use_internal_errors($previous);

    if (!$loaded) {
        throw new RuntimeException('Najnakup HTML could not be parsed.');
    }

    $xpath = new DOMXPath($document);
    $blocks = $xpath->query(classQuery(WIDGET_CLASS_REVIEW));
    if ($blocks === false) {
        return [];
    }

    $reviews = [];
    foreach ($blocks as $block) {
        $name = firstText($xpath, $block, WIDGET_CLASS_NAME);
        $dateTime = firstText($xpath, $block, WIDGET_CLASS_DATETIME);
        preg_match('/\d{2}\.\d{2}\.\d{4}/', $dateTime, $dateMatch);
        $date = $dateMatch[0] ?? '';
        $recommendation = firstText($xpath, $block, WIDGET_CLASS_RECOMMENDATION);
        $positive = firstText($xpath, $block, WIDGET_CLASS_POSITIVE);
        $negative = firstText($xpath, $block, WIDGET_CLASS_NEGATIVE);
        $summary = firstText($xpath, $block, WIDGET_CLASS_SUMMARY);
        $text = implode(' ', uniqueParts([$positive, $negative, $summary]));

        if ($name === '' || $date === '' || $text === '') {
            continue;
        }

        $recommendationUpper = function_exists('mb_strtoupper')
            ? mb_strtoupper($recommendation, 'UTF-8')
            : strtoupper($recommendation);
        $summaryLower = function_exists('mb_strtolower')
            ? mb_strtolower($summary, 'UTF-8')
            : strtolower($summary);
        $sourceKey = hash('sha256', $name . '|' . $date . '|' . $text);

        $reviews[] = [
            'source_key' => $sourceKey,
            'name' => $name,
            'date' => $date,
            'text' => $text,
            'recommended' => !str_contains($recommendationUpper, 'NEODPORÚČAM'),
            'customer_type' => str_contains($summaryLower, 'nakupujem pravidelne') ? 'regular' : 'verified',
        ];
    }

    return $reviews;
}

function extractHiddenFields(string $html): array
{
    $fields = [];
    if (!class_exists('DOMDocument')) {
        return $fields;
    }

    $previous = libxml_use_internal_errors(true);
    $document = new DOMDocument();
    if ($document->loadHTML('<?xml encoding="utf-8" ?>' . $html, LIBXML_NOWARNING | LIBXML_NOERROR | LIBXML_NONET)) {
        $xpath = new DOMXPath($document);
        $inputs = $xpath->query('//form//input[@name]');
        if ($inputs !== false) {
            foreach ($inputs as $input) {
                $name = $input->attributes?->getNamedItem('name')?->nodeValue;
                if ($name !== null && $name !== '') {
                    $fields[$name] = $input->attributes?->getNamedItem('value')?->nodeValue ?? '';
                }
            }
        }
    }
    libxml_clear_errors();
    libxml_use_internal_errors($previous);
    return $fields;
}

function fetchPage(?array $postFields, string $cookieFile): array
{
    $ch = curl_init(SOURCE_URL);
    if ($ch === false) {
        throw new RuntimeException('cURL initialization failed.');
    }

    $options = [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_FOLLOWLOCATION => true,
        CURLOPT_MAXREDIRS => 3,
        CURLOPT_CONNECTTIMEOUT => 10,
        CURLOPT_TIMEOUT => 30,
        CURLOPT_ENCODING => '',
        CURLOPT_USERAGENT => 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/152.0.0.0 Safari/537.36',
        CURLOPT_HTTPHEADER => [
            'Accept: text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Accept-Language: sk-SK,sk;q=0.9,en;q=0.7',
            'Referer: https://www.foodland.sk/',
        ],
        CURLOPT_COOKIEJAR => $cookieFile,
        CURLOPT_COOKIEFILE => $cookieFile,
        CURLOPT_SSL_VERIFYPEER => true,
        CURLOPT_SSL_VERIFYHOST => 2,
    ];

    if ($postFields !== null) {
        $options[CURLOPT_POST] = true;
        $options[CURLOPT_POSTFIELDS] = http_build_query($postFields, '', '&', PHP_QUERY_RFC3986);
        $options[CURLOPT_HTTPHEADER][] = 'Content-Type: application/x-www-form-urlencoded';
        $options[CURLOPT_HTTPHEADER][] = 'Origin: https://www.najnakup.sk';
    }

    curl_setopt_array($ch, $options);
    $html = curl_exec($ch);
    $error = curl_error($ch);
    $status = (int) curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
    curl_close($ch);

    if ($html === false) {
        throw new RuntimeException($error !== '' ? $error : 'Najnakup request failed.');
    }
    if ($status < 200 || $status >= 300) {
        throw new RuntimeException('Najnakup returned HTTP ' . $status . '.');
    }
    if (strlen($html) < 500) {
        throw new RuntimeException('Najnakup response was unexpectedly short.');
    }

    return ['html' => $html, 'status' => $status, 'bytes' => strlen($html)];
}

function fetchReviews(): array
{
    if (!function_exists('curl_init')) {
        throw new RuntimeException('PHP cURL extension is not available.');
    }

    $cookieFile = tempnam(sys_get_temp_dir(), 'fl_nn_');
    if ($cookieFile === false) {
        throw new RuntimeException('Temporary cookie file could not be created.');
    }

    $reviews = [];
    $seen = [];
    $diagnostics = [];

    try {
        $page = fetchPage(null, $cookieFile);
        for ($pageNumber = 1; $pageNumber <= 3; $pageNumber++) {
            $pageReviews = parseWidget($page['html']);
            $diagnostics[] = [
                'page' => $pageNumber,
                'http_status' => $page['status'],
                'response_bytes' => $page['bytes'],
                'reviews_found' => count($pageReviews),
            ];

            foreach ($pageReviews as $review) {
                if (!isset($seen[$review['source_key']])) {
                    $seen[$review['source_key']] = true;
                    $reviews[] = $review;
                }
                if (count($reviews) >= MAX_REVIEWS) {
                    break 2;
                }
            }

            $nextPage = $pageNumber + 1;
            $fields = extractHiddenFields($page['html']);
            $fields['__EVENTTARGET'] = 'ucShopRating1$DataPager1$ctl00$ctl0' . ($nextPage - 1);
            $fields['__EVENTARGUMENT'] = '';
            $page = fetchPage($fields, $cookieFile);
        }
    } finally {
        @unlink($cookieFile);
    }

    if (count($reviews) < 10) {
        throw new RuntimeException('Fewer than 10 usable reviews were found.');
    }

    return [
        'ok' => true,
        'source' => 'najnakup-widget',
        'shop_id' => 8237,
        'count' => count($reviews),
        'updated_at_utc' => gmdate('c'),
        'stale' => false,
        'items' => array_slice($reviews, 0, MAX_REVIEWS),
        'diagnostics' => $diagnostics,
    ];
}

$cacheDirectory = __DIR__ . DIRECTORY_SEPARATOR . 'cache';
$cacheFile = $cacheDirectory . DIRECTORY_SEPARATOR . 'najnakup-reviews.json';
$cached = null;

if (is_file($cacheFile)) {
    $decoded = json_decode((string) file_get_contents($cacheFile), true);
    if (is_array($decoded) && isset($decoded['items']) && is_array($decoded['items'])) {
        $cached = $decoded;
    }
}

if ($cached !== null && filemtime($cacheFile) !== false && (time() - (int) filemtime($cacheFile)) < CACHE_TTL_SECONDS) {
    $cached['cache'] = 'hit';
    respond($cached);
}

try {
    $payload = fetchReviews();
    $payload['cache'] = 'refreshed';

    if (!is_dir($cacheDirectory) && !mkdir($cacheDirectory, 0755, true) && !is_dir($cacheDirectory)) {
        throw new RuntimeException('Cache directory could not be created.');
    }

    $encoded = json_encode($payload, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_PRETTY_PRINT);
    if ($encoded === false || file_put_contents($cacheFile, $encoded, LOCK_EX) === false) {
        throw new RuntimeException('Cache file could not be written.');
    }

    respond($payload);
} catch (Throwable $error) {
    if ($cached !== null) {
        $cached['ok'] = true;
        $cached['stale'] = true;
        $cached['cache'] = 'stale-fallback';
        $cached['refresh_error'] = $error->getMessage();
        respond($cached);
    }

    respond([
        'ok' => false,
        'source' => 'najnakup-widget',
        'count' => 0,
        'updated_at_utc' => gmdate('c'),
        'items' => [],
        'error' => $error->getMessage(),
    ], 502);
}

