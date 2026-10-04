/* NP backend — Cloudflare Pages Function (file: functions/api/[[path]].js)
   On-demand and cache-first. There is NO scheduled handler: with nobody using NP, nothing here runs and no
   sports-data request is made. Every external call is caused by a user request, goes through the cache first,
   and is shared by everyone who asks for the same thing.
   Services used: Pages Functions + the Cache API (always), and D1 as binding NP_DB (optional, for persistence).
   Secrets (optional): ODDS_API_KEY. Never sent to the browser. */
const NP_VERSION = 'np-backend-1.0';
/* shared with the browser build (extracted from index.html at build time) */
const NP_TZ = 'America/New_York';
const getLocalGameDate = t => new Intl.DateTimeFormat('en-CA', { timeZone:NP_TZ, year:'numeric', month:'2-digit', day:'2-digit' }).format(new Date(t));
const num = v => { if (v == null || v === '') return null; const s = String(v).trim(); if (/^(EVEN|PK|pick)/i.test(s)) return 0; const x = parseFloat(s.replace(/[^\d.+-]/g,'')); return isFinite(x) ? x : null; };
function parseTeam(c){
  const t = c.team || {};
  return { id:t.id, name:t.displayName || t.name, short:t.shortDisplayName || t.name || t.displayName, abbr:t.abbreviation || (t.shortDisplayName||'').slice(0,3).toUpperCase(), logo:t.logo || t.logos?.[0]?.href,
    color:/^[0-9a-f]{6}$/i.test(t.color || '') ? '#' + t.color : null, alt:/^[0-9a-f]{6}$/i.test(t.alternateColor || '') ? '#' + t.alternateColor : null,
    record:(c.records||[]).find(r=>r.type==='total' || r.name==='overall' || r.type==='ytd')?.summary || '', homeRec:(c.records||[]).find(r=>r.type==='home')?.summary || '', roadRec:(c.records||[]).find(r=>r.type==='road' || r.type==='away')?.summary || '', score:c.score, form:c.form || '' };
}
function parseEspnOdds(o, home, away){
  if (!o) return null;
  const out = { provider:o.provider?.name || 'ESPN BET', details:o.details || '' };
  let hs = num(o.pointSpread?.home?.close?.line ?? o.pointSpread?.home?.current?.line);
  if (hs == null && o.details){ const m = o.details.match(/^([A-Z]{2,5})\s*([+-]?\d+(\.\d+)?)/); if (m){ const v = parseFloat(m[2]); hs = (m[1]===home.abbr) ? v : -v; } else if (/EVEN|PK/i.test(o.details)) hs = 0; }
  out.homeSpread = hs; out.homeSpreadOpen = num(o.pointSpread?.home?.open?.line);
  out.homeSpreadPrice = num(o.homeTeamOdds?.spreadOdds ?? o.pointSpread?.home?.close?.odds);
  out.awaySpreadPrice = num(o.awayTeamOdds?.spreadOdds ?? o.pointSpread?.away?.close?.odds);
  out.homeML = num(o.homeTeamOdds?.moneyLine ?? o.moneyline?.home?.close?.odds); out.awayML = num(o.awayTeamOdds?.moneyLine ?? o.moneyline?.away?.close?.odds);
  out.homeMLOpen = num(o.moneyline?.home?.open?.odds); out.awayMLOpen = num(o.moneyline?.away?.open?.odds);
  out.drawML = num(o.drawOdds?.moneyLine ?? o.moneyline?.draw?.close?.odds);
  out.total = num(o.overUnder ?? o.total?.over?.close?.line); out.totalOpen = num(o.total?.over?.open?.line);
  out.overPrice = num(o.overOdds ?? o.total?.over?.close?.odds); out.underPrice = num(o.underOdds ?? o.total?.under?.close?.odds);
  return out;
}
function normalizeGameStatus(name, state){
  const n = String(name || '').toUpperCase(), s = String(state || '').toLowerCase();
  if (/POSTPONED/.test(n)) return 'postponed';
  if (/CANCEL/.test(n)) return 'cancelled';
  if (/SUSPENDED/.test(n)) return 'suspended';
  if (/FORFEIT/.test(n)) return 'final';
  if (/DELAY/.test(n)) return s === 'in' ? 'live' : 'delayed';
  if (/FINAL|FULL_TIME|END_OF_GAME/.test(n)) return 'final';
  if (/HALFTIME|IN_PROGRESS|END_PERIOD|FIRST_HALF|SECOND_HALF|OVERTIME|SHOOTOUT|END_OF_EXTRATIME|EXTRA_TIME|PENALTY/.test(n)) return 'live';
  return s === 'in' ? 'live' : s === 'post' ? 'final' : 'scheduled';
}
function validateGameRecord(g){
  const why = [];
  if (!g || !g.id) why.push('missing id');
  if (!g?.home?.id || !g?.away?.id || !g.home.name || !g.away.name) why.push('missing team');
  if (g?.home?.id && g.home.id === g.away?.id) why.push('same team twice');
  const t = new Date(g?.date).getTime(); if (!isFinite(t)) why.push('bad start time');
  for (const s of ['home','away']){ const v = g?.[s]?.score; if (v != null && v !== '' && !(+v >= 0 && +v < 400)) why.push('impossible score'); }
  return why;
}
const INTEGRITY = { rejected:[], dupes:[], conflicts:[], preserved:[] };
function deduplicateGames(list){
  const byId = new Map();
  for (const g of list){ if (!byId.has(g.id)) byId.set(g.id, g); }
  const out = [];
  for (const g of byId.values()){
    const dup = out.find(x => x.sport === g.sport && x.home.id === g.home.id && x.away.id === g.away.id && Math.abs(new Date(x.date) - new Date(g.date)) < 3*3600e3);
    if (!dup) out.push(g); else INTEGRITY.dupes.push({ kept:dup.id, dropped:g.id, sport:g.sport, at:Date.now() });
  }
  return out;
}
const OFFICIAL = {
  mlb:{ name:'MLB Stats API', url:d => `https://statsapi.mlb.com/api/v1/schedule?sportId=1&date=${d}`,
    games:j => (j.dates || []).flatMap(x => x.games || []).map(x => ({ id:String(x.gamePk), start:x.gameDate, home:x.teams?.home?.team?.name, away:x.teams?.away?.team?.name,
      hs:x.teams?.home?.score, as:x.teams?.away?.score, status: /postpon/i.test(x.status?.detailedState) ? 'postponed' : /cancel/i.test(x.status?.detailedState) ? 'cancelled' : /suspend/i.test(x.status?.detailedState) ? 'suspended' : x.status?.abstractGameState === 'Final' ? 'final' : x.status?.abstractGameState === 'Live' ? 'live' : 'scheduled' })) },
  nhl:{ name:'NHL web API', url:d => `https://api-web.nhle.com/v1/score/${d}`,
    games:j => (j.games || []).map(x => ({ id:String(x.id), start:x.startTimeUTC, home:`${x.homeTeam?.placeName?.default || ''} ${x.homeTeam?.name?.default || ''}`.trim(), homeShort:x.homeTeam?.name?.default, away:`${x.awayTeam?.placeName?.default || ''} ${x.awayTeam?.name?.default || ''}`.trim(), awayShort:x.awayTeam?.name?.default,
      hs:x.homeTeam?.score, as:x.awayTeam?.score, status: /FINAL|OFF/.test(x.gameState) ? 'final' : /LIVE|CRIT/.test(x.gameState) ? 'live' : /PPD/.test(x.gameScheduleState || '') ? 'postponed' : /CNCL/.test(x.gameScheduleState || '') ? 'cancelled' : 'scheduled' })) },
};
const brierOne = (p, o) => { const ks = Object.keys(p).filter(k => k !== 'threeWay'); return ks.reduce((t, k) => t + (p[k] - (k === o ? 1 : 0))**2, 0); };
const llOne = (p, o) => -Math.log(Math.max(1e-6, p[o] ?? 1e-6));
function evalMetrics(L = predLoad()){
  const games = L.filter(x => x.k === 'game'), picks = L.filter(x => x.k === 'pick');
  const both = games.filter(x => x.mkt);
  const avg = a => a.length ? a.reduce((t, v) => t + v, 0)/a.length : null;
  const out = { nGames:games.length, nPicks:picks.length,
    brier:avg(games.map(x => brierOne(x.wp, x.outcome))), logloss:avg(games.map(x => llOne(x.wp, x.outcome))),
    nBaseline:both.length, brierModelVsMkt:both.length ? avg(both.map(x => brierOne(x.wp, x.outcome))) : null, brierMkt:both.length ? avg(both.map(x => brierOne(x.mkt, x.outcome))) : null,
    llMkt:both.length ? avg(both.map(x => llOne(x.mkt, x.outcome))) : null,
    pickBrier:avg(picks.map(x => (x.p - x.hit)**2)), hitRate:avg(picks.map(x => x.hit)), meanP:avg(picks.map(x => x.p)), buckets:[] };
  for (let b = 0; b < 10; b++){ const lo = b/10, hi = (b + 1)/10, s = picks.filter(x => x.p >= lo && (x.p < hi || (b === 9 && x.p <= 1))); if (s.length) out.buckets.push({ lo, hi, n:s.length, meanP:avg(s.map(x => x.p)), hit:avg(s.map(x => x.hit)) }); }
  const priced = picks.filter(x => x.dec > 1); out.nPriced = priced.length;
  out.roi = priced.length ? priced.reduce((t, x) => t + (x.hit ? x.dec - 1 : -1), 0)/priced.length : null;
  return out;
}

/* ---------------- allow-list: the only upstream requests this backend will make ---------------- */
const SPORT_PATH = '(?:football/(?:nfl|college-football)|basketball/(?:nba|wnba|mens-college-basketball)|baseball/mlb|hockey/nhl|soccer/[a-z0-9._-]{2,24})';
const RULES = [
  { name:'ESPN scoreboard', provider:'espn', re:new RegExp(`^https://site\\.api\\.espn\\.com/apis/site/v2/sports/${SPORT_PATH}/scoreboard$`), q:['dates','limit'], ttl:scoreboardTtl },
  { name:'ESPN summary', provider:'espn', re:new RegExp(`^https://site\\.api\\.espn\\.com/apis/site/v2/sports/${SPORT_PATH}/summary$`), q:['event'], ttl:summaryTtl, persist:3650*864e5, persistFinal:true },
  { name:'ESPN roster', provider:'espn', re:new RegExp(`^https://site\\.api\\.espn\\.com/apis/site/v2/sports/${SPORT_PATH}/teams/\\d{1,6}/roster$`), q:[], ttl:() => 12*3600e3, persist:12*3600e3 },
  { name:'ESPN standings', provider:'espn', re:/^https:\/\/site\.api\.espn\.com\/apis\/v2\/sports\/soccer\/[a-z0-9._-]{2,24}\/standings$/, q:['season'], ttl:() => 6*3600e3, persist:6*3600e3 },
  { name:'ESPN game log', provider:'espn', re:new RegExp(`^https://site\\.web\\.api\\.espn\\.com/apis/common/v3/sports/${SPORT_PATH}/athletes/\\d{1,10}/gamelog$`), q:['season'], ttl:() => 6*3600e3, persist:6*3600e3 },
  { name:'ESPN odds', provider:'espn', re:/^https:\/\/sports\.core\.api\.espn\.com\/v2\/sports\/[a-z-]{3,20}\/leagues\/[a-z0-9._-]{2,30}\/events\/\d{1,12}\/competitions\/\d{1,12}\/odds(\/\d{1,6})?$/, q:['lang','region'], ttl:() => 120e3 },
  { name:'ESPN prop lines', provider:'espn', re:/^https:\/\/sports\.core\.api\.espn\.com\/v2\/sports\/[a-z-]{3,20}\/leagues\/[a-z0-9._-]{2,30}\/events\/\d{1,12}\/competitions\/\d{1,12}\/odds\/\d{1,6}\/propBets$/, q:['lang','region','limit','page'], ttl:() => 240e3 },
  { name:'Open-Meteo forecast', provider:'open-meteo', re:/^https:\/\/api\.open-meteo\.com\/v1\/forecast$/, q:['latitude','longitude','hourly','temperature_unit','wind_speed_unit','forecast_days','timezone'], ttl:() => 3600e3 },
  { name:'Open-Meteo geocoding', provider:'open-meteo', re:/^https:\/\/geocoding-api\.open-meteo\.com\/v1\/search$/, q:['name','count','language'], ttl:() => 30*864e5, persist:30*864e5 },
  { name:'MLB Stats API', provider:'mlb', re:/^https:\/\/statsapi\.mlb\.com\/api\/v1\/schedule$/, q:['sportId','date'], ttl:() => 60e3 },
  { name:'NHL web API', provider:'nhl', re:/^https:\/\/api-web\.nhle\.com\/v1\/score\/\d{4}-\d{2}-\d{2}$/, q:[], ttl:() => 60e3 },
  { name:'The Odds API events', provider:'odds-api', re:/^https:\/\/api\.the-odds-api\.com\/v4\/sports\/[a-z0-9_]{3,60}\/events$/, q:[], ttl:() => 30*60e3, secret:'ODDS_API_KEY' },
  { name:'The Odds API odds', provider:'odds-api', re:/^https:\/\/api\.the-odds-api\.com\/v4\/sports\/[a-z0-9_]{3,60}\/events\/[a-z0-9]{8,64}\/odds$/, q:['bookmakers','markets','oddsFormat'], ttl:() => 5*60e3, secret:'ODDS_API_KEY' },
];
function ruleFor(raw){
  let u; try { u = new URL(raw); } catch(e){ return null; }
  if (u.protocol !== 'https:') return null;
  const base = u.origin + u.pathname, rule = RULES.find(r => r.re.test(base)); if (!rule) return null;
  const qs = new URLSearchParams(); for (const k of [...u.searchParams.keys()].sort()) if (rule.q.includes(k)){ const v = u.searchParams.get(k); if (v.length <= 400) qs.set(k, v); }
  const clean = base + (String(qs) ? '?' + qs : '');
  return { rule, url:clean };
}
/* freshness: the server decides, not the browser */
function scoreboardTtl(body){
  const ev = body?.events || [], now = Date.now();
  if (ev.some(e => (e.status || e.competitions?.[0]?.status)?.type?.state === 'in')) return 20e3;
  if (ev.some(e => { const t = Date.parse(e.date); return t - now < 30*60e3 && t - now > -4*3600e3 && (e.status?.type?.state || 'pre') === 'pre'; })) return 60e3;
  return 5*60e3;
}
function summaryTtl(body){
  const st = body?.header?.competitions?.[0]?.status?.type;
  if (st?.state === 'in') return 15e3;
  if (st?.state === 'post' && /FINAL|FULL_TIME/i.test(st?.name || '')) return 30*864e5;   // a final box score never changes
  return 3*60e3;
}
/* trim what NP never uses before it leaves the server */
const TRIM = ['videos','article','ticketsInfo','meta','broadcasts','standings','wallclockAvailable','espnHomeRun'];
function trim(body){ if (body && typeof body === 'object' && !Array.isArray(body)) for (const k of TRIM) delete body[k]; return body; }
/* basic validation: a response that fails it never replaces good data */
function validate(rule, body){
  if (!body || typeof body !== 'object') return 'not JSON';
  if (/scoreboard/.test(rule.name) && !Array.isArray(body.events)) return 'scoreboard without events';
  if (rule.name === 'ESPN summary' && !body.header) return 'summary without header';
  return null;
}

/* ---------------- per-provider protection: backoff, retry limits, daily caps ---------------- */
const MEM = { inflight:new Map(), cool:{}, calls:{} };
const CAPS = { 'odds-api':50 };   // per UTC day, protects the paid/credit provider; free providers rely on caching
const day = () => new Date().toISOString().slice(0, 10);
function cooling(p){ const c = MEM.cool[p]; return c && c.until > Date.now() ? c : null; }
function coolDown(p, retryAfterSec){ const c = MEM.cool[p] || { n:0 }; c.n = Math.min(c.n + 1, 6); const ms = retryAfterSec ? retryAfterSec*1000 : 15e3 * 2 ** (c.n - 1); c.until = Date.now() + Math.min(ms, 15*60e3); MEM.cool[p] = c; return c; }
async function countCall(env, p, ok){
  const k = p + '|' + day(); MEM.calls[k] = (MEM.calls[k] || 0) + 1;
  if (env.NP_DB) try { await env.NP_DB.prepare(`INSERT INTO provider_stats (provider, day, calls, errors) VALUES (?1, ?2, 1, ?3) ON CONFLICT(provider, day) DO UPDATE SET calls = calls + 1, errors = errors + ?3`).bind(p, day(), ok ? 0 : 1).run(); } catch(e){}
}
async function callsToday(env, p){
  if (env.NP_DB) try { const r = await env.NP_DB.prepare('SELECT calls FROM provider_stats WHERE provider = ?1 AND day = ?2').bind(p, day()).first(); return r?.calls || 0; } catch(e){}
  return MEM.calls[p + '|' + day()] || 0;
}
async function upstream(env, rule, url){
  const p = rule.provider, c = cooling(p);
  if (c) throw Object.assign(new Error(`${p} is cooling down after errors`), { status:503, retryAt:c.until });
  if (CAPS[p] && await callsToday(env, p) >= (+env.ODDS_DAILY_CAP || CAPS[p])) throw Object.assign(new Error(`${p} daily request cap reached`), { status:429 });
  let target = url;
  if (rule.secret){ const key = env[rule.secret]; if (!key) throw Object.assign(new Error('not configured'), { status:404 }); target += (target.includes('?') ? '&' : '?') + 'apiKey=' + encodeURIComponent(key); }
  let last;
  for (let a = 0; a < 2; a++){
    try {
      const r = await fetch(target, { headers:{ 'accept':'application/json', 'user-agent':'NP/1.0' }, cf:{ cacheTtl:0 } });
      if (r.status === 429){ const ra = +r.headers.get('retry-after') || 0; coolDown(p, ra); await countCall(env, p, false); throw Object.assign(new Error('rate limited by ' + p), { status:429 }); }
      if (r.status >= 500){ last = Object.assign(new Error(`${p} HTTP ${r.status}`), { status:502 }); await countCall(env, p, false); if (a === 0){ await new Promise(s => setTimeout(s, 400)); continue; } coolDown(p); throw last; }
      if (!r.ok){ await countCall(env, p, false); throw Object.assign(new Error(`${p} HTTP ${r.status}`), { status:r.status === 404 ? 404 : 502 }); }
      const body = await r.json(); await countCall(env, p, true); if (MEM.cool[p]) MEM.cool[p].n = 0;
      return { body, remaining:r.headers.get('x-requests-remaining') };
    } catch(e){ last = e; if (e.status) throw e; if (a === 0) continue; }
  }
  coolDown(p); throw Object.assign(last || new Error('upstream failed'), { status:502 });
}

/* ---------------- cache: Cache API (edge, all visitors) + D1 last-good copy ---------------- */
/* Three cache layers, fastest first: this server instance's memory → Cloudflare's edge cache (custom domains only;
   on *.workers.dev it is a no-op) → the D1 database (shared by every instance). */
const cacheKey = url => new Request('https://np-cache.internal/v1?u=' + encodeURIComponent(url));
const L0 = new Map();
const CENV = { db:null };
export function resetMemoryCache(){ L0.clear(); }   // used by the offline test harness to simulate a cold instance
async function cacheGet(url){
  const m = L0.get(url); if (m) return m;
  try { const r = await caches.default.match(cacheKey(url)); if (r) return { body:await r.json(), at:+r.headers.get('x-np-at'), ttl:+r.headers.get('x-np-ttl') }; } catch(e){}
  if (CENV.db) try { const r = await CENV.db.prepare('SELECT body, fetched_at, ttl_ms FROM cache WHERE key = ?1').bind(url).first(); if (r){ const v = { body:JSON.parse(r.body), at:r.fetched_at, ttl:r.ttl_ms }; L0.set(url, v); return v; } } catch(e){}
  return null;
}
async function cachePut(url, body, at, ttl){
  L0.set(url, { body, at, ttl }); if (L0.size > 400) L0.delete(L0.keys().next().value);
  try { await caches.default.put(cacheKey(url), new Response(JSON.stringify(body), { headers:{ 'content-type':'application/json', 'cache-control':`max-age=${Math.max(60, Math.ceil(ttl/1000) * 20)}`, 'x-np-at':String(at), 'x-np-ttl':String(ttl) } })); } catch(e){}
  if (CENV.db) try { const s = JSON.stringify(body); if (s.length < 900000) await CENV.db.prepare('INSERT INTO cache (key, fetched_at, ttl_ms, body) VALUES (?1,?2,?3,?4) ON CONFLICT(key) DO UPDATE SET fetched_at=?2, ttl_ms=?3, body=?4').bind(url, at, ttl, s).run(); } catch(e){}
}
async function lastGood(env, key){ if (!env.NP_DB) return null; try { const r = await env.NP_DB.prepare('SELECT body, fetched_at, ttl_ms FROM datasets WHERE key = ?1 AND valid = 1').bind(key).first(); return r ? { body:JSON.parse(r.body), at:r.fetched_at, ttl:r.ttl_ms } : null; } catch(e){ return null; } }
async function saveGood(env, key, type, meta, body, at, ttl){
  if (!env.NP_DB) return; const s = JSON.stringify(body); if (s.length > 900000) return;
  try { await env.NP_DB.prepare(`INSERT INTO datasets (key, type, sport, league, date, source, fetched_at, ttl_ms, valid, body) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,1,?9)
    ON CONFLICT(key) DO UPDATE SET fetched_at = ?7, ttl_ms = ?8, valid = 1, body = ?9, source = ?6`).bind(key, type, meta.sport || null, meta.league || null, meta.date || null, meta.source || null, at, ttl, s).run(); } catch(e){}
}
/* One function every route goes through: cache → (coalesced) upstream → validate → store → return.
   Failure never becomes "no data": the last valid copy is returned and marked stale. */
async function getData(env, ctx, key, type, meta, ttlOf, load, opts = {}){
  const now = Date.now();
  let hit = await cacheGet(key);
  if (!hit && opts.persist){ const lg = await lastGood(env, key); if (lg && now - lg.at < opts.persist) hit = lg; else if (lg) hit = { ...lg, old:true }; }
  if (hit && !hit.old && now - hit.at < Math.min(hit.ttl, opts.persist || Infinity)) return { body:hit.body, at:hit.at, cache:'HIT' };
  if (!MEM.inflight.has(key)){
    MEM.inflight.set(key, (async () => {
      const got = await load();
      const err = opts.validate ? opts.validate(got.body, hit?.body) : null;
      if (err) throw Object.assign(new Error('invalid response: ' + err), { status:502, invalid:true });
      const at = Date.now(), ttl = ttlOf(got.body);
      ctx.waitUntil(cachePut(key, got.body, at, ttl));
      if (opts.persistIf ? opts.persistIf(got.body) : opts.persist) ctx.waitUntil(saveGood(env, key, type, meta, got.body, at, ttl));
      if (opts.after) ctx.waitUntil(opts.after(got.body));
      return { body:got.body, at, remaining:got.remaining };
    })().finally(() => MEM.inflight.delete(key)));
  }
  try { const r = await MEM.inflight.get(key); return { ...r, cache:'MISS' }; }
  catch(e){
    const fallback = hit || await lastGood(env, key);
    if (fallback) return { body:fallback.body, at:fallback.at, cache:'STALE', error:e.message };
    throw e;
  }
}

/* ---------------- normalized slate (canonical games, validated, cross-checked) ---------------- */
const SITE = 'https://site.api.espn.com/apis/site/v2/sports/';
const SPORT_SITE = { nfl:'football/nfl', nba:'basketball/nba', mlb:'baseball/mlb', nhl:'hockey/nhl' };
const SOCCER_NAMES = { 'eng.1':'Premier League', 'esp.1':'La Liga', 'ger.1':'Bundesliga', 'ita.1':'Serie A', 'fra.1':'Ligue 1', 'usa.1':'MLS', 'uefa.champions':'Champions League', 'uefa.europa':'Europa League',
  'fifa.worldq.uefa':'World Cup Qualifying · UEFA', 'fifa.worldq.conmebol':'World Cup Qualifying · CONMEBOL', 'fifa.worldq.concacaf':'World Cup Qualifying · CONCACAF', 'fifa.worldq.afc':'World Cup Qualifying · AFC', 'fifa.worldq.caf':'World Cup Qualifying · CAF',
  'uefa.nations':'UEFA Nations League', 'concacaf.nations.league':'CONCACAF Nations League', 'fifa.friendly':'International Friendly', 'uefa.euro':'European Championship', 'conmebol.america':'Copa América' };
const ymdET = t => getLocalGameDate(t).replace(/-/g, '');
function parseEvents(j, sport, lg, lgName){
  const out = [];
  for (const ev of j.events || []){ const c = ev.competitions?.[0]; if (!c) continue;
    const hc = c.competitors?.find(x => x.homeAway === 'home'), ac = c.competitors?.find(x => x.homeAway === 'away'); if (!hc || !ac) continue;
    const home = parseTeam(hc), away = parseTeam(ac), st = ev.status || c.status || {};
    const logo = String(j.leagues?.[0]?.logos?.[0]?.href || '').replace(/^http:/, 'https:');
    out.push({ id:ev.id, sport, league:lg || null, leagueName:lgName || j.leagues?.[0]?.name || '', leagueLogo:/^https:\/\/a\.espncdn\.com\//.test(logo) ? logo : null, date:ev.date, name:ev.name, short:ev.shortName,
      state:st.type?.state, status:normalizeGameStatus(st.type?.name, st.type?.state), statusName:st.type?.name || '', statusText:st.type?.shortDetail || '', clock:st.displayClock, period:st.period,
      venue:c.venue ? { name:c.venue.fullName, city:c.venue.address?.city, state:c.venue.address?.state, country:c.venue.address?.country, indoor:!!c.venue.indoor } : null,
      broadcast:(c.broadcasts || []).flatMap(b => b.names || []).join(', '), home, away, espnOdds:parseEspnOdds(c.odds?.[0], home, away) }); }
  return out;
}
const normN = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[.'’]/g, '').replace(/\s+/g, ' ').trim();
async function crossCheck(env, ctx, sport, games, log){
  const O = OFFICIAL[sport]; if (!O || !games.length) return;
  const dates = [...new Set(games.map(g => getLocalGameDate(g.date)))].slice(0, 2);
  let off = [];
  for (const d of dates){ const url = O.url(d), m = ruleFor(url); if (!m) continue;
    try { const r = await getData(env, ctx, m.url, 'official', { sport, date:d, source:O.name }, m.rule.ttl, () => upstream(env, m.rule, m.url)); off.push(...O.games(r.body)); } catch(e){ return; } }
  for (const g of games){
    const mm = off.filter(o => (normN(o.home) === normN(g.home.name) || (o.homeShort && normN(o.homeShort) === normN(g.home.short))) && (normN(o.away) === normN(g.away.name) || (o.awayShort && normN(o.awayShort) === normN(g.away.short))))
      .sort((a, b) => Math.abs(Date.parse(a.start) - Date.parse(g.date)) - Math.abs(Date.parse(b.start) - Date.parse(g.date)))[0];
    if (!mm) continue; g.officialId = mm.id; g.verified = O.name;
    if (mm.status !== g.status && ['final','postponed','cancelled','suspended'].includes(mm.status)){ log.push({ gid:g.id, field:'status', espn:g.status, official:mm.status, source:O.name }); g.status = mm.status; if (mm.status !== 'suspended') g.state = 'post'; }
    if (mm.status === 'final' && g.status === 'final' && mm.hs != null && (+mm.hs !== +g.home.score || +mm.as !== +g.away.score)){ log.push({ gid:g.id, field:'final score', espn:`${g.away.score}-${g.home.score}`, official:`${mm.as}-${mm.hs}`, source:O.name }); g.home.score = String(mm.hs); g.away.score = String(mm.as); }
  }
}
async function slate(env, ctx, sport, league, days){
  days = Math.max(1, Math.min(15, days | 0 || 1));
  const lg = sport === 'soccer' ? String(league || 'eng.1') : null;
  if (sport === 'soccer' && !/^[a-z0-9._-]{2,24}$/.test(lg)) throw Object.assign(new Error('bad league'), { status:400 });
  if (sport !== 'soccer' && !SPORT_SITE[sport]) throw Object.assign(new Error('unknown sport'), { status:400 });
  const path = sport === 'soccer' ? `soccer/${lg}` : SPORT_SITE[sport];
  const a = ymdET(Date.now()), b = ymdET(Date.now() + (days - 1)*864e5);
  const key = `slate:${sport}:${lg || ''}:${a}:${days}`;
  return getData(env, ctx, key, 'slate', { sport, league:lg, date:a, source:'ESPN' }, body => body.ttl, async () => {
    const urls = days > 1 ? [`${SITE}${path}/scoreboard?dates=${a}-${b}&limit=300`] : [`${SITE}${path}/scoreboard?dates=${a}`, `${SITE}${path}/scoreboard`];
    let games = [], ok = 0, ttl = 5*60e3, err = null;
    for (const u of urls){ const m = ruleFor(u); try { const r = await getData(env, ctx, m.url, 'raw', { sport }, m.rule.ttl, () => upstream(env, m.rule, m.url)); ok++; ttl = Math.min(ttl, scoreboardTtl(r.body)); games.push(...parseEvents(r.body, sport, lg, lg ? SOCCER_NAMES[lg] : '')); } catch(e){ err = e; } }
    if (!ok) throw err || new Error('ESPN unavailable');
    const rejected = [];
    games = games.filter(g => { const why = validateGameRecord(g); if (why.length) rejected.push({ id:g.id, why:why.join(', ') }); return !why.length; });
    games = deduplicateGames(games); INTEGRITY.dupes.length = 0; games = games.sort((x, y) => Date.parse(x.date) - Date.parse(y.date));
    for (const g of games) g.localDate = getLocalGameDate(g.date);
    const conflicts = []; await crossCheck(env, ctx, sport, games, conflicts);
    return { body:{ games, rejected, conflicts, ttl, source:'ESPN', sport, league:lg, from:a, days } };
  }, { validate:(body, prev) => {
      // an empty slate is accepted only if the previous one had nothing still to play today
      if (!body.games.length && prev?.games?.some(g => g.status !== 'final' && g.localDate >= getLocalGameDate(Date.now()))) return 'empty slate while games were scheduled';
      return null; },
    persist:30*60e3, after:body => storeGames(env, body.games) });
}
/* ---------------- persistence: games, teams, predictions (D1) ---------------- */
const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS datasets (key TEXT PRIMARY KEY, type TEXT, sport TEXT, league TEXT, date TEXT, source TEXT, fetched_at INTEGER, ttl_ms INTEGER, valid INTEGER, body TEXT)`,
  `CREATE TABLE IF NOT EXISTS games (id TEXT PRIMARY KEY, sport TEXT, league TEXT, start TEXT, local_date TEXT, status TEXT, home_id TEXT, away_id TEXT, home TEXT, away TEXT, home_score TEXT, away_score TEXT, source TEXT, verified TEXT, updated_at INTEGER)`,
  `CREATE TABLE IF NOT EXISTS teams (key TEXT PRIMARY KEY, sport TEXT, id TEXT, name TEXT, abbr TEXT, color TEXT, alt_color TEXT, logo TEXT, updated_at INTEGER)`,
  `CREATE TABLE IF NOT EXISTS predictions (gid TEXT, model TEXT, made_at INTEGER, start TEXT, sport TEXT, wp TEXT, mkt TEXT, feats TEXT, picks TEXT, outcome TEXT, graded_at INTEGER, PRIMARY KEY (gid, model))`,
  `CREATE TABLE IF NOT EXISTS cache (key TEXT PRIMARY KEY, fetched_at INTEGER, ttl_ms INTEGER, body TEXT)`,
  `CREATE TABLE IF NOT EXISTS provider_stats (provider TEXT, day TEXT, calls INTEGER, errors INTEGER, PRIMARY KEY (provider, day))`,
];
let schemaReady = false;
async function ensureSchema(env){ if (!env.NP_DB || schemaReady) return; try { await env.NP_DB.batch(SCHEMA.map(s => env.NP_DB.prepare(s))); schemaReady = true; } catch(e){} }
async function storeGames(env, games){
  if (!env.NP_DB || !games.length) return; const now = Date.now(), st = [];
  for (const g of games){
    st.push(env.NP_DB.prepare(`INSERT INTO games (id, sport, league, start, local_date, status, home_id, away_id, home, away, home_score, away_score, source, verified, updated_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15)
      ON CONFLICT(id) DO UPDATE SET start=?4, local_date=?5, status=?6, home_score=?11, away_score=?12, verified=?14, updated_at=?15`).bind(g.id, g.sport, g.league, g.date, g.localDate, g.status, g.home.id, g.away.id, g.home.name, g.away.name, g.home.score ?? null, g.away.score ?? null, 'ESPN', g.verified || null, now));
    for (const t of [g.home, g.away]) st.push(env.NP_DB.prepare(`INSERT INTO teams (key, sport, id, name, abbr, color, alt_color, logo, updated_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9) ON CONFLICT(key) DO UPDATE SET name=?4, abbr=?5, color=?6, alt_color=?7, logo=?8, updated_at=?9`)
      .bind(g.sport + ':' + t.id, g.sport, t.id, t.name, t.abbr, t.color || null, t.alt || null, t.logo || null, now));
    // grade from the server's own final score: the browser can't set outcomes
    if (g.status === 'final' && g.home.score !== '' && g.home.score != null){ const hs = +g.home.score, as = +g.away.score; if (isFinite(hs) && isFinite(as))
      st.push(env.NP_DB.prepare(`UPDATE predictions SET outcome = ?2, graded_at = ?3 WHERE gid = ?1 AND outcome IS NULL`).bind(g.id, hs > as ? 'home' : hs < as ? 'away' : 'draw', now)); }
    if (g.status === 'postponed' || g.status === 'cancelled') st.push(env.NP_DB.prepare(`UPDATE predictions SET outcome = 'void', graded_at = ?2 WHERE gid = ?1 AND outcome IS NULL`).bind(g.id, now));
  }
  try { for (let i = 0; i < st.length; i += 50) await env.NP_DB.batch(st.slice(i, i + 50)); } catch(e){}
}
const okProb = p => p && typeof p === 'object' && ['home','away'].every(k => typeof p[k] === 'number' && p[k] >= 0 && p[k] <= 1) && (p.draw == null || (typeof p.draw === 'number' && p.draw >= 0 && p.draw <= 1)) && Math.abs(p.home + p.away + (p.draw || 0) - 1) < 0.02;
async function savePrediction(env, req){
  if (!env.NP_DB) throw Object.assign(new Error('storage not configured'), { status:501 });
  const txt = await req.text(); if (txt.length > 20000) throw Object.assign(new Error('too large'), { status:413 });
  let b; try { b = JSON.parse(txt); } catch(e){ throw Object.assign(new Error('bad JSON'), { status:400 }); }
  if (!/^[0-9A-Za-z]{1,20}$/.test(String(b.gid)) || !/^np-[0-9.]{1,10}$/.test(String(b.model))) throw Object.assign(new Error('bad ids'), { status:400 });
  if (!okProb(b.wp) || (b.mkt != null && !okProb(b.mkt))) throw Object.assign(new Error('probabilities must be 0–1 and sum to 1'), { status:422 });
  // only the server's own schedule decides whether the game has started
  const g = await env.NP_DB.prepare('SELECT start, status, sport FROM games WHERE id = ?1').bind(String(b.gid)).first();
  if (!g) throw Object.assign(new Error('unknown game'), { status:404 });
  if (g.status !== 'scheduled' && g.status !== 'delayed' || Date.parse(g.start) <= Date.now()) throw Object.assign(new Error('game has started; predictions are frozen'), { status:409 });
  const picks = Array.isArray(b.picks) ? b.picks.slice(0, 20).filter(x => x && typeof x.p === 'number' && x.p > 0 && x.p < 1).map(x => ({ id:String(x.id).slice(0, 120), label:String(x.label || '').slice(0, 120), p:x.p, dec:typeof x.dec === 'number' && x.dec > 1 && x.dec < 100 ? x.dec : null })) : [];
  await env.NP_DB.prepare(`INSERT INTO predictions (gid, model, made_at, start, sport, wp, mkt, feats, picks) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)
    ON CONFLICT(gid, model) DO UPDATE SET made_at=?3, wp=?6, mkt=?7, feats=?8, picks=?9 WHERE outcome IS NULL`).bind(String(b.gid), b.model, Date.now(), g.start, g.sport, JSON.stringify(b.wp), b.mkt ? JSON.stringify(b.mkt) : null, JSON.stringify(b.feats || null).slice(0, 2000), JSON.stringify(picks)).run();
  return { saved:true };
}
async function metrics(env){
  if (!env.NP_DB) return { configured:false };
  const rows = (await env.NP_DB.prepare(`SELECT gid, sport, model, wp, mkt, outcome FROM predictions WHERE outcome IS NOT NULL AND outcome != 'void' ORDER BY graded_at DESC LIMIT 5000`).all()).results || [];
  const L = rows.map(r => ({ k:'game', gid:r.gid, sport:r.sport, model:r.model, wp:JSON.parse(r.wp), mkt:r.mkt ? JSON.parse(r.mkt) : null, outcome:r.outcome })).filter(x => x.outcome !== 'draw' || x.wp.draw != null);
  const pending = (await env.NP_DB.prepare(`SELECT COUNT(*) AS n FROM predictions WHERE outcome IS NULL`).first())?.n || 0;
  return { configured:true, pending, ...evalMetrics(L) };
}

/* ---------------- router ---------------- */
const json = (data, status = 200, extra = {}) => new Response(JSON.stringify(data), { status, headers:{ 'content-type':'application/json; charset=utf-8', 'cache-control':'no-store', 'x-content-type-options':'nosniff', ...extra } });
export async function onRequest(ctx){
  const { request:req, env } = ctx, u = new URL(req.url), path = u.pathname.replace(/^\/api\/?/, ''); CENV.db = env.NP_DB || null;
  try {
    await ensureSchema(env);
    if (env.NP_DB && Math.random() < 0.02) ctx.waitUntil(env.NP_DB.prepare('DELETE FROM cache WHERE fetched_at < ?1').bind(Date.now() - 3*864e5).run().catch(() => {}));   // tidy old cache rows now and then
    if (req.method === 'GET' && path === 'health'){
      const stats = env.NP_DB ? ((await env.NP_DB.prepare('SELECT provider, calls, errors FROM provider_stats WHERE day = ?1').bind(day()).all()).results || []) : Object.entries(MEM.calls).filter(([k]) => k.endsWith(day())).map(([k, v]) => ({ provider:k.split('|')[0], calls:v }));
      return json({ np:true, version:NP_VERSION, storage:!!env.NP_DB, odds:!!env.ODDS_API_KEY, scheduled_jobs:0, today:day(), upstream_calls_today:stats, cooling:Object.fromEntries(Object.entries(MEM.cool).filter(([, c]) => c.until > Date.now()).map(([p, c]) => [p, new Date(c.until).toISOString()])) });
    }
    if (req.method === 'GET' && path === 'slate'){
      const r = await slate(env, ctx, String(u.searchParams.get('sport') || ''), u.searchParams.get('league'), +u.searchParams.get('days') || 1);
      return json({ ...r.body, fetchedAt:r.at, cache:r.cache, stale:r.cache === 'STALE', error:r.error || null });
    }
    if (req.method === 'GET' && path === 'x'){
      const m = ruleFor(u.searchParams.get('u') || ''); if (!m) return json({ error:'not an allowed source' }, 403);
      const r = await getData(env, ctx, m.url, 'raw', { source:m.rule.name }, m.rule.ttl, () => upstream(env, m.rule, m.url).then(x => ({ ...x, body:trim(x.body) })),
        { validate:b => validate(m.rule, b), persist:m.rule.persist, persistIf:m.rule.persistFinal ? (b => summaryTtl(b) >= 864e5) : null });
      return json(r.body, 200, { 'x-np-cache':r.cache, 'x-np-fetched-at':String(r.at), ...(r.cache === 'STALE' ? { 'x-np-stale':'1' } : {}), ...(r.remaining != null ? { 'x-requests-remaining':String(r.remaining) } : {}) });
    }
    if (req.method === 'POST' && path === 'predictions') return json(await savePrediction(env, req));
    if (req.method === 'GET' && path === 'metrics') return json(await metrics(env));
    return json({ error:'not found' }, 404);
  } catch(e){
    return json({ error:String(e.message || 'error').slice(0, 200), retryAt:e.retryAt || null }, e.status || 500);
  }
}
