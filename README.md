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
`SEARCH_TERMS`. To add a new batch of terms (e.g. a whole new product category)
without editing that list, set `SEARCH_TERMS_EXTRA` instead — it's appended on top
at startup, so the two never need to be merged by hand.

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
image_url, price, was_price, on_special, unit_price, url`.

## Postgres (optional)

Set `DATABASE_URL` and every run also writes to two tables:

- **`price_history`** — append-only log, one row per (product, search term,
  run). Same columns as the CSV, plus a `BIGSERIAL id` (`ORDER BY id`
  reproduces scrape order) and a unique constraint on
  `(scraped_at, search_term, product_id)` so re-running never duplicates a row.
- **`products`** — one row per `product_id`, the current/latest known state.
  This is what a consumer (the API below, or any other app) should read for
  "what does this cost right now" instead of aggregating the log itself.

Both are created automatically on first run — no manual migration needed for
new deployments.

**Manual price correction:** update a row in `products` and set
`price_locked = true` (the API's `PATCH /products/:id` does this for you).
Once locked, the scraper's own upsert stops touching that product's
price/was_price/on_special/unit_price — everything else (name, image, url)
keeps auto-updating from the freshest scrape. `POST /products/:id/unlock`
(or `UPDATE products SET price_locked = false ...`) resumes automatic pricing.

**Adding a product manually:** either `INSERT`/`UPDATE` the `products` table
directly (e.g. via a GUI client like TablePlus/pgAdmin using the connection
details you were given), or `POST /products` on the API below. A manually
added product still picks up live prices from future scrapes if it happens to
match one of `SEARCH_TERMS` — unless you also set `price_locked = true`.

To backfill CSV history that predates the Postgres integration, run
`node src/migrate.js` once against a deployment that already has
`DATABASE_URL` set and the volume mounted — it reads the existing
`OUTPUT_DIR/price_history.csv` and loads it into both tables, skipping
anything already present.

## API (for the iOS app)

`api/` is a second, independent service — a small dependency-light (just
`pg`, no framework) JSON API over the same Postgres database, meant to run as
its own always-on-but-sleeps-when-idle Railway service (see "Run on Railway"
below) rather than inside the one-off scraper container.

```
GET    /health
GET    /products                 ?search_term=&q=&on_special=true&limit=&offset=
GET    /products/:id
GET    /products/:id/history     ?limit=
PATCH  /products/:id             [auth] manual price correction -> price_locked=true
                                  body: { price?, was_price?, on_special?, unit_price? }
POST   /products/:id/unlock      [auth] resume auto price updates from the scraper
POST   /products                 [auth] add/replace a product manually
                                  body: { product_id, name, image_url?, url?,
                                          search_term?, price?, was_price?,
                                          on_special?, unit_price?, price_locked? }
DELETE /products/:id             [auth]
```

`[auth]` routes require header `x-api-key: <API_KEY>` matching the service's
`API_KEY` env var. Reads are open (no key) — this is read-only public price
data, same as what any shopper sees on the site. If `API_KEY` isn't set, all
write routes are refused (fails closed, not open).

Run locally: `cd api && npm install && DATABASE_URL=... API_KEY=... npm start`.

## Run on Railway

This repo ships **two** Dockerfiles for **two** Railway services in the same
project, both pointed at this GitHub repo:

- **`scraper`** (repo root) — the Playwright-based one-off job described
  above. Runs once per deploy/redeploy, then exits.
- **`api`** (root directory set to `api/`) — the always-on JSON API. Deploy
  flow:
  1. New Service → Deploy from GitHub repo → same repo → set **Root
     Directory** to `api` (Settings → Source).
  2. Set `DATABASE_URL` to a reference pointing at your Postgres service
     (e.g. `${{postgres.DATABASE_URL}}`), and set `API_KEY` to a long random
     secret.
  3. Generate a public domain (Settings → Networking) so the iOS app has a
     URL to call.
  4. Turn on **sleep on idle** (Settings → Sleep) so it costs nothing while
     no one's using it — it wakes on the next incoming request.

Both services share the same `postgres` database service via
`${{postgres.DATABASE_URL}}` variable references — no separate database per
service needed.

For the scraper service specifically:

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
   rows appended to `price_history.csv` and upserted into Postgres.

If you want it fully hands-off later, Railway supports a cron schedule on the
service (e.g. daily) instead of manual redeploys — ask and it can be added,
but starting manual keeps request volume (and detection risk) low while you
confirm it's actually getting through.
