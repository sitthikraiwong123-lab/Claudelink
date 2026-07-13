/* ============================================================
   Schmoll Export/Warranty Form - Machine & Part Lookup Database
   Backend: Google Apps Script (bound to its own Spreadsheet)
   ============================================================

   This is a SEPARATE database from the WSP system - it only
   exists to power auto-fill inside index-2.html (the Export/
   Warranty PDF form). Same no-login design: a small trusted
   team, so there is no password check on the API.

   SETUP:
   1. Extensions -> Apps Script -> paste this file as Code.gs
   2. Run the function "setupMissingSheets" once (Run menu, or
      the "Lookup Admin" menu after reloading the spreadsheet) -
      this creates the Parts/Pending_Machines/Pending_Parts tabs
      automatically. Your existing "MC List" tab is used
      as-is for Machines; nothing about it needs to change.
   3. Deploy -> New deployment -> Web app
        Execute as: Me
        Who has access: Anyone
   4. Copy the deployment URL into index-2.html's LOOKUP_API_URL constant
*/

const SHEETS = {
  MACHINES: 'MC List',         // your existing tab - used as-is
  PARTS: 'Part No.',           // your existing tab - used as-is (note the trailing period)
  COMPANIONS: 'Companion'      // NEW optional tab: parts that are requisitioned together (see getCompanionGroups)
};

// Paste your Google Drive folder ID here (open the folder → copy the ID from the URL after /folders/)
const IMAGE_FOLDER_ID = '1CrTf-wl-7Bjsn4emxXViuJRi2LkSTzWA';

// Your "MC List" tab uses its own column names. This maps them to the
// standard field names the app expects, so nothing about your sheet needs to
// change. (Extra columns like "CNC version" and "Warranty Over" are simply
// carried through untouched - they don't need a mapping entry.)
const MACHINE_HEADER_MAP = {
  'Machine Serial Number': 'MachineNumber',
  'Customer name': 'CustomerName',
  'Machine Type': 'MachineType'
};
const MACHINE_HEADER_MAP_REVERSE = (function(map){
  const out = {};
  Object.keys(map).forEach(k => { out[map[k]] = k; });
  return out;
})(MACHINE_HEADER_MAP);

// "Part No." tab: only Article No. needs renaming (note the period); Description
// already matches. CNC Ver and the 9 "Suggestion word" alias columns pass
// through untouched - they're preserved in the synced data for future use
// (e.g. alias-based search), just not used by the simple exact-match
// auto-fill in index-2.html yet.
const PART_HEADER_MAP = {
  'Article No.': 'ArticleNo'
};
const PART_HEADER_MAP_REVERSE = (function(map){
  const out = {};
  Object.keys(map).forEach(k => { out[map[k]] = k; });
  return out;
})(PART_HEADER_MAP);

function doGet(e) { return handleRequest(e); }
function doPost(e) { return handleRequest(e); }

function handleRequest(e) {
  let result;
  try {
    const params = (e.postData && e.postData.contents) ? JSON.parse(e.postData.contents) : e.parameter;
    switch (params.action) {
      case 'fullSync':      result = fullSync(); break;
      case 'deltaSync':     result = deltaSync(params); break;
      case 'recordNew':     result = recordNew(params); break;
      case 'deleteRecord':  result = deleteRecord(params); break;
      case 'deleteAlias':   result = deleteAlias(params); break;
      case 'uploadImage':   result = uploadImage(params); break;
      case 'setImageURL':   result = setImageURL(params); break;
      case 'deleteAlias':   result = deleteAlias(params); break;
      case 'updatePart':    result = updatePart(params); break;
      case 'getEditLog':    result = getEditLog(params); break;
      case 'restorePart':   result = restorePart(params); break;
      case 'softDeletePart':     result = softDeletePart(params); break;
      case 'getRecycleBin':      result = getRecycleBin(params); break;
      case 'restoreDeletedPart': result = restoreDeletedPart(params); break;
      case 'saveCompanionSet':   result = saveCompanionSet(params); break;
      case 'deleteCompanionSet': result = deleteCompanionSet(params); break;
      case 'ping':          result = { success: true, time: Date.now() }; break;
      case 'debugHeaders':  result = debugHeaders(); break;
      default:              result = { success: false, error: 'Unknown action: ' + params.action };
    }
  } catch (err) {
    result = { success: false, error: String(err) };
  }
  return ContentService.createTextOutput(JSON.stringify(result)).setMimeType(ContentService.MimeType.JSON);
}

// ============================================================
// SHEET HELPERS
// ============================================================
function getSheet(name) {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(name);
  if (!sheet) throw new Error('Sheet not found: ' + name);
  return sheet;
}

// Finds a column by name, tolerating extra spaces / different casing in the
// real sheet header (e.g. "Description " or "description" both match "Description").
// Falls back to an exact match first (fast path), then a normalized comparison.
function findColIdx(headers, name) {
  let idx = headers.indexOf(name);
  if (idx !== -1) return idx;
  const target = String(name).trim().toLowerCase();
  for (let i = 0; i < headers.length; i++) {
    if (String(headers[i]).trim().toLowerCase() === target) return i;
  }
  return -1;
}

function sheetToObjects(name, headerMap) {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(name);
  if (!sheet) return [];
  const data = sheet.getDataRange().getValues();
  if (data.length < 2) return [];
  const headers = data[0];

  // Normalize the header map's keys too, so it still matches even if the real
  // sheet header has extra whitespace or different casing than expected.
  let normalizedMap = null;
  if (headerMap) {
    normalizedMap = {};
    Object.keys(headerMap).forEach(k => { normalizedMap[String(k).trim().toLowerCase()] = headerMap[k]; });
  }

  return data.slice(1)
    .filter(row => row.some(c => c !== '' && c !== null))
    .map(row => {
      const obj = {};
      headers.forEach((h, i) => {
        const hNorm = String(h).trim().toLowerCase();
        const key = (normalizedMap && normalizedMap[hNorm]) ? normalizedMap[hNorm] : String(h).trim();
        obj[key] = row[i];
      });
      return obj;
    });
}

// ============================================================
// SYNC
// ============================================================
function fullSync() {
  return {
    success: true,
    machines: sheetToObjects(SHEETS.MACHINES, MACHINE_HEADER_MAP),
    parts: sheetToObjects(SHEETS.PARTS, PART_HEADER_MAP),
    companions: getCompanionSets(),
    syncedAt: Date.now()
  };
}

// Reads the optional "Companion" tab. Each ROW is one "requisition-as-a-set":
//   Col A = Set Name, Col B = combined-image URL, Col C onwards = part Article
//   Nos (the FIRST one is the main/trigger part). No header row.
// Example:  WATERFILTER POLYMER | https://.../img | 72656 | 72657
//   → picking 72656 suggests 72657, and the set image goes on the main part.
// Managed in-app via the "ชุดเบิก" tab (saveCompanionSet / deleteCompanionSet).
// Optional: if the tab doesn't exist, returns [].
function getCompanionSets() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEETS.COMPANIONS);
  if (!sheet) return [];
  const data = sheet.getDataRange().getValues();
  const sets = [];
  data.forEach(function (row) {
    const name = String(row[0] == null ? '' : row[0]).trim();
    const image = String(row[1] == null ? '' : row[1]).trim();
    const parts = row.slice(2).map(function (c) { return String(c == null ? '' : c).trim(); }).filter(function (c) { return c !== ''; });
    if (name || parts.length) sets.push({ name: name, image: image, parts: parts, trigger: parts[0] || '' });
  });
  return sets;
}

// Find the 1-based row of a set by name (case-insensitive), or -1.
function findCompanionRow_(sheet, name) {
  const key = String(name || '').trim().toLowerCase();
  if (!key) return -1;
  const data = sheet.getDataRange().getValues();
  for (var r = 0; r < data.length; r++) {
    if (String(data[r][0] == null ? '' : data[r][0]).trim().toLowerCase() === key) return r + 1;
  }
  return -1;
}

// Upsert a set. params: { name, imageURL, parts:[...], origName? }
function saveCompanionSet(params) {
  const name = String(params.name || '').trim();
  if (!name) return { success: false, error: 'ต้องตั้งชื่อชุด' };
  const image = String(params.imageURL || '').trim();
  const parts = (params.parts || []).map(function (p) { return String(p || '').trim(); }).filter(function (p) { return p; });
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(SHEETS.COMPANIONS);
  if (!sheet) sheet = ss.insertSheet(SHEETS.COMPANIONS);

  const rowValues = [name, image].concat(parts);
  const origName = String(params.origName || name).trim();
  let rowNum = findCompanionRow_(sheet, origName);
  // if renaming to a name that already exists elsewhere, block
  if (origName.toLowerCase() !== name.toLowerCase()) {
    const clash = findCompanionRow_(sheet, name);
    if (clash !== -1 && clash !== rowNum) return { success: false, error: 'มีชุดชื่อ "' + name + '" อยู่แล้ว' };
  }
  if (rowNum === -1) {
    sheet.appendRow(rowValues);
  } else {
    // clear the old row first (it may have had more parts than the new one)
    sheet.getRange(rowNum, 1, 1, Math.max(sheet.getLastColumn(), rowValues.length)).clearContent();
    sheet.getRange(rowNum, 1, 1, rowValues.length).setValues([rowValues]);
  }
  return { success: true, name: name };
}

function deleteCompanionSet(params) {
  const name = String(params.name || '').trim();
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(SHEETS.COMPANIONS);
  if (!sheet) return { success: true };
  const rowNum = findCompanionRow_(sheet, name);
  if (rowNum !== -1) sheet.deleteRow(rowNum);
  return { success: true };
}

function deltaSync(params) {
  const since = Number(params.since) || 0;
  function filtered(name, headerMap) {
    return sheetToObjects(name, headerMap).filter(r => {
      if (!r.LastModified) return true;
      const t = new Date(r.LastModified).getTime();
      return isNaN(t) ? true : t > since;
    });
  }
  return {
    success: true,
    machines: filtered(SHEETS.MACHINES, MACHINE_HEADER_MAP),
    parts: filtered(SHEETS.PARTS, PART_HEADER_MAP),
    companions: getCompanionSets(), // small list — always sent in full, even on delta sync
    syncedAt: Date.now()
  };
}

// ============================================================
// RECORD NEW MACHINE/PART - typed straight into index-2.html
// when the number isn't found. Per your call: write directly
// into the master sheet immediately (no separate review stage).
// If something's wrong, just delete that row directly in the
// sheet - Google Sheets' own "File > Version history" already
// shows exactly what was added and when, so no extra tooling
// is needed for that.
// ============================================================
function appendDirectToMaster(sheetName, headerMap, data) {
  const sheet = getSheet(sheetName);
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  const row = headers.map(h => {
    if (h === 'LastModified') return new Date();
    const standardKey = (headerMap && headerMap[h]) ? headerMap[h] : h;
    return data[standardKey] !== undefined ? data[standardKey] : '';
  });
  sheet.appendRow(row);
}

const MASTER_SHEET_FOR_TYPE = {
  Machine: { name: SHEETS.MACHINES, map: MACHINE_HEADER_MAP },
  Part: { name: SHEETS.PARTS, map: PART_HEADER_MAP }
};

// Finds header columns that look like "Suggestion word..." regardless of exact
// spacing/numbering, so we don't depend on the sheet's exact column text.
function findAliasColumnIndexes(headers) {
  const out = [];
  headers.forEach((h, i) => { if (/suggestion\s*word/i.test(h)) out.push(i); });
  return out;
}

// Looks at the trailing number in each existing "Suggestion word" header
// (word1...word9) and returns the next number to use (10, 11, 12...).
function getNextAliasColumnNumber(headers, aliasCols) {
  let maxNum = 0;
  aliasCols.forEach(ci => {
    const m = String(headers[ci]).match(/(\d+)\s*$/);
    if (m) maxNum = Math.max(maxNum, parseInt(m[1], 10));
  });
  return maxNum + 1;
}

// ============================================================
// TOMBSTONES - when something is deleted via the app, we remember
// it for a while so a delayed offline-outbox replay from someone's
// phone can't resurrect data that was deliberately removed.
// ============================================================
const TOMBSTONE_SHEET = 'DeletedKeys';
const TOMBSTONE_WINDOW_MS = 7 * 24 * 3600 * 1000; // 7 days

function getTombstoneSheet() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(TOMBSTONE_SHEET);
  if (!sheet) {
    sheet = ss.insertSheet(TOMBSTONE_SHEET);
    sheet.getRange(1, 1, 1, 3).setValues([['Type', 'Key', 'DeletedAt']]);
    sheet.setFrozenRows(1);
  }
  return sheet;
}

function recordTombstone(type, key) {
  const sheet = getTombstoneSheet();
  sheet.appendRow([type, String(key).trim().toLowerCase(), new Date()]);
}

// Returns true if this key was deleted recently enough that we should refuse
// to silently re-insert it (a delayed offline sync trying to "undo" a deletion).
function wasRecentlyDeleted(type, key) {
  const sheet = getTombstoneSheet();
  const data = sheet.getDataRange().getValues();
  const keyLower = String(key).trim().toLowerCase();
  const cutoff = Date.now() - TOMBSTONE_WINDOW_MS;
  for (let r = data.length - 1; r >= 1; r--) {
    if (data[r][0] === type && String(data[r][1]).trim().toLowerCase() === keyLower) {
      const deletedAt = new Date(data[r][2]).getTime();
      if (deletedAt >= cutoff) return true;
    }
  }
  return false;
}

// ============================================================
// PART HELPERS
// ============================================================
function findRowByExactValue(data, colIdx, value) {
  const v = String(value).trim().toLowerCase();
  for (let r = 1; r < data.length; r++) {
    if (String(data[r][colIdx]).trim().toLowerCase() === v) return r;
  }
  return -1;
}

// Finds a CODELESS row (empty ArticleNo) whose Description or any alias
// column exactly matches the given text (case-insensitive).
function findCodelessRowMatching(data, articleNoColIdx, descColIdx, aliasCols, text, excludeRow) {
  const v = String(text).trim().toLowerCase();
  if (!v) return -1;
  for (let r = 1; r < data.length; r++) {
    if (r === excludeRow) continue;
    if (String(data[r][articleNoColIdx]).trim()) continue; // has a code already, skip
    if (String(data[r][descColIdx] || '').trim().toLowerCase() === v) return r;
    for (let i = 0; i < aliasCols.length; i++) {
      if (String(data[r][aliasCols[i]] || '').trim().toLowerCase() === v) return r;
    }
  }
  return -1;
}

function recordNewPart(params, target) {
  const sheet = getSheet(target.name);
  const data = sheet.getDataRange().getValues();
  const headers = data[0];

  let realArticleNoHeader = 'ArticleNo';
  Object.keys(target.map).forEach(rh => { if (target.map[rh] === 'ArticleNo') realArticleNoHeader = rh; });
  const articleNoColIdx = findColIdx(headers, realArticleNoHeader);
  const descColIdx = findColIdx(headers, "Description");
  const aliasCols = findAliasColumnIndexes(headers);

  const newArticleNo = String((params.data || {}).ArticleNo || '').trim();
  const newDesc = String((params.data || {}).Description || '').trim();

  // ----- No Article No given: codeless entry (name known, code not known yet) -----
  if (!newArticleNo) {
    if (!newDesc) return { success: true, action: 'noop_empty' };
    if (wasRecentlyDeleted('Part', newDesc)) return { success: true, action: 'blocked_recently_deleted' };
    const dup = findCodelessRowMatching(data, articleNoColIdx, descColIdx, aliasCols, newDesc, -1);
    if (dup !== -1) return { success: true, action: 'duplicate_noop' };
    appendDirectToMaster(target.name, target.map, params.data || {});
    return { success: true, action: 'inserted_codeless' };
  }

  if (wasRecentlyDeleted('Part', newArticleNo)) return { success: true, action: 'blocked_recently_deleted' };

  // ----- Article No given -----
  const existingRow = findRowByExactValue(data, articleNoColIdx, newArticleNo);

  if (existingRow === -1) {
    // Genuinely new Article No - but maybe a codeless row should "graduate" into it
    // instead of creating a duplicate-looking second entry for the same part.
    const codelessRow = findCodelessRowMatching(data, articleNoColIdx, descColIdx, aliasCols, newDesc, -1);
    if (codelessRow !== -1) {
      sheet.getRange(codelessRow + 1, articleNoColIdx + 1).setValue(newArticleNo);
      return { success: true, action: 'graduated_codeless' };
    }
    appendDirectToMaster(target.name, target.map, params.data || {});
    return { success: true, action: 'inserted' };
  }

  // Article No already exists - is the description actually new info?
  let resultAction = 'duplicate_noop';
  if (newDesc) {
    const existingDesc = String(data[existingRow][descColIdx] || '').trim();
    if (newDesc.toLowerCase() !== existingDesc.toLowerCase()) {
      const alreadyKnown = aliasCols.some(ci =>
        String(data[existingRow][ci] || '').trim().toLowerCase() === newDesc.toLowerCase());
      if (!alreadyKnown) {
        const emptyCol = aliasCols.find(ci => !String(data[existingRow][ci] || '').trim());
        if (emptyCol === undefined) {
          const nextNum = getNextAliasColumnNumber(headers, aliasCols);
          const newColIdx1Based = sheet.getLastColumn() + 1;
          sheet.getRange(1, newColIdx1Based).setValue('Suggestion word' + nextNum);
          sheet.getRange(existingRow + 1, newColIdx1Based).setValue(newDesc);
          resultAction = 'alias_added_new_column';
        } else {
          sheet.getRange(existingRow + 1, emptyCol + 1).setValue(newDesc);
          resultAction = 'alias_added';
        }
      }
    }
  }

  // Cleanup: if a separate codeless row turns out to describe this same part
  // (matches the Description we just confirmed belongs under this Article No),
  // fold it in - it's now redundant.
  const orphan = findCodelessRowMatching(data, articleNoColIdx, descColIdx, aliasCols, newDesc, existingRow);
  if (orphan !== -1) {
    sheet.deleteRow(orphan + 1);
    resultAction += '+merged_codeless_deleted';
  }

  return { success: true, action: resultAction };
}

// Diagnostic: shows the EXACT raw header text (quotes reveal hidden whitespace)
// for both sheets, so header-matching issues can be confirmed without guessing.
// Uploads a base64-encoded image to the configured Drive folder and returns a
// public view URL.  Requires IMAGE_FOLDER_ID to be set in the config above AND
// the Drive API to be authorized (Apps Script will ask on first deploy).
function uploadImage(params) {
  if (IMAGE_FOLDER_ID === 'PASTE_YOUR_DRIVE_FOLDER_ID_HERE') {
    throw new Error('IMAGE_FOLDER_ID ยังไม่ได้ตั้งค่าใน Code.gs — เปิด folder ใน Drive แล้ว copy ID จาก URL มาใส่');
  }
  const base64 = params.base64;
  const mimeType = params.mimeType || 'image/jpeg';
  const filename = params.filename || ('part_' + Date.now() + '.jpg');
  if (!base64) throw new Error('No base64 image data provided');

  const folder = DriveApp.getFolderById(IMAGE_FOLDER_ID);
  const bytes = Utilities.base64Decode(base64);
  const blob = Utilities.newBlob(bytes, mimeType, filename);
  const file = folder.createFile(blob);
  file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);

  // Use the thumbnail-friendly URL format that works reliably in <img> tags
  const fileId = file.getId();
  const url = 'https://lh3.googleusercontent.com/d/' + fileId;
  return { success: true, url: url, fileId: fileId };
}

// Writes an image URL into the ImageURL column for an existing coded part.
// Called after uploadImage succeeds for a part that was coded but had no image yet.
function setImageURL(params) {
  const articleNo = String(params.articleNo || '').trim();
  const url = String(params.url || '').trim();
  if (!articleNo || !url) throw new Error('articleNo and url are required');

  const sheet = getSheet(SHEETS.PARTS);
  const data = sheet.getDataRange().getValues();
  const headers = data[0];

  let realArticleNoHeader = 'Article No.';
  Object.keys(PART_HEADER_MAP).forEach(rh => { if (PART_HEADER_MAP[rh] === 'ArticleNo') realArticleNoHeader = rh; });
  const articleNoColIdx = findColIdx(headers, realArticleNoHeader);
  const imageUrlColIdx = findColIdx(headers, 'ImageURL');

  if (imageUrlColIdx === -1) {
    throw new Error('ImageURL column not found in "' + SHEETS.PARTS + '" tab — please add it first');
  }

  const keyLower = articleNo.toLowerCase();
  for (let r = 1; r < data.length; r++) {
    if (String(data[r][articleNoColIdx]).trim().toLowerCase() !== keyLower) continue;
    sheet.getRange(r + 1, imageUrlColIdx + 1).setValue(url);
    return { success: true, updated: true, row: r + 1 };
  }
  return { success: true, updated: false, message: 'ArticleNo not found in sheet' };
}

function debugHeaders() {
  const machinesSheet = getSheet(SHEETS.MACHINES);
  const partsSheet = getSheet(SHEETS.PARTS);
  const machinesHeaders = machinesSheet.getRange(1, 1, 1, machinesSheet.getLastColumn()).getValues()[0];
  const partsHeaders = partsSheet.getRange(1, 1, 1, partsSheet.getLastColumn()).getValues()[0];
  return {
    success: true,
    machinesSheetName: SHEETS.MACHINES,
    machinesHeadersRaw: machinesHeaders.map(h => JSON.stringify(h)),
    partsSheetName: SHEETS.PARTS,
    partsHeadersRaw: partsHeaders.map(h => JSON.stringify(h))
  };
}

function recordNew(params) {
  const target = MASTER_SHEET_FOR_TYPE[params.type];
  if (!target) throw new Error('Invalid type: ' + params.type);

  if (params.type === 'Part') {
    return recordNewPart(params, target);
  }

  // ----- Machine (no codeless/alias concept - simple key-based dedup) -----
  const keyValue = String((params.data || {}).MachineNumber || '').trim();
  if (!keyValue) throw new Error('No MachineNumber provided');
  if (wasRecentlyDeleted('Machine', keyValue)) return { success: true, action: 'blocked_recently_deleted' };

  const sheet = getSheet(target.name);
  const data = sheet.getDataRange().getValues();
  const headers = data[0];
  let realKeyHeader = 'MachineNumber';
  Object.keys(target.map).forEach(rh => { if (target.map[rh] === 'MachineNumber') realKeyHeader = rh; });
  const keyColIdx = findColIdx(headers, realKeyHeader);

  const existingRow = findRowByExactValue(data, keyColIdx, keyValue);
  if (existingRow === -1) {
    appendDirectToMaster(target.name, target.map, params.data || {});
    return { success: true, action: 'inserted' };
  }
  return { success: true, action: 'duplicate_noop' };
}

// Deletes the row(s) matching the given key (MachineNumber or ArticleNo) from the
// real sheet - used when the person wants to undo something they just recorded.
// Also leaves a tombstone so a delayed offline sync can't bring it back.
function deleteRecord(params) {
  const target = MASTER_SHEET_FOR_TYPE[params.type];
  if (!target) throw new Error('Invalid type: ' + params.type);
  const keyField = params.byField === 'Description' ? 'Description' : (params.type === 'Machine' ? 'MachineNumber' : 'ArticleNo');
  const keyValue = String(params.key || '').trim().toLowerCase();
  if (!keyValue) throw new Error('No key provided to delete');

  const sheet = getSheet(target.name);
  const data = sheet.getDataRange().getValues();
  const headers = data[0];
  let realHeaderName = keyField;
  Object.keys(target.map).forEach(realHeader => {
    if (target.map[realHeader] === keyField) realHeaderName = realHeader;
  });
  const colIdx = findColIdx(headers, realHeaderName);
  if (colIdx === -1) throw new Error('Could not find column: ' + realHeaderName);

  // When deleting a codeless Part by Description, only touch rows that are
  // actually codeless (empty Article No) - never delete a real coded part
  // just because its canonical name happens to match the text.
  let articleNoColIdx = -1;
  if (params.type === 'Part' && keyField === 'Description') {
    let realArticleNoHeader = 'ArticleNo';
    Object.keys(target.map).forEach(rh => { if (target.map[rh] === 'ArticleNo') realArticleNoHeader = rh; });
    articleNoColIdx = findColIdx(headers, realArticleNoHeader);
  }

  let deletedCount = 0;
  for (let r = data.length - 1; r >= 1; r--) {
    if (String(data[r][colIdx]).trim().toLowerCase() !== keyValue) continue;
    if (articleNoColIdx !== -1 && String(data[r][articleNoColIdx]).trim()) continue; // has a code now - don't delete
    sheet.deleteRow(r + 1);
    deletedCount++;
  }
  if (deletedCount > 0) recordTombstone(params.type, keyValue);
  return { success: true, deletedCount: deletedCount };
}

// Clears a single Suggestion-word cell for a given Article No.
// params: { articleNo, columnName } - columnName is the exact header of the alias column to clear.
function deleteAlias(params) {
  const target = MASTER_SHEET_FOR_TYPE['Part'];
  const articleNo = String(params.articleNo || '').trim();
  const colName   = String(params.columnName || '').trim();
  if (!articleNo || !colName) throw new Error('articleNo and columnName are required');

  const sheet = getSheet(target.name);
  const data = sheet.getDataRange().getValues();
  const headers = data[0];

  let realArticleNoHeader = 'ArticleNo';
  Object.keys(target.map).forEach(rh => { if (target.map[rh] === 'ArticleNo') realArticleNoHeader = rh; });
  const articleNoColIdx = findColIdx(headers, realArticleNoHeader);
  const aliasColIdx     = findColIdx(headers, colName);
  if (aliasColIdx === -1) throw new Error('Column not found: ' + colName);

  const keyLower = articleNo.toLowerCase();
  for (let r = 1; r < data.length; r++) {
    if (String(data[r][articleNoColIdx]).trim().toLowerCase() !== keyLower) continue;
    sheet.getRange(r + 1, aliasColIdx + 1).setValue('');
    return { success: true, cleared: colName };
  }
  return { success: true, cleared: null };
}

// ============================================================
// AUDITED PART EDIT — updatePart / getEditLog / restorePart
// Every edit here (a) requires an editor name, (b) backs up the previous row
// to the "EditLog" tab BEFORE changing, and (c) can be restored later.
// ============================================================
const EDITLOG_SHEET = 'EditLog';
const EDITLOG_HEADERS = ['Timestamp', 'Editor', 'Action', 'ArticleNo', 'NewArticleNo', 'OldData', 'NewData'];

function getEditLogSheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(EDITLOG_SHEET);
  if (!sh) { sh = ss.insertSheet(EDITLOG_SHEET); sh.appendRow(EDITLOG_HEADERS); }
  return sh;
}

function safeParse_(s) { try { return JSON.parse(s); } catch (e) { return null; } }

function partsSheetInfo_() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEETS.PARTS);
  if (!sheet) throw new Error('Sheet not found: ' + SHEETS.PARTS);
  const data = sheet.getDataRange().getValues();
  const headers = data[0];
  let realArticleNoHeader = 'Article No.';
  Object.keys(PART_HEADER_MAP).forEach(function (rh) { if (PART_HEADER_MAP[rh] === 'ArticleNo') realArticleNoHeader = rh; });
  return {
    sheet: sheet, data: data, headers: headers,
    articleNoCol: findColIdx(headers, realArticleNoHeader),
    descCol: findColIdx(headers, 'Description'),
    imageCol: findColIdx(headers, 'ImageURL'),
    aliasCols: findAliasColumnIndexes(headers)
  };
}

// Returns { rowIndex0, obj } for the row whose ArticleNo matches (case-insensitive), else null.
function findPartRow_(info, articleNo) {
  const key = String(articleNo || '').trim().toLowerCase();
  if (!key) return null;
  for (let r = 1; r < info.data.length; r++) {
    if (String(info.data[r][info.articleNoCol]).trim().toLowerCase() === key) {
      const obj = {};
      info.headers.forEach(function (h, i) { obj[String(h).trim()] = info.data[r][i]; });
      return { rowIndex0: r, obj: obj };
    }
  }
  return null;
}

function updatePart(params) {
  const editor = String(params.editor || '').trim();
  if (!editor) return { success: false, error: 'ต้องระบุชื่อผู้แก้ไขก่อน (editor required)' };
  const origArticleNo = String(params.origArticleNo || '').trim();
  if (!origArticleNo) return { success: false, error: 'origArticleNo required' };

  const info = partsSheetInfo_();
  const found = findPartRow_(info, origArticleNo);
  if (!found) return { success: false, error: 'ไม่พบอะไหล่รหัส ' + origArticleNo };
  const rowNum = found.rowIndex0 + 1;
  const oldData = found.obj;

  const newArticleNo = (params.newArticleNo !== undefined) ? String(params.newArticleNo).trim() : origArticleNo;
  const renaming = newArticleNo && newArticleNo.toLowerCase() !== origArticleNo.toLowerCase();
  if (renaming && findPartRow_(info, newArticleNo)) {
    return { success: false, error: 'รหัส ' + newArticleNo + ' มีอยู่แล้ว เปลี่ยนไม่ได้' };
  }

  // ----- back up BEFORE changing -----
  const imgHeader = info.imageCol >= 0 ? String(info.headers[info.imageCol]).trim() : null;
  const newDataPreview = {
    ArticleNo: newArticleNo,
    Description: (params.newDescription !== undefined) ? String(params.newDescription) : oldData['Description'],
    ImageURL: (params.imageURL !== undefined) ? String(params.imageURL) : (imgHeader ? oldData[imgHeader] : ''),
    aliases: (params.aliases !== undefined) ? params.aliases : undefined
  };
  getEditLogSheet_().appendRow([new Date(), editor, 'update', origArticleNo, newArticleNo, JSON.stringify(oldData), JSON.stringify(newDataPreview)]);

  // ----- apply -----
  if (params.newDescription !== undefined && info.descCol >= 0)
    info.sheet.getRange(rowNum, info.descCol + 1).setValue(String(params.newDescription));

  if (params.imageURL !== undefined) {
    let imgCol = info.imageCol;
    if (imgCol < 0) { imgCol = info.headers.length; info.sheet.getRange(1, imgCol + 1).setValue('ImageURL'); }
    info.sheet.getRange(rowNum, imgCol + 1).setValue(String(params.imageURL));
  }

  if (params.aliases !== undefined) {
    const aliases = (params.aliases || []).map(function (a) { return String(a || '').trim(); }).filter(function (a) { return a; });
    info.aliasCols.forEach(function (ci) { info.sheet.getRange(rowNum, ci + 1).setValue(''); });
    let headers = info.sheet.getRange(1, 1, 1, info.sheet.getLastColumn()).getValues()[0];
    let aliasCols = findAliasColumnIndexes(headers);
    for (let i = 0; i < aliases.length; i++) {
      if (i < aliasCols.length) {
        info.sheet.getRange(rowNum, aliasCols[i] + 1).setValue(aliases[i]);
      } else {
        const nextNum = getNextAliasColumnNumber(headers, aliasCols);
        const newColIdx1 = info.sheet.getLastColumn() + 1;
        info.sheet.getRange(1, newColIdx1).setValue('Suggestion word' + nextNum);
        info.sheet.getRange(rowNum, newColIdx1).setValue(aliases[i]);
        headers = info.sheet.getRange(1, 1, 1, info.sheet.getLastColumn()).getValues()[0];
        aliasCols = findAliasColumnIndexes(headers);
      }
    }
  }

  // rename LAST, so all the lookups above matched on the original key
  if (renaming) info.sheet.getRange(rowNum, info.articleNoCol + 1).setValue(newArticleNo);

  return { success: true, articleNo: newArticleNo };
}

function getEditLog(params) {
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(EDITLOG_SHEET);
  if (!sh) return { success: true, entries: [] };
  const data = sh.getDataRange().getValues();
  if (data.length < 2) return { success: true, entries: [] };
  const wantArticle = params && params.articleNo ? String(params.articleNo).trim().toLowerCase() : null;
  const limit = Number(params && params.limit) || 100;
  const out = [];
  for (let r = data.length - 1; r >= 1 && out.length < limit; r--) {
    const artA = String(data[r][3] || '').trim().toLowerCase();
    const artB = String(data[r][4] || '').trim().toLowerCase();
    if (wantArticle && artA !== wantArticle && artB !== wantArticle) continue;
    out.push({
      rowIndex: r + 1,
      timestamp: data[r][0] ? new Date(data[r][0]).getTime() : null,
      editor: data[r][1], action: data[r][2],
      articleNo: data[r][3], newArticleNo: data[r][4],
      oldData: safeParse_(data[r][5]), newData: safeParse_(data[r][6])
    });
  }
  return { success: true, entries: out };
}

function restorePart(params) {
  const editor = String(params.editor || '').trim();
  if (!editor) return { success: false, error: 'ต้องระบุชื่อผู้แก้ไขก่อน (editor required)' };
  const logRow = Number(params.rowIndex);
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(EDITLOG_SHEET);
  if (!sh || !logRow) return { success: false, error: 'ไม่พบรายการสำรอง' };
  const logVals = sh.getRange(logRow, 1, 1, EDITLOG_HEADERS.length).getValues()[0];
  const oldData = safeParse_(logVals[5]);
  const origArticleNo = String(logVals[3] || '').trim();
  const newArticleNo = String(logVals[4] || '').trim() || origArticleNo;
  if (!oldData) return { success: false, error: 'ข้อมูลสำรองเสียหาย' };

  const info = partsSheetInfo_();
  const found = findPartRow_(info, newArticleNo) || findPartRow_(info, origArticleNo);
  if (!found) return { success: false, error: 'ไม่พบอะไหล่ที่จะกู้คืน' };
  const rowNum = found.rowIndex0 + 1;
  const curArticle = String(found.obj[String(info.headers[info.articleNoCol]).trim()] || '').trim();

  getEditLogSheet_().appendRow([new Date(), editor, 'restore', curArticle, origArticleNo, JSON.stringify(found.obj), JSON.stringify(oldData)]);

  info.headers.forEach(function (h, i) {
    const key = String(h).trim();
    if (Object.prototype.hasOwnProperty.call(oldData, key)) info.sheet.getRange(rowNum, i + 1).setValue(oldData[key]);
  });
  return { success: true, articleNo: origArticleNo };
}

// ============================================================
// SOFT DELETE + RECYCLE BIN (BACKUP) — softDeletePart / getRecycleBin /
//   restoreDeletedPart
// Deleting a part from the edit page does NOT remove it for good. The whole
// original row is copied into a "RecycleBin" tab (with who/when), then the row
// is removed from the live "Part No." sheet. From the app's ถังขยะ (Recycle
// Bin) tab it can be restored back into the live sheet at any time.
// ============================================================
const RECYCLEBIN_SHEET = 'RecycleBin';
// RowData = JSON of the whole original row (header -> value), so a restore can
// rebuild every column exactly, even columns the app doesn't otherwise use.
const RECYCLEBIN_HEADERS = ['DeletedAt', 'DeletedBy', 'ArticleNo', 'Description', 'RowData'];

function getRecycleBinSheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(RECYCLEBIN_SHEET);
  if (!sh) {
    sh = ss.insertSheet(RECYCLEBIN_SHEET);
    sh.appendRow(RECYCLEBIN_HEADERS);
    sh.setFrozenRows(1);
  }
  return sh;
}

// Move ONE part into the recycle bin (backup + remove from live sheet).
// params: { articleNo, editor }
function softDeletePart(params) {
  const editor = String(params.editor || '').trim();
  if (!editor) return { success: false, error: 'ต้องลงชื่อผู้แก้ไขก่อน (editor required)' };
  const articleNo = String(params.articleNo || '').trim();
  if (!articleNo) return { success: false, error: 'articleNo required' };

  const info = partsSheetInfo_();
  const found = findPartRow_(info, articleNo);
  if (!found) return { success: false, error: 'ไม่พบอะไหล่รหัส ' + articleNo };
  const rowNum = found.rowIndex0 + 1;
  const oldData = found.obj;

  // 1) back up the full row into the RecycleBin tab BEFORE removing it
  getRecycleBinSheet_().appendRow([
    new Date(), editor, articleNo, String(oldData['Description'] || ''), JSON.stringify(oldData)
  ]);
  // 2) leave an audit trail in the EditLog timeline as well
  getEditLogSheet_().appendRow([new Date(), editor, 'delete', articleNo, '', JSON.stringify(oldData), '']);
  // 3) remove from the live sheet + tombstone it (blocks a stale offline re-insert)
  info.sheet.deleteRow(rowNum);
  recordTombstone('Part', articleNo);

  return { success: true, articleNo: articleNo };
}

// List everything currently in the recycle bin, newest first.
function getRecycleBin(params) {
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(RECYCLEBIN_SHEET);
  if (!sh) return { success: true, entries: [] };
  const data = sh.getDataRange().getValues();
  if (data.length < 2) return { success: true, entries: [] };
  const limit = Number(params && params.limit) || 200;
  const out = [];
  for (let r = data.length - 1; r >= 1 && out.length < limit; r--) {
    // skip blank rows (e.g. after a restore removed the row)
    if (!String(data[r][2] || '').trim() && !String(data[r][4] || '').trim()) continue;
    out.push({
      rowIndex: r + 1,
      deletedAt: data[r][0] ? new Date(data[r][0]).getTime() : null,
      deletedBy: data[r][1],
      articleNo: data[r][2],
      description: data[r][3]
    });
  }
  return { success: true, entries: out };
}

// Put a recycle-bin row back into the live "Part No." sheet, then remove it
// from the bin. Rejects if that Article No. already exists live again.
// params: { rowIndex, editor }
function restoreDeletedPart(params) {
  const editor = String(params.editor || '').trim();
  if (!editor) return { success: false, error: 'ต้องลงชื่อผู้แก้ไขก่อน (editor required)' };
  const binRow = Number(params.rowIndex);
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(RECYCLEBIN_SHEET);
  if (!sh || !binRow) return { success: false, error: 'ไม่พบรายการในถังขยะ' };

  const vals = sh.getRange(binRow, 1, 1, RECYCLEBIN_HEADERS.length).getValues()[0];
  const articleNo = String(vals[2] || '').trim();
  const rowData = safeParse_(vals[4]);
  if (!rowData) return { success: false, error: 'ข้อมูลสำรองเสียหาย' };

  const info = partsSheetInfo_();
  if (articleNo && findPartRow_(info, articleNo)) {
    return { success: false, error: 'รหัส ' + articleNo + ' มีอยู่ในฐานข้อมูลแล้ว กู้คืนไม่ได้' };
  }

  // rebuild the row in the live sheet's column order; stamp LastModified so it
  // flows back out on the next delta sync.
  const sheet = getSheet(SHEETS.PARTS);
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  const newRow = headers.map(function (h) {
    const key = String(h).trim();
    if (key === 'LastModified') return new Date();
    return Object.prototype.hasOwnProperty.call(rowData, key) ? rowData[key] : '';
  });
  sheet.appendRow(newRow);

  // audit + clear the bin row
  getEditLogSheet_().appendRow([new Date(), editor, 'restore-deleted', articleNo, '', '', JSON.stringify(rowData)]);
  sh.deleteRow(binRow);

  return { success: true, articleNo: articleNo };
}
