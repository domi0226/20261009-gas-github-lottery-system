/**
 * 活動幸運抽獎系統 (GitHub Pages 前端應用程式)
 *
 * 核心功能：
 * 1. 介接 Google Apps Script (GAS) doGet API 獲取人員名單與獎品設定。
 * 2. 獎品切換與配額計算 (Prize Selection and Quota Display)。
 * 3. 前端真亂數抽獎與動畫舞台 (Random Participant Drawing)。
 * 4. 中獎紀錄分組展示、localStorage 狀態持久化與 CSV 匯出 (Winner Record Tracking and History)。
 * 5. 參加者身分識別：以固定識別鍵 (key) 與系統識別碼 (rowUids) 對應中獎紀錄，名單重排或重新載入後不混淆。
 */

(function () {
  'use strict';

  // 本地儲存鍵名常數
  const STORAGE_KEYS = {
    API_URL: 'lottery_gas_api_url',
    WINNERS: 'lottery_winners_history',
    DATA_CACHE: 'lottery_cached_data'
  };

  // 識別方式顯示名稱
  const KEY_TYPE_LABELS = {
    sid: '學號',
    code: '活動識別碼',
    tel: '手機',
    row: '系統識別碼',
    legacy: '舊版紀錄'
  };

  // 內建展示示範資料（大學校園活動抽獎示範，格式同 GAS API schemaVersion 2）
  const DEMO_DATA = {
    schemaVersion: 2,
    prizes: [
      { id: 'demo_p1', name: '頭獎：Apple iPad Air (256GB)', quota: 1, order: 1, description: '特獎校園高效學習首選' },
      { id: 'demo_p2', name: '二獎：Sony 降噪藍牙耳機', quota: 2, order: 2, description: '專注讀書聽歌神器' },
      { id: 'demo_p3', name: '三獎：校園書局與百貨禮券 $2000', quota: 5, order: 3, description: '購書文具實用好禮' },
      { id: 'demo_p4', name: '幸運獎：星巴克飲品兌換券', quota: 10, order: 4, description: '期中期末暖心咖啡' }
    ],
    participants: [
      demoStudent('B11902001', '陳冠宇', '資訊工程學系', '大三'),
      demoStudent('B12703015', '林若晴', '財務金融學系', '大二'),
      demoStudent('B10102033', '張凱翔', '外國語文學系', '大四'),
      demoStudent('B13501008', '黃子庭', '生物機電學系', '大一'),
      demoStudent('R12521019', '吳家瑋', '電機工程研究所', '碩二'),
      demoStudent('B11201042', '許雅筑', '歷史學系', '大三'),
      demoStudent('B12901024', '楊宗翰', '土木工程學系', '大二'),
      demoStudent('B10302011', '蔡欣妤', '化學工程學系', '大四'),
      demoStudent('B13105022', '劉宇恆', '中國文學系', '大一'),
      demoStudent('B11602017', '周佩穎', '社會學系', '大三'),
      demoStudent('B12304005', '鄭兆廷', '機械工程學系', '大二'),
      demoStudent('B10902050', '謝宜萱', '醫學系', '大四'),
      demoStudent('B13801016', '郭哲銘', '法律學系', '大一'),
      demoStudent('R13622003', '曾詩婷', '經濟學研究所', '碩一'),
      demoStudent('B11401039', '梁詠晴', '心理學系', '大三'),
      // 無學號參加者：同名不同人、共用號碼、活動識別碼、僅系統識別碼
      demoParticipant({ key: 'tel:demo16', keyType: 'tel', rowUids: ['demo-row-16'], phoneMasked: '0933-***-512', name: '陳冠宇', department: '企業管理學系', grade: '大一' }),
      demoParticipant({ key: 'tel:demo17', keyType: 'tel', rowUids: ['demo-row-17'], phoneMasked: '0922-***-108', name: '林小美', department: '化學工程學系', grade: '大四', flags: ['shared_phone'] }),
      demoParticipant({ key: 'tel:demo18', keyType: 'tel', rowUids: ['demo-row-18'], phoneMasked: '0922-***-108', name: '林大明', department: '化學工程學系', grade: '大二', flags: ['shared_phone'] }),
      demoParticipant({ key: 'code:A7K2Q9', keyType: 'code', rowUids: ['demo-row-19'], eventCode: 'A7K2Q9', name: '王曉明', department: '校外來賓' }),
      demoParticipant({ key: 'row:demo-row-20', keyType: 'row', rowUids: ['demo-row-20'], name: '李宜蓁', department: '歷史學系', grade: '大二', flags: ['no_alt_id'] })
    ],
    warnings: [
      { type: 'shared_phone', message: '共用同一手機號碼：林小美、林大明，已視為不同人。', rows: [17, 18] }
    ]
  };

  function demoParticipant(fields) {
    return Object.assign({
      key: '', keyType: '', rowUids: [], studentId: '', eventCode: '', phoneMasked: '',
      name: '', department: '', grade: '', email: '', flags: [], duplicateCount: 1
    }, fields);
  }

  function demoStudent(studentId, name, department, grade) {
    return demoParticipant({
      key: 'sid:' + studentId, keyType: 'sid', rowUids: ['demo-row-' + studentId], studentId: studentId,
      name: name, department: department, grade: grade, email: studentId.toLowerCase() + '@school.edu.tw'
    });
  }

  // 應用程式狀態模型
  const state = {
    apiUrl: '',
    prizes: [],
    participants: [],
    warnings: [],
    currentPrizeId: null,
    winners: [], // 格式: [{ participantKey, keyType, rowUids, identityValue, name, department, grade, email, phoneMasked, prizeId, prizeName, timestamp }]
    isRolling: false,
    rollIntervalId: null
  };

  // DOM 元素快取
  let dom = {};

  /**
   * 初始化入口
   */
  function init() {
    cacheDomElements();
    bindEvents();
    loadPersistedState();

    if (state.prizes.length === 0) {
      // 若尚無資料，自動載入展示資料提供即時體驗
      loadData(DEMO_DATA);
    } else {
      reconcileWinners();
      updateUI();
    }
  }

  /**
   * 快取 DOM 元素
   */
  function cacheDomElements() {
    dom = {
      configPanel: document.getElementById('config-panel'),
      btnToggleConfig: document.getElementById('btn-toggle-config'),
      btnCloseConfig: document.getElementById('btn-close-config'),
      btnLoadDemo: document.getElementById('btn-load-demo'),
      gasApiUrl: document.getElementById('gas-api-url'),
      btnFetchData: document.getElementById('btn-fetch-data'),
      apiStatusMsg: document.getElementById('api-status-message'),

      prizeSelect: document.getElementById('prize-select'),
      statTotalQuota: document.getElementById('stat-total-quota'),
      statDrawnCount: document.getElementById('stat-drawn-count'),
      statRemainingQuota: document.getElementById('stat-remaining-quota'),
      prizeDesc: document.getElementById('prize-desc'),

      rollingDisplay: document.getElementById('rolling-display'),
      winnerCandidateName: domEl('.winner-candidate-name'),
      winnerCandidateMeta: domEl('.winner-candidate-meta'),
      stagePlaceholder: domEl('.stage-placeholder'),
      btnDraw: document.getElementById('btn-draw'),
      drawWarning: document.getElementById('draw-warning'),

      identityWarnings: document.getElementById('identity-warnings'),
      identityWarningsTitle: document.getElementById('identity-warnings-title'),
      identityWarningsList: document.getElementById('identity-warnings-list'),

      winnersListContainer: document.getElementById('winners-list-container'),
      btnExportCsv: document.getElementById('btn-export-csv'),
      btnResetLottery: document.getElementById('btn-reset-lottery')
    };
  }

  function domEl(selector) {
    return document.querySelector(selector);
  }

  /**
   * 綁定事件監聽
   */
  function bindEvents() {
    dom.btnToggleConfig.addEventListener('click', toggleConfigPanel);
    dom.btnCloseConfig.addEventListener('click', () => dom.configPanel.classList.add('hidden'));
    dom.btnLoadDemo.addEventListener('click', () => {
      loadData(DEMO_DATA);
      showStatusMessage('已載入展示示範資料！', 'success');
    });

    dom.btnFetchData.addEventListener('click', handleFetchApiData);
    dom.prizeSelect.addEventListener('change', handlePrizeChange);
    dom.btnDraw.addEventListener('click', handleStartDraw);
    dom.btnExportCsv.addEventListener('click', exportWinnersToCsv);
    dom.btnResetLottery.addEventListener('click', handleResetLottery);
  }

  /**
   * 從 LocalStorage 載入歷史紀錄
   */
  function loadPersistedState() {
    try {
      const savedUrl = localStorage.getItem(STORAGE_KEYS.API_URL);
      if (savedUrl) {
        state.apiUrl = savedUrl;
        dom.gasApiUrl.value = savedUrl;
      }

      const savedWinners = localStorage.getItem(STORAGE_KEYS.WINNERS);
      if (savedWinners) {
        state.winners = JSON.parse(savedWinners).map(migrateLegacyWinner);
        persistWinners();
      }

      const cachedData = localStorage.getItem(STORAGE_KEYS.DATA_CACHE);
      if (cachedData) {
        const parsed = JSON.parse(cachedData);
        if (parsed.prizes && parsed.participants) {
          applyDataset(parsed);
          if (state.prizes.length > 0) {
            state.currentPrizeId = state.prizes[0].id;
          }
        }
      }
    } catch (e) {
      console.warn('載入 LocalStorage 失敗:', e);
    }
  }

  /**
   * 切換設定面板展開狀態
   */
  function toggleConfigPanel() {
    dom.configPanel.classList.toggle('hidden');
  }

  /**
   * 顯示 API 連線狀態訊息
   */
  function showStatusMessage(msg, type) {
    dom.apiStatusMsg.textContent = msg;
    dom.apiStatusMsg.className = 'status-message ' + type;
  }

  /**
   * 呼叫 GAS Web App API 取得即時資料
   */
  async function handleFetchApiData() {
    const url = dom.gasApiUrl.value.trim();
    if (!url) {
      showStatusMessage('請輸入有效的 Google Apps Script 網址！', 'error');
      return;
    }

    showStatusMessage('正在自 Google 試算表同步資料中...', '');
    dom.btnFetchData.disabled = true;

    try {
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error('HTTP 錯誤，狀態代碼：' + response.status);
      }
      const json = await response.json();
      if (json.status !== 'success') {
        throw new Error(json.message || 'API 回傳錯誤');
      }

      state.apiUrl = url;
      localStorage.setItem(STORAGE_KEYS.API_URL, url);
      loadData(json);
      const warningText = state.warnings.length > 0 ? `，${state.warnings.length} 則名單提醒` : '';
      showStatusMessage(`連線成功！共載入 ${state.prizes.length} 項獎品與 ${state.participants.length} 位人員${warningText}。`, 'success');
      dom.configPanel.classList.add('hidden');
    } catch (err) {
      showStatusMessage('連線失敗：' + err.message + ' (請確認 Web App 發布權限為 Anyone)', 'error');
    } finally {
      dom.btnFetchData.disabled = false;
    }
  }

  /**
   * 載入資料並更新狀態
   */
  function loadData(data) {
    applyDataset(data);

    // 快取資料至 LocalStorage
    try {
      localStorage.setItem(STORAGE_KEYS.DATA_CACHE, JSON.stringify({
        schemaVersion: 2,
        prizes: state.prizes,
        participants: state.participants,
        warnings: state.warnings
      }));
    } catch (e) {}

    // 初始化選定第一個獎品
    if (state.prizes.length > 0) {
      if (!state.currentPrizeId || !state.prizes.some(p => p.id === state.currentPrizeId)) {
        state.currentPrizeId = state.prizes[0].id;
      }
    } else {
      state.currentPrizeId = null;
    }

    reconcileWinners();
    updateUI();
  }

  /**
   * 將 API 資料寫入狀態；舊版 API（無 schemaVersion）的人員資料會轉換為識別鍵格式
   */
  function applyDataset(data) {
    state.prizes = data.prizes || [];
    state.warnings = (data.warnings || []).slice();

    const raw = data.participants || [];
    if (data.schemaVersion >= 2) {
      state.participants = raw.map(p => Object.assign({ rowUids: [], flags: [], duplicateCount: 1 }, p));
      return;
    }

    const adapted = raw.map(adaptLegacyParticipant);
    state.participants = adapted.filter(p => p.key);
    const dropped = adapted.length - state.participants.length;
    if (dropped > 0) {
      state.warnings.push({
        type: 'identity_missing',
        message: `${dropped} 位人員缺少穩定識別資料（舊版 API 以列號產生編號），已排除於抽獎名單。請更新 GAS 後端至最新版本。`,
        rows: []
      });
    }
  }

  /**
   * 舊版人員格式 { id, name, ... } 轉換：只有真正的學號才能作為識別鍵
   */
  function adaptLegacyParticipant(p) {
    const sid = normalizeLegacyId(p.id);
    return {
      key: sid ? 'sid:' + sid : '',
      keyType: sid ? 'sid' : '',
      rowUids: [],
      studentId: sid,
      eventCode: '',
      phoneMasked: '',
      name: p.name || '',
      department: p.department || '',
      grade: p.grade || '',
      email: p.email || '',
      flags: [],
      duplicateCount: 1
    };
  }

  /**
   * 舊版編號正規化；`s_N`、`user_N` 是依列號產生的編號，視為無效
   */
  function normalizeLegacyId(id) {
    const text = String(id || '').normalize('NFKC').replace(/\s+/g, '');
    if (!text || /^(s|user)_\d+$/.test(text)) return '';
    return text.toUpperCase();
  }

  /**
   * 舊版中獎紀錄 { winnerId, ... } 遷移為識別鍵格式
   */
  function migrateLegacyWinner(w) {
    if (w.participantKey) return Object.assign({ rowUids: [] }, w);
    const sid = normalizeLegacyId(w.winnerId);
    return {
      participantKey: sid ? 'sid:' + sid : 'legacy:' + (w.winnerId || w.timestamp),
      keyType: sid ? 'sid' : 'legacy',
      rowUids: [],
      identityValue: sid || String(w.winnerId || ''),
      name: w.name || '',
      department: w.department || '',
      grade: w.grade || '',
      email: w.email || '',
      phoneMasked: '',
      prizeId: w.prizeId,
      prizeName: w.prizeName,
      timestamp: w.timestamp
    };
  }

  /**
   * 重新載入名單後，對齊中獎紀錄：
   * - 獎品 id 對不上但名稱相同時（舊版 prize_N），改用新的獎品 id。
   * - 補上對應參加者目前的所有系統識別碼，確保補填學號等識別資料變更後仍判定為已中獎。
   */
  function reconcileWinners() {
    let changed = false;
    state.winners.forEach(w => {
      if (!state.prizes.some(p => p.id === w.prizeId)) {
        const sameName = state.prizes.find(p => p.name === w.prizeName);
        if (sameName) {
          w.prizeId = sameName.id;
          changed = true;
        }
      }

      const current = findParticipantForWinner(w);
      if (current) {
        current.rowUids.forEach(uid => {
          if (w.rowUids.indexOf(uid) < 0) {
            w.rowUids.push(uid);
            changed = true;
          }
        });
      }
    });
    if (changed) persistWinners();
  }

  /**
   * 依識別鍵或系統識別碼，在目前名單中找出中獎者
   */
  function findParticipantForWinner(w) {
    return state.participants.find(p => p.key === w.participantKey) ||
      state.participants.find(p => p.rowUids.some(uid => w.rowUids.indexOf(uid) >= 0)) ||
      null;
  }

  /**
   * 判斷人員是否已中獎（識別鍵或任一系統識別碼相符即視為同一人）
   */
  function isAlreadyWon(p, winners) {
    const list = winners || state.winners;
    return list.some(w => w.participantKey === p.key || p.rowUids.some(uid => w.rowUids.indexOf(uid) >= 0));
  }

  /**
   * 取得識別值（學號／活動碼／遮罩手機／系統識別碼）
   */
  function getIdentityValue(p) {
    switch (p.keyType) {
      case 'sid': return p.studentId;
      case 'code': return p.eventCode;
      case 'tel': return p.phoneMasked;
      case 'row': return p.rowUids[0] || '';
      default: return '';
    }
  }

  /**
   * 舞台與名冊上用來區分同名者的識別標示
   */
  function getDisplayId(keyType, identityValue) {
    if (!identityValue) return '';
    switch (keyType) {
      case 'sid': return '#' + identityValue;
      case 'code': return '#活動碼 ' + identityValue;
      case 'tel': return '☎ ' + identityValue;
      case 'row': return '#系統碼 ' + identityValue.slice(0, 8);
      default: return '#' + identityValue;
    }
  }

  function getParticipantMeta(p) {
    return [p.department, p.grade, getDisplayId(p.keyType, getIdentityValue(p))].filter(Boolean).join(' ');
  }

  /**
   * 切換獎品事件處理 (Prize Selection and Quota Display)
   */
  function handlePrizeChange(e) {
    state.currentPrizeId = e.target.value;
    updateStageAndStats();
  }

  /**
   * 獲取當前所選獎品物件
   */
  function getCurrentPrize() {
    return state.prizes.find(p => p.id === state.currentPrizeId) || null;
  }

  /**
   * 計算特定獎品之配額統計
   */
  function getPrizeQuotaStats(prizeId) {
    const prize = state.prizes.find(p => p.id === prizeId);
    if (!prize) return { total: 0, drawn: 0, remaining: 0 };

    const drawnCount = state.winners.filter(w => w.prizeId === prizeId).length;
    const remaining = Math.max(0, prize.quota - drawnCount);
    return {
      total: prize.quota,
      drawn: drawnCount,
      remaining: remaining
    };
  }

  /**
   * 取得尚未中獎之合格抽獎人員池
   */
  function getEligibleParticipants() {
    return state.participants.filter(p => !isAlreadyWon(p));
  }

  /**
   * 完整更新頁面 UI
   */
  function updateUI() {
    renderPrizeOptions();
    updateStageAndStats();
    renderIdentityWarnings();
    renderWinnersList();
  }

  /**
   * 渲染獎品下拉選單
   */
  function renderPrizeOptions() {
    dom.prizeSelect.innerHTML = '';
    if (state.prizes.length === 0) {
      dom.prizeSelect.innerHTML = '<option value="">(無可用獎品)</option>';
      return;
    }

    state.prizes.forEach(prize => {
      const stats = getPrizeQuotaStats(prize.id);
      const opt = document.createElement('option');
      opt.value = prize.id;
      opt.textContent = `${prize.name} (剩餘: ${stats.remaining}/${stats.total})`;
      if (prize.id === state.currentPrizeId) {
        opt.selected = true;
      }
      dom.prizeSelect.appendChild(opt);
    });
  }

  /**
   * 更新抽獎舞台與名額看版數據
   */
  function updateStageAndStats() {
    const currentPrize = getCurrentPrize();
    dom.drawWarning.textContent = '';

    if (!currentPrize) {
      dom.statTotalQuota.textContent = '0';
      dom.statDrawnCount.textContent = '0';
      dom.statRemainingQuota.textContent = '0';
      dom.prizeDesc.textContent = '';
      dom.btnDraw.disabled = true;
      return;
    }

    const stats = getPrizeQuotaStats(currentPrize.id);
    dom.statTotalQuota.textContent = stats.total;
    dom.statDrawnCount.textContent = stats.drawn;
    dom.statRemainingQuota.textContent = stats.remaining;
    dom.prizeDesc.textContent = currentPrize.description || '';

    const eligible = getEligibleParticipants();

    // 判斷按鈕是否可點擊
    if (state.isRolling) {
      dom.btnDraw.disabled = true;
      dom.btnDraw.textContent = '抽獎中...';
    } else if (stats.remaining <= 0) {
      dom.btnDraw.disabled = true;
      dom.btnDraw.textContent = '該獎項已抽完';
      dom.drawWarning.textContent = '🎉 此獎項配額已全數抽出完畢！';
    } else if (eligible.length === 0) {
      dom.btnDraw.disabled = true;
      dom.btnDraw.textContent = '無可用候選名單';
      dom.drawWarning.textContent = '⚠️ 所有人員皆已獲獎，名單已空。';
    } else {
      dom.btnDraw.disabled = false;
      dom.btnDraw.textContent = '開始抽獎';
    }
  }

  /**
   * 執行隨機開獎 (Random Participant Drawing)
   */
  function handleStartDraw() {
    const currentPrize = getCurrentPrize();
    if (!currentPrize || state.isRolling) return;

    const stats = getPrizeQuotaStats(currentPrize.id);
    if (stats.remaining <= 0) return;

    const eligible = getEligibleParticipants();
    if (eligible.length === 0) {
      dom.drawWarning.textContent = '⚠️ 尚無未獲獎之合格人員！';
      return;
    }

    state.isRolling = true;
    updateStageAndStats();

    // 啟動視覺滾動效果
    dom.rollingDisplay.classList.remove('winner-won');
    dom.rollingDisplay.classList.add('rolling');
    dom.stagePlaceholder.textContent = '正在抽取：' + currentPrize.name;

    const duration = 2500; // 滾動動畫持續 2.5 秒
    const startTime = Date.now();
    let speed = 50; // 毫秒切換頻率

    function rollTick() {
      const randomIndex = Math.floor(Math.random() * eligible.length);
      const tempPerson = eligible[randomIndex];
      dom.winnerCandidateName.textContent = tempPerson.name;
      dom.winnerCandidateMeta.textContent = getParticipantMeta(tempPerson);

      const elapsed = Date.now() - startTime;
      if (elapsed < duration) {
        state.rollIntervalId = setTimeout(rollTick, speed);
      } else {
        // 定格真亂數中獎人
        finalizeWinner(currentPrize, eligible);
      }
    }

    rollTick();
  }

  /**
   * 定格決定最終中獎人 (使用加密等級或均勻隨機)
   */
  function finalizeWinner(prize, eligiblePool) {
    // 採用 crypto 均勻隨機抽取
    let finalIndex = 0;
    if (window.crypto && window.crypto.getRandomValues) {
      const randomBuffer = new Uint32Array(1);
      window.crypto.getRandomValues(randomBuffer);
      finalIndex = randomBuffer[0] % eligiblePool.length;
    } else {
      finalIndex = Math.floor(Math.random() * eligiblePool.length);
    }

    const winner = eligiblePool[finalIndex];

    // 更新舞台定格視覺
    dom.rollingDisplay.classList.remove('rolling');
    dom.rollingDisplay.classList.add('winner-won');
    dom.stagePlaceholder.textContent = '恭喜中獎！';
    dom.winnerCandidateName.textContent = winner.name;
    dom.winnerCandidateMeta.textContent = getParticipantMeta(winner);

    // 記錄中獎者（以識別鍵與系統識別碼對應，不依賴名單列序）
    const winnerRecord = {
      participantKey: winner.key,
      keyType: winner.keyType,
      rowUids: winner.rowUids.slice(),
      identityValue: getIdentityValue(winner),
      name: winner.name,
      department: winner.department || '',
      grade: winner.grade || '',
      email: winner.email || '',
      phoneMasked: winner.phoneMasked || '',
      prizeId: prize.id,
      prizeName: prize.name,
      timestamp: new Date().toLocaleString('zh-TW', { hour12: false })
    };

    state.winners.push(winnerRecord);
    persistWinners();

    state.isRolling = false;
    renderPrizeOptions();
    updateStageAndStats();
    renderWinnersList();
  }

  /**
   * 保存中獎紀錄至 LocalStorage (Winner Record Tracking and History)
   */
  function persistWinners() {
    try {
      localStorage.setItem(STORAGE_KEYS.WINNERS, JSON.stringify(state.winners));
    } catch (e) {
      console.warn('儲存中獎紀錄至 LocalStorage 失敗:', e);
    }
  }

  /**
   * 渲染名單識別提醒（重複報名、共用號碼、學號衝突等）
   */
  function renderIdentityWarnings() {
    dom.identityWarningsList.innerHTML = '';
    if (state.warnings.length === 0) {
      dom.identityWarnings.classList.add('hidden');
      return;
    }

    dom.identityWarnings.classList.remove('hidden');
    dom.identityWarningsTitle.textContent = `⚠️ 名單識別提醒（${state.warnings.length}）`;
    state.warnings.forEach(w => {
      const li = document.createElement('li');
      li.textContent = w.message + (w.rows && w.rows.length ? `（試算表第 ${w.rows.join('、')} 列）` : '');
      dom.identityWarningsList.appendChild(li);
    });
  }

  /**
   * 中獎紀錄與目前名單比對後的狀態標記
   */
  function getWinnerStatusTag(w) {
    if (w.keyType === 'legacy') return '⚠ 舊版紀錄，請人工核對';
    const current = findParticipantForWinner(w);
    if (!current) return '⚠ 名單中已不存在';
    if (current.key !== w.participantKey || current.name !== w.name) {
      return `⚠ 資料已變更：目前為 ${current.name} ${getDisplayId(current.keyType, getIdentityValue(current))}`.trim();
    }
    return '';
  }

  /**
   * 渲染右側中獎分組名冊
   */
  function renderWinnersList() {
    dom.winnersListContainer.innerHTML = '';
    if (state.winners.length === 0) {
      dom.winnersListContainer.innerHTML = '<div class="empty-hint">尚無中獎紀錄</div>';
      return;
    }

    // 依獎品分組
    const grouped = {};
    state.winners.forEach(w => {
      if (!grouped[w.prizeId]) {
        grouped[w.prizeId] = {
          prizeName: w.prizeName,
          items: []
        };
      }
      grouped[w.prizeId].items.push(w);
    });

    Object.keys(grouped).forEach(prizeId => {
      const group = grouped[prizeId];
      const groupEl = document.createElement('div');
      groupEl.className = 'winner-prize-group';

      const titleEl = document.createElement('div');
      titleEl.className = 'group-title';
      titleEl.appendChild(createTextElement('span', '', group.prizeName));
      titleEl.appendChild(createTextElement('span', '', `(${group.items.length} 位)`));
      groupEl.appendChild(titleEl);

      const listEl = document.createElement('div');
      listEl.className = 'winner-items-list';

      group.items.forEach(item => {
        const itemEl = document.createElement('div');
        itemEl.className = 'winner-item';
        const metaParts = [item.department, item.grade, getDisplayId(item.keyType, item.identityValue)].filter(Boolean).join(' · ');

        const infoEl = document.createElement('div');
        infoEl.appendChild(createTextElement('div', 'winner-item-name', item.name));
        infoEl.appendChild(createTextElement('div', 'winner-item-meta', metaParts));
        const statusTag = getWinnerStatusTag(item);
        if (statusTag) {
          infoEl.appendChild(createTextElement('div', 'winner-item-status', statusTag));
        }

        itemEl.appendChild(infoEl);
        itemEl.appendChild(createTextElement('div', 'winner-item-time', item.timestamp));
        listEl.appendChild(itemEl);
      });

      groupEl.appendChild(listEl);
      dom.winnersListContainer.appendChild(groupEl);
    });
  }

  // 姓名、獎品名稱來自表單與試算表輸入，一律以 textContent 寫入
  function createTextElement(tag, className, text) {
    const el = document.createElement(tag);
    if (className) el.className = className;
    el.textContent = text;
    return el;
  }

  /**
   * 匯出中獎名單為 CSV 檔案
   */
  function exportWinnersToCsv() {
    if (state.winners.length === 0) {
      alert('目前尚無任何中獎紀錄可供匯出！');
      return;
    }

    const csvCell = value => `"${String(value || '').replace(/"/g, '""')}"`;
    const headers = ['獎品名稱', '得獎者姓名', '系所', '年級', '識別方式', '識別值', '系統識別碼', '電子郵件', '中獎時間'];
    const rows = state.winners.map(w => [
      w.prizeName,
      w.name,
      w.department,
      w.grade,
      KEY_TYPE_LABELS[w.keyType] || '',
      w.identityValue,
      (w.rowUids || []).join(' '),
      w.email,
      w.timestamp
    ].map(csvCell));

    const csvContent = '﻿' + [headers.join(','), ...rows.map(r => r.join(','))].join('\r\n');
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.setAttribute('href', url);
    link.setAttribute('download', `中獎名冊_${new Date().toISOString().slice(0, 10)}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  }

  /**
   * 重置抽獎紀錄
   */
  function handleResetLottery() {
    if (state.winners.length === 0) {
      alert('目前無中獎紀錄。');
      return;
    }

    const confirmed = confirm('確定要清除所有中獎紀錄嗎？此動作將重新計算所有獎項剩餘配額。');
    if (confirmed) {
      state.winners = [];
      localStorage.removeItem(STORAGE_KEYS.WINNERS);
      dom.winnerCandidateName.textContent = '---';
      dom.winnerCandidateMeta.textContent = '';
      dom.stagePlaceholder.textContent = '準備抽獎';
      dom.rollingDisplay.classList.remove('winner-won', 'rolling');

      renderPrizeOptions();
      updateStageAndStats();
      renderWinnersList();
      alert('已成功重置中獎紀錄！');
    }
  }

  // 暴露全域給測試或除錯
  window.__lotterySystem = {
    state,
    loadData,
    getPrizeQuotaStats,
    getEligibleParticipants,
    isAlreadyWon,
    migrateLegacyWinner,
    exportWinnersToCsv
  };

  // 網頁載入後啟動
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
