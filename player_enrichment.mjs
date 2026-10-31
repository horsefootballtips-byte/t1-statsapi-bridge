
/**
 * Matchcraft player and match-stat enrichment for the owner's existing T5 collector.
 * No keys embedded. Receives the existing collector's authenticated api/fetchAll.
 * Prior-match observations only; never promote expected XI to confirmed.
 */
const asArray = x => Array.isArray(x) ? x : Array.isArray(x?.data) ? x.data : [];
const key = x => String(x ?? "").trim();
const playerId = p => key(p?.id ?? p?.player_id);
const ms = m => Date.parse(m?.utc_date ?? m?.date ?? m?.scheduled_at ?? m?.kickoff ?? "");
const sideName = (m,s) => String(m?.[s+"_team"]?.name ?? m?.[s+"_team_name"] ?? "");
const sideId = (m,s) => key(m?.[s+"_team"]?.id ?? m?.[s+"_team_id"]);
const safeDate = d => Number.isFinite(d) ? new Date(d).toISOString() : null;

export function isFavouriteMatch(match, favourite = ["Brentford"]) {
  const teams = [sideName(match,"home"), sideName(match,"away")].map(s=>s.trim().toLowerCase());
  return favourite.some(f=>teams.some(t=>t.includes(String(f).trim().toLowerCase())));
}

export function matchOpponents(match) {
  const home = {id:sideId(match,"home"),name:sideName(match,"home")};
  const away = {id:sideId(match,"away"),name:sideName(match,"away")};
  if(!home.id || !away.id || !home.name || !away.name)
    return {verified:false,home,away,reason:"Missing verified two-sided fixture identity"};
  return {verified:true,home,away};
}

/** Bound concurrency and add pacing; the StatsAPI Starter limit is 120/min. */
export async function limitedMap(items, fn, concurrency=2, minGapMs=750) {
  const values = new Array(items.length);
  let cursor=0, nextSlot=0;
  const take = async () => {
    while(cursor < items.length) {
      const i=cursor++;
      const now=Date.now(),slot=Math.max(now,nextSlot);
      nextSlot=slot+minGapMs;
      if(slot>now)await new Promise(resolve=>setTimeout(resolve,slot-now));
      try { values[i]=await fn(items[i],i); }
      catch(err){ values[i]={unavailable:true,reason:String(err?.message||err).slice(0,180)}; }
    }
  };
  await Promise.all(Array.from({length:Math.min(concurrency,items.length)},take));
  return values;
}

export function createPlayerCollector({api,fetchAll,diagnostics,cache=new Map()}) {
  const fetchOnce = async (id,run) => {
    if(cache.has(id)) return cache.get(id);
    // Cache in-flight promises so duplicate fixtures do not duplicate calls.
    const job=Promise.resolve().then(run).catch(err=>{
      diagnostics?.errors?.push({type:"PLAYER_ENRICHMENT",key:id,message:String(err?.message||err).slice(0,180)});
      return null;
    });
    cache.set(id,job);
    return job;
  };
  const historyBefore = (rows,kickoff) => rows
    .filter(x=>Number.isFinite(ms(x)) && ms(x)<kickoff && /finish|complete|^ft$/i.test(String(x.status??"finished")))
    .sort((a,b)=>ms(b)-ms(a)).slice(0,15);

  async function teamDataset(team,seasonId,history,kickoff) {
    const teamKey=key(team.id);
    // Collect EVERY listed player, including reserves and likely substitutes.
    const rawSquad=await fetchOnce("squad:"+teamKey,()=>fetchAll("/players",{team_id:teamKey}));
    const squad=asArray(rawSquad).filter(p=>playerId(p));
    const uniqueSquad=[...new Map(squad.map(p=>[playerId(p),p])).values()];
    const seasonStats = await limitedMap(uniqueSquad,async player=>{
      const id=playerId(player);
      const stats=seasonId ? await fetchOnce("player:"+id+":"+seasonId,()=>api("/players/"+encodeURIComponent(id)+"/stats",{season_id:seasonId},true)) : null;
      return {player_id:id,player_name:player.name??player.player_name??null,position:player.position??null,season_stats:stats?.data??stats??null};
    },2,750);
    // Never include the target match or later games in historical player data.
    const previous=historyBefore(history,kickoff);
    return {
      team_id:teamKey,team_name:team.name,
      squad_source:"TheStatsAPI /players?team_id={id}",squad:uniqueSquad,
      squad_count:uniqueSquad.length,season_stats:seasonStats,
      history_matches:previous.map(m=>({id:m.id,kickoff_utc:safeDate(ms(m)),home_team:sideName(m,"home"),away_team:sideName(m,"away")})),
      history_count:previous.length,
      coverage:{squad:uniqueSquad.length>0,season_stats:seasonStats.filter(s=>s?.season_stats).length}
    };
  }

  async function collectForFixture(match,homeHistory,awayHistory) {
    const fixture=matchOpponents(match);
    if(!fixture.verified)return {state:"UNRESOLVED",fixture,reason:fixture.reason};
    const kickoff=ms(match);
    if(!Number.isFinite(kickoff))return {state:"UNRESOLVED",fixture,reason:"Missing verified fixture kickoff"};
    const season=key(match.season_id??match.season?.id);
    // Match ID and both teams are established BEFORE requesting any player data.
    const teams=await Promise.all([
      teamDataset(fixture.home,season,homeHistory,kickoff),
      teamDataset(fixture.away,season,awayHistory,kickoff)
    ]);
    const priorIds=[...new Set([...historyBefore(homeHistory,kickoff),...historyBefore(awayHistory,kickoff)].map(x=>key(x.id)).filter(Boolean))];
    const recentPlayerStats=await limitedMap(priorIds,async id=>{
      const r=await fetchOnce("match-player:"+id,()=>api("/matches/"+encodeURIComponent(id)+"/player-stats",{},true));
      return {match_id:id,data:r?.data??r??null,source:"TheStatsAPI"};
    },2,750);
    // Confirmed lineups may not yet be available before kickoff. Null is NOT
    // evidence a player is absent; never make up a starting XI.
    const lineups=await fetchOnce("lineups:"+key(match.id),()=>api("/matches/"+encodeURIComponent(match.id)+"/lineups",{},true));
    const d=lineups?.data??lineups??null;
    const hasConfirmed=Boolean(d?.home?.starting_xi?.length===11 && d?.away?.starting_xi?.length===11);
    return {
      state:"COLLECTED",fixture,
      target_match_id:key(match.id),kickoff_utc:safeDate(kickoff),
      teams:{home:teams[0],away:teams[1]},
      historical_player_matches:recentPlayerStats,
      pre_match_lineup_state:hasConfirmed?"CONFIRMED":"NOT_YET_CONFIRMED",
      confirmed_lineups:hasConfirmed?d:null,
      potential_player_pool:"FULL_SQUAD_UNLESS_VERIFIED_OTHERWISE",
      sampled_before_kickoff:true,
      sources:["TheStatsAPI team squads","TheStatsAPI player season stats","TheStatsAPI historical match player stats","TheStatsAPI confirmed lineups"],
      coverage:{
        home_squad:teams[0].squad_count,away_squad:teams[1].squad_count,
        player_history_games:recentPlayerStats.filter(x=>x?.data).length,
        player_history_games_checked:priorIds.length,
        confirmed_lineup:hasConfirmed
      }
    };
  }
  return {collectForFixture};
}
