# ScaleFlow AI lead list

100 leads for ScaleFlow AI, an email warmup and deliverability product. Built for the Revenue Inc GTM Engineer take-home, 20 to 22 August 2026.

**[Loom walkthrough](https://www.loom.com/share/320038e70c3b4ba29ad5265a3e83fef3)**  ·  **The list: [`data/leads_final.csv`](data/leads_final.csv)**

| | |
|---|---|
| Rows | 100 |
| Source | 71 Clutch, 29 Crunchbase |
| Signal tier | 4 tier_1, 19 tier_2, 77 tier_3 |
| Email | 100 of 100 with a live MX record, no role accounts |
| Countries | US, UK, CA, AU |
| New spend | $4.12 (Apify) |

Columns: `company`, `domain`, `country`, `headcount`, `company_type`, `decision_maker_name`, `decision_maker_title`, `decision_maker_linkedin`, `sales_owner_title`, `email`, `email_status`, `signal_tier`, `signal_type`, `signal_evidence`, `signal_url`, `source`, `origin_url`, `captured_at`.

## Read this before opening the CSV

1. **Most rows come from Clutch.** Of the 300 companies the Crunchbase scraper pulled, 74% had raised more than $20M and 7% fit the ICP. Agencies rarely raise venture capital, and Clutch lists them by service. Crunchbase contributed the 29 rows that fit.
2. **`signal_tier` ranks the list by intent evidence.** All 100 rows passed the company type, country, and headcount filters. 7 of 357 companies had a signal I could verify with a URL, and tier_1 rows carry it. tier_2 is lead-gen agencies and sales consultancies, whose whole business is outbound email. tier_3 has no dated signal. An empty `signal_url` means nothing was found, never a guess.
3. **"VP of Sales" is read as "someone owns sales".** The ICP accepts Founder as a decision maker and then disqualifies any company without a VP of Sales. In a 15-person agency those two rules cancel. `sales_owner_title` shows the title that satisfied the rule on each row. 5 of the first 48 carried the literal title.
4. **`email_status` reports an MX check.** Each address passed a syntax check, a live DNS MX lookup, and a role-account check. No SMTP handshake was run, so the column never says `valid`.
5. **`headcount` is the band the source reported.** `10 - 49` crosses the ICP floor of 11. `50 - 249` and `101-250` cross the ceiling of 200. 73 rows sit in a band that crosses a boundary. I did not guess a midpoint.

## Pipeline

```
src/icp.ts                   The ICP as zod schemas: the company gate and the shape of a shipped lead.
src/scrapers/crunchbase.ts   Playwright. Logged-in saved search, real pagination, 2s between requests, stops on CAPTCHA.
src/scrapers/clutch.ts       Playwright. Three listings, 200 per category, null-rate check before it writes anything.
src/pipeline/normalize.ts    Merge both sources, normalize domains, ICP geo and headcount filter, dedupe by domain.
Apify actors                 LinkedIn jobs and posts for the intent signal.
Clay                         Decision maker, sales owner, work email, through Clay's MCP server.
src/pipeline/finalize.ts     Join Clay output, MX check, drop non-sales titles, rank by tier, validate each row, write the top 100.
```

`src/mcp/server.ts` exposes the pipeline as an MCP server with four tools. `src/agent/qualify.ts` drives it, scores each lead against the ICP, and stops at a human approval gate.

## Run

```bash
pnpm install
npx playwright install chromium
pnpm test                                # 42 tests, including one that parses every shipped row against the lead schema
pnpm scrape:clutch
pnpm scrape:crunchbase                   # needs .crunchbase.storageState.json from a logged-in trial session
pnpm normalize                           # writes data/companies.csv
pnpm finalize path/to/clay-export.csv    # writes data/leads_final.csv
pnpm mcp
pnpm agent                               # reads data/companies.csv, so it runs on a fresh clone
```

The signal step needs `APIFY_TOKEN`. The Clay step ran through Clay's MCP server and is not scripted here.
