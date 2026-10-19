/**
 * Google Apps Script (GAS) 抽獎系統後端 Web App API
 *
 * 功能：
 * 1. 提供 doGet API，讀取 Google Form 表單回應名單與獎品設定分頁。
 * 2. 資料清理與正規化（過濾空白列、修剪字串、型別轉換）。
 * 3. 參加者身分識別：學號 > 活動識別碼 > 手機號碼 > 系統識別碼，並處理重複報名與衝突。
 * 4. 輸出符合前端抽獎系統規範之 JSON 格式（schemaVersion 2）。
 */

// 設定預設工作表名稱
const CONFIG = {
  // 獎品分頁名稱候選清單
  PRIZE_SHEET_NAMES: ['獎品設定', '獎品清單', 'Prizes', 'Prize'],
  // 人員名冊分頁名稱候選清單（若未比對成功則預設使用第一個工作表）
  PARTICIPANT_SHEET_NAMES: ['表單回應 1', '表單回應', 'Form Responses 1', 'Form Responses', '參加名單', 'Participants'],
  // 系統識別碼欄位標題（第一個為自動建立欄位時使用的名稱）
  ROW_UID_HEADERS: ['系統識別碼', 'Row UID'],
  // 視為「未填寫」的佔位值（比對時不分大小寫）
  PLACEHOLDER_VALUES: ['無', '沒有', '無學號', 'n/a', 'na', 'none', 'null', '-', '--', '0', 'x']
};

const SCHEMA_VERSION = 2;

/**
 * Web App GET 請求處理入口
 */
function doGet(e) {
  try {
    const data = getLotteryData();
    return createJsonResponse({
      status: 'success',
      schemaVersion: SCHEMA_VERSION,
      timestamp: new Date().toISOString(),
      prizes: data.prizes,
      participants: data.participants,
      warnings: data.warnings
    });
  } catch (error) {
    return createJsonResponse({
      status: 'error',
      message: error.toString(),
      prizes: [],
      participants: [],
      warnings: []
    });
  }
}

/**
 * 表單送出觸發器：為新回應寫入系統識別碼（由 setupTriggers() 安裝）
 */
function onFormSubmit(e) {
  const sheet = e && e.range ? e.range.getSheet() : findSheet(getTargetSpreadsheet(), CONFIG.PARTICIPANT_SHEET_NAMES, 0);
  ensureRowIds(sheet);
}

/**
 * 建立標準 JSON HTTP 回應物件
 */
function createJsonResponse(data) {
  const output = ContentService.createTextOutput(JSON.stringify(data));
  output.setMimeType(ContentService.MimeType.JSON);
  return output;
}

/**
 * 取得試算表實例（支援作用中試算表或指定試算表 ID）
 */
function getTargetSpreadsheet() {
  try {
    return SpreadsheetApp.getActiveSpreadsheet();
  } catch (e) {
    // 若為獨立腳本，可透過 Script Properties 設定 SPREADSHEET_ID
    const propId = PropertiesService.getScriptProperties().getProperty('SPREADSHEET_ID');
    if (propId) {
      return SpreadsheetApp.openById(propId);
    }
    throw new Error('無法取得 Google 試算表，請綁定於容器試算表或設定 SPREADSHEET_ID 屬性。');
  }
}

/**
 * 依候選名稱查找工作表，若未找到可指定是否 fallback 至預設
 */
function findSheet(ss, candidateNames, fallbackToIndex = -1) {
  const sheets = ss.getSheets();
  for (let i = 0; i < candidateNames.length; i++) {
    const sheet = ss.getSheetByName(candidateNames[i]);
    if (sheet) return sheet;
  }
  if (fallbackToIndex >= 0 && sheets.length > fallbackToIndex) {
    return sheets[fallbackToIndex];
  }
  return null;
}

/**
 * 讀取並標準化試算表資料
 */
function getLotteryData() {
  const ss = getTargetSpreadsheet();
  if (!ss) {
    throw new Error('未找到 Google 試算表。');
  }

  // 1. 讀取獎品分頁
  const prizeSheet = findSheet(ss, CONFIG.PRIZE_SHEET_NAMES);
  const rawPrizes = prizeSheet ? prizeSheet.getDataRange().getValues() : [];
  const prizeResult = parsePrizes(rawPrizes);

  // 2. 讀取人員分頁（若未找到指定名稱則預設取第一個分頁）
  const participantSheet = findSheet(ss, CONFIG.PARTICIPANT_SHEET_NAMES, 0);
  const warnings = prizeResult.warnings.slice();
  let participants = [];

  if (participantSheet) {
    // 先補齊缺漏的系統識別碼，再讀取資料
    const uidResult = ensureRowIds(participantSheet);
    if (!uidResult.ok) {
      warnings.push({
        type: 'row_uid_write_failed',
        message: '系統識別碼寫入失敗（' + uidResult.error + '），缺少識別資料的人員已排除於抽獎名單。',
        rows: []
      });
    }
    const rawParticipants = participantSheet.getDataRange().getValues();
    const participantResult = parseParticipants(rawParticipants, { salt: getPhoneSalt_ });
    participants = participantResult.participants;
    Array.prototype.push.apply(warnings, participantResult.warnings);
  }

  return {
    prizes: prizeResult.prizes,
    participants: participants,
    warnings: warnings
  };
}

/**
 * 解析並正規化獎品資料 (Output Data Format Normalization)
 * 獎品 id 以「獎品代碼」或「獎品名稱」產生，不依賴列號，分頁重排後仍能對應中獎紀錄。
 */
function parsePrizes(rows) {
  if (!rows || rows.length <= 1) return { prizes: [], warnings: [] };

  const headers = rows[0].map(h => String(h || '').trim());
  const nameIndex = findColumnIndex(headers, ['獎品名稱', '獎項名稱', '獎品', '名稱', 'Prize', 'Name']);
  const quotaIndex = findColumnIndex(headers, ['配額', '數量', '總數', '名額', 'Quota', 'Count', 'Quantity']);
  const orderIndex = findColumnIndex(headers, ['順序', '抽獎順序', 'Order', 'Sort']);
  const descIndex = findColumnIndex(headers, ['說明', '備註', 'Description', 'Desc']);
  const codeIndex = findColumnIndex(headers, ['獎品代碼', '獎項代碼', 'Prize Code', 'Prize ID']);

  const prizes = [];
  const seenIds = {};
  const duplicateRows = [];
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    if (isRowEmpty(row)) continue;

    const name = nameIndex >= 0 ? String(row[nameIndex] || '').trim() : String(row[0] || '').trim();
    if (!name) continue;

    const rawQuota = quotaIndex >= 0 ? row[quotaIndex] : 1;
    const quota = Math.max(0, parseInt(rawQuota, 10) || 0);

    const rawOrder = orderIndex >= 0 ? row[orderIndex] : i;
    const order = parseInt(rawOrder, 10) || i;

    const description = descIndex >= 0 ? String(row[descIndex] || '').trim() : '';

    const code = codeIndex >= 0 ? normalizeCode(row[codeIndex]) : '';
    const id = code ? 'prize:' + code : 'prize-name:' + normalizeText(name);
    if (seenIds[id]) {
      // 同代碼或同名稱的獎品無法穩定區分，只保留第一筆
      duplicateRows.push(i + 1);
      continue;
    }
    seenIds[id] = true;

    prizes.push({
      id: id,
      name: name,
      quota: quota,
      order: order,
      description: description
    });
  }

  // 依抽獎順序排序
  prizes.sort((a, b) => a.order - b.order);

  const warnings = [];
  if (duplicateRows.length > 0) {
    warnings.push({
      type: 'prize_duplicate',
      message: '獎品分頁有重複的獎品名稱或代碼，已略過重複列。若確實為不同獎項，請填寫不同的「獎品代碼」。',
      rows: duplicateRows
    });
  }
  return { prizes: prizes, warnings: warnings };
}

/**
 * 解析並正規化抽獎人員資料 (支援大學生名冊：系所、年級、姓名)
 *
 * 識別鍵優先序：學號 (sid:) > 活動識別碼 (code:) > 手機號碼 (tel:) > 系統識別碼 (row:)
 * - 同一識別鍵且同姓名：視為重複報名，合併為最早的一筆。
 * - 同一學號／活動碼／系統識別碼但姓名不同：保留最早的一筆，其餘排除並警示。
 * - 同一手機但姓名不同：視為不同人（識別鍵含姓名），標示共用號碼。
 *
 * @param {Array[]} rows 工作表原始資料（含標題列）
 * @param {{salt: (string|function(): string)}} options 手機號碼雜湊用的鹽（或延遲取得鹽的函式）
 */
function parseParticipants(rows, options) {
  if (!rows || rows.length <= 1) return { participants: [], warnings: [] };

  const headers = rows[0].map(h => String(h || '').trim());
  const nameIndex = findColumnIndex(headers, ['姓名', '學生姓名', '中文姓名', '名字', 'Name', 'Full Name']);
  const deptIndex = findColumnIndex(headers, ['系所', '科系', '學系', '系別', '院系', '部門', '組別', '單位', 'Department', 'Dept', 'Major']);
  const gradeIndex = findColumnIndex(headers, ['年級', '年級別', '年級(如大一/大二)', 'Grade', 'Year']);
  const idIndex = findColumnIndex(headers, ['學號', '學生證號', '員工編號', '工號', '編號', 'ID', 'Student ID', 'Employee ID']);
  const emailIndex = findColumnIndex(headers, ['電子郵件', '學校信箱', 'Email', '信箱']);
  const phoneIndex = findColumnIndex(headers, ['手機號碼', '手機', '電話', '聯絡電話', 'Phone', 'Mobile']);
  const codeIndex = findColumnIndex(headers, ['活動識別碼', '報到序號', '報名序號', 'Event Code']);
  const uidIndex = findColumnIndex(headers, CONFIG.ROW_UID_HEADERS);
  const timeIndex = findColumnIndex(headers, ['時間戳記', 'Timestamp', '填答時間']);

  let salt = null;
  const getSalt = () => {
    if (salt === null) {
      salt = typeof options.salt === 'function' ? options.salt() : options.salt;
    }
    return salt;
  };
  const cell = (row, index) => (index >= 0 ? row[index] : '');

  // 1. 逐列正規化
  const records = [];
  const skippedNoName = [];
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i].filter((_, col) => col !== uidIndex);
    if (isRowEmpty(row)) continue;
    const rowNumber = i + 1;
    const raw = rows[i];

    const name = nameIndex >= 0 ? String(raw[nameIndex] || '').trim() : String(raw[1] || raw[0] || '').trim();
    if (!name) {
      skippedNoName.push(rowNumber);
      continue;
    }

    const studentId = normalizeCode(cell(raw, idIndex));
    const eventCode = normalizeCode(cell(raw, codeIndex));
    const phone = normalizePhone(cell(raw, phoneIndex));
    const rowUid = String(cell(raw, uidIndex) || '').trim();
    const nameNorm = normalizeText(name);

    const record = {
      rowNumber: rowNumber,
      sortTime: toSortTime(cell(raw, timeIndex)),
      nameNorm: nameNorm,
      phoneHash: '',
      phoneInvalid: phone.invalid,
      participant: {
        key: '',
        keyType: '',
        rowUids: rowUid ? [rowUid] : [],
        studentId: studentId,
        eventCode: eventCode,
        phoneMasked: phone.value ? maskPhone(phone.value) : '',
        name: name,
        department: String(cell(raw, deptIndex) || '').trim(),
        grade: String(cell(raw, gradeIndex) || '').trim(),
        email: String(cell(raw, emailIndex) || '').trim(),
        flags: [],
        duplicateCount: 1
      }
    };
    const p = record.participant;

    if (phone.value) {
      record.phoneHash = hmacHex(phone.value, getSalt());
    }
    if (phone.invalid) p.flags.push('phone_invalid');

    if (studentId) {
      p.keyType = 'sid';
      p.key = 'sid:' + studentId;
    } else if (eventCode) {
      p.keyType = 'code';
      p.key = 'code:' + eventCode;
    } else if (phone.value) {
      // 識別鍵含姓名：共用號碼的不同人可區分，且不受他人加入名單影響
      p.keyType = 'tel';
      p.key = 'tel:' + hmacHex(phone.value + '|' + nameNorm, getSalt());
    } else if (rowUid) {
      p.keyType = 'row';
      p.key = 'row:' + rowUid;
      p.flags.push('no_alt_id');
    }
    records.push(record);
  }

  // 2. 依填答時間（無則依列序）排序，確保「最早的一筆」與名單排序無關
  records.sort((a, b) => (a.sortTime - b.sortTime) || (a.rowNumber - b.rowNumber));

  // 3. 依識別鍵合併重複與偵測衝突
  const byKey = {};
  const participants = [];
  const keptRecords = [];
  const identityMissing = [];
  const duplicates = {};
  const conflicts = { sid: [], code: [], row: [] };
  const phoneInvalidRows = [];

  records.forEach(record => {
    const p = record.participant;
    if (record.phoneInvalid) phoneInvalidRows.push(record.rowNumber);
    if (!p.key) {
      identityMissing.push(record.rowNumber);
      return;
    }
    const existing = byKey[p.key];
    if (!existing) {
      byKey[p.key] = record;
      participants.push(p);
      keptRecords.push(record);
      return;
    }
    if (existing.nameNorm === record.nameNorm || p.keyType === 'tel') {
      existing.participant.duplicateCount++;
      Array.prototype.push.apply(existing.participant.rowUids, p.rowUids);
      if (existing.participant.flags.indexOf('duplicate') < 0) existing.participant.flags.push('duplicate');
      (duplicates[p.key] = duplicates[p.key] || [existing.rowNumber]).push(record.rowNumber);
    } else {
      conflicts[p.keyType].push({ kept: existing.rowNumber, excluded: record.rowNumber });
    }
  });

  // 4. 共用號碼與疑似重複（只提示，不自動合併）
  const byPhone = {};
  const byProfile = {};
  keptRecords.forEach(record => {
    if (record.phoneHash) (byPhone[record.phoneHash] = byPhone[record.phoneHash] || []).push(record);
    const p = record.participant;
    const profileKey = [record.nameNorm, normalizeText(p.department), normalizeText(p.grade)].join('|');
    (byProfile[profileKey] = byProfile[profileKey] || []).push(record);
  });

  const addFlag = (record, flag) => {
    if (record.participant.flags.indexOf(flag) < 0) record.participant.flags.push(flag);
  };
  const sharedPhoneGroups = [];
  const suspectedGroups = [];

  Object.keys(byPhone).forEach(hash => {
    const group = byPhone[hash];
    const distinctKeys = uniqueValues(group.map(r => r.participant.key));
    if (distinctKeys.length < 2) return;
    group.forEach(r => addFlag(r, 'shared_phone'));
    sharedPhoneGroups.push(group);
    // 同號碼且姓名只差一個字，可能是同一人打錯名字
    for (let a = 0; a < group.length; a++) {
      for (let b = a + 1; b < group.length; b++) {
        if (group[a].nameNorm !== group[b].nameNorm && editDistanceAtMostOne(group[a].nameNorm, group[b].nameNorm)) {
          addFlag(group[a], 'suspected_duplicate');
          addFlag(group[b], 'suspected_duplicate');
          suspectedGroups.push([group[a], group[b]]);
        }
      }
    }
  });

  Object.keys(byProfile).forEach(profileKey => {
    const group = byProfile[profileKey];
    if (group.length < 2) return;
    group.forEach(r => addFlag(r, 'suspected_duplicate'));
    suspectedGroups.push(group);
  });

  // 5. 彙整警示
  const warnings = [];
  const rowsOf = group => group.map(r => r.rowNumber).sort((a, b) => a - b);
  const namesOf = group => uniqueValues(group.map(r => r.participant.name)).join('、');

  if (skippedNoName.length > 0) {
    warnings.push({ type: 'skipped_no_name', message: '略過 ' + skippedNoName.length + ' 列（缺姓名）。', rows: skippedNoName });
  }
  if (identityMissing.length > 0) {
    warnings.push({ type: 'identity_missing', message: identityMissing.length + ' 列缺少系統識別碼，已排除於抽獎名單。請執行 backfillRowIds() 後重新載入。', rows: identityMissing });
  }
  Object.keys(duplicates).forEach(key => {
    const p = byKey[key].participant;
    warnings.push({ type: 'duplicate', message: p.name + ' 重複報名 ' + duplicates[key].length + ' 次，已合併為一筆。', rows: duplicates[key] });
  });
  const conflictLabels = { sid: '學號', code: '活動識別碼', row: '系統識別碼' };
  Object.keys(conflicts).forEach(type => {
    conflicts[type].forEach(c => {
      warnings.push({
        type: type + '_conflict',
        message: '第 ' + c.excluded + ' 列與第 ' + c.kept + ' 列' + conflictLabels[type] + '相同但姓名不同，已保留較早的第 ' + c.kept + ' 列，第 ' + c.excluded + ' 列暫時排除。請修正試算表後重新載入。',
        rows: [c.kept, c.excluded]
      });
    });
  });
  if (phoneInvalidRows.length > 0) {
    warnings.push({ type: 'phone_invalid', message: phoneInvalidRows.length + ' 列手機號碼格式無法辨識（僅接受台灣手機 09 開頭共 10 碼），已改用其他識別資料。', rows: phoneInvalidRows.sort((a, b) => a - b) });
  }
  sharedPhoneGroups.forEach(group => {
    warnings.push({ type: 'shared_phone', message: '共用同一手機號碼：' + namesOf(group) + '，已視為不同人。', rows: rowsOf(group) });
  });
  suspectedGroups.forEach(group => {
    warnings.push({ type: 'suspected_duplicate', message: '疑似同一人重複報名：' + namesOf(group) + '（識別資料不同，未自動合併），請人工確認。', rows: rowsOf(group) });
  });

  return { participants: participants, warnings: warnings };
}

/**
 * 為人員分頁每一列補上固定的系統識別碼（UUID 寫回試算表，永久保存）
 * @return {{ok: boolean, written: number, error: (string|undefined)}}
 */
function ensureRowIds(sheet) {
  if (!sheet) return { ok: false, written: 0, error: '找不到人員分頁' };
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) return { ok: false, written: 0, error: '無法取得寫入鎖定' };

  try {
    const lastRow = sheet.getLastRow();
    const lastCol = sheet.getLastColumn();
    if (lastRow < 1 || lastCol < 1) return { ok: true, written: 0 };

    const headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0].map(h => String(h || '').trim());
    let uidCol = findColumnIndex(headers, CONFIG.ROW_UID_HEADERS) + 1;
    if (uidCol === 0) {
      uidCol = lastCol + 1;
      sheet.getRange(1, uidCol).setValue(CONFIG.ROW_UID_HEADERS[0]);
    }
    if (lastRow < 2) return { ok: true, written: 0 };

    const data = sheet.getRange(2, 1, lastRow - 1, Math.max(lastCol, uidCol)).getValues();
    const uids = data.map(row => [row[uidCol - 1]]);
    let written = 0;
    data.forEach((row, r) => {
      const content = row.filter((_, col) => col !== uidCol - 1);
      if (isRowEmpty(content) || String(uids[r][0] || '').trim()) return;
      uids[r][0] = Utilities.getUuid();
      written++;
    });

    if (written > 0) {
      sheet.getRange(2, uidCol, uids.length, 1).setValues(uids);
      SpreadsheetApp.flush();
    }
    return { ok: true, written: written };
  } catch (e) {
    return { ok: false, written: 0, error: String(e) };
  } finally {
    lock.releaseLock();
  }
}

/**
 * 一次性設定：補齊既有資料列的系統識別碼（於 Apps Script 編輯器手動執行）
 */
function backfillRowIds() {
  const sheet = findSheet(getTargetSpreadsheet(), CONFIG.PARTICIPANT_SHEET_NAMES, 0);
  const result = ensureRowIds(sheet);
  Logger.log(result.ok ? '已補上 ' + result.written + ' 列系統識別碼。' : '補寫失敗：' + result.error);
  return result;
}

/**
 * 一次性設定：安裝表單送出觸發器，並補齊既有資料列的系統識別碼
 */
function setupTriggers() {
  ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === 'onFormSubmit')
    .forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('onFormSubmit').forSpreadsheet(getTargetSpreadsheet()).onFormSubmit().create();
  Logger.log('已安裝 onFormSubmit 觸發器。');
  backfillRowIds();
}

/**
 * 一次性設定：產生手機號碼雜湊用的秘密鹽（已存在時不覆寫，活動期間請勿更換）
 */
function setupPhoneSalt() {
  const props = PropertiesService.getScriptProperties();
  if (props.getProperty('PHONE_SALT')) {
    Logger.log('PHONE_SALT 已存在，未變更。活動期間更換會使既有中獎紀錄無法對應。');
    return;
  }
  props.setProperty('PHONE_SALT', Utilities.getUuid() + Utilities.getUuid());
  Logger.log('已建立 PHONE_SALT。');
}

function getPhoneSalt_() {
  const salt = PropertiesService.getScriptProperties().getProperty('PHONE_SALT');
  if (!salt) {
    throw new Error('尚未設定 PHONE_SALT，請先在 Apps Script 編輯器執行 setupPhoneSalt()。');
  }
  return salt;
}

/**
 * 一般文字正規化：全形轉半形、去除所有空白、轉小寫（用於姓名、系所比對）
 */
function normalizeText(value) {
  return String(value == null ? '' : value).normalize('NFKC').replace(/\s+/g, '').toLowerCase();
}

/**
 * 學號／活動識別碼／獎品代碼正規化：全形轉半形、去除空白、轉大寫，佔位值視為空白
 */
function normalizeCode(value) {
  const text = String(value == null ? '' : value).normalize('NFKC').replace(/\s+/g, '');
  return isPlaceholderValue(text) ? '' : text.toUpperCase();
}

function isPlaceholderValue(text) {
  return !text || CONFIG.PLACEHOLDER_VALUES.indexOf(text.toLowerCase()) >= 0;
}

/**
 * 台灣手機號碼正規化，統一為 09xxxxxxxx
 * @return {{value: string, invalid: boolean}} value 為空字串表示未提供或無效
 */
function normalizePhone(value) {
  // 試算表常將 0912345678 存成數字 912345678
  let text = typeof value === 'number' ? String(Math.round(value)) : String(value == null ? '' : value);
  text = text.normalize('NFKC').replace(/[\s\-.()]/g, '');
  if (isPlaceholderValue(text)) return { value: '', invalid: false };

  text = text.replace(/^\+/, '');
  if (/^8860?9\d{8}$/.test(text)) {
    text = '0' + text.slice(-9);
  } else if (/^9\d{8}$/.test(text)) {
    text = '0' + text;
  }
  return /^09\d{8}$/.test(text) ? { value: text, invalid: false } : { value: '', invalid: true };
}

function maskPhone(phone) {
  return phone.slice(0, 4) + '-***-' + phone.slice(-3);
}

/**
 * HMAC-SHA256 雜湊（取前 16 個十六進位字元），避免 API 暴露原始手機號碼
 */
function hmacHex(text, salt) {
  const bytes = Utilities.computeHmacSha256Signature(text, salt, Utilities.Charset.UTF_8);
  return bytes.map(b => ('0' + (b & 0xff).toString(16)).slice(-2)).join('').slice(0, 16);
}

function toSortTime(value) {
  if (value instanceof Date) return value.getTime();
  const parsed = Date.parse(value);
  return isNaN(parsed) ? Number.MAX_SAFE_INTEGER : parsed;
}

function uniqueValues(list) {
  return list.filter((v, i) => list.indexOf(v) === i);
}

/**
 * 判斷兩字串的編輯距離是否 ≤ 1（姓名打錯一個字）
 */
function editDistanceAtMostOne(a, b) {
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  let j = 0;
  let edits = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      i++;
      j++;
      continue;
    }
    if (++edits > 1) return false;
    if (a.length > b.length) i++;
    else if (a.length < b.length) j++;
    else {
      i++;
      j++;
    }
  }
  return edits + (a.length - i) + (b.length - j) <= 1;
}

/**
 * 欄位標題比對輔助函式
 */
function findColumnIndex(headers, candidateKeys) {
  for (let i = 0; i < headers.length; i++) {
    const header = headers[i].toLowerCase();
    for (let j = 0; j < candidateKeys.length; j++) {
      if (header === candidateKeys[j].toLowerCase()) {
        return i;
      }
    }
  }
  return -1;
}

/**
 * 檢查列資料是否全為空
 */
function isRowEmpty(row) {
  if (!row || !Array.isArray(row)) return true;
  return row.every(cell => String(cell || '').trim() === '');
}

/**
 * 開發測試專用函式
 */
function testDoGet() {
  const result = getLotteryData();
  Logger.log('Prizes count: ' + result.prizes.length);
  Logger.log('Participants count: ' + result.participants.length);
  Logger.log('Warnings: ' + JSON.stringify(result.warnings, null, 2));
  Logger.log(JSON.stringify(result, null, 2));
  return result;
}

/**
 * 身分識別情境測試（不讀寫試算表，於編輯器手動執行；失敗時拋出錯誤）
 */
function testIdentityFixtures() {
  const H = ['時間戳記', '系所', '年級', '姓名', '學號', '手機號碼', '活動識別碼', '電子郵件', '系統識別碼'];
  const t = n => new Date(2026, 9, 9, 18, n, 0);
  const rows = [
    H,
    [t(1), '資訊工程學系', '大三', '陳冠宇', 'B11902001', '', '', '', 'u01'],
    [t(2), '企業管理學系', '大一', '陳冠宇', '', '0912-345-678', '', '', 'u02'],          // T1、T6
    [t(3), '校外來賓', '', '王曉明', '', '', 'a7k2q9', '', 'u03'],                        // T2
    [t(4), '歷史學系', '大二', '李宜蓁', '', '', '', '', 'u04'],                           // T3
    [t(5), '社會學系', '大三', '周佩穎', '無', '0933 111 222', '', '', 'u05'],             // T4
    [t(6), '法律學系', '大一', '郭哲銘', '', '02-2621-5656', '', '', 'u06'],               // T5
    [t(7), '企業管理學系', '大一', '陳冠宇', '', '+886 912 345 678', '', '', 'u07'],       // T8
    [t(8), '化學工程學系', '大四', '林小美', '', '0922108108', '', '', 'u08'],             // T9
    [t(9), '化學工程學系', '大二', '林大明', '', 922108108, '', '', 'u09'],                // T9（數字格式）
    [t(10), '資訊工程學系', '大三', '陳冠宇', 'b11902001 ', '', '', '', 'u10'],            // T10、T13
    [t(11), '醫學系', '大四', '謝宜萱', 'B10902050', '', '', '', 'u11'],
    [t(12), '醫學系', '大四', '冒名者', 'B10902050', '', '', '', 'u12'],                   // T11
    [t(13), '心理學系', '大三', '梁詠晴', 'B11401039', '', '', '', 'u13'],
    [t(14), '心理學系', '大三', '梁詠晴', '', '0955000111', '', '', 'u14'],                // T12
    [t(15), '心理學系', '大三', '', 'B99999999', '', '', '', 'u15'],                       // 缺姓名
    [t(16), '心理學系', '大三', '無碼者', '', '', '', '', '']                              // 缺系統識別碼
  ];

  const run = input => parseParticipants(input, { salt: 'test-salt' });
  const result = run(rows);
  const ps = result.participants;
  const find = rowUid => ps.filter(p => p.rowUids.indexOf(rowUid) >= 0)[0];
  const hasWarning = type => result.warnings.some(w => w.type === type);
  const failures = [];
  const check = (label, ok) => { if (!ok) failures.push(label); };

  check('T1 無學號以手機識別', find('u02').keyType === 'tel' && find('u02').phoneMasked === '0912-***-678');
  check('T2 活動碼轉大寫', find('u03').key === 'code:A7K2Q9');
  check('T3 三者皆空以系統識別碼識別', find('u04').key === 'row:u04' && find('u04').flags.indexOf('no_alt_id') >= 0);
  check('T4 學號佔位值視為空白', find('u05').keyType === 'tel');
  check('T5 市話視為無效', find('u06').keyType === 'row' && find('u06').flags.indexOf('phone_invalid') >= 0);
  check('T6 同名不同人分開', find('u01').key !== find('u02').key);
  check('T8 同手機同姓名合併', find('u07') === find('u02') && find('u02').duplicateCount === 2);
  check('T9 共用號碼不同姓名為兩人', find('u08').key !== find('u09').key && find('u08').flags.indexOf('shared_phone') >= 0);
  check('T10/T13 同學號合併（大小寫與空白）', find('u10') === find('u01') && find('u01').duplicateCount === 2);
  check('T11 同學號不同姓名排除後者', !find('u12') && find('u11') && hasWarning('sid_conflict'));
  check('T12 疑似重複僅標示', find('u13') !== find('u14') && find('u13').flags.indexOf('suspected_duplicate') >= 0);
  check('缺姓名略過', hasWarning('skipped_no_name'));
  check('缺系統識別碼排除', !ps.some(p => p.name === '無碼者') && hasWarning('identity_missing'));

  // T14/T20：名單反向排序後，每人的識別鍵與保留的那一筆都不變
  const reversed = [H].concat(rows.slice(1).reverse());
  const snapshot = list => list.map(p => p.key + '=' + p.rowUids.join(',')).sort().join(';');
  check('T14/T20 重排後識別結果一致', snapshot(run(reversed).participants) === snapshot(ps));

  check('手機正規化', ['0912-345-678', '0912 345 678', '+886 912 345 678', '+886-0912-345678', 912345678, '０９１２３４５６７８']
    .every(v => normalizePhone(v).value === '0912345678'));

  const prizeResult = parsePrizes([
    ['獎品名稱', '配額', '抽獎順序'],
    ['頭獎', 1, 1],
    ['二獎', 2, 2]
  ]);
  const prizeReordered = parsePrizes([
    ['獎品名稱', '配額', '抽獎順序'],
    ['二獎', 2, 2],
    ['頭獎', 1, 1]
  ]);
  check('T22 獎品重排後 id 不變', JSON.stringify(prizeResult.prizes) === JSON.stringify(prizeReordered.prizes));

  if (failures.length > 0) {
    throw new Error('身分識別測試失敗：\n' + failures.join('\n'));
  }
  Logger.log('身分識別測試全部通過（' + ps.length + ' 位參加者，' + result.warnings.length + ' 則警示）。');
  return result;
}
