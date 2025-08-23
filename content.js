console.log("content script alive");

const SEASON = new Date().getFullYear();

const observer = new MutationObserver(() => init());
init();

function init() {
    // Bind to player name anchors
    document
      .querySelectorAll('.player-column__athlete a:not([data-lrbound])')
      .forEach((a) => bind(a));
  
    // Also bind to headshot images
    document
      .querySelectorAll('img[src*="/mlb/players/full/"]:not([data-lrbound])')
      .forEach((img) => bind(img));
  
    observer.observe(document.body, {
      childList: true,
      subtree: true
    });
  }

  function bind(el) {
    if (el.getAttribute("data-lrbound")) return;
    el.setAttribute("data-lrbound", "1");
    el.addEventListener("mouseenter", onEnter, { passive: true });
    el.addEventListener("mouseleave", onLeave, { passive: true });
  }

let tip;

function onLeave() {
  if (tip) {
    tip.remove();
    tip = null;
  }
}

function onEnter(e) {
    const node = e.currentTarget;
    // go up to the row that contains both the img and aria-label
    const container = node.closest("tr") || node.closest("div") || node;
  
    const { espnId, fullName } = extractIdAndName(container);
    const teamAbbr = findTeamAbbr(container);
  
    console.log("Hover detected", { espnId, fullName, teamAbbr });
  
    if (!fullName) return;
  
    createTip(node, "Loading splits...");
    chrome.runtime.sendMessage(
      {
        type: "fetchSplits",
        payload: { espnId, fullName, teamAbbr, season: SEASON }
      },
      (res) => {
        if (!res?.ok) {
          console.error("Background error:", res.error);
          updateTip("No splits found");
          return;
        }
        const { seasonSplits, careerSplits } = res.data;
        updateTip(render(seasonSplits, careerSplits));
      }
    );
  }
  
  function extractIdAndName(scope) {
    // Look for headshot img inside the row
    const img = scope.querySelector('img[src*="/mlb/players/full/"]');
    let espnId = null;
    let fullName = "";
  
    if (img) {
      const mi = img.src.match(/mlb\/players\/full\/(\d+)\.png/);
      if (mi) espnId = mi[1];
      if (img.alt) fullName = img.alt.trim();
    }
  
    // Fallback: use anchor text
    if (!fullName) {
      const a = scope.querySelector("a.AnchorLink");
      if (a) fullName = a.textContent.trim();
    }
  
    return { espnId, fullName };
  }
  
  function findTeamAbbr(scope) {
    // Look for aria-label on any child div
    const labelled = scope.querySelector("[aria-label*=' for ']");
    let teamFull = null;
    if (labelled) {
      const al = labelled.getAttribute("aria-label") || "";
      const idx = al.lastIndexOf(" for ");
      if (idx !== -1) teamFull = al.slice(idx + 5).trim();
    }
    return teamFull ? TEAM_NAME_TO_ABBR[teamFull] : null;
  }

const TEAM_NAME_TO_ABBR = {
  "Atlanta Braves": "ATL",
  "Miami Marlins": "MIA",
  "New York Mets": "NYM",
  "Philadelphia Phillies": "PHI",
  "Washington Nationals": "WSH",
  "Chicago Cubs": "CHC",
  "Cincinnati Reds": "CIN",
  "Milwaukee Brewers": "MIL",
  "Pittsburgh Pirates": "PIT",
  "St. Louis Cardinals": "STL",
  "Arizona Diamondbacks": "ARI",
  "Colorado Rockies": "COL",
  "Los Angeles Dodgers": "LAD",
  "San Diego Padres": "SD",
  "San Francisco Giants": "SF",
  "Baltimore Orioles": "BAL",
  "Boston Red Sox": "BOS",
  "New York Yankees": "NYY",
  "Tampa Bay Rays": "TB",
  "Toronto Blue Jays": "TOR",
  "Chicago White Sox": "CWS",
  "Cleveland Guardians": "CLE",
  "Detroit Tigers": "DET",
  "Kansas City Royals": "KC",
  "Minnesota Twins": "MIN",
  "Houston Astros": "HOU",
  "Los Angeles Angels": "LAA",
  "Oakland Athletics": "OAK",
  "Seattle Mariners": "SEA",
  "Texas Rangers": "TEX"
};

function createTip(anchor, html) {
  tip = document.createElement("div");
  tip.className = "lr-splits-tip";
  tip.innerHTML = html;
  document.body.appendChild(tip);
  position(anchor, tip);
}

function updateTip(html) {
  if (tip) tip.innerHTML = html;
}

function position(anchor, t) {
  const r = anchor.getBoundingClientRect();
  t.style.top = window.scrollY + r.bottom + 6 + "px";
  t.style.left = window.scrollX + r.left + "px";
}

function render(season, career) {
  const fmt = (x) =>
    x == null ? "-" : typeof x === "number" ? x.toFixed(3) : x;
  const row = (label, s) =>
    `<div class="row"><div class="cell label">${label}</div>
     <div class="cell">${fmt(s?.avg)}</div>
     <div class="cell">${fmt(s?.obp)}</div>
     <div class="cell">${fmt(s?.slg)}</div>
     <div class="cell">${fmt(s?.ops)}</div>
     <div class="cell">${s?.hr ?? "-"}</div>
     <div class="cell">${s?.pa ?? "-"}</div></div>`;

  return `
  <div class="hdr">Splits vs L/R</div>
  <div class="subhdr">Season ${season?.season}</div>
  <div class="grid">
    <div class="row head">
      <div class="cell label"></div>
      <div class="cell">AVG</div><div class="cell">OBP</div>
      <div class="cell">SLG</div><div class="cell">OPS</div>
      <div class="cell">HR</div><div class="cell">PA</div>
    </div>
    ${row("vs LHP", season?.vsLeft)}
    ${row("vs RHP", season?.vsRight)}
  </div>
  <div class="subhdr">Career</div>
  <div class="grid">
    <div class="row head">
      <div class="cell label"></div>
      <div class="cell">AVG</div><div class="cell">OBP</div>
      <div class="cell">SLG</div><div class="cell">OPS</div>
      <div class="cell">HR</div><div class="cell">PA</div>
    </div>
    ${row("vs LHP", career?.vsLeft)}
    ${row("vs RHP", career?.vsRight)}
  </div>`;
}