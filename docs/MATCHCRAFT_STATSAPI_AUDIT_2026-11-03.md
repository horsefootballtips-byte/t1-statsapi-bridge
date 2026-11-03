# Matchcraft — TheStatsAPI F1 → F2 → F3 audit (3 November 2026)

## Scope and sources
Read-only comparison of GitHub `collector.mjs`, `player_enrichment.mjs`, `t3-shard-handoff.mjs`, both GitHub Actions workflows, the connected Floot Matchcraft database and UI code, and the vendor's public endpoint documentation index. No paid API requests were made and no account secrets were accessed. The standalone `api.thestatsapi.com/llms.txt` link could not be directly downloaded here; endpoint identities were cross-checked against the vendor's public /docs/llms.txt and specific documentation pages. All estimates are uncalibrated until separately tested against historical outcomes.

## Confirmed current state
- Github T5 data/latest.json says 2026-11-03 COMPLETE/VALIDATED, **85 fixtures**; full source file ~33.6 MB.
- Matchcraft football run 65 (`T5_FULL_GITHUB_MODEL_ALL_MARKETS`) contains **85 fixtures**, **82** numeric core-goal models, **77** corner models, **79** card models, **76** shot models, and **zero** stored recommended picks.
- Run 64 (07:05 F2 fallback) contains **12 fixtures** and **15** stored selections; F2 reported that the full same-day T5 snapshot was not ready at the time.
- F3 reported no independently verified new F3 upload for 3 November. A validated F1 data pack should not be described as a validated F2/F3 betting-selection pack.
- Matchcraft can dynamically display many modelled outcomes via `footballTipGroups` and `footballMarketSpotlights` even without stored F2 picks. Those suggestions must not be conflated with independently scored official F2 selections.

## API endpoints — 34 advertised across six categories
Category | Advertised | Called by F1 now | Key unused opportunities
--- | ---: | ---: | ---
Competitions | 5 | 1 | Competition details, seasons, tables and groups for stronger identity/coverage checking
Teams | 6 | 1 | Direct squad endpoint, injuries/suspensions, table history, team profile
Matches | 12 | 4 | Match detail, referee, shotmap, events, heatmaps; live variants optional/in-play only
Players | 5 | 2 | Player profile, injuries/suspensions and season heatmap
Odds | 3 | 1 | V2 player-prop odds and live odds; **NOT proof of William Hill prices**
Coverage | 3 | 0 | Competition-season coverage flags, so absent data is correctly marked unavailable
Total | **34** | **9** | Not all 34 are needed by a prematch collector; use endpoints by modelling purpose and plan usage

The nine called API families: `/competitions`, `/matches`, `/teams/{id}/stats`, `/matches/{id}/stats`, `/matches/{id}/odds`, `/players`, `/players/{id}/stats`, `/matches/{id}/player-stats`, `/matches/{id}/lineups`. The last three are Brentford-focused; the public API reference now specifies player-prop odds at `/v2/football/matches/{id}/odds/players`, not the deprecated v1 route.

## Concrete gaps and impact
1. **Handoff automation missing:** `publish-t3-handoff.yml` is not triggered when `data/latest.json` changes. Only older October compact batches were present in the examined repository tree. A complete 33 MB snapshot exists, but downstream F2/F3 retrieval is brittle. The proposed workflow fix explicitly dispatches the compact handoff workflow AFTER a verified collector COMPLETE state and checkpoint commit. GitHub Actions commits made with GITHUB_TOKEN do not normally trigger another workflow's push event.
2. **15-game window loses evidence:** F1 `recentHistory` pulls up to 15 previous results per team, but detailed /stats are fetched for only **5** for most teams (**15** for Brentford). The old T3 shard script then trimmed `recent_matches` to 5. The proposed shard fix retains up to 15 match-result/history entries; it does **not** falsely claim to add missing advanced match statistics.
3. **No generic player/referee enrichment:** F1 fetches per-player/lineups information only for Brentford fixtures; official referee tendencies, injuries, shotmaps and v2 player-prop bookmaker prices are not currently collected across the fixture universe. Extend incrementally using real coverage and availability flags, not fabricated values.
4. **Timing:** The 07:00 F2 task ran a smaller fallback before the 85-fixture same-day GitHub pack was available. The 14:00 F3 task did not produce a verified new F3 selection upload. Completing F1 alone does not finish an F2/F3 shortlist.
5. **Monitoring and request caps:** The public provider docs expose `X-RateLimit-Remaining` and `X-Monthly-Quota-Remaining`. The proposed collector change captures these headers without extra requests. Do not increase 5 → 15 detailed calls across all fixtures until the true quota, cache overlap and monthly budget are verified. Handle monthly `USAGE_LIMIT_EXCEEDED` differently from minute-rate `RATE_LIMITED` in a later tested collector change.
6. **Model confidence:** Current MATCHCRAFT count and goal models estimate uncalibrated probabilities. Backtest by league, market, odds and 5/10/15 windows before promising predictive improvement.

## Staged changes in this review branch
- Explicitly dispatch compact T3 handoff on collector COMPLETE, using the existing Actions write permission; do not rely on GITHUB_TOKEN push triggering another workflow.
- Increase retained T3 *recent result rows* from five to fifteen per team; existing byte-bounded batches and per-batch readbacks remain in force.
- Capture API quota header counters in diagnostics; zero new provider requests.
- No new player, card, referee or xG data is fabricated. No production workflow or Matchcraft publish is changed until branch is merged and separately verified.

## Validation/rollout checklist
- On a **new completed** daily collector run, verify the explicit workflow dispatch succeeds and the T3 publisher runs and `data/t3/YYYY-MM-DD/manifest.json` is independently readable with complete source SHA256 and fixture count.
- Confirm all T3 batches together match the 85 fixture IDs (example 2026-11-03), and are each < 420 KB. Run the shard generator on a same-date local snapshot before deployment where possible.
- Verify 5/10/15 controls use only observed pre-match data, correctly indicate when detailed stats are not available, and never silently show unsubstantiated percentages.
- Verify F2/F3 import completed genuine **pre-kickoff** modelled fixtures, qualifying picks, and supported specials separately; preserve previously stored packs and bets.
- Audit real quota headers and competition-season coverage before adding broad historical stats, referee data and v2 player odds.
