# T1 StatsAPI Snapshot Collector

This repository publishes **secret-free** football-data snapshots for the T1 football branch.

## One-time secret setup

In this repository open:

**Settings → Secrets and variables → Actions → New repository secret**

Create:

- Name: `STATS_API_KEY`
- Value: your TheStatsAPI API key

The key is used only inside GitHub Actions. Never place it in `collector.mjs`, the workflow YAML, README, or `data/`.

## What the collector does

- Retrieves the competition map.
- Retrieves all fixtures for the operating date with full pagination.
- Preserves every fixture in the snapshot.
- Enriches request-efficient candidates where StatsAPI reports odds/live-odds/xG availability.
- Retrieves recent pre-kickoff competitive history, team-season stats, optional xG/match stats, and pre-match odds where available.
- Never treats StatsAPI bookmaker availability as proof of William Hill availability.
- Collects a rolling three-day window every day (e.g. Thu/Fri/Sat, then Fri/Sat/Sun), using independent validated day snapshots.
- For a previously completed fixture day, fetches only its small fixture manifest and reuses historical statistics for unchanged matches. A 400-fixture Saturday is **not** fully re-enriched on Friday and Saturday.
- Only new, rescheduled, replaced or materially changed fixtures cause new historical enrichment; incidental score/status or pricing availability changes do not automatically invalidate cached histories. Confirmed line-ups and independent results use their own refresh paths.
- If the provider monthly allowance is exhausted, reuses previously validated snapshots where available and pauses incomplete collection rather than starting repeat continuation jobs.
- Offline incremental regression tests run before scheduled collection; use `node --test collector_incremental.test.mjs` to run them without any paid requests.
- Writes `data/YYYY-MM-DD.json` plus `data/latest.json`.
- Never writes the API key into output.

## Schedule

The workflow uses two UTC cron entries plus a Europe/London time guard so BST/GMT changes do not shift the intended local run. It collects at approximately **21:40 Europe/London**, ahead of the current **22:47 T1** schedule.

You can also run it manually from **Actions → Collect T1 StatsAPI snapshot → Run workflow** and optionally supply a date.

## Credit-saving verification (21 November 2026)

The prior collector stored an in-memory history cache that disappeared after every GitHub run and rebuilt previous-day COMPLETE snapshots. A saved audit of the Saturday 21 November fixture set showed 410 fixtures already known, three additions and eleven fixture-record changes, yet 413 were fully rebuilt. This was a substantial avoidable cost.

The new snapshot reuse policy passed real archived-snapshot integration tests with mock API responses: **192 completed fixtures across three saved days reused, four inexpensive paginated fixture-list calls, zero historical statistics or odds requests**. Separately, all 413 stored Saturday fixture histories passed the strict reusable-identity check. These were offline demonstrations, not a live TheStatsAPI usage measurement; the next successful subscribed collection should confirm the production request counts and source freshness.

To check spend after renewal, inspect `data/latest.json` diagnostics: `requests_total`, `requests_by_route`, `validated_snapshots_reused`, `preserved_historical_enrichments`, `newly_enriched_fixtures` and `api_quota_last_seen`. Avoid running manual historical refresh jobs unless new material source evidence justifies their cost.
