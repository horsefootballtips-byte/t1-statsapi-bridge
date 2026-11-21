// Matchcraft final-score collector. Only trusted TheStatsAPI "finished" matches.
 // Uses existing GitHub STATS_API_KEY secret; publishes no keys, bets or member data.
import {mkdir,writeFile} from "node:fs/promises";
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
const backfill=process.env.BACKFILL==="1";
const to=ukDate(),from=backfill?"2026-08-01":new Date(Date.now()-7*86400000).toISOString().slice(0,10);
const sha=s=>createHash("sha256").update(s).digest("hex");
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
let requests=0;let quota=null;
async function get(path,params){
 const url=new URL(api+path);
 for(const [k,v]of Object.entries(params))url.searchParams.set(k,String(v));
 for(let attempt=0;attempt<4;attempt++){
  const res=await fetch(url,{headers:{Authorization:"Bearer "+key,Accept:"application/json","User-Agent":"Matchcraft-Final-Results/1.0"},signal:AbortSignal.timeout(30000)});
  requests++;
  quota=res.headers.get("X-Monthly-Quota-Remaining")||quota;
  if(res.status===429){await pause((attempt+1)*10000);continue}
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
  const response=await get("/matches",{competition_id:id,status:"finished",date_from:from,date_to:to,per_page:100,page});
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
   if(day<from||day>to||String(m.status).toLowerCase()!=="finished")continue;
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
const unique=new Map();
for(const m of results){
 const old=unique.get(m.matchId);
 if(old && JSON.stringify(old)!==JSON.stringify(m))throw Error("Conflicting final score for "+m.matchId);
 unique.set(m.matchId,m);
}
const matches=[...unique.values()].sort((a,b)=>a.utcDate.localeCompare(b.utcDate)||a.matchId.localeCompare(b.matchId));
if(matches.length===0)throw Error("No valid completed matches; don't overwrite the last successful snapshot");
const generatedAt=new Date().toISOString();
const payload={schema:"MATCHCRAFT_STATSAPI_FINISHED_SCORES_V1",generatedAt,from,to,coverage:checks,scope:target.length,
 matches,recordsSha256:sha(JSON.stringify(matches)),source:"TheStatsAPI /football/matches status=finished",
 note:"Provider-confirmed 90-minute-old full-time scores for league fixtures, not player or bookmaker market results"};
await mkdir("data/results",{recursive:true});
const json=JSON.stringify(payload);
await writeFile("data/results/latest.json",json+"\n");
await writeFile("data/results/"+to+".json",json+"\n");
console.log(JSON.stringify({state:"COMPLETE",matches:matches.length,leagues:checks.length,requests,quota_remaining:quota,date:to,backfill}));
