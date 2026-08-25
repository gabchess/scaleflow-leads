# What broke

Things that failed while building this, written down because the failures shaped the
design more than the plan did. Costs included.

## Crunchbase was the wrong primary source, measured on day one

The brief assumed Crunchbase. The first scrape of 300 companies showed 74% had raised
past the $20M revenue ceiling and only 7% fit the ICP. Agencies rarely raise venture
capital; Clutch lists them by service. The fix was moving the primary source to Clutch,
which ended up producing 71 of the 100 shipped rows. Measuring the source before
building on it was the whole difference.

## A run reported 300 rows that were completely empty

An early Clutch run wrote its file and reported success while every row was null: the
selectors had missed and nothing checked. The fix is the null-rate check that now runs
before any file write in `src/scrapers/clutch.ts`. A scraper that cannot fail loudly
will fail silently.

## CAPTCHA ends a Crunchbase run, by design

The logged-in scraper paginates with a 2-second delay and stops the moment a CAPTCHA
appears rather than trying to solve or route around it. A blocked run resumes after a
manual login refresh. Slower, and the account stays alive.

## What a run costs

$4.12 in Apify credit for the signal pass on this run. Scraping and filtering cost $0.
Clay enrichment billed on the Clay side, per their plan.

## The email column's honest limit

Every address passed syntax, live DNS MX, and a role-account check. No SMTP handshake
ran, so `email_status` never says `valid`. Deliverability is unproven until you send.
