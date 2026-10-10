import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';

const REPO_DATA = 'data';
const MAX_BATCH_BYTES = 420_000; // comfortably below GitHub's 1 MB Contents limit
const MAX_FIXTURES_PER_BATCH = 5;
const bytes = value => Buffer.byteLength(JSON.stringify(value), 'utf8');
const sha256 = raw => createHash('sha256').update(raw).digest('hex');
const idOf = x => String(x?.id ?? '');
const sortKeys = keys => keys.sort((a, b) => {
  const importance = k => /^(id|date|utc_date|scheduled_at|kickoff|status|name|home_team|away_team|home_team_id|away_team_id|score|scores|result|goals|home_score|away_score|competition|competition_id|season|season_id|xg|stats|form)$/i.test(k) ? 0 : /score|goal|date|team|match|league|rating|season|win|draw|loss|xg|stat|total|home|away|competition/i.test(k) ? 1 : 2;
  return importance(a) - importance(b);
});

// Bounded structured evidence, not an unbounded raw payload. Never invent a value.
function bound(value, limit, depth = 0) {
  if (value == null || typeof value === 'boolean' || typeof value === 'number') return value;
  if (typeof value === 'string') return value.slice(0, Math.min(value.length, 700));
  if (depth > 8) return null;
  if (Array.isArray(value)) {
    const out = [];
    for (const x of value.slice(0, 75)) {
      const entry = bound(x, Math.min(6500, limit), depth + 1);
      if (bytes([...out, entry]) > limit) break;
      out.push(entry);
    }
    return out;
  }
  if (typeof value !== 'object') return null;
  const out = {};
  const keys = sortKeys(Object.keys(value)).slice(0, 100);
  for (const key of keys) {
    if (/^(url|urls|logo|logos|image|images|photo|photos|video|videos|commentary|timeline|lineups|player_stats|players|referee|referees|broadcasts)$/i.test(key)) continue;
    const remaining = limit - bytes(out) - Buffer.byteLength(key, 'utf8') - 6;
    if (remaining < 30) break;
    const entry = bound(value[key], Math.min(remaining, 16000), depth + 1);
    if (bytes({ ...out, [key]: entry }) <= limit) out[key] = entry;
  }
  return out;
}

function compactFixture(match, enriched) {
  const side = sideName => {
    const block = enriched?.[sideName] || {};
    return {
      team_id: block.team_id ?? null,
      recent_matches: (Array.isArray(block.recent_matches) ? block.recent_matches : [])
        .slice(0, 5).map(row => bound(row, 6000)),
      season_stats: bound(block.season_stats ?? null, 16000),
      detailed_stats: bound(block.detailed_stats ?? null, 8500)
    };
  };
  const record = {
    fixture_id: idOf(match),
    match: bound(match, 16000),
    state: enriched?.state || 'UNENRICHED',
    availability: enriched?.availability || null,
    home: side('home'),
    away: side('away'),
    odds: bound(enriched?.odds ?? null, 5000),
    evidence_format: 'BOUNDED_SOURCE_FACTS',
    // Large optional fields are condensed. Original full V4 file remains authoritative.
    source_raw_retained_in_archive: true
  };
  if (enriched?.error) record.enrichment_error = String(enriched.error).slice(0, 500);
  return record;
}

async function publishOne(date) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw Error('Invalid date: ' + date);
  const sourcePath = REPO_DATA + '/' + date + '.json';
  const sourceRaw = await readFile(sourcePath, 'utf8');
  const source = JSON.parse(sourceRaw);
  if (source.operating_date !== date || source.state !== 'COMPLETE' ||
      source.schema !== 'T5_STATSAPI_GITHUB_SNAPSHOT_V4' || source.secret_free !== true) {
    throw Error('Source snapshot not complete or not verified: ' + sourcePath);
  }
  const fixtures = source.fixtures;
  const enriched = source.enriched_fixtures;
  if (!Array.isArray(fixtures) || !Array.isArray(enriched) || !fixtures.length || fixtures.length !== enriched.length) {
    throw Error('Manifest and enrichment counts differ for ' + date);
  }
  const fixtureIds = fixtures.map(idOf);
  const enrichedIds = enriched.map(e => idOf(e?.match));
  if (fixtureIds.some(id => !id) || new Set(fixtureIds).size !== fixtures.length ||
      enrichedIds.some(id => !id) || new Set(enrichedIds).size !== enriched.length ||
      enrichedIds.some(id => !fixtureIds.includes(id))) {
    throw Error('Missing, duplicated or orphaned fixture IDs: ' + date);
  }
  const byId = new Map(enriched.map(row => [idOf(row.match), row]));
  const targetDir = REPO_DATA + '/t3/' + date;
  await mkdir(targetDir, { recursive: true });
  const batches = [];
  let batch = [];
  const flush = async () => {
    if (!batch.length) return;
    const filename = 'batch-' + String(batches.length + 1).padStart(4, '0') + '.json';
    const path = targetDir + '/' + filename;
    const payload = {
      schema: 'T5_T3_FIXTURE_BATCH_V1',
      operating_date: date,
      batch_number: batches.length + 1,
      fixture_count: batch.length,
      fixtures: batch
    };
    const raw = JSON.stringify(payload) + '\n';
    const size = Buffer.byteLength(raw, 'utf8');
    if (size > MAX_BATCH_BYTES) throw Error('Oversized batch: ' + path + ': ' + size);
    await writeFile(path, raw, 'utf8');
    if (await readFile(path, 'utf8') !== raw) throw Error('Batch readback failed: ' + path);
    batches.push({
      number: batches.length + 1,
      path,
      size_bytes: size,
      sha256: sha256(raw),
      fixture_count: batch.length,
      fixture_ids: batch.map(row => row.fixture_id)
    });
    batch = [];
  };
  for (const fixture of fixtures) {
    const record = compactFixture(fixture, byId.get(idOf(fixture)));
    if (bytes({ fixtures: [record] }) + 300 > MAX_BATCH_BYTES) {
      throw Error('Fixture exceeds safe bound: ' + idOf(fixture));
    }
    if (batch.length >= MAX_FIXTURES_PER_BATCH ||
        bytes({ fixtures: [...batch, record] }) + 300 > MAX_BATCH_BYTES) await flush();
    batch.push(record);
  }
  await flush();
  const sourceHash = sha256(sourceRaw);
  const manifest = {
    schema: 'T5_T3_SHARDED_MANIFEST_V1',
    operating_date: date,
    state: 'COMPLETE',
    T3_READY: true,
    source_schema: source.schema,
    source_snapshot: { path: sourcePath, size_bytes: Buffer.byteLength(sourceRaw, 'utf8'), sha256: sourceHash },
    source_fixtures: fixtures.length,
    source_enriched: enriched.length,
    published_fixtures: batches.reduce((sum, b) => sum + b.fixture_count, 0),
    fixture_count: fixtures.length,
    batch_count: batches.length,
    max_batch_bytes: MAX_BATCH_BYTES,
    evidence_policy: 'Source facts preserved in compact bounded form; original full snapshot available for forensic readback. Never infer missing facts.',
    batch_files: batches
  };
  if (manifest.published_fixtures !== fixtures.length ||
      new Set(batches.flatMap(b => b.fixture_ids)).size !== fixtures.length) {
    throw Error('Not all fixtures preserved across batches: ' + date);
  }
  for (const b of batches) {
    const raw = await readFile(b.path, 'utf8');
    const parsed = JSON.parse(raw);
    if (sha256(raw) !== b.sha256 || parsed.fixture_count !== b.fixture_count ||
        parsed.fixtures.some((f, i) => f.fixture_id !== b.fixture_ids[i])) {
      throw Error('Independent shard readback failed: ' + b.path);
    }
  }
  const manifestPath = targetDir + '/manifest.json';
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
  const check = JSON.parse(await readFile(manifestPath, 'utf8'));
  if (!check.T3_READY || check.batch_count !== batches.length || check.published_fixtures !== fixtures.length) {
    throw Error('Manifest readback failure: ' + manifestPath);
  }
  console.log('PUBLISHED_T3_MANIFEST ' + manifestPath + ' fixture_count=' + fixtures.length +
    ' batch_count=' + batches.length + ' largest_batch_bytes=' + Math.max(...batches.map(b => b.size_bytes)));
  return { operating_date: date, manifest_path: manifestPath, batches: batches.length, fixtures: fixtures.length };
}

export async function publishT3Handoff() {
  const target = (process.env.TARGET_DATE || '').trim();
  let dates;
  if (target) dates = [target];
  else {
    const latest = JSON.parse(await readFile(REPO_DATA + '/latest.json', 'utf8'));
    dates = (latest.outputs || []).filter(x => x.state === 'COMPLETE')
      .map(x => x.operating_date);
  }
  if (!dates.length) {
    console.log('No complete T5 snapshots to publish; preserving existing handoffs.');
    return [];
  }
  const results = [];
  for (const date of dates) results.push(await publishOne(date));
  return results;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) {
  publishT3Handoff().catch(err => { console.error(err); process.exitCode = 1; });
}
