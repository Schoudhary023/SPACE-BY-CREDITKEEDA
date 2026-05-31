/**
 * Gift Card Price Checker — Dry Run Script
 * Run: node scripts/gcPriceCheck.js
 *
 * Architecture: one scraper per platform, all export the same interface:
 *   { platform, url(brand), parse(html) } → [{ face, price, discountPct }]
 *
 * To add a new platform: add a scraper object to SCRAPERS array.
 * To add a new brand: add an entry to BRANDS map with per-platform URLs.
 */

const https = require('https');
const http = require('http');
const zlib = require('zlib');

// ─── Brand Registry ───────────────────────────────────────────────────────────

const BRANDS = {
  uber: {
    name: 'Uber',
    platforms: {
      // mobile site bypasses some 403s
      flipkart:  'https://dl.flipkart.com/dl/uber-digital-gift-card/p/itm52547005eaed5',
      magicpin:  'https://magicpin.in/Gurgaon/Magicpin/Restaurant/Uber/store/30a501/vouchers/',
      // gyftr URL patterns to try in order
      gyftr:     'https://www.gyftr.com/gift-cards/uber-gift-card',
      maximize:  'https://www.maximize.money/gift-cards',
      // specific Uber GC product ASIN instead of search page
      amazon:    'https://www.amazon.in/dp/B07GBT1RVH',
    },
  },
};

// ─── HTTP Fetch Helper ────────────────────────────────────────────────────────

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Accept-Language': 'en-IN,en-GB;q=0.9,en;q=0.8',
  'Accept-Encoding': 'gzip, deflate, br',
  'Cache-Control': 'no-cache',
  'Connection': 'keep-alive',
  'Upgrade-Insecure-Requests': '1',
};

function fetchPage(url, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const lib = parsed.protocol === 'https:' ? https : http;
    const options = {
      hostname: parsed.hostname,
      path: parsed.pathname + parsed.search,
      method: 'GET',
      headers: { ...HEADERS, ...extraHeaders, 'Host': parsed.hostname },
      timeout: 15000,
    };

    const req = lib.request(options, (res) => {
      const chunks = [];

      // handle redirect
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        const redirectUrl = res.headers.location.startsWith('http')
          ? res.headers.location
          : `${parsed.protocol}//${parsed.hostname}${res.headers.location}`;
        return fetchPage(redirectUrl, extraHeaders).then(resolve).catch(reject);
      }

      const stream = res.headers['content-encoding'] === 'gzip'
        ? res.pipe(zlib.createGunzip())
        : res.headers['content-encoding'] === 'br'
          ? res.pipe(zlib.createBrotliDecompress())
          : res;

      stream.on('data', chunk => chunks.push(chunk));
      stream.on('end', () => resolve({ status: res.statusCode, html: Buffer.concat(chunks).toString('utf-8'), headers: res.headers }));
      stream.on('error', reject);
    });

    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
    req.end();
  });
}

// ─── Platform Scrapers ────────────────────────────────────────────────────────

const SCRAPERS = [

  {
    platform: 'Flipkart',
    async fetch(brand) {
      // Try desktop first, fall back to mobile URL
      const desktopUrl = 'https://www.flipkart.com/uber-digital-gift-card/p/itm52547005eaed5';
      const mobileUrl  = 'https://dl.flipkart.com/dl/uber-digital-gift-card/p/itm52547005eaed5';

      // Flipkart's internal page API — returns JSON with full product data
      const apiUrl = `https://www.flipkart.com/api/3/page/fetch?url=%2Fuber-digital-gift-card%2Fp%2Fitm52547005eaed5`;
      const apiRes = await fetchPage(apiUrl, {
        Referer: 'https://www.flipkart.com/',
        Accept: 'application/json',
        'x-user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      });

      if (apiRes.status === 200) {
        try {
          const data = JSON.parse(apiRes.html);
          const str = JSON.stringify(data);
          // Flipkart embeds finalPrice and mrp in the page slots data
          const finalPrices = [...str.matchAll(/"finalPrice"\s*:\s*\{[^}]*"value"\s*:\s*(\d+)/g)].map(m => parseInt(m[1]));
          const mrps = [...str.matchAll(/"mrp"\s*:\s*\{[^}]*"value"\s*:\s*(\d+)/g)].map(m => parseInt(m[1]));
          if (finalPrices.length && mrps.length) {
            const url = desktopUrl;
            return mrps.slice(0, finalPrices.length).map((face, i) => ({
              face, price: finalPrices[i],
              discountPct: (((face - finalPrices[i]) / face) * 100).toFixed(1),
              url,
            })).filter(r => r.face > 50 && r.face < 15000);
          }
          // Also try simpler key patterns
          const sp = [...str.matchAll(/"sellingPrice"\s*:\s*(\d+)/g)].map(m => parseInt(m[1]));
          const mp = [...str.matchAll(/"maximumRetailPrice"\s*:\s*(\d+)/g)].map(m => parseInt(m[1]));
          if (sp.length && mp.length) {
            return [{ face: mp[0], price: sp[0], discountPct: (((mp[0] - sp[0]) / mp[0]) * 100).toFixed(1), url: desktopUrl }];
          }
          // Return raw keys found for debugging
          const allNums = [...new Set([...str.matchAll(/"value"\s*:\s*(\d{3,5})/g)].map(m => parseInt(m[1])).filter(n => n > 50 && n < 15000))];
          return { note: 'API responded but price keys not matched', sample_numbers: allNums.slice(0, 10) };
        } catch (e) {
          return { error: 'API JSON parse failed', detail: e.message };
        }
      }

      // HTML fallback — try both desktop and mobile
      let html, status;
      for (const url of [desktopUrl, mobileUrl]) {
        const res = await fetchPage(url, { Referer: 'https://www.google.com/', 'sec-fetch-dest': 'document', 'sec-fetch-mode': 'navigate' });
        status = res.status; html = res.html;
        if (status === 200) break;
      }
      if (status !== 200) return { error: `API ${apiRes.status}, HTML ${status} — both blocked` };

      const allPrices = [...html.matchAll(/₹\s*(\d[\d,]*)/g)].map(m => parseInt(m[1].replace(/,/g, ''))).filter(p => p > 50 && p < 15000);
      const discountMatch = html.match(/(\d+)%\s*off/i);
      return { raw_prices_found: [...new Set(allPrices)].slice(0, 8), discount_found: discountMatch?.[1], note: 'HTML fallback — Flipkart is JS-rendered, needs Puppeteer for full data' };
    }
  },

  {
    platform: 'Magicpin',
    async fetch(brand) {
      const url = BRANDS[brand].platforms.magicpin;
      const { status, html } = await fetchPage(url, { Referer: 'https://magicpin.in/' });

      if (status !== 200) return { error: `HTTP ${status}` };

      const results = [];

      // Magicpin voucher pages list denominations with prices
      // Pattern: face value and selling price
      const voucherBlocks = [...html.matchAll(/(?:₹|Rs\.?)\s*(\d[\d,]*)\s*(?:worth|face|value)?[\s\S]{0,200}?(?:₹|Rs\.?)\s*(\d[\d,]*)/g)];
      for (const m of voucherBlocks) {
        const a = parseInt(m[1].replace(/,/g, ''));
        const b = parseInt(m[2].replace(/,/g, ''));
        if (a !== b && a > b && b > 50) {
          results.push({ face: a, price: b, discountPct: (((a - b) / a) * 100).toFixed(1), url });
        }
      }

      // Filter: GC discounts are typically 1–15%. Anything >20% off is likely a parse artifact.
      const filtered = results.filter(r => {
        const d = parseFloat(r.discountPct);
        // Also require both values to be "round" GC denominations
        const roundNumbers = [50, 75, 100, 150, 200, 250, 300, 400, 500, 750, 1000, 1500, 2000, 2500, 3000, 5000, 7500, 10000];
        const faceIsRound = roundNumbers.includes(r.face);
        return d >= 1 && d <= 15 && faceIsRound;
      });

      if (filtered.length === 0 && results.length > 0) {
        return { note: 'Pairs found but filtered as likely parse artifacts', raw: results };
      }
      if (filtered.length === 0) {
        const allPrices = [...html.matchAll(/₹\s*(\d[\d,]*)/g)].map(m => parseInt(m[1].replace(/,/g, ''))).filter(p => p > 50 && p < 15000);
        return { raw_prices_found: [...new Set(allPrices)].slice(0, 10), error: 'Could not parse structured price data' };
      }

      return filtered;
    }
  },

  {
    platform: 'Gyftr',
    async fetch(brand) {
      // Gyftr is Next.js — all data is in __NEXT_DATA__ JSON, no scraping needed
      const urlsToTry = [
        `https://www.gyftr.com/${brand}`,
        `https://www.gyftr.com/gift-cards/${brand}-gift-card`,
      ];

      let html, status, finalUrl;
      for (const url of urlsToTry) {
        const res = await fetchPage(url, { Referer: 'https://www.gyftr.com/' });
        status = res.status;
        html = res.html;
        finalUrl = url;
        if (status === 200) break;
      }

      if (status !== 200) return { error: `HTTP ${status} on all URL patterns tried`, tried: urlsToTry };

      // Gyftr is Next.js — extract __NEXT_DATA__ for clean structured data
      const nextDataMatch = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
      if (!nextDataMatch) return { error: 'No __NEXT_DATA__ found', url: finalUrl };

      let pageData;
      try { pageData = JSON.parse(nextDataMatch[1]); } catch (e) { return { error: 'Failed to parse NEXT_DATA', detail: e.message }; }

      const products = pageData?.props?.pageProps?.reduxState?.brandInfo?.productDetailStore;
      if (!products || !Array.isArray(products)) return { error: 'productDetailStore not found in NEXT_DATA' };

      // Credit card pg_discount from brandPgListStore — this is our target payment method
      const pgList = pageData?.props?.pageProps?.reduxState?.brandInfo?.brandPgListStore || [];
      const ccPg = pgList.find(pg => pg.pg_slug === 'PAYUCC') || pgList.find(pg => pg.pg_name === 'Credit Card');
      const ccDiscount = ccPg?.pg_discount || 0;
      const processingCharge = pageData?.props?.pageProps?.reduxState?.brandInfo?.brandDetailStore?.processing_charge || 0;

      // Effective CC discount = product discount + cc pg_discount - processing charge
      const results = products
        .filter(p => p.mrp > 0)
        .map(p => {
          const productDiscount = p.discount || 0;
          const totalDiscount = productDiscount + ccDiscount - processingCharge;
          const price = totalDiscount > 0 ? +(p.mrp * (1 - totalDiscount / 100)).toFixed(0) : p.mrp;
          return {
            face: p.mrp,
            price,
            discountPct: totalDiscount > 0 ? totalDiscount.toFixed(1) : '0.0',
            // stock_left: 0 = unlimited for digital GCs (issued on demand) — presence in list = in stock
            inStock: true,
            paymentNote: `${ccDiscount}% CC discount`,
            url: finalUrl,
          };
        });

      if (results.length === 0) return { error: 'No products found in NEXT_DATA', url: finalUrl };
      return results;
    }
  },

  {
    platform: 'Maximize',
    async fetch(brand) {
      // Try API endpoint first (Maximize is a React SPA — their data comes from API calls)
      const apiUrls = [
        'https://www.maximize.money/api/gift-cards?search=uber',
        'https://www.maximize.money/api/products?category=gift-cards&q=uber',
        'https://api.maximize.money/gift-cards',
      ];
      const pageUrls = [
        'https://www.maximize.money/gift-cards',
        'https://www.maximize.money/',
      ];

      // Try API endpoints
      for (const url of apiUrls) {
        try {
          const res = await fetchPage(url, {
            Accept: 'application/json',
            Referer: 'https://www.maximize.money/',
            'X-Requested-With': 'XMLHttpRequest',
          });
          if (res.status === 200 && res.html.trim().startsWith('{') || res.html.trim().startsWith('[')) {
            const data = JSON.parse(res.html);
            return { api_data: data, url };
          }
        } catch (_) {}
      }

      // Fall back to page scrape
      for (const url of pageUrls) {
        const res = await fetchPage(url, {
          Referer: 'https://www.google.com/',
          'sec-fetch-dest': 'document',
          'sec-fetch-mode': 'navigate',
          'sec-fetch-site': 'none',
        });
        if (res.status === 200) {
          const { html } = res;
          const prices = [...html.matchAll(/₹\s*(\d[\d,]*)/g)].map(m => parseInt(m[1].replace(/,/g, ''))).filter(p => p > 50 && p < 15000);
          const discountMatch = html.match(/(\d+(?:\.\d+)?)\s*%\s*(?:off|discount|cashback)/i);
          // Check if Uber is even mentioned
          const hasUber = /uber/i.test(html);
          return { url, has_uber_mention: hasUber, raw_prices: [...new Set(prices)].slice(0, 8), discount_found: discountMatch?.[1], html_length: html.length };
        }
      }

      return { error: 'All URLs returned non-200. Maximize likely requires auth session.', note: 'May need Puppeteer with login' };
    }
  },

  {
    platform: 'Amazon',
    async fetch(brand) {
      // Hit specific product ASIN page for Uber GC, not search results
      // B07GBT1RVH = Uber Gift Card (multi-denomination selector)
      const url = 'https://www.amazon.in/dp/B07GBT1RVH';
      const { status, html } = await fetchPage(url, {
        Referer: 'https://www.google.com/',
        'sec-fetch-dest': 'document',
        'sec-fetch-mode': 'navigate',
        'sec-fetch-site': 'none',
      });

      if (status !== 200) return { error: `HTTP ${status}` };

      const results = [];

      // Amazon embeds twister (variation) data in a JSON blob
      const twisterMatch = html.match(/var\s+dataToReturn\s*=\s*({[\s\S]*?});\s*\n/);
      if (twisterMatch) {
        try {
          const data = JSON.parse(twisterMatch[1]);
          console.log('  [amazon] Found twister data');
        } catch (_) {}
      }

      // Look for "priceblock" or "a-price" patterns
      const wholePrices = [...html.matchAll(/"priceAmount"\s*:\s*"?([\d.]+)"?/g)].map(m => parseFloat(m[1]));
      if (wholePrices.length) {
        for (const p of [...new Set(wholePrices)]) {
          if (p > 50 && p < 15000) results.push({ face: p, price: p, discountPct: '0.0', url, note: 'Amazon sells at face value' });
        }
      }

      // Try JSON-LD
      const jsonLds = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)];
      for (const m of jsonLds) {
        try {
          const data = JSON.parse(m[1]);
          const price = data?.offers?.price || data?.offers?.lowPrice;
          if (price) results.push({ face: parseFloat(price), price: parseFloat(price), discountPct: '0.0', url, note: 'Amazon sells at face value' });
        } catch (_) {}
      }

      // Grab denomination options from variation selector (Amazon embeds these)
      const denomMatches = [...html.matchAll(/"variationValues"\s*:\s*\{([^}]+)\}/g)];
      const denomsFound = [];
      for (const m of denomMatches) {
        const vals = [...m[1].matchAll(/"([^"]+)"/g)].map(v => v[1]);
        denomsFound.push(...vals);
      }

      const allPrices = [...html.matchAll(/₹\s*(\d[\d,]*)/g)].map(m => parseInt(m[1].replace(/,/g, ''))).filter(p => p > 50 && p < 15000);

      if (results.length === 0) {
        return {
          note: 'Amazon sells GCs at face value (no discount)',
          denominations_found: [...new Set(allPrices)].filter(p => [100,200,250,500,1000,1500,2000,3000,5000,7500,10000].includes(p)),
          raw_prices: [...new Set(allPrices)].slice(0, 10),
        };
      }

      return results;
    }
  },

];

// ─── Runner ───────────────────────────────────────────────────────────────────

async function run(brand = 'uber') {
  console.log(`\n${'═'.repeat(60)}`);
  console.log(`  Gift Card Price Check — ${BRANDS[brand].name}`);
  console.log(`  ${new Date().toISOString()}`);
  console.log(`${'═'.repeat(60)}\n`);

  for (const scraper of SCRAPERS) {
    process.stdout.write(`Fetching ${scraper.platform}... `);
    try {
      const result = await scraper.fetch(brand);
      console.log('done');
      console.log(`  → ${JSON.stringify(result, null, 2).replace(/\n/g, '\n  ')}`);
    } catch (err) {
      console.log('ERROR');
      console.log(`  → ${err.message}`);
    }
    console.log();
  }
}

run('uber').catch(console.error);
