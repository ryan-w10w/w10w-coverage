// netlify/functions/sheets.js
// Proxies Google Sheets CSV export to avoid CORS issues
// No API key needed — sheet must be set to "Anyone with link can view"

const SHEET_ID = "1waxoeFqMEu4dvZFlcWeC-f7c06Rd-iuQ6rSXfbnrRGY";
const SHEET_NAME = "Fixed Costs";

exports.handler = async function(event, context) {
  const url = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/export?format=csv&sheet=${encodeURIComponent(SHEET_NAME)}`;

  try {
    const response = await fetch(url);
    if (!response.ok) {
      return {
        statusCode: 502,
        body: JSON.stringify({ error: "Could not fetch sheet", status: response.status })
      };
    }

    const csv = await response.text();
    const rows = csv.split('\n').map(row => {
      // Handle quoted CSV fields
      const result = [];
      let current = '';
      let inQuotes = false;
      for (let i = 0; i < row.length; i++) {
        if (row[i] === '"') {
          inQuotes = !inQuotes;
        } else if (row[i] === ',' && !inQuotes) {
          result.push(current.trim());
          current = '';
        } else {
          current += row[i];
        }
      }
      result.push(current.trim());
      return result;
    });

    // Find the TOTAL row — look for "TOTAL" in column A
    let fixedTotal = null;
    let totalRow = -1;
    for (let i = 0; i < rows.length; i++) {
      if (rows[i][0] && rows[i][0].toUpperCase().includes('TOTAL')) {
        // Column C (index 2) has the monthly total
        const raw = rows[i][2];
        if (raw) {
          // Strip $ and commas
          const num = parseFloat(raw.replace(/[$,]/g, ''));
          if (!isNaN(num)) {
            fixedTotal = num;
            totalRow = i + 1; // 1-indexed
          }
        }
        break;
      }
    }

    if (fixedTotal === null) {
      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
        body: JSON.stringify({ error: "TOTAL row not found", rowCount: rows.length })
      };
    }

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'public, max-age=3600' // cache for 1 hour
      },
      body: JSON.stringify({
        fixedMonthly: fixedTotal,
        fixedAnnual: fixedTotal * 12,
        source: "Fixed Costs sheet",
        totalRow: totalRow,
        fetchedAt: new Date().toISOString()
      })
    };

  } catch (err) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: err.message })
    };
  }
};
