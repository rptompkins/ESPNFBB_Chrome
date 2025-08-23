// Prettier: printWidth 80
const MLB_BASE = "https://statsapi.mlb.com/api/v1";
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    try {
      if (msg.type === "fetchSplits") {
        const { espnId, fullName, teamAbbr, season } = msg.payload;
        console.log("BG fetchSplits", msg.payload);

        const mlbamId = await resolveMlbPersonId({
          espnId,
          fullName,
          teamAbbr
        });
        console.log("Resolved MLBAM ID", { mlbamId, fullName, teamAbbr });

        if (!mlbamId) {
          return sendResponse({ ok: false, error: "id_not_found" });
        }

        const [seasonSplits, careerSplits] = await Promise.all([
          getSeasonSplits(mlbamId, season),
          getCareerSplits(mlbamId)
        ]);

        console.log("Final splits data for", fullName, {
          mlbamId,
          seasonSplits,
          careerSplits
        });

        sendResponse({
          ok: true,
          data: { mlbamId, seasonSplits, careerSplits }
        });
      }
    } catch (e) {
      console.error("BG error", e);
      sendResponse({ ok: false, error: String(e) });
    }
  })();
  return true;
});

// ---------- ID resolution (name + team, cached, tolerant) ----------
async function resolveMlbPersonId({ espnId, fullName, teamAbbr }) {
  console.log(`Starting ID resolution for: "${fullName}", team: ${teamAbbr}, ESPN ID: ${espnId}`);
  
  if (espnId) {
    const mapped = await getCache(`map:espn:${espnId}`);
    if (mapped) {
      console.log(`Found cached ESPN mapping: ${espnId} -> ${mapped}`);
      return mapped;
    }
  }

  const cacheKey = `id:${fullName}|${teamAbbr || ""}`;
  const cached = await getCache(cacheKey);
  if (cached) {
    console.log(`Found cached ID for "${fullName}": ${cached}`);
    return cached;
  }

  // Try multiple search strategies
  const searchStrategies = [
    fullName,
    `${fullName.split(' ').pop()}, ${fullName.split(' ')[0]}`, // "Last, First" format
    fullName.split(' ').pop(), // Just last name
    fullName.split(' ')[0]     // Just first name
  ];

  let bestMatch = null;
  let bestScore = -1;

  for (const searchTerm of searchStrategies) {
    console.log(`Trying search strategy: "${searchTerm}"`);
    
    const url = `${MLB_BASE}/people/search?name=${encodeURIComponent(searchTerm)}`;
    console.log("MLB search URL:", url);
    
    try {
      const res = await fetch(url);
      if (!res.ok) {
        console.log(`Search failed for "${searchTerm}": ${res.status}`);
        continue;
      }
      
      const json = await res.json();
      const people = Array.isArray(json?.people) ? json.people : [];
      console.log(`Found ${people.length} results for "${searchTerm}"`);
      
      if (people.length === 0) continue;

      const [targetFirst, targetLast] = splitName(stripSuffix(fullName));
      
      for (const person of people) {
        console.log(`Evaluating: ${person.fullName} (ID: ${person.id}) - Team: ${person.currentTeam?.abbreviation}`);
        
        const [pFirst, pLast] = splitName(stripSuffix(person.fullName || ""));
        let score = 0;

        // Exact name match gets highest priority
        if (normalizeName(person.fullName) === normalizeName(fullName)) {
          score += 20;
          console.log(`  +20 exact name match`);
        }

        // Last name match
        if (pLast && targetLast && normalizeName(pLast) === normalizeName(targetLast)) {
          score += 10;
          console.log(`  +10 last name match`);
        }

        // First name match
        if (pFirst && targetFirst && normalizeName(pFirst) === normalizeName(targetFirst)) {
          score += 8;
          console.log(`  +8 first name match`);
        }

        // Team match
        if (teamAbbr && person.currentTeam?.abbreviation?.toUpperCase() === teamAbbr.toUpperCase()) {
          score += 15; // High weight for team match
          console.log(`  +15 team match (${person.currentTeam.abbreviation})`);
        }

        // Active player bonus
        if (person.active) {
          score += 2;
          console.log(`  +2 active player`);
        }

        console.log(`  Final score: ${score}`);

        if (score > bestScore) {
          bestMatch = person;
          bestScore = score;
          console.log(`  NEW BEST MATCH: ${person.fullName} (${person.id}) with score ${score}`);
        }
      }
      
      // If we found a very good match (exact name + team), use it immediately
      if (bestScore >= 35) {
        console.log(`Found excellent match, stopping search: ${bestMatch.fullName} (${bestMatch.id})`);
        break;
      }
      
    } catch (error) {
      console.log(`Search error for "${searchTerm}":`, error);
    }
  }

  const finalId = bestMatch?.id || null;
  console.log(`Final resolution result: ${fullName} -> ${finalId} (${bestMatch?.fullName}) with score ${bestScore}`);

  if (finalId) {
    await setCache(cacheKey, finalId, ONE_DAY_MS);
    if (espnId) await setCache(`map:espn:${espnId}`, finalId, ONE_DAY_MS);
  }

  return finalId;
}

function stripSuffix(name) {
  return (name || "").replace(/\s+(jr\.|sr\.|ii|iii|iv|v)$/i, "").trim();
}
function splitName(name) {
  const norm = normalizeName(name);
  const parts = norm.split(" ").filter(Boolean);
  if (parts.length === 0) return ["", ""];
  if (parts.length === 1) return [parts[0], parts[0]];
  return [parts[0], parts[parts.length - 1]];
}
function normalizeName(s) {
  return (s || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// ---------- L/R splits via /stats?playerId= ----------
// This is documented/used in public StatsAPI docs and hackathon examples.
// It returns stats array with splits for the requested stat types.

async function getSeasonSplits(mlbamId, season) {
  const cacheKey = `splits:season:v3:${mlbamId}:${season}`;
  const cached = await getCache(cacheKey);
  if (cached) {
    console.log(`Using cached season data for ${mlbamId}:`, cached);
    return cached;
  }

  const url =
    `${MLB_BASE}/people/${mlbamId}/stats?stats=statSplits` +
    `&sitCodes=vl,vr&group=hitting&gameType=R&season=${season}`;
  console.log("Season stats URL:", url);

  const res = await fetch(url);
  if (!res.ok) throw new Error(`season_splits_failed ${res.status}`);
  const json = await res.json();

  const vsLeft = pickFromSplitsEndpoint(json, "vl");
  const vsRight = pickFromSplitsEndpoint(json, "vr");

  console.log(`Season splits for player ${mlbamId}:`, { vsLeft, vsRight });

  const normalized = { season, vsLeft, vsRight };
  await setCache(cacheKey, normalized, ONE_DAY_MS);
  return normalized;
}

async function getCareerSplits(mlbamId) {
  const cacheKey = `splits:career:v3:${mlbamId}`;
  const cached = await getCache(cacheKey);
  if (cached) {
    console.log(`Using cached career data for ${mlbamId}:`, cached);
    return cached;
  }

  // Try career in a single call (omit season).
  let url =
    `${MLB_BASE}/people/${mlbamId}/stats?stats=statSplits` +
    `&sitCodes=vl,vr&group=hitting&gameType=R`;
  console.log("Career stats URL:", url);

  let res = await fetch(url);
  if (!res.ok) throw new Error(`career_splits_failed ${res.status}`);
  let json = await res.json();

  let vsLeft = pickFromSplitsEndpoint(json, "vl");
  let vsRight = pickFromSplitsEndpoint(json, "vr");

  console.log(`Career splits for player ${mlbamId}:`, { vsLeft, vsRight });

  // If career returns empty for some players, aggregate per-season.
  if (!hasData(vsLeft) && !hasData(vsRight)) {
    console.log(`No career data found for ${mlbamId}, aggregating seasons...`);
    const agg = await aggregateCareerBySeasonViaStats(mlbamId);
    vsLeft = agg.vsLeft;
    vsRight = agg.vsRight;
    console.log(`Aggregated career splits for ${mlbamId}:`, { vsLeft, vsRight });
  }

  const career = { vsLeft, vsRight };
  await setCache(cacheKey, career, ONE_DAY_MS);
  return career;
}

// Fallback: sum per-season using the same /stats endpoint
async function aggregateCareerBySeasonViaStats(mlbamId) {
  const personRes = await fetch(`${MLB_BASE}/people/${mlbamId}`);
  if (!personRes.ok) throw new Error("person_fetch_failed");
  const person = await personRes.json();
  const debut = person?.people?.[0]?.mlbDebutDate?.slice(0, 4) || "2010";
  const currentYear = new Date().getFullYear();

  let aggL = initAgg();
  let aggR = initAgg();

  for (let y = Number(debut); y <= currentYear; y++) {
    const url =
      `${MLB_BASE}/people/${mlbamId}/stats?stats=statSplits` +
      `&sitCodes=vl,vr&group=hitting&gameType=R&season=${y}`;
    console.log("Season stats (career agg) URL:", url);

    const res = await fetch(url);
    if (!res.ok) continue;
    const j = await res.json();

    const L = pickFromSplitsEndpoint(j, "vl");
    const R = pickFromSplitsEndpoint(j, "vr");
    aggL = addAgg(aggL, L);
    aggR = addAgg(aggR, R);
  }

  return { vsLeft: finalizeAgg(aggL), vsRight: finalizeAgg(aggR) };
}

// Parse /people/{personId}/stats response for splits with sitCodes (vl/vr)
function pickFromSplitsEndpoint(json, sitCode) {
  console.log(`Parsing splits for sitCode: ${sitCode}`, json);
  
  const arr = Array.isArray(json?.stats) ? json.stats : [];
  // Look for statSplits entry
  const entry = arr.find((s) => {
    const t = (s?.type?.displayName || s?.type?.type || s?.type || "")
      .toString()
      .toLowerCase();
    return t === "statsplits";
  });

  if (!entry) {
    console.log(`No statSplits entry found for ${sitCode}`);
    return null;
  }

  const splits = Array.isArray(entry.splits) ? entry.splits : [];
  if (splits.length === 0) {
    console.log(`No splits data found for ${sitCode}`);
    return null;
  }

  console.log(`Found ${splits.length} splits for ${sitCode}:`, splits.map(s => ({code: s?.split?.code, avg: s?.stat?.avg})));

  // Find the split for our situation code (vl or vr) - should be exactly one match per player
  const targetSplit = splits.find(sp => sp?.split?.code?.toLowerCase() === sitCode.toLowerCase());
  
  if (!targetSplit) {
    console.log(`No match found for split code ${sitCode}`);
    return null;
  }

  console.log(`Match found for ${sitCode}:`, targetSplit.stat);
  const result = pickHitting(targetSplit.stat);
  console.log(`Final result for ${sitCode}:`, result);
  return result;
}

// Parse /stats response for a given type (vsLeft/vsRight) - legacy function
function pickFromStatsEndpoint(json, typeName) {
  const arr = Array.isArray(json?.stats) ? json.stats : [];
  // Find the entry for our stat type
  const entry =
    arr.find((s) => {
      const t =
        (s?.type?.displayName || s?.type?.type || s?.type || "")
          .toString()
          .toLowerCase();
      return t === typeName.toLowerCase();
    }) || null;

  const splits = Array.isArray(entry?.splits) ? entry.splits : [];
  if (splits.length === 0) return null;

  // Some players have multiple team splits; aggregate them.
  let agg = initAgg();
  for (const sp of splits) {
    agg = addAgg(agg, pickHitting(sp?.stat));
  }
  return finalizeAgg(agg);
}

// ---------- Stat helpers ----------
function hasData(s) {
  return s && (s.pa || s.ab || s.h || s.hr);
}
function pickHitting(stat) {
  if (!stat) return null;
  return {
    pa: num(stat.plateAppearances),
    ab: num(stat.atBats),
    h: num(stat.hits),
    hr: num(stat.homeRuns),
    bb: num(stat.baseOnBalls),
    avg: num(stat.avg),
    obp: num(stat.obp),
    slg: num(stat.slg),
    ops: num(stat.ops)
  };
}
function num(v) {
  if (v == null) return 0;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}
function initAgg() {
  return { pa: 0, ab: 0, h: 0, hr: 0, bb: 0, tb: 0 };
}
function addAgg(agg, s) {
  if (!s) return agg;
  return {
    pa: agg.pa + s.pa,
    ab: agg.ab + s.ab,
    h: agg.h + s.h,
    hr: agg.hr + s.hr,
    bb: agg.bb + s.bb,
    tb: agg.tb + Math.round((s.slg || 0) * (s.ab || 0))
  };
}
function finalizeAgg(a) {
  const avg = a.ab ? a.h / a.ab : 0;
  const obp = a.pa ? (a.h + a.bb) / a.pa : 0;
  const slg = a.ab ? a.tb / a.ab : 0;
  const ops = obp + slg;
  return {
    pa: a.pa,
    ab: a.ab,
    h: a.h,
    hr: a.hr,
    avg: round(avg),
    obp: round(obp),
    slg: round(slg),
    ops: round(ops)
  };
}
function round(v) {
  return Math.round(v * 1000) / 1000;
}

// ---------- Cache ----------
async function getCache(key) {
  const { cache = {} } = await chrome.storage.local.get("cache");
  const item = cache[key];
  if (!item) return null;
  if (Date.now() > item.exp) {
    delete cache[key];
    await chrome.storage.local.set({ cache });
    return null;
  }
  return item.val;
}
async function setCache(key, val, ttl) {
  const { cache = {} } = await chrome.storage.local.get("cache");
  cache[key] = { val, exp: Date.now() + ttl };
  await chrome.storage.local.set({ cache });
}