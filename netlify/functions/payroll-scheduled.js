// /api/payroll-scheduled?start=YYYY-MM-DD&end=YYYY-MM-DD
// Fetches PUBLISHED scheduled shifts from Square Labor.
// Filters out:
//   - Unassigned shift slots (template shifts published before staff are assigned)
//   - Shifts where the team_member_id doesn't resolve to a known team member
//   - Bogus durations (>24h or negative — usually old recurring templates)
// Returns per-employee weekly totals AND per-employee per-day breakdown.
// Daily breakdown enables 45-min daily tolerance in the front-end variance check.

const SQUARE_BASE = 'https://connect.squareup.com';
const LOCATION_ID = process.env.SQUARE_LOCATION_ID || 'LHSVRCNXBB7E8';

// DST-aware timezone helpers for America/New_York
function nyToUTCISO(dateStr, h, m, s) {
  const pad = n => String(n).padStart(2, '0');
  const timeStr = `${pad(h)}:${pad(m)}:${pad(s)}`;
  for (const off of ['-04:00', '-05:00']) {
    const cand = new Date(`${dateStr}T${timeStr}${off}`);
    const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(cand);
    if (fmt === dateStr) return cand.toISOString();
  }
  return new Date(`${dateStr}T${timeStr}-04:00`).toISOString();
}

function squareHeaders() {
  return {
    'Square-Version': '2024-08-21',
    'Authorization': `Bearer ${process.env.SQUARE_TOKEN}`,
    'Content-Type': 'application/json'
  };
}

function localDateOf(isoString) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(new Date(isoString));
}

async function fetchAllScheduledShifts(startISO, endISO, opts = {}) {
  const shifts = [];
  let cursor;
  let pages = 0;
  const maxPages = opts.maxPages || 100;
  do {
    const filter = { location_ids: [LOCATION_ID] };
    if (opts.teamMemberIds) {
      filter.team_member_ids = opts.teamMemberIds;
    }
    if (!opts.nofilter) {
      filter.start_at = { start_at: startISO, end_at: endISO };
    }
    const body = {
      query: { filter },
      limit: 50
    };
    if (cursor) body.cursor = cursor;

    const r = await fetch(`${SQUARE_BASE}/v2/labor/scheduled-shifts/search`, {
      method: 'POST',
      headers: squareHeaders(),
      body: JSON.stringify(body)
    });
    if (!r.ok) {
      const errBody = await r.text();
      console.error(`Scheduled shifts API ${r.status}: ${errBody}`);
      return { shifts, error: `Square scheduled-shifts API returned ${r.status}: ${errBody.slice(0, 300)}`, pages };
    }
    const data = await r.json();
    if (data.scheduled_shifts) shifts.push(...data.scheduled_shifts);
    cursor = data.cursor;
    pages += 1;
    if (pages >= maxPages) break;
  } while (cursor);
  return { shifts, error: null, pages };
}

async function fetchByTeamMember(startISO, endISO, members) {
  // Fan out per-employee queries in parallel. Workaround for Square's location-level cap.
  const memberIds = Object.keys(members);
  const results = await Promise.all(
    memberIds.map(async (id) => {
      const { shifts } = await fetchAllScheduledShifts(startISO, endISO, { teamMemberIds: [id], maxPages: 5 });
      return shifts;
    })
  );
  return results.flat();
}

async function fetchTeamMembers() {
  const r = await fetch(`${SQUARE_BASE}/v2/team-members/search`, {
    method: 'POST',
    headers: squareHeaders(),
    body: JSON.stringify({ query: { filter: { location_ids: [LOCATION_ID] } }, limit: 200 })
  });
  if (!r.ok) return {};
  const data = await r.json();
  const map = {};
  (data.team_members || []).forEach(tm => {
    map[tm.id] = [tm.given_name, tm.family_name].filter(Boolean).join(' ').trim() || 'Unknown';
  });
  return map;
}

function parseISODuration(d) {
  if (!d) return 0;
  const m = String(d).match(/^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!m) return 0;
  return (parseInt(m[1] || 0)) + (parseInt(m[2] || 0) / 60) + (parseInt(m[3] || 0) / 3600);
}

exports.handler = async (event) => {
  try {
    const { start, end, debug, nofilter, strategy } = event.queryStringParameters || {};
    if (!start || !end) {
      return { statusCode: 400, body: JSON.stringify({ error: 'start and end (YYYY-MM-DD) required' }) };
    }
    const startISO = nyToUTCISO(start, 0, 0, 0);
    const endISO = nyToUTCISO(end, 23, 59, 59);

    const members = await fetchTeamMembers();

    let shifts, error, pages;
    if (strategy === 'byteam') {
      // Per-team-member query strategy: fan out one search per employee,
      // bypasses any per-location cap Square may impose.
      shifts = await fetchByTeamMember(startISO, endISO, members);
      error = null;
      pages = -1;
    } else {
      const fetchOpts = nofilter ? { nofilter: true, maxPages: 30 } : {};
      const result = await fetchAllScheduledShifts(startISO, endISO, fetchOpts);
      shifts = result.shifts;
      error = result.error;
      pages = result.pages;
    }

    const byEmployee = {};
    let countedShifts = 0;
    let skippedUnassigned = 0;
    let skippedUnknownMember = 0;
    let skippedBogusDuration = 0;
    let skippedOutOfRange = 0;
    let skippedDuplicate = 0;
    let skippedNoDetails = 0;
    const noDetailsSamples = [];
    const inRangeSamples = [];

    const winStart = new Date(startISO).getTime();
    const winEnd = new Date(endISO).getTime();
    const seenIds = new Set();

    shifts.forEach(s => {
      // Dedupe in case Square returns version-history duplicates
      if (s.id && seenIds.has(s.id)) { skippedDuplicate += 1; return; }
      if (s.id) seenIds.add(s.id);

      const details = s.published_shift_details;
      if (!details || !details.start_at || !details.end_at) {
        skippedNoDetails += 1;
        if (debug && noDetailsSamples.length < 3) noDetailsSamples.push(s);
        return;
      }

      // Defensive client-side date filter: Square's filter is unreliable here,
      // so we re-check that the shift's published start time falls in our window.
      const shiftStartMs = new Date(details.start_at).getTime();
      if (shiftStartMs < winStart || shiftStartMs > winEnd) {
        skippedOutOfRange += 1;
        return;
      }

      if (debug && inRangeSamples.length < 2) inRangeSamples.push(s);

      // Resolve team member. Unassigned slots have no team_member_id and are skipped.
      const memberId = s.team_member_id || details.team_member_id;
      if (!memberId) { skippedUnassigned += 1; return; }

      const name = members[memberId];
      if (!name) { skippedUnknownMember += 1; return; }

      // Sanity-check duration. Skip multi-day shifts (likely orphaned templates) and negatives.
      const grossHrs = (new Date(details.end_at) - new Date(details.start_at)) / 3600000;
      if (grossHrs > 24 || grossHrs < 0) {
        skippedBogusDuration += 1;
        console.warn(`Skipping bogus scheduled shift: ${grossHrs}h for ${name} (${details.start_at} to ${details.end_at})`);
        return;
      }

      // Subtract unpaid breaks
      let unpaidBreakHrs = 0;
      (details.breaks || []).forEach(b => {
        if (b.is_paid === false) {
          unpaidBreakHrs += parseISODuration(b.expected_duration);
        }
      });

      const netHrs = Math.max(0, grossHrs - unpaidBreakHrs);
      const localDate = localDateOf(details.start_at);

      if (!byEmployee[name]) byEmployee[name] = { hours: 0, shift_count: 0, by_date: {} };
      byEmployee[name].hours += netHrs;
      byEmployee[name].shift_count += 1;
      byEmployee[name].by_date[localDate] = (byEmployee[name].by_date[localDate] || 0) + netHrs;
      countedShifts += 1;
    });

    const result = {
      employees: byEmployee,
      scheduled_shifts: countedShifts,
      raw_shifts_received: shifts.length,
      skipped: {
        unassigned: skippedUnassigned,
        unknown_member: skippedUnknownMember,
        bogus_duration: skippedBogusDuration,
        out_of_range: skippedOutOfRange,
        duplicate: skippedDuplicate,
        no_details: skippedNoDetails
      },
      warning: error
    };
    if (debug) {
      // Build date distribution: what dates is Square actually returning?
      const dateCounts = {};
      const outOfRangeSamples = [];
      shifts.forEach(s => {
        const d = s.published_shift_details || s.draft_shift_details;
        if (d && d.start_at) {
          const localDate = localDateOf(d.start_at);
          dateCounts[localDate] = (dateCounts[localDate] || 0) + 1;
          // Capture a few out-of-range PUBLISHED shifts to inspect their dates
          if (s.published_shift_details && outOfRangeSamples.length < 5) {
            const ms = new Date(s.published_shift_details.start_at).getTime();
            if (ms < winStart || ms > winEnd) {
              outOfRangeSamples.push({
                id: s.id,
                start_at: s.published_shift_details.start_at,
                end_at: s.published_shift_details.end_at,
                team_member_id: s.team_member_id || s.published_shift_details.team_member_id,
                version: s.version,
                updated_at: s.updated_at
              });
            }
          }
        }
      });
      // Sort dates ascending for readability
      const sortedDateCounts = Object.fromEntries(
        Object.entries(dateCounts).sort(([a], [b]) => a.localeCompare(b))
      );
      result.debug = {
        window_utc: { start: startISO, end: endISO },
        strategy: strategy || 'location',
        pages_fetched: pages,
        nofilter_mode: !!nofilter,
        date_distribution: sortedDateCounts,
        no_details_samples: noDetailsSamples,
        in_range_samples: inRangeSamples,
        out_of_range_samples: outOfRangeSamples,
        member_count: Object.keys(members).length
      };
    }

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
      body: JSON.stringify(result)
    };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
