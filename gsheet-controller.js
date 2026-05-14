import { config } from './config.js';

// CDP Activation for Tabs (borrowed from Webmaster)
async function activateTab(page) {
    const client = await page.createCDPSession();
    const targetId = page.target()._targetId;
    await client.send('Target.activateTarget', { targetId });
    await client.detach();
}

/**
 * Fetch data from Google Sheet using CSV export (no API key needed).
 * The sheet must be publicly accessible (Anyone with the link can view).
 * 
 * Returns an array of objects for rows where column G = "Yes":
 * [{ name: "col A", description: "col B", startTime: "col C", endTime: "col D", rowIndex: N }]
 */
export async function fetchSheetData(logCallback = console.log) {
    const csvUrl = `https://docs.google.com/spreadsheets/d/${config.sheetId}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent(config.sheetName || 'RPA_Promotion_AA')}`;

    logCallback('[GSheet] Fetching data from Google Sheet...');

    try {
        const response = await fetch(csvUrl);
        if (!response.ok) {
            throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }

        const csvText = await response.text();
        const rows = parseCSV(csvText);

        logCallback(`[GSheet] Total rows (incl. header): ${rows.length}`);

        if (rows.length < 2) {
            logCallback('[GSheet] No data rows found.');
            return [];
        }

        // Log header row for debugging
        logCallback(`[GSheet] Headers: ${rows[0].join(' | ')}`);

        // Skip header row (index 0), filter with dual-column conditions:
        // Column H (index 7) = "Yes" AND Column G (index 6) = "" (empty) or "Edit"
        // Rows with G = "Success" or "Fail" are skipped automatically
        const matchingRows = [];
        let skippedSuccess = 0;
        let skippedFail = 0;
        for (let i = 1; i < rows.length; i++) {
            const row = rows[i];
            const checkCol = (row[9] || '').trim(); // Column J (index 9) = Check_colunm
            const statusCol = (row[8] || '').trim(); // Column I (index 8) = Status

            if (checkCol.toLowerCase() !== 'yes') continue; // H must be "Yes"

            // Check Column G status
            const statusLower = statusCol.toLowerCase();
            if (statusLower === 'success') {
                skippedSuccess++;
                logCallback(`[GSheet] ↳ Row ${i + 1}: G="${statusCol}" → Skipped (already done)`);
                continue;
            }
            if (statusLower === 'failed') {
                skippedFail++;
                logCallback(`[GSheet] ↳ Row ${i + 1}: G="${statusCol}" → Skipped (previously failed)`);
                continue;
            }

            // G is empty or "Edit" → process this row
            if (statusCol === '' || statusLower === 'edit') {
                logCallback(`[GSheet] ↳ Row ${i + 1}: G="${statusCol || '(empty)'}" → Will process`);
                matchingRows.push({
                    templateId: (row[0] || '').trim(),      // Column A = Meta Data (Template Source)
                    name: (row[6] || '').trim(),            // Column G = Name (New)
                    description: (row[2] || '').trim(),     // Column C = Description (New)
                    startTime: (row[3] || '').trim(),       // Column D = Start Time (New)
                    endTime: (row[4] || '').trim(),          // Column E = End Time (New)
                    productArticle: (row[1] || '').trim(),  // Column B = Product Article
                    benefitArticle: (row[1] || '').trim(),  // Column B = Benefit Article
                    selectableItems: (row[5] || '').trim(), // Column F = Selectable Items (New)
                    rowIndex: i + 1 // 1-based row number in sheet
                });
            }
        }

        logCallback(`[GSheet] Found ${matchingRows.length} rows to process (Skipped: ${skippedSuccess} Success, ${skippedFail} Failed).`);
        return matchingRows;

    } catch (err) {
        logCallback(`[GSheet] ❌ Error fetching sheet: ${err.message}`);
        throw err;
    }
}

/**
 * Simple CSV parser that handles quoted fields with commas and newlines.
 */
function parseCSV(text) {
    const rows = [];
    let currentRow = [];
    let currentField = '';
    let inQuotes = false;

    for (let i = 0; i < text.length; i++) {
        const char = text[i];
        const nextChar = text[i + 1];

        if (inQuotes) {
            if (char === '"' && nextChar === '"') {
                currentField += '"';
                i++; // Skip escaped quote
            } else if (char === '"') {
                inQuotes = false;
            } else {
                currentField += char;
            }
        } else {
            if (char === '"') {
                inQuotes = true;
            } else if (char === ',') {
                currentRow.push(currentField);
                currentField = '';
            } else if (char === '\r' && nextChar === '\n') {
                currentRow.push(currentField);
                currentField = '';
                rows.push(currentRow);
                currentRow = [];
                i++; // Skip \n
            } else if (char === '\n') {
                currentRow.push(currentField);
                currentField = '';
                rows.push(currentRow);
                currentRow = [];
            } else {
                currentField += char;
            }
        }
    }

    // Last field/row
    if (currentField || currentRow.length > 0) {
        currentRow.push(currentField);
        rows.push(currentRow);
    }

    return rows;
}

export { activateTab };
