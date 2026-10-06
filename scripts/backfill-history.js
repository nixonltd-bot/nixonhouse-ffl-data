const fs = require('fs');
const path = require('path');

const LEAGUE_ID = '298051';
const START_SEASON = 2015;
const END_SEASON = 2026;

async function getJson(url) {
  const r = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0',
      'Accept': 'application/json'
    }
  });
  if (!r.ok) {
    const body = await r.text().catch(() => '');
    throw new Error(`ESPN request failed ${r.status} ${r.statusText}: ${url}\n${body.slice(0,500)}`);
  }
  return r.json();
}

function teamName(t) {
  if (!t) return '';
  if (t.name) return String(t.name).trim();
  return [t.location, t.nickname].filter(Boolean).join(' ').trim() || `Team ${t.id}`;
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function scoreForPeriod(side, period) {
  const p = side?.pointsByScoringPeriod;
  if (p && Object.prototype.hasOwnProperty.call(p, String(period))) {
    return num(p[String(period)]);
  }
  return null;
}

function addPerformance(rows, seen, {
  season, week, matchupId, teamId, team, opponentId, opponent,
  points, opponentPoints, source, matchupPeriodId
}) {
  if (points === null || opponentPoints === null) return;
  if (points === 0 && opponentPoints === 0) return;
  const key = [season, week, matchupId, teamId].join(':');
  if (seen.has(key)) return;
  seen.add(key);
  rows.push({
    season,
    week,
    matchupId,
    matchupPeriodId,
    teamId,
    team,
    opponentId,
    opponent,
    score: Number(points.toFixed(2)),
    opponentScore: Number(opponentPoints.toFixed(2)),
    result: points === opponentPoints ? 'T' : (points > opponentPoints ? 'W' : 'L'),
    margin: Number(Math.abs(points - opponentPoints).toFixed(2)),
    source
  });
}

async function fetchSeason(season) {
  let raw;
  let endpoint;
  if (season >= 2018) {
    endpoint = `https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/${season}/segments/0/leagues/${LEAGUE_ID}?view=mTeam&view=mMatchup&view=mMatchupScore&view=mSettings&view=mStatus`;
    raw = await getJson(endpoint);
  } else {
    endpoint = `https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/leagueHistory/${LEAGUE_ID}?seasonId=${season}&view=mTeam&view=mMatchup&view=mMatchupScore&view=mSettings&view=mStatus`;
    const hist = await getJson(endpoint);
    raw = Array.isArray(hist) ? hist[0] : hist;
  }

  const teamsById = {};
  for (const t of (raw.teams || [])) teamsById[t.id] = teamName(t);

  const rows = [];
  const seen = new Set();

  for (const g of (raw.schedule || [])) {
    if (!g.home || !g.away) continue;
    const hId = g.home.teamId;
    const aId = g.away.teamId;
    const hName = teamsById[hId] || `Team ${hId}`;
    const aName = teamsById[aId] || `Team ${aId}`;

    const periods = new Set([
      ...Object.keys(g.home?.pointsByScoringPeriod || {}),
      ...Object.keys(g.away?.pointsByScoringPeriod || {})
    ].map(Number).filter(Number.isFinite));

    if (periods.size) {
      for (const week of [...periods].sort((a,b) => a-b)) {
        const hs = scoreForPeriod(g.home, week);
        const as = scoreForPeriod(g.away, week);
        if (hs === null || as === null) continue;
        addPerformance(rows, seen, {
          season, week, matchupId:g.id, matchupPeriodId:g.matchupPeriodId,
          teamId:hId, team:hName, opponentId:aId, opponent:aName,
          points:hs, opponentPoints:as, source:'pointsByScoringPeriod'
        });
        addPerformance(rows, seen, {
          season, week, matchupId:g.id, matchupPeriodId:g.matchupPeriodId,
          teamId:aId, team:aName, opponentId:hId, opponent:hName,
          points:as, opponentPoints:hs, source:'pointsByScoringPeriod'
        });
      }
    } else {
      const week = num(g.matchupPeriodId);
      const hs = num(g.home.totalPoints);
      const as = num(g.away.totalPoints);
      if (week !== null && hs !== null && as !== null) {
        addPerformance(rows, seen, {
          season, week, matchupId:g.id, matchupPeriodId:g.matchupPeriodId,
          teamId:hId, team:hName, opponentId:aId, opponent:aName,
          points:hs, opponentPoints:as, source:'totalPoints'
        });
        addPerformance(rows, seen, {
          season, week, matchupId:g.id, matchupPeriodId:g.matchupPeriodId,
          teamId:aId, team:aName, opponentId:hId, opponent:hName,
          points:as, opponentPoints:hs, source:'totalPoints'
        });
      }
    }
  }

  rows.sort((a,b) => a.week-b.week || a.matchupId-b.matchupId || a.teamId-b.teamId);
  return {
    season,
    endpointType: season >= 2018 ? 'season' : 'leagueHistory',
    teamCount: Object.keys(teamsById).length,
    performanceCount: rows.length,
    teams: teamsById,
    weeklyScores: rows
  };
}

(async () => {
  fs.mkdirSync('history/seasons', {recursive:true});
  const all = [];
  const seasonSummary = [];

  for (let season = START_SEASON; season <= END_SEASON; season++) {
    console.log(`Fetching ${season}...`);
    try {
      const data = await fetchSeason(season);
      fs.writeFileSync(
        path.join('history/seasons', `${season}.json`),
        JSON.stringify(data, null, 2) + '\n'
      );
      all.push(...data.weeklyScores);
      seasonSummary.push({
        season,
        teamCount:data.teamCount,
        performanceCount:data.performanceCount,
        status:'ok'
      });
      console.log(`  ${data.performanceCount} team-week scores`);
    } catch (e) {
      console.error(`  FAILED ${season}: ${e.message}`);
      seasonSummary.push({season,status:'error',error:e.message});
    }
  }

  all.sort((a,b) =>
    b.score-a.score ||
    a.season-b.season ||
    a.week-b.week ||
    a.team.localeCompare(b.team)
  );

  const completedSeasons = seasonSummary.filter(x=>x.status==='ok').map(x=>x.season);
  const failedSeasons = seasonSummary.filter(x=>x.status==='error');

  const payload = {
    league:'The NixonHouse Gang',
    leagueId:Number(LEAGUE_ID),
    generated:new Date().toISOString(),
    seasonsRequested:[START_SEASON, END_SEASON],
    completedSeasons,
    failedSeasons,
    count:all.length,
    weeklyScores:all
  };

  fs.writeFileSync('history/all-weekly-scores.json', JSON.stringify(payload, null, 2) + '\n');

  const records = {
    league:'The NixonHouse Gang',
    leagueId:Number(LEAGUE_ID),
    generated:payload.generated,
    coverage:{
      requested:`${START_SEASON}-${END_SEASON}`,
      completedSeasons,
      failedSeasons,
      teamWeekScores:all.length
    },
    highestSingleWeek: all[0] || null,
    top25SingleWeekScores: all.slice(0,25),
    lowestSingleWeek: [...all].filter(x=>x.score>0).sort((a,b)=>a.score-b.score)[0] || null,
    biggestBlowout: [...all].sort((a,b)=>b.margin-a.margin)[0] || null,
    highestScoreInLoss: all.filter(x=>x.result==='L').sort((a,b)=>b.score-a.score)[0] || null,
    closestGame: [...all].filter(x=>x.margin>0).sort((a,b)=>a.margin-b.margin)[0] || null
  };

  fs.writeFileSync('history/records.json', JSON.stringify(records, null, 2) + '\n');

  console.log('\n=== ALL-TIME HIGH ===');
  if (records.highestSingleWeek) {
    const r = records.highestSingleWeek;
    console.log(`${r.score} - ${r.team} vs ${r.opponent} (${r.opponentScore}), ${r.season} Week ${r.week}`);
  }
  if (failedSeasons.length) {
    console.log('\nFailed seasons:');
    for (const f of failedSeasons) console.log(`- ${f.season}: ${f.error}`);
    process.exitCode = 2;
  }
})().catch(e => { console.error(e); process.exit(1); });
