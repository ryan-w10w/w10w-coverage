// /api/payroll-cash?start=YYYY-MM-DD&end=YYYY-MM-DD
// Reads nightly Cash Tips (Col R) and Cash Payments (Col S) from the existing payroll sheet.
//
// Sheet structure assumed (adjust COL_* constants if columns differ):
//   Col A: Date (YYYY-MM-DD or M/D/YYYY)
//   Col B: Employee Name
//   Col R: Cash Tips (dollars)
//   Col S: Cash Payments (dollars, what came out of the till for that person)
//
// Auth: uses a Google service account JSON in env var GOOGLE_SHEETS_SA_JSON
// (same pattern as the existing /api/sheets function for the Fixed Costs sheet).
// The service account must have Viewer access to the sheet.

const SHEET_ID = '1SJ88Y00YWDPpMrOTg1tzrrLiKI0FCNV3VsQchircvvY';
const TAB_NAME = 'Payroll'; // Adjust if the tab is named differently
const RANGE = `${TAB_NAME}!A2:S`; // Skip header row, pull through Col S

const COL_DATE = 0;        // A
const COL_EMPLOYEE = 1;    // B
const COL_CASH_TIPS = 17;  // R (0-indexed)
const COL_CASH_PAY = 18;   // S

function parseDate(raw) {
  if (!raw) return null;
  const s = String(raw).trim();
  // ISO-style first
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  // M/D/YYYY or MM/DD/YYYY
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (m) {
    const [, mm, dd, yyyy] = m;
    return `${yyyy}-${mm.padStart(2, '0')}-${dd.padStart(2, '0')}`;
  }
  return null;
}

function parseDollars(raw) {
  if (raw == null || raw === '') return 0;
  const n = Number(String(raw).replace(/[$,]/g, ''));
  return Number.isFinite(n) ? n : 0;
}

async function getAccessToken() {
  // JWT-based service account flow. Avoids pulling in google-auth-library as a dep.
  const sa = JSON.parse(process.env.GOOGLE_SHEETS_SA_JSON);
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const claim = Buffer.from(JSON.stringify({
    iss: sa.client_email,
    scope: 'https://www.googleapis.com/auth/spreadsheets.readonly',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600
  })).toString('base64url');
  const signingInput = `${header}.${claim}`;
  const crypto = require('crypto');
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(signingInput);
  const signature = signer.sign(sa.private_key).toString('base64url');
  const jwt = `${signingInput}.${signature}`;

  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${jwt}`
  });
  if (!r.ok) throw new Error(`OAuth token failed ${r.status}: ${await r.text()}`);
  return (await r.json()).access_token;
}

exports.handler = async (event) => {
  try {
    const { start, end } = event.queryStringParameters || {};
    if (!start || !end) {
      return { statusCode: 400, body: JSON.stringify({ error: 'start and end (YYYY-MM-DD) required' }) };
    }

    const token = await getAccessToken();
    const url = `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${encodeURIComponent(RANGE)}?valueRenderOption=UNFORMATTED_VALUE`;
    const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!r.ok) throw new Error(`Sheets API ${r.status}: ${await r.text()}`);
    const data = await r.json();
    const rows = data.values || [];

    const entries = [];
    rows.forEach(row => {
      const date = parseDate(row[COL_DATE]);
      const employee = (row[COL_EMPLOYEE] || '').toString().trim();
      if (!date || !employee) return;
      if (date < start || date > end) return;
      const cashTips = parseDollars(row[COL_CASH_TIPS]);
      const cashPay = parseDollars(row[COL_CASH_PAY]);
      if (cashTips === 0 && cashPay === 0) return;
      entries.push({ date, employee, cash_tips: cashTips, cash_payments: cashPay });
    });

    // Aggregate per-day totals for sanity checks (cash out should match cash tips paid).
    const byDay = {};
    entries.forEach(e => {
      if (!byDay[e.date]) byDay[e.date] = { date: e.date, cash_tips: 0, cash_payments: 0 };
      byDay[e.date].cash_tips += e.cash_tips;
      byDay[e.date].cash_payments += e.cash_payments;
    });

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
      body: JSON.stringify({ entries, by_day: Object.values(byDay).sort((a, b) => a.date.localeCompare(b.date)) })
    };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
