const fs = require('fs');

const LEAGUE_ID = '298051';
const SEASON = '2026';
const BASE_URL = `https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/${SEASON}/segments/0/leagues/${LEAGUE_ID}`;

async function getJson(url) {
  const r = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0',
      'Accept': 'application/json'
    }
  });
  if (!r.ok) throw new Error(`ESPN request failed: ${r.status} ${r.statusText}`);
  return r.json();
}

(async () => {
  const league = await getJson(BASE_URL + '?view=mTeam&view=mStandings&view=mStatus');
  const currentWeek = Number(league.scoringPeriodId || 1);
  const teamsById = {};
  const teams = (league.teams || []).map(t => {
    teamsById[t.id] = (t.name || '').trim();
    return {
      'Team ID': t.id,
      'Team Name': (t.name || '').trim(),
      'Abbrev': t.abbrev || '',
      'Wins': t.record?.overall?.wins ?? 0,
      'Losses': t.record?.overall?.losses ?? 0,
      'Ties': t.record?.overall?.ties ?? 0,
      'Points For': t.record?.overall?.pointsFor ?? 0
    };
  });

  const matchups = [];
  for (let week = 1; week <= currentWeek; week++) {
    const data = await getJson(BASE_URL + `?view=mScoreboard&view=mMatchupScore&scoringPeriodId=${week}&matchupPeriodId=${week}`);
    for (const g of (data.schedule || []).filter(x => Number(x.matchupPeriodId) === week)) {
      const hs = Number(g.home?.totalPointsLive ?? g.home?.totalPoints ?? 0);
      const as = Number(g.away?.totalPointsLive ?? g.away?.totalPoints ?? 0);
      const hn = teamsById[g.home?.teamId] || `Team ${g.home?.teamId}`;
      const an = teamsById[g.away?.teamId] || `Team ${g.away?.teamId}`;
      matchups.push({
        Week: week,
        'Matchup ID': g.id,
        'Home Team': hn,
        'Home Score': hs,
        'Away Team': an,
        'Away Score': as,
        Winner: hs === as ? 'TIE' : (hs > as ? hn : an),
        Margin: Number(Math.abs(hs - as).toFixed(2))
      });
    }
  }

  const out = {
    league: 'The NixonHouse Gang',
    leagueId: Number(LEAGUE_ID),
    season: Number(SEASON),
    updated: new Date().toISOString(),
    teams,
    matchups
  };
  fs.writeFileSync('matchups.json', JSON.stringify(out, null, 2) + '\n');
  console.log(`Updated ${matchups.length} matchups through scoring period ${currentWeek}`);
})().catch(e => { console.error(e); process.exit(1); });
