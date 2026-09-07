/**
 * New endpoint for the mobile offline app.
 * It can coexist with the existing doGet(e) without changing the web UI.
 */
function doPost(e) {
  try {
    const payload = JSON.parse((e.postData && e.postData.contents) || '{}');
    if (payload.action === 'syncOfflineRecords') return handleOfflineSync_(payload);
    return jsonResponse_({ ok: false, error: 'Unknown action' });
  } catch (error) {
    return jsonResponse_({ ok: false, error: String(error) });
  }
}

function handleOfflineSync_(payload) {
  const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  const sheetName = '離線同步紀錄';
  const sheet = spreadsheet.getSheetByName(sheetName) || spreadsheet.insertSheet(sheetName);
  const headers = ['id', '建立時間', '類型', '名稱', '方案', '人員', '金額', '數量', '日期', '備註', '照片連結', '來源'];
  if (sheet.getLastRow() === 0) sheet.appendRow(headers);

  const ids = new Set(sheet.getLastRow() < 2 ? [] : sheet.getRange(2, 1, sheet.getLastRow() - 1, 1).getValues().flat());
  const acceptedIds = [];
  (payload.records || []).forEach(record => {
    if (ids.has(record.id)) { acceptedIds.push(record.id); return; }
    const photoUrl = saveOfflinePhoto_(record.photo, record.id);
    sheet.appendRow([record.id, record.createdAt || '', record.type || '', record.title || '', record.project || '', record.person || '', record.amount || '', record.quantity || '', record.due || '', record.note || '', photoUrl, payload.source || '']);
    acceptedIds.push(record.id);
  });
  return jsonResponse_({ ok: true, acceptedIds });
}

function jsonResponse_(data) {
  return ContentService.createTextOutput(JSON.stringify(data)).setMimeType(ContentService.MimeType.JSON);
}

function saveOfflinePhoto_(dataUrl, id) {
  if (!dataUrl) return '';
  const match = dataUrl.match(/^data:(.+);base64,(.+)$/);
  if (!match) return '';
  const folders = DriveApp.getFoldersByName('密室現場照片');
  const folder = folders.hasNext() ? folders.next() : DriveApp.createFolder('密室現場照片');
  const blob = Utilities.newBlob(Utilities.base64Decode(match[2]), match[1], `現場-${id}.jpg`);
  return folder.createFile(blob).getUrl();
}
