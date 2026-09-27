import { mkdir, writeFile, readFile } from "node:fs/promises";

const API_BASE = "https://api.thestatsapi.com/api/football";
const API_KEY = process.env.STATS_API_KEY;
const TIMEZONE = "Europe/London";

/*
 * Each pass deliberately stops before GitHub's observed ~30-minute
 * execution ceiling. Progress is committed by the workflow and the
 * next pass resumes from the checkpoint.
 */
const PASS_BUDGET_MS = Number(
  process.env.PASS_BUDGET_MS || 22 * 60 * 1000
);

const passStartedAt = Date.now();

if (!API_KEY) {
  console.error("STATS_API_KEY is not configured.");
  process.exit(2);
}

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
        "User-Agent": "T1-GitHub-Collector/3.0"
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
        stats:
          detailedMap.get(String(row.id)) || null
      }))
      .filter(row => row.stats !== null);

    const awayDetailed = awayHistory
      .slice(0, 3)
      .map(row => ({
        match_id: row.id,
        stats:
          detailedMap.get(String(row.id)) || null
      }))
      .filter(row => row.stats !== null);

    return {
      match,
      state: "COMPLETE",
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

async function readJsonIfExists(filename) {
  try {
    return JSON.parse(
      await readFile(filename, "utf8")
    );
  } catch (error) {
    if (error?.code === "ENOENT") {
      return null;
    }

    throw error;
  }
}

async function saveCheckpoint(
  date,
  competitions,
  fixtures,
  enriched,
  state = "IN_PROGRESS"
) {
  const filename =
    `data/${date}.checkpoint.json`;

  const payload = {
    schema: "T1_STATSAPI_GITHUB_CHECKPOINT_V3",
    generated_at_utc: new Date().toISOString(),
    operating_date: date,
    timezone: TIMEZONE,
    source: "TheStatsAPI",
    secret_free: true,
    state,
    competitions,
    fixtures,
    enriched_fixtures: enriched,
    completed_match_ids: enriched
      .map(row => String(row?.match?.id || ""))
      .filter(Boolean),
    diagnostics
  };

  await writeFile(
    filename,
    JSON.stringify(payload, null, 2) + "\n",
    "utf8"
  );

  return filename;
}

async function collectDate(date, competitions) {
  const fixtures = await fetchAll("/matches", {
    date_from: date,
    date_to: date
  });

  const candidates = fixtures.filter(match =>
    match?.odds_available === true ||
    match?.live_odds_available === true ||
    match?.xg_available === true
  );

  const checkpointFile =
    `data/${date}.checkpoint.json`;

  const previous =
    await readJsonIfExists(checkpointFile);

  const fixtureIds = new Set(
    fixtures
      .map(row => String(row?.id || ""))
      .filter(Boolean)
  );

  /*
   * Only retain checkpoint rows that still exist in today's
   * current fixture manifest.
   */
  const enriched =
    Array.isArray(previous?.enriched_fixtures)
      ? previous.enriched_fixtures.filter(row =>
          fixtureIds.has(
            String(row?.match?.id || "")
          )
        )
      : [];

  const completed = new Set(
    enriched
      .map(row => String(row?.match?.id || ""))
      .filter(Boolean)
  );

  const remaining = candidates.filter(
    row => !completed.has(String(row?.id || ""))
  );

  const BATCH_SIZE = 4;

  console.log(
    `Resume ${date}: ` +
    `${completed.size}/${candidates.length} already complete; ` +
    `${remaining.length} remaining`
  );

  for (
    let start = 0;
    start < remaining.length;
    start += BATCH_SIZE
  ) {
    /*
     * Stop ourselves before GitHub kills the job.
     * This gives the workflow time to commit the checkpoint.
     */
    if (
      Date.now() - passStartedAt >= PASS_BUDGET_MS
    ) {
      await saveCheckpoint(
        date,
        competitions,
        fixtures,
        enriched,
        "CONTINUATION_REQUIRED"
      );

      console.log(
        `CONTINUATION_REQUIRED ${date}: ` +
        `${enriched.length}/${candidates.length}`
      );

      return {
        complete: false,
        fixture_count: fixtures.length,
        candidate_count: candidates.length,
        enriched_count: enriched.length
      };
    }

    const batch = remaining.slice(
      start,
      start + BATCH_SIZE
    );

    const results = await Promise.all(
      batch.map(match =>
        enrichFixture(match, date)
      )
    );

    enriched.push(...results);

    for (const row of results) {
      if (row?.match?.id) {
        completed.add(String(row.match.id));
      }
    }

    /*
     * Save after every batch.
     */
    await saveCheckpoint(
      date,
      competitions,
      fixtures,
      enriched,
      "IN_PROGRESS"
    );

    console.log(
      `Progress ${date}: ` +
      `${enriched.length}/${candidates.length}`
    );
  }

  const snapshot = {
    schema: "T1_STATSAPI_GITHUB_SNAPSHOT_V3",
    generated_at_utc: new Date().toISOString(),
    operating_date: date,
    timezone: TIMEZONE,
    source: "TheStatsAPI",
    secret_free: true,
    state: "COMPLETE",
    competitions,
    fixtures,
    enriched_fixtures: enriched,
    diagnostics
  };

  await saveCheckpoint(
    date,
    competitions,
    fixtures,
    enriched,
    "COMPLETE"
  );

  return {
    complete: true,
    snapshot,
    fixture_count: fixtures.length,
    candidate_count: candidates.length,
    enriched_count: enriched.length
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
    `Starting resumable StatsAPI collection for ${baseDate}`
  );

  await mkdir("data", {
    recursive: true
  });

  const competitions =
    await fetchAll("/competitions");

  const dates = isFriday(baseDate)
    ? [
        baseDate,
        addDays(baseDate, 1),
        addDays(baseDate, 2)
      ]
    : [baseDate];

  const outputIndex = [];
  let continuationRequired = false;

  for (const date of dates) {
    /*
     * If this date is already completely collected,
     * don't waste another pass collecting it again.
     */
    const existingFinal =
      await readJsonIfExists(`data/${date}.json`);

    if (
      existingFinal?.state === "COMPLETE" &&
      existingFinal?.schema ===
        "T1_STATSAPI_GITHUB_SNAPSHOT_V3"
    ) {
      outputIndex.push({
        operating_date: date,
        filename: `data/${date}.json`,
        fixture_count:
          existingFinal.fixtures?.length || 0,
        enriched_count:
          existingFinal.enriched_fixtures?.length || 0,
        state: "COMPLETE"
      });

      continue;
    }

    console.log(
      `Collecting StatsAPI data for ${date}`
    );

    const result =
      await collectDate(date, competitions);

    if (!result.complete) {
      continuationRequired = true;

      outputIndex.push({
        operating_date: date,
        filename:
          `data/${date}.checkpoint.json`,
        fixture_count: result.fixture_count,
        enriched_count: result.enriched_count,
        state: "CONTINUATION_REQUIRED"
      });

      /*
       * Stop this pass here. A continuation pass
       * resumes this date from the checkpoint.
       */
      break;
    }

    const filename =
      `data/${date}.json`;

    await writeFile(
      filename,
      JSON.stringify(
        result.snapshot,
        null,
        2
      ) + "\n",
      "utf8"
    );

    outputIndex.push({
      operating_date: date,
      filename,
      fixture_count: result.fixture_count,
      enriched_count: result.enriched_count,
      state: "COMPLETE"
    });

    console.log(
      `Finished ${date}: ` +
      `${result.fixture_count} fixtures, ` +
      `${result.enriched_count} enriched`
    );
  }

  await writeFile(
    "data/latest.json",
    JSON.stringify(
      {
        schema: "T1_STATSAPI_GITHUB_INDEX_V3",
        generated_at_utc:
          new Date().toISOString(),
        base_operating_date: baseDate,
        state: continuationRequired
          ? "CONTINUATION_REQUIRED"
          : "COMPLETE",
        outputs: outputIndex
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
        continuation_required:
          continuationRequired,
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
