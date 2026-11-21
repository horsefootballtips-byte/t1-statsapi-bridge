/**
 * Conservative, credit-saving reuse of previously validated T5 histories.
 * A three-day rolling FIXTURE calendar must not imply three new 400-match
 * HISTORY downloads each morning.
 *
 * This module makes no network calls and never trusts partial enrichment.
 */
export function matchCoreKey(match) {
  if (!match || typeof match !== "object" || !match.id) return null;
  const team = side => String(match?.[`${side}_team`]?.id ?? match?.[`${side}_team_id`] ?? "");
  const kickoff = match.utc_date || match.date || match.scheduled_at || match.kickoff || "";
  const competition = match.competition_id || match.competition?.id || "";
  const season = match.season_id || match.season?.id || "";
  const status = String(match.status || "").toLowerCase();
  const disruption = /postpon|cancel|abandon|suspend/.test(status) ? "DISRUPTED" : "ACTIVE";
  if (!team("home") || !team("away") || !kickoff || !competition) return null;
  // Availability/odds, scores, in-play status and volatile metadata are
  // intentionally excluded; targeted odds and XI checks own their refresh.
  return JSON.stringify([
    String(match.id),String(kickoff),team("home"),team("away"),
    String(competition),String(season),disruption
  ]);
}
export function canReuseFinishedEnrichment(oldRow, currentMatch) {
  return oldRow?.state === "COMPLETE" &&
    matchCoreKey(oldRow.match) !== null &&
    matchCoreKey(oldRow.match) === matchCoreKey(currentMatch);
}
export function planFixtureRefresh(oldSnapshot, newFixtures) {
  if (!Array.isArray(newFixtures) || newFixtures.length === 0) {
    return {identical:false,reason:"NO_NEW_FIXTURES",changedIds:[]};
  }
  if (!oldSnapshot || oldSnapshot.state !== "COMPLETE" ||
      !Array.isArray(oldSnapshot.fixtures) ||
      !Array.isArray(oldSnapshot.enriched_fixtures) ||
      oldSnapshot.fixtures.length !== oldSnapshot.enriched_fixtures.length) {
    return {identical:false,reason:"NO_VALID_OLD_SNAPSHOT",changedIds:newFixtures.map(x=>String(x.id))};
  }
  const oldById = new Map(),newById = new Map();
  for (const f of oldSnapshot.fixtures) {
    const key=matchCoreKey(f);
    if (!key || oldById.has(String(f.id)))return {identical:false,reason:"OLD_MANIFEST_INVALID",changedIds:[]};
    oldById.set(String(f.id),key);
  }
  for (const f of newFixtures) {
    const key=matchCoreKey(f);
    if (!key || newById.has(String(f.id)))return {identical:false,reason:"NEW_MANIFEST_INVALID",changedIds:[]};
    newById.set(String(f.id),key);
  }
  const enriched=new Map();
  for(const row of oldSnapshot.enriched_fixtures){
    const id=String(row?.match?.id||"");
    if(!id||enriched.has(id)||!canReuseFinishedEnrichment(row,oldSnapshot.fixtures.find(x=>String(x.id)===id)))
      return {identical:false,reason:"OLD_ENRICHMENT_INVALID",changedIds:[]};
    enriched.set(id,row);
  }
  const changedIds=[];
  for(const [id,key] of newById)if(oldById.get(id)!==key)changedIds.push(id);
  const removedIds=[...oldById.keys()].filter(id=>!newById.has(id));
  return {
    identical:changedIds.length===0&&removedIds.length===0&&newFixtures.length===oldSnapshot.fixtures.length,
    reason:changedIds.length||removedIds.length?"CHANGED_FIXTURE_IDENTITIES":"IDENTICAL",
    changedIds,removedIds,
    reusedCount:newFixtures.length-changedIds.length
  };
}
