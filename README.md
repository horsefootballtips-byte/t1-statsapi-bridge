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
- On Fridays, writes independent Friday, Saturday, and Sunday snapshots.
- Writes `data/YYYY-MM-DD.json` plus `data/latest.json`.
- Never writes the API key into output.

## Schedule

The workflow uses two UTC cron entries plus a Europe/London time guard so BST/GMT changes do not shift the intended local run. It collects at approximately **21:40 Europe/London**, ahead of the current **22:47 T1** schedule.

You can also run it manually from **Actions → Collect T1 StatsAPI snapshot → Run workflow** and optionally supply a date.
