// /api/payroll-scheduled?start=YYYY-MM-DD&end=YYYY-MM-DD
// Fetches PUBLISHED scheduled shifts from Square Labor and aggregates hours per employee.
// Drafts (unpublished) are ignored. Unpaid breaks are subtracted from scheduled hours.
// Returns gracefully empty if scheduling isn't available so the rest of the tool still works.

const SQUARE_BASE = 'https://connect.squareup.com';
const LOCATION_ID = process.env.SQUARE_LOCATION_ID || 'LHSVRCNXBB7E8';
const TZ_OFFSET_HOURS = -4;

function squareHeaders() {
  return {
    'Square-Version': '2024-08-21',
    'Authorization': `Bearer ${process.env.SQUARE_TOKEN}`,
    'Content-Type': 'application/json'
  };
}

async function fetchAllScheduledShifts(startISO, endISO) {
  const shifts = [];
  let cursor;
  do {
    const body = {
      query: {
        filter: {
          location_ids: [LOCATION_ID],
          start_at: { start_at: startISO, end_at: endISO }
        }
      },
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
      return { shifts, error: `Square scheduled-shifts API returned ${r.status}: ${errBody.slice(0, 300)}` };
    }
    const data = await r.json();
    if (data.scheduled_shifts) shifts.push(...data.scheduled_shifts);
    cursor = data.cursor;
  } while (cursor);
  return { shifts, error: null };
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
  // PT1H30M -> 1.5 hours, PT45M -> 0.75, PT2H -> 2
  if (!d) return 0;
  const m = String(d).match(/^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!m) return 0;
  return (parseInt(m[1] || 0)) + (parseInt(m[2] || 0) / 60) + (parseInt(m[3] || 0) / 3600);
}

exports.handler = async (event) => {
  try {
    const { start, end } = event.queryStringParameters || {};
    if (!start || !end) {
      return { statusCode: 400, body: JSON.stringify({ error: 'start and end (YYYY-MM-DD) required' }) };
    }
    const startISO = new Date(`${start}T00:00:00${TZ_OFFSET_HOURS < 0 ? '-' : '+'}0${Math.abs(TZ_OFFSET_HOURS)}:00`).toISOString();
    const endISO = new Date(`${end}T23:59:59${TZ_OFFSET_HOURS < 0 ? '-' : '+'}0${Math.abs(TZ_OFFSET_HOURS)}:00`).toISOString();

    const [{ shifts, error }, members] = await Promise.all([
      fetchAllScheduledShifts(startISO, endISO),
      fetchTeamMembers()
    ]);

    const byEmployee = {};
    let countedShifts = 0;

    shifts.forEach(s => {
      // Only count PUBLISHED shifts. Drafts haven't been communicated to the team.
      const details = s.published_shift_details;
      if (!details || !details.start_at || !details.end_at) return;

      const startAt = details.start_at;
      const endAt = details.end_at;
      const memberId = s.team_member_id;
      const name = members[memberId] || 'Unknown';

      const grossHrs = (new Date(endAt) - new Date(startAt)) / 3600000;

      // Subtract unpaid breaks from the schedule (matches how actual hours are computed in Square)
      let unpaidBreakHrs = 0;
      (details.breaks || []).forEach(b => {
        if (b.is_paid === false) {
          unpaidBreakHrs += parseISODuration(b.expected_duration);
        }
      });

      const netHrs = Math.max(0, grossHrs - unpaidBreakHrs);
      if (!byEmployee[name]) byEmployee[name] = { hours: 0, shift_count: 0 };
      byEmployee[name].hours += netHrs;
      byEmployee[name].shift_count += 1;
      countedShifts += 1;
    });

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
      body: JSON.stringify({
        employees: byEmployee,
        scheduled_shifts: countedShifts,
        warning: error
      })
    };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
