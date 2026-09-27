import { mkdir, writeFile } from "node:fs/promises";

const API_BASE = "https://api.thestatsapi.com/api/football";
const API_KEY = process.env.STATS_API_KEY;
const TIMEZONE = "Europe/London";

if (!API_KEY) {
  console.error("STATS_API_KEY is not configured.");
  process.exit(2);
}

/*
 * Shared caches.
 *
 * These are the important change. If several fixtures require the same
 * team's history, season statistics or historical match statistics,
 * StatsAPI is contacted once and the result is reused.
 */
const cache = {
  histories: new Map(),
  teamStats: new Map(),
  matchStats: new Map(),
  odds: new Map()
};

const diagnostics = {
  requests_total: 0,
  requests_by_route: {},
  pagination_pages: 0,
  retries: 0,
  rate_limit_events: 0,
  cache_hits: 0,
  cache_misses: 0,
  duplicate_requests_avoided: 0,
  errors: []
};

function londonDate() {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(new Date());

  const get = type =>
    parts.find(part => part.type === type)?.value;

  return `${get("year")}-${get("month")}-${get("day")}`;
}

function addDays(dateString, days) {
  const date = new Date(`${dateString}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function isFriday(dateString) {
  return (
    new Date(`${dateString}T12:00:00Z`).getUTCDay() === 5
  );
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function routeFamily(path) {
  if (path.includes("/odds")) return "odds";
  if (path.includes("/stats")) return "stats";
  if (path.startsWith("/matches")) return "matches";
  if (path.startsWith("/teams")) return "teams";
  if (path.startsWith("/competitions")) return "competitions";
  return "other";
}

async function api(path, params = {}, allow404 = false) {
  const url = new URL(API_BASE + path);

  for (const [key, value] of Object.entries(params)) {
    if (
      value !== undefined &&
      value !== null &&
      value !== ""
    ) {
      url.searchParams.set(key, String(value));
    }
  }

  const family = routeFamily(path);

  for (let attempt = 0; attempt < 4; attempt++) {
    diagnostics.requests_total++;

    diagnostics.requests_by_route[family] =
      (diagnostics.requests_by_route[family] || 0) + 1;

    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${API_KEY}`,
        Accept: "application/json",
        "User-Agent": "T1-GitHub-Collector/2.0"
      }
    });

    if (allow404 && response.status === 404) {
      return null;
    }

    if (response.status === 429 && attempt < 3) {
      diagnostics.rate_limit_events++;
      diagnostics.retries++;

      const retryAfter =
        Number(response.headers.get("retry-after")) || 2;

      await sleep(retryAfter * 1000);
      continue;
    }

    if (response.status >= 500 && attempt < 3) {
      diagnostics.retries++;
      await sleep(1500 * (attempt + 1));
      continue;
    }

    const body = await response.text();

    if (!response.ok) {
      throw new Error(
        `StatsAPI HTTP ${response.status}: ${body.slice(0, 250)}`
      );
    }

    return body ? JSON.parse(body) : {};
  }

  throw new Error(`Request failed: ${path}`);
}

async function fetchAll(path, params = {}) {
  let page = 1;
  let totalPages = 1;
  const rows = [];

  do {
    const response = await api(path, {
      ...params,
      per_page: 100,
      page
    });

    diagnostics.pagination_pages++;

    if (Array.isArray(response?.data)) {
      rows.push(...response.data);
    }

    totalPages = Number(response?.meta?.total_pages || 1);
    page++;
  } while (page <= totalPages);

  return rows;
}

function kickoffMs(match) {
  const value =
    match?.utc_date ||
    match?.date ||
    match?.scheduled_at ||
    match?.kickoff;

  const ms = value ? Date.parse(value) : NaN;

  return Number.isFinite(ms) ? ms : null;
}

function teamId(match, side) {
  return (
    match?.[`${side}_team`]?.id ||
    match?.[`${side}_team_id`] ||
    null
  );
}

function seasonId(match) {
  return match?.season_id || match?.season?.id || null;
}

/*
 * Download a team's historical matches once per operating date.
 * Previously this could be downloaded again for every fixture.
 */
async function recentHistory(team, targetMatch, date) {
  const targetKickoff = kickoffMs(targetMatch);

  if (!team || !targetKickoff) return [];

  const key = `${team}|${date}`;

  let history;

  if (cache.histories.has(key)) {
    diagnostics.cache_hits++;
    diagnostics.duplicate_requests_avoided++;
    history = cache.histories.get(key);
  } else {
    diagnostics.cache_misses++;

    history = await fetchAll("/matches", {
      team_id: team,
      status: "finished",
      date_from: addDays(date, -400),
      date_to: date
    });

    cache.histories.set(key, history);
  }

  return history
    .filter(match => {
      const kickoff = kickoffMs(match);
      return kickoff && kickoff < targetKickoff;
    })
    .sort((a, b) => kickoffMs(b) - kickoffMs(a))
    .slice(0, 5);
}

/*
 * Season statistics are also cached.
 */
async function getTeamStats(team, season) {
  if (!team || !season) return null;

  const key = `${team}|${season}`;

  if (cache.teamStats.has(key)) {
    diagnostics.cache_hits++;
    diagnostics.duplicate_requests_avoided++;
    return cache.teamStats.get(key);
  }

  diagnostics.cache_misses++;

  try {
    const result = await api(
      `/teams/${encodeURIComponent(team)}/stats`,
      { season_id: season }
    );

    cache.teamStats.set(key, result);
    return result;
  } catch (error) {
    diagnostics.errors.push({
      type: "TEAM_STATS",
      team,
      message: String(error.message || error)
    });

    cache.teamStats.set(key, null);
    return null;
  }
}

/*
 * Historical match statistics are cached by match ID.
 */
async function getMatchStats(match) {
  if (!match?.id || match?.xg_available !== true) {
    return null;
  }

  const key = String(match.id);

  if (cache.matchStats.has(key)) {
    diagnostics.cache_hits++;
    diagnostics.duplicate_requests_avoided++;
    return cache.matchStats.get(key);
  }

  diagnostics.cache_misses++;

  try {
    const result = await api(
      `/matches/${encodeURIComponent(match.id)}/stats`,
      {},
      true
    );

    cache.matchStats.set(key, result);
    return result;
  } catch (error) {
    diagnostics.errors.push({
      type: "MATCH_STATS",
      match_id: match.id,
      message: String(error.message || error)
    });

    cache.matchStats.set(key, null);
    return null;
  }
}

/*
 * Target-match odds are requested only once.
 */
async function getMatchOdds(match) {
  if (!match?.id || match?.odds_available !== true) {
    return null;
  }

  const key = String(match.id);

  if (cache.odds.has(key)) {
    diagnostics.cache_hits++;
    diagnostics.duplicate_requests_avoided++;
    return cache.odds.get(key);
  }

  diagnostics.cache_misses++;

  try {
    const result = await api(
      `/matches/${encodeURIComponent(match.id)}/odds`
    );

    cache.odds.set(key, result);
    return result;
  } catch (error) {
    diagnostics.errors.push({
      type: "ODDS",
      match_id: match.id,
      message: String(error.message || error)
    });

    cache.odds.set(key, null);
    return null;
  }
}

async function enrichFixture(match, date) {
  const home = teamId(match, "home");
  const away = teamId(match, "away");
  const season = seasonId(match);

  try {
    const [
      homeHistory,
      awayHistory,
      homeSeason,
      awaySeason,
      odds
    ] = await Promise.all([
      recentHistory(home, match, date),
      recentHistory(away, match, date),
      getTeamStats(home, season),
      getTeamStats(away, season),
      getMatchOdds(match)
    ]);

    /*
     * Detailed stats are deliberately limited to the latest
     * three relevant historical matches per side.
     */
    const detailedMatches = [
      ...homeHistory.slice(0, 3),
      ...awayHistory.slice(0, 3)
    ];

    const uniqueDetailed = [
      ...new Map(
        detailedMatches
          .filter(row => row?.id)
          .map(row => [String(row.id), row])
      ).values()
    ];

    const detailedResults = await Promise.all(
      uniqueDetailed.map(async row => ({
        match_id: row.id,
        stats: await getMatchStats(row)
      }))
    );

    const detailedMap = new Map(
      detailedResults.map(row => [
        String(row.match_id),
        row.stats
      ])
    );

    const homeDetailed = homeHistory
      .slice(0, 3)
      .map(row => ({
        match_id: row.id,
        stats: detailedMap.get(String(row.id)) || null
      }))
      .filter(row => row.stats !== null);

    const awayDetailed = awayHistory
      .slice(0, 3)
      .map(row => ({
        match_id: row.id,
        stats: detailedMap.get(String(row.id)) || null
      }))
      .filter(row => row.stats !== null);

    return {
      match,
      home: {
        team_id: home,
        recent_matches: homeHistory,
        season_stats: homeSeason,
        detailed_stats: homeDetailed
      },
      away: {
        team_id: away,
        recent_matches: awayHistory,
        season_stats: awaySeason,
        detailed_stats: awayDetailed
      },
      odds
    };
  } catch (error) {
    return {
      match,
      state: "PARTIAL",
      error: String(error.message || error)
    };
  }
}

async function collectDate(date, competitions) {
  const fixtures = await fetchAll("/matches", {
    date_from: date,
    date_to: date
  });

  /*
   * Preserve every fixture in the raw fixture list.
   * Enrichment remains focused on fixtures where StatsAPI
   * indicates useful advanced data.
   */
  const candidates = fixtures.filter(match =>
    match?.odds_available === true ||
    match?.live_odds_available === true ||
    match?.xg_available === true
  );

  const enriched = [];

  /*
   * Small batches are faster than one-at-a-time processing
   * without hammering StatsAPI with every fixture simultaneously.
   */
  const BATCH_SIZE = 4;

  for (
    let start = 0;
    start < candidates.length;
    start += BATCH_SIZE
  ) {
    const batch = candidates.slice(
      start,
      start + BATCH_SIZE
    );

    const results = await Promise.all(
      batch.map(match =>
        enrichFixture(match, date)
      )
    );

    enriched.push(...results);

    console.log(
      `Progress ${date}: ${Math.min(
        start + BATCH_SIZE,
        candidates.length
      )}/${candidates.length}`
    );
  }

  return {
    schema: "T1_STATSAPI_GITHUB_SNAPSHOT_V2",
    generated_at_utc: new Date().toISOString(),
    operating_date: date,
    timezone: TIMEZONE,
    source: "TheStatsAPI",
    secret_free: true,
    competitions,
    fixtures,
    enriched_fixtures: enriched,
    diagnostics
  };
}

async function main() {
  const manualDate =
    process.env.TARGET_DATE?.trim() || "";

  const baseDate =
    manualDate || londonDate();

  if (!/^\d{4}-\d{2}-\d{2}$/.test(baseDate)) {
    throw new Error(`Invalid date: ${baseDate}`);
  }

  console.log(
    `Starting T1 StatsAPI collection for ${baseDate}`
  );

  const competitions =
    await fetchAll("/competitions");

  const dates = isFriday(baseDate)
    ? [
        baseDate,
        addDays(baseDate, 1),
        addDays(baseDate, 2)
      ]
    : [baseDate];

  await mkdir("data", {
    recursive: true
  });

  const outputIndex = [];

  for (const date of dates) {
    console.log(
      `Collecting StatsAPI data for ${date}`
    );

    const snapshot =
      await collectDate(date, competitions);

    const filename =
      `data/${date}.json`;

    await writeFile(
      filename,
      JSON.stringify(snapshot, null, 2) + "\n",
      "utf8"
    );

    outputIndex.push({
      operating_date: date,
      filename,
      fixture_count:
        snapshot.fixtures.length,
      enriched_count:
        snapshot.enriched_fixtures.length
    });

    console.log(
      `Finished ${date}: ` +
      `${snapshot.fixtures.length} fixtures, ` +
      `${snapshot.enriched_fixtures.length} enriched`
    );
  }

  await writeFile(
    "data/latest.json",
    JSON.stringify(
      {
        schema: "T1_STATSAPI_GITHUB_INDEX_V2",
        generated_at_utc:
          new Date().toISOString(),
        base_operating_date:
          baseDate,
        outputs:
          outputIndex
      },
      null,
      2
    ) + "\n",
    "utf8"
  );

  console.log(
    JSON.stringify(
      {
        ok: true,
        outputs: outputIndex,
        diagnostics
      },
      null,
      2
    )
  );
}

main().catch(error => {
  console.error(
    String(error.message || error)
  );

  process.exit(1);
});
