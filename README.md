# Woolworths (AU) price scraper

Searches woolworths.com.au for a list of terms with a stealth headless browser,
extracts product name/price/unit price, and appends every run to a price-history
CSV plus a `latest.json` snapshot.

## About the "bot-proof" ask — read this first

Two things worth knowing before you run this:

1. **robots.txt disallows this path.** `woolworths.com.au/robots.txt` blocks
   `/shop/search/`, and Woolworths' Terms of Use prohibit automated access to
   their site. This tool doesn't break any authentication or access non-public
   data — it reads the same prices any shopper sees — but it does go against
   the site's stated rules. That's a ToS/contract matter, not a hacking one,
   but it's on you to decide the risk is acceptable (rate-limit hard, don't
   resell the data, expect your access to get cut off if Woolworths notices).
2. **"Super proof against bot detectors" isn't a real guarantee against Akamai
   Bot Manager**, which is what Woolworths runs. Akamai scores requests on
   things a headless browser can't fully fake from the client side: IP/ASN
   reputation, TLS/HTTP2 fingerprint ordering, and long-run behavioral history
   tied to a device fingerprint. This code does the legitimate client-side
   half properly (stealth patches, realistic fingerprint, human-like pacing,
   persisted cookies) — but **running it from Railway's shared datacenter IPs
   is the single biggest reason it'll get flagged**, no matter how good the
   browser-level stealth is. If you need this to actually keep working, put a
   residential/mobile proxy in `PROXY_SERVER` — that matters more than any of
   the JS-level tricks combined.

Treat this as "best-effort, low-volume, personal-use price checking," not a
production data pipeline that's guaranteed to never get blocked.

## What it does

- Loads `woolworths.com.au/shop/search/products?searchTerm=<term>` in a real
  (stealth-patched) Chromium via Playwright, one term at a time.
- Extracts products by anchoring on the stable `/shop/productdetails/<id>/`
  URL pattern rather than CSS classes (which change on every frontend deploy).
- Detects Akamai/CAPTCHA block pages and 403/429/503 responses, backs off with
  randomised exponential delay, and retries.
- Writes `OUTPUT_DIR/latest.json` (this run only) and appends to
  `OUTPUT_DIR/price_history.csv` (every run, forever — that's your price
  history log).
- Persists Akamai's trust cookies across runs (`OUTPUT_DIR/session-state.json`)
  so repeat runs look like a returning device instead of a brand-new one.
- On a soft failure, dumps the offending page HTML to `OUTPUT_DIR/debug/` so
  you can see exactly what Woolworths served and fix selectors/logic yourself
  if their markup has changed.

## Configuration

All via env vars — see `.env.example`. The only one you'll normally touch is
`SEARCH_TERMS`.

## Run locally

```bash
npm install
npx playwright install --with-deps chromium
cp .env.example .env   # edit SEARCH_TERMS
npm start
```

Watch it run with `HEADLESS=false npm run debug`.

## Run on Railway

This repo ships a `Dockerfile` pinned to the Playwright version in
`package.json` (browser binaries baked into the image must match the driver
version). Deploy flow:

1. Push this repo to GitHub.
2. In Railway: New Project → Deploy from GitHub repo → pick this repo.
3. Add a volume mounted at `/data` (Settings → Volumes) so `price_history.csv`
   and the session-state cookie jar survive redeploys — without it, every
   deploy starts from zero history and a fresh (untrusted) device fingerprint.
4. Set `SEARCH_TERMS` (and `PROXY_SERVER` if you have one) in the service's
   Variables tab.
5. Set the restart policy to **Never** (Settings → Deploy) — this is a script
   that runs once and exits, not a long-lived server. With restart-on-failure
   left on, a blocked run would loop-retry against Woolworths, which is
   exactly the hammering you don't want.
6. To get a fresh price check later: click **Redeploy** on the service (or
   trigger it from the CLI/API). Each redeploy = one run = one more batch of
   rows appended to `price_history.csv` on the volume.

If you want it fully hands-off later, Railway supports a cron schedule on the
service (e.g. daily) instead of manual redeploys — ask and it can be added,
but starting manual keeps request volume (and detection risk) low while you
confirm it's actually getting through.

## Output

`price_history.csv` columns: `scraped_at, search_term, product_id, name,
price, was_price, on_special, unit_price, url`.
