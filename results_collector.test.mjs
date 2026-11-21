import test from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,mkdir,copyFile,writeFile,readFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {spawnSync} from "node:child_process";
import {fileURLToPath} from "node:url";
import {createHash} from "node:crypto";
const source=fileURLToPath(new URL("./results_collector.mjs",import.meta.url));
const dayAgo=n=>new Date(Date.now()-n*86400000).toISOString().slice(0,10);
const digest=x=>createHash("sha256").update(JSON.stringify(x)).digest("hex");
const driver=`
const dayAgo=n=>new Date(Date.now()-n*86400000).toISOString().slice(0,10);
let called=0;
globalThis.fetch=async input=>{
 const u=new URL(String(input));called++;
 if(u.hostname!=="api.thestatsapi.com")throw Error("Paid-test network forbidden");
 if(process.env.TEST_QUOTA_LOCK==="1")return new Response(JSON.stringify({
  error:{code:"USAGE_LIMIT_EXCEEDED"}
 }),{status:429,headers:{"X-Monthly-Quota-Remaining":"0"}});
 const competition=u.searchParams.get("competition_id");
 const fake=n=>({id:"mt_"+competition.replace(/[^a-z0-9]/ig,"").toLowerCase()+(n===6?"h":"r"),
   competition_id:competition,utc_date:dayAgo(n)+"T12:00:00Z",
   status:"finished",score:{home:n===6?3:1,away:0},
   home_team:{name:"Home "+competition},away_team:{name:"Away "+competition}});
 const from=u.searchParams.get("date_from"),to=u.searchParams.get("date_to");
 const matches=[fake(6),fake(1)].filter(x=>x.utc_date.slice(0,10)>=from&&x.utc_date.slice(0,10)<=to);
 return new Response(JSON.stringify({data:matches,meta:{total_pages:1}}),
  {status:200,headers:{"X-Monthly-Quota-Remaining":"90000"}});
};
process.on("exit",()=>console.log("OFFLINE_REQUESTS",called));
await import("./results_collector.mjs");
`;
test("keeps verified history, queries only new 48h, and fails fast when monthly limit exhausted",async()=>{
 const dir=await mkdtemp(join(tmpdir(),"matchcraft-results-offline-"));
 await mkdir(join(dir,"data","results"),{recursive:true});
 await copyFile(source,join(dir,"results_collector.mjs"));
 await writeFile(join(dir,"mock.mjs"),driver);
 const run=env=>spawnSync(process.execPath,["mock.mjs"],{
  cwd:dir,encoding:"utf8",timeout:20000,env:{
   ...process.env,STATS_API_KEY:"MOCK_ONLY_NEVER_USED_FOR_NETWORK",...env
  }
 });
 const first=run();
 assert.equal(first.status,0,first.stderr);
 const path=join(dir,"data","results","latest.json");
 const before=JSON.parse(await readFile(path,"utf8"));
 assert.equal(before.matches.length,30);
 assert.equal(before.recordsSha256,digest(before.matches));
 assert.equal(before.refreshWindow.from,dayAgo(7));
 const second=run();
 assert.equal(second.status,0,second.stderr);
 const after=JSON.parse(await readFile(path,"utf8"));
 assert.equal(after.matches.length,30,"no historical score is lost or duplicated");
 assert.equal(after.recordsSha256,before.recordsSha256);
 assert.equal(after.refreshWindow.from,dayAgo(2));
 assert.match(second.stdout,/"retainedPrevious":30/);
 assert.match(second.stdout,/"newlyFetched":15/);
 const hold=run({TEST_QUOTA_LOCK:"1"});
 assert.notEqual(hold.status,0);
 assert.match(hold.stderr,/monthly quota exhausted/i);
 assert.match(hold.stdout,/OFFLINE_REQUESTS 1/);
 assert.equal((await readFile(path,"utf8")).includes(after.recordsSha256),true,
   "failed provider response cannot overwrite last verified snapshot");
});
