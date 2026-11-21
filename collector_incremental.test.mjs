import test from "node:test";
import assert from "node:assert/strict";
import {matchCoreKey,canReuseFinishedEnrichment,planFixtureRefresh} from "./collector_incremental.mjs";
const fixture=(id,extra={})=>({
 id,utc_date:"2026-11-21T15:00:00Z",home_team:{id:"h"+id},away_team:{id:"a"+id},
 competition_id:"eng.1",season_id:"2026",status:"scheduled",odds_available:false,...extra
});
const snapshot=(fixtures)=>({
 state:"COMPLETE",fixtures,
 enriched_fixtures:fixtures.map(match=>({match,state:"COMPLETE",home:{recent_matches:[{id:"old"}]}}))
});
test("unchanged Saturdays reuse the full validated 3-day source without historical API calls",()=>{
 const first=[fixture("1"),fixture("2"),fixture("3")],old=snapshot(first);
 assert.deepEqual(planFixtureRefresh(old,structuredClone(first)).identical,true);
 const dynamic=first.map(m=>({...m,status:"finished",odds_available:true,score:{home:1,away:0}}));
 assert.equal(planFixtureRefresh(old,dynamic).identical,true);
 assert.equal(canReuseFinishedEnrichment(old.enriched_fixtures[0],dynamic[0]),true);
});
test("one genuine fixture change refreshes only that match while others keep histories",()=>{
 const original=[fixture("1"),fixture("2"),fixture("3")],old=snapshot(original);
 const next=[fixture("1"),fixture("2",{utc_date:"2026-11-21T17:30:00Z"}),fixture("3"),fixture("4")];
 const plan=planFixtureRefresh(old,next);
 assert.deepEqual(plan.changedIds,["2","4"]);
 assert.equal(plan.reusedCount,2);
 assert.equal(canReuseFinishedEnrichment(old.enriched_fixtures[1],next[1]),false);
 assert.equal(canReuseFinishedEnrichment(old.enriched_fixtures[2],next[2]),true);
});
test("never trust an incomplete, duplicate or damaged source as reusable",()=>{
 const fixtures=[fixture("1"),fixture("2")],old=snapshot(fixtures);
 old.enriched_fixtures[1].state="PARTIAL";
 assert.equal(planFixtureRefresh(old,fixtures).identical,false);
 const duplicate=snapshot([fixture("1"),fixture("1")]);
 assert.equal(planFixtureRefresh(duplicate,[fixture("1"),fixture("2")]).identical,false);
 assert.equal(matchCoreKey(fixture("1",{home_team:{}})),null);
});
test("fixture removals, postponements and changes in team identity are material",()=>{
 const original=[fixture("1"),fixture("2")],old=snapshot(original);
 assert.deepEqual(planFixtureRefresh(old,[fixture("1")]).removedIds,["2"]);
 assert.deepEqual(planFixtureRefresh(old,[fixture("1",{status:"postponed"}),fixture("2")]).changedIds,["1"]);
 assert.deepEqual(planFixtureRefresh(old,[fixture("1",{home_team:{id:"new"}}),fixture("2")]).changedIds,["1"]);
});
