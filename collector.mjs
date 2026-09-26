import { mkdir, writeFile } from "node:fs/promises";

const API_BASE = "https://api.thestatsapi.com/api/football";
const API_KEY = process.env.STATS_API_KEY;
const TIMEZONE = "Europe/London";

if (!API_KEY) {
  console.error("STATS_API_KEY is not configured.");
  process.exit(2);
}

const diagnostics = {
  requests_total: 0,
  requests_by_route: {},
  pagination_pages: 0,
  retries: 0,
  rate_limit_events: 0,
  errors: []
};

function londonDate() {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(new Date());

  const get = t => parts.find(p => p.type === t)?.value;

  return `${get("year")}-${get("month")}-${get("day")}`;
}

function addDays(dateString, days) {
  const d = new Date(`${dateString}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function isFriday(dateString) {
  return new Date(`${dateString}T12:00:00Z`).getUTCDay() === 5;
}

async function sleep(ms) {
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
    if (value !== undefined && value !== null && value !== "") {
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
        "User-Agent": "T1-GitHub-Collector/1.0"
      }
    });

    if (allow404 && response.status === 404) {
      return null;
    }

    if (response.status === 429 && attempt < 3) {
      diagnostics.rate_limit_events++;
      diagnostics.retries++;
      await sleep(2000 * (attempt + 1));
      continue;
    }

    if (response.status >= 500 && attempt < 3) {
      diagnostics.retries++;
      await sleep(1500 * (attempt + 1));
      continue;
    }

    const text = await response.text();

    if (!response.ok) {
      throw new Error(
        `StatsAPI HTTP ${response.status}: ${text.slice(0, 250)}`
      );
    }

    return text ? JSON.parse(text) : {};
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

  const history = await fetchAll("/matches", {
    team_id: team,
    status: "finished",
    date_from: addDays(date, -400),
    date_to: date
  });

  return history
    .filter(m => {
      const k = kickoffMs(m);
      return k && k < targetKickoff;
    })
    .sort((a, b) => kickoffMs(b) - kickoffMs(a))
    .slice(0, 5);
}

async function teamStats(team, season) {
  if (!team || !season) return null;

  try {
    return await api(
      `/teams/${encodeURIComponent(team)}/stats`,
      { season_id: season }
    );
  } catch (err) {
    diagnostics.errors.push({
      type: "TEAM_STATS",
      team,
      message: String(err.message || err)
    });

    return null;
  }
}

async function matchStats(match) {
  if (!match?.id || match?.xg_available !== true) {
    return null;
  }

  try {
    return await api(
      `/matches/${encodeURIComponent(match.id)}/stats`,
      {},
      true
    );
  } catch (err) {
    diagnostics.errors.push({
      type: "MATCH_STATS",
      match_id: match.id,
      message: String(err.message || err)
    });

    return null;
  }
}

async function matchOdds(match) {
  if (!match?.id || match?.odds_available !== true) {
    return null;
  }

  try {
    return await api(
      `/matches/${encodeURIComponent(match.id)}/odds`
    );
  } catch (err) {
    diagnostics.errors.push({
      type: "ODDS",
      match_id: match.id,
      message: String(err.message || err)
    });

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
      teamStats(home, season),
      teamStats(away, season),
      matchOdds(match)
    ]);

    const homeDetailed = [];
    const awayDetailed = [];

    for (const row of homeHistory.slice(0, 3)) {
      const stats = await matchStats(row);

      if (stats) {
        homeDetailed.push({
          match_id: row.id,
          stats
        });
      }
    }

    for (const row of awayHistory.slice(0, 3)) {
      const stats = await matchStats(row);

      if (stats) {
        awayDetailed.push({
          match_id: row.id,
          stats
        });
      }
    }

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
  } catch (err) {
    return {
      match,
      state: "PARTIAL",
      error: String(err.message || err)
    };
  }
}

async function collectDate(date, competitions) {
  const fixtures = await fetchAll("/matches", {
    date_from: date,
    date_to: date
  });

  const enriched = [];

  for (const match of fixtures) {
    const useful =
      match?.odds_available === true ||
      match?.live_odds_available === true ||
      match?.xg_available === true;

    if (!useful) continue;

    enriched.push(
      await enrichFixture(match, date)
    );
  }

  return {
    schema: "T1_STATSAPI_GITHUB_SNAPSHOT_V1",
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
    throw new Error(
      `Invalid date: ${baseDate}`
    );
  }

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
  }

  await writeFile(
    "data/latest.json",
    JSON.stringify(
      {
        schema:
          "T1_STATSAPI_GITHUB_INDEX_V1",
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

main().catch(err => {
  console.error(
    String(err.message || err)
  );

  process.exit(1);
});
