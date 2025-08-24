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
      } else if (msg.type === "clearPlayerCache") {
        const { espnId, fullName, teamAbbr } = msg.payload;
        console.log("Clearing cache for", { espnId, fullName, teamAbbr });
        
        if (espnId) await clearCache(`map:espn:${espnId}`);
        if (fullName) await clearCache(`id:${fullName}|${teamAbbr || ""}`);
        
        sendResponse({ ok: true });
      } else if (msg.type === "clearAllCache") {
        console.log("Clearing ALL extension cache");
        await chrome.storage.local.set({ cache: {} });
        sendResponse({ ok: true, message: "All cache cleared" });
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
      // Validate the cached mapping by checking if the name roughly matches
      try {
        const validateRes = await fetch(`${MLB_BASE}/people/${mapped}`);
        if (validateRes.ok) {
          const validateJson = await validateRes.json();
          const cachedPlayerName = validateJson?.people?.[0]?.fullName || "";
          
          // More strict name validation
          const normalizedCached = normalizeName(cachedPlayerName);
          const normalizedRequested = normalizeName(fullName);
          
          // Check if last names match (most important for baseball)
          const cachedLastName = normalizedCached.split(' ').pop();
          const requestedLastName = normalizedRequested.split(' ').pop();
          
          const nameMatch = cachedLastName === requestedLastName;
          
          if (!nameMatch) {
            console.log(`❌ INVALID CACHE: ESPN ID ${espnId} mapped to "${cachedPlayerName}" but requested "${fullName}"`);
            console.log(`❌ Last names don't match: "${cachedLastName}" vs "${requestedLastName}"`);
            await clearCache(`map:espn:${espnId}`);
            // Also clear any name-based cache for good measure
            await clearCache(`id:${fullName}|${teamAbbr || ""}`);
          } else {
            console.log(`✅ Cached mapping validated: "${cachedPlayerName}" matches "${fullName}"`);
            return mapped;
          }
        } else {
          console.log(`❌ Cache validation API call failed: ${validateRes.status}`);
          await clearCache(`map:espn:${espnId}`);
        }
      } catch (e) {
        console.log(`❌ Cache validation error, clearing: ${e.message}`);
        await clearCache(`map:espn:${espnId}`);
      }
    }
  }

  const cacheKey = `id:${fullName}|${teamAbbr || ""}`;
  const cached = await getCache(cacheKey);
  if (cached) {
    console.log(`Found cached ID for "${fullName}": ${cached}`);
    return cached;
  }

  // Try team roster first if we have team info - more reliable for newer players
  if (teamAbbr) {
    console.log(`🔍 Trying team roster search for ${fullName} on ${teamAbbr}`);
    const rosterMatch = await searchTeamRoster(fullName, teamAbbr);
    if (rosterMatch) {
      console.log(`✅ Found via team roster: ${rosterMatch.fullName} (${rosterMatch.id})`);
      const finalId = rosterMatch.id;
      await setCache(cacheKey, finalId, ONE_DAY_MS);
      if (espnId) await setCache(`map:espn:${espnId}`, finalId, ONE_DAY_MS);
      return finalId;
    }
  }

  // Fallback to search API (but with stricter validation)
  console.log(`🔍 Trying MLB search API for ${fullName}`);
  const searchStrategies = [
    fullName,
    `${fullName.split(' ').pop()}, ${fullName.split(' ')[0]}`, // "Last, First" format
    fullName.split(' ').pop(), // Just last name
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

        // STRICT: Both first and last name must match for search results
        const firstMatch = pFirst && targetFirst && normalizeName(pFirst) === normalizeName(targetFirst);
        const lastMatch = pLast && targetLast && normalizeName(pLast) === normalizeName(targetLast);
        
        if (!lastMatch) {
          console.log(`  ❌ REJECTED: Last name "${pLast}" doesn't match "${targetLast}"`);
          continue; // Skip entirely if last name doesn't match
        }

        // ADDITIONAL PROTECTION: Reject well-known mismatches
        if (person.id === 457705 && normalizeName(fullName) !== 'andrew mccutchen') {
          console.log(`  ❌ REJECTED McCutchen mismatch: "${fullName}" is not Andrew McCutchen`);
          continue;
        }

        // Exact name match gets highest priority
        if (normalizeName(person.fullName) === normalizeName(fullName)) {
          score += 50;
          console.log(`  +50 exact name match`);
        }

        // Last name match (required)
        score += 15;
        console.log(`  +15 last name match`);

        // First name match
        if (firstMatch) {
          score += 20;
          console.log(`  +20 first name match`);
        }

        // Team match - make this the highest priority
        if (teamAbbr && person.currentTeam?.abbreviation?.toUpperCase() === teamAbbr.toUpperCase()) {
          score += 30; // Very high weight for team match
          console.log(`  +30 team match (${person.currentTeam.abbreviation})`);
        }

        // Active player bonus
        if (person.active) {
          score += 5;
          console.log(`  +5 active player`);
        }

        console.log(`  Final score: ${score}`);

        if (score > bestScore) {
          bestMatch = person;
          bestScore = score;
          console.log(`  NEW BEST MATCH: ${person.fullName} (${person.id}) with score ${score}`);
        }
      }
      
      // If we found a very good match, use it
      if (bestScore >= 60) {
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

// Search for a player in their team's roster - more reliable for newer players
async function searchTeamRoster(fullName, teamAbbr) {
  const teamId = TEAM_ABBR_TO_ID[teamAbbr.toUpperCase()];
  if (!teamId) {
    console.log(`❌ Unknown team abbreviation: ${teamAbbr}`);
    return null;
  }
  
  console.log(`🔍 Searching roster for team ${teamAbbr} (ID: ${teamId})`);
  
  try {
    const url = `${MLB_BASE}/teams/${teamId}/roster`;
    const res = await fetch(url);
    if (!res.ok) {
      console.log(`❌ Roster fetch failed: ${res.status}`);
      return null;
    }
    
    const json = await res.json();
    const roster = Array.isArray(json?.roster) ? json.roster : [];
    console.log(`Found ${roster.length} players in ${teamAbbr} roster`);
    
    const [targetFirst, targetLast] = splitName(stripSuffix(fullName));
    
    for (const player of roster) {
      const person = player.person;
      if (!person?.fullName) continue;
      
      const [pFirst, pLast] = splitName(stripSuffix(person.fullName));
      
      // Check for exact name match
      if (normalizeName(person.fullName) === normalizeName(fullName)) {
        console.log(`✅ EXACT MATCH in roster: ${person.fullName} (${person.id})`);
        return person;
      }
      
      // Check for last name match with first name/initial match
      if (pLast && targetLast && normalizeName(pLast) === normalizeName(targetLast)) {
        if (pFirst && targetFirst && 
           (normalizeName(pFirst) === normalizeName(targetFirst) || 
            pFirst.charAt(0).toLowerCase() === targetFirst.charAt(0).toLowerCase())) {
          console.log(`✅ NAME MATCH in roster: ${person.fullName} (${person.id})`);
          return person;
        }
      }
    }
    
    console.log(`❌ Player "${fullName}" not found in ${teamAbbr} roster`);
    return null;
    
  } catch (error) {
    console.log(`❌ Roster search error: ${error.message}`);
    return null;
  }
}

// Mapping of team abbreviations to MLB team IDs
const TEAM_ABBR_TO_ID = {
  'ATL': 144, 'MIA': 146, 'NYM': 121, 'PHI': 143, 'WSH': 120,
  'CHC': 112, 'CIN': 113, 'MIL': 158, 'PIT': 134, 'STL': 138,
  'ARI': 109, 'COL': 115, 'LAD': 119, 'SD': 135, 'SF': 137,
  'BAL': 110, 'BOS': 111, 'NYY': 147, 'TB': 139, 'TOR': 141,
  'CWS': 145, 'CLE': 114, 'DET': 116, 'KC': 118, 'MIN': 142,
  'HOU': 117, 'LAA': 108, 'OAK': 133, 'SEA': 136, 'TEX': 140
};

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
  const cacheKey = `splits:career:v4:${mlbamId}`;
  const cached = await getCache(cacheKey);
  if (cached) {
    console.log(`Using cached career data for ${mlbamId}:`, cached);
    return cached;
  }

  // Always aggregate by season for more reliable career totals
  // The MLB API's career totals without season parameter can be unreliable
  console.log(`Aggregating career stats by season for ${mlbamId}...`);
  const agg = await aggregateCareerBySeasonViaStats(mlbamId);
  const vsLeft = agg.vsLeft;
  const vsRight = agg.vsRight;
  
  console.log(`Aggregated career splits for ${mlbamId}:`, { vsLeft, vsRight });

  const career = { vsLeft, vsRight };
  await setCache(cacheKey, career, ONE_DAY_MS);
  return career;
}

// Aggregate career stats by summing all seasons
async function aggregateCareerBySeasonViaStats(mlbamId) {
  const personRes = await fetch(`${MLB_BASE}/people/${mlbamId}`);
  if (!personRes.ok) throw new Error("person_fetch_failed");
  const person = await personRes.json();
  const debut = person?.people?.[0]?.mlbDebutDate?.slice(0, 4) || "2015";
  const currentYear = new Date().getFullYear();

  console.log(`Aggregating career for player ${mlbamId} from ${debut} to ${currentYear}`);

  let aggL = initAgg();
  let aggR = initAgg();
  let seasonsWithData = 0;

  for (let y = Math.max(Number(debut), 2015); y <= currentYear; y++) {
    try {
      const url =
        `${MLB_BASE}/people/${mlbamId}/stats?stats=statSplits` +
        `&sitCodes=vl,vr&group=hitting&gameType=R&season=${y}`;
      console.log(`Fetching ${y} season data for ${mlbamId}`);

      const res = await fetch(url);
      if (!res.ok) {
        console.log(`No data for season ${y}: ${res.status}`);
        continue;
      }
      
      const j = await res.json();
      const L = pickFromSplitsEndpoint(j, "vl");
      const R = pickFromSplitsEndpoint(j, "vr");
      
      if (hasData(L) || hasData(R)) {
        seasonsWithData++;
        console.log(`Adding ${y} season data: vsL=${L?.pa || 0} PA, vsR=${R?.pa || 0} PA`);
        aggL = addAgg(aggL, L);
        aggR = addAgg(aggR, R);
      }
    } catch (error) {
      console.log(`Error fetching ${y} season data:`, error.message);
    }
  }

  console.log(`Career aggregation complete: ${seasonsWithData} seasons with data`);
  console.log(`Career totals: vsL=${aggL.pa} PA, vsR=${aggR.pa} PA`);

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
async function clearCache(key) {
  const { cache = {} } = await chrome.storage.local.get("cache");
  delete cache[key];
  await chrome.storage.local.set({ cache });
}