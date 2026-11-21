// Matchcraft final-score collector. Only trusted TheStatsAPI "finished" matches.
 // Uses existing GitHub STATS_API_KEY secret; publishes no keys, bets or member data.
import {mkdir,writeFile,readFile} from "node:fs/promises";
import {createHash} from "node:crypto";
const api="https://api.thestatsapi.com/api/football";
const key=process.env.STATS_API_KEY;
if(!key)throw Error("Missing existing STATS_API_KEY GitHub Actions secret");
const target=[
 ["Premier League","comp_3039"],["Championship","comp_8321"],
 ["League One","comp_0196"],["League Two","comp_4023"],
 ["Scottish Premiership","comp_6387"],["Scottish Championship","comp_6236"],
 ["Scottish League One","comp_3615"],["Scottish League Two","comp_7454"],
 ["La Liga","comp_8814"],["Serie A","comp_5840"],
 ["Bundesliga","comp_4643"],["Ligue 1","comp_0256"],
 ["National League","comp_5878"],["National League North","comp_6219"],
 ["National League South","comp_0182"]
];
const ukDate=()=>new Intl.DateTimeFormat("sv-SE",{timeZone:"Europe/London",year:"numeric",month:"2-digit",day:"2-digit"}).format(new Date());
// A historic backfill must be explicitly selected. Never treat a code push
// or an ordinary manual refresh as permission to re-download whole seasons.
const backfill=process.env.BACKFILL==="1";
const to=ukDate();
const sha=s=>createHash("sha256").update(s).digest("hex");
let previous=null;
try{
 const saved=JSON.parse(await readFile("data/results/latest.json","utf8"));
 if(saved?.schema!=="MATCHCRAFT_STATSAPI_FINISHED_SCORES_V1"||
  saved?.scope!==15||!Array.isArray(saved?.matches)||
  typeof saved?.from!=="string"||!/^20\d{2}-\d{2}-\d{2}$/.test(saved.from)||
  !/^[a-f0-9]{64}$/i.test(saved.recordsSha256||"")||
  sha(JSON.stringify(saved.matches))!==saved.recordsSha256)
  throw Error("Previously saved result snapshot is malformed; refusing unsafe merge");
 previous=saved;
}catch(e){if(e.code!=="ENOENT")throw e;}
const dayAgo=n=>new Date(Date.now()-n*86400000).toISOString().slice(0,10);
// Recheck only the latest 48 hours to allow late confirmations/corrections.
// First run without a saved snapshot gets a single seven-day catchup.
const refreshFrom=backfill?"2026-08-01":dayAgo(previous?2:7);
const from=previous?.from&&previous.from<refreshFrom?previous.from:refreshFrom;
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
let requests=0;let quota=null;
async function get(path,params){
 const url=new URL(api+path);
 for(const [k,v]of Object.entries(params))url.searchParams.set(k,String(v));
 for(let attempt=0;attempt<4;attempt++){
  const res=await fetch(url,{headers:{Authorization:"Bearer "+key,Accept:"application/json","User-Agent":"Matchcraft-Final-Results/1.0"},signal:AbortSignal.timeout(30000)});
  requests++;
  quota=res.headers.get("X-Monthly-Quota-Remaining")||quota;
  if(res.status===429){
   const detail=await res.text();
   let code="";try{code=JSON.parse(detail)?.error?.code||""}catch{}
   if(code==="USAGE_LIMIT_EXCEEDED"||res.headers.get("X-Monthly-Quota-Remaining")==="0")
    throw Error("TheStatsAPI monthly quota exhausted — results collection paused, no retries");
   await pause((attempt+1)*10000);continue
  }
  if(!res.ok)throw Error("Results API "+res.status+" /football/matches");
  const data=await res.json();
  if(!Array.isArray(data?.data)||typeof data?.meta!=="object")throw Error("Invalid result response envelope");
  return data;
 }
 throw Error("Provider rate-limited beyond retries");
}
const results=[],checks=[];
for(const [league,id]of target){
 let page=1,totalPages=1,accepted=0,seen=new Set(),rawCount=0;
 do{
  const response=await get("/matches",{competition_id:id,status:"finished",date_from:refreshFrom,date_to:to,per_page:100,page});
  const reported=Number(response.meta.total_pages||1);
  if(!Number.isInteger(reported)||reported<1||reported>30)throw Error("Unsafe pagination for "+league);
  totalPages=reported;
  for(const m of response.data){
   rawCount++;
   if(String(m.competition_id)!==id)throw Error("Misrouted competition "+league);
   const event=String(m.utc_date||"");
   const when=new Date(event);
   if(!Number.isFinite(when.getTime()))continue;
   const day=event.slice(0,10);
   if(day<refreshFrom||day>to||String(m.status).toLowerCase()!=="finished")continue;
   if(when.getTime()>Date.now()-85*60*1000)continue; // don't publish too early
   const hg=m.score?.regulation?.home??m.score?.home,ag=m.score?.regulation?.away??m.score?.away;
   if(!Number.isInteger(hg)||!Number.isInteger(ag)||hg<0||ag<0||hg>35||ag>35)continue;
   const home=String(m.home_team?.name||"").trim(),away=String(m.away_team?.name||"").trim();
   const matchId=String(m.id||"").trim();
   if(!home||!away||home===away||!/^mt_[a-z0-9]+$/i.test(matchId))continue;
   if(seen.has(matchId))continue;seen.add(matchId);
   results.push({matchId,league,competitionId:id,date:day,utcDate:event,home,away,homeGoals:hg,awayGoals:ag,status:"FINAL",scoreSource:"TheStatsAPI verified finished score"});
   accepted++;
  }
  page++;
  if(page>totalPages)break;
  await pause(150);
 }while(page<=totalPages);
 checks.push({league,competitionId:id,pages:totalPages,rawCount,accepted});
 console.log(league,accepted,"verified finals; pages",totalPages);
}
// Append new full-time scores to the cached, cryptographically verified
// season history. Previously verified matches are not re-fetched again
// outside the 48-hour safety window. Any corrected/conflicting scores
// require manual review and MUST NOT overwrite the last verified score.
const unique=new Map((previous?.matches||[]).map(m=>[m.matchId,m]));
const conflicts=[];
for(const m of results){
 const old=unique.get(m.matchId);
 if(old&&(old.homeGoals!==m.homeGoals||old.awayGoals!==m.awayGoals)){
  conflicts.push(m.matchId);continue;
 }
 unique.set(m.matchId,m);
}
const matches=[...unique.values()].sort((a,b)=>a.utcDate.localeCompare(b.utcDate)||a.matchId.localeCompare(b.matchId));
if(matches.length===0)throw Error("No valid completed matches; don't overwrite the last successful snapshot");
const generatedAt=new Date().toISOString();
const payload={schema:"MATCHCRAFT_STATSAPI_FINISHED_SCORES_V1",generatedAt,from,to,coverage:checks.map(c=>({
 ...c,accepted:matches.filter(m=>m.league===c.league).length
})),scope:target.length,
 matches,recordsSha256:sha(JSON.stringify(matches)),source:"TheStatsAPI /football/matches status=finished",
 refreshWindow:{from:refreshFrom,to,backfill},conflictingScoreIds:conflicts,
 note:"Provider-confirmed full-time scores retained across runs; only latest two days rechecked. No player/bookmaker settlement inferred."};
await mkdir("data/results",{recursive:true});
const json=JSON.stringify(payload);
await writeFile("data/results/latest.json",json+"\n");
await writeFile("data/results/"+to+".json",json+"\n");
console.log(JSON.stringify({state:conflicts.length?"PARTIAL_CONFLICTS_RETAINED":"COMPLETE",
 matches:matches.length,newlyFetched:results.length,retainedPrevious:previous?.matches.length||0,
 conflicted:conflicts.length,leagues:checks.length,requests,quota_remaining:quota,
 refreshFrom,date:to,backfill}));
