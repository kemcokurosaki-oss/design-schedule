// JSローカル日付を "YYYY-MM-DD" 文字列に変換（Supabase date列への保存用）
function _toDateStr(date) {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
}

// Supabaseのdate列（"YYYY-MM-DD"）をローカル深夜0時のDateとして解釈するヘルパー
function _parseSupabaseDate(str) {
    if (!str) return null;
    if (typeof str !== 'string') return new Date(str);
    const s = str.trim();
    // "YYYY-MM-DD" 形式（時刻なし）→ ローカル深夜0時
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
        const [y, mo, d] = s.split('-').map(Number);
        return new Date(y, mo - 1, d);
    }
    // 時刻あり・タイムゾーンなし → UTCとして解釈
    if (!s.endsWith('Z') && !/[+-]\d{2}:?\d{2}$/.test(s)) {
        return new Date(s.replace(' ', 'T') + 'Z');
    }
    return new Date(s);
}

// 図面モード：総枚数（未設定は null として扱い画面上は空欄。0 は有効値として残す）
function _normalizeTotalSheetsLoad(v) {
    if (v == null || v === "") return null;
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0) return null;
    return Math.floor(n);
}

// 図面モード：完了枚数（未入力のみ null。0 は「0枚完了」として残す）
function _normalizeCompletedSheetsLoad(v) {
    if (v == null || v === "") return null;
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0) return null;
    return Math.floor(n);
}

/** 全体工程表で「完了済み」に移動した工事番号（completed_projects）。ガントでは非表示・工事番号一覧では参照可 */
let _completedProjectNumbers = new Set();

async function _refreshCompletedProjectNumbers() {
    const { data, error } = await supabaseClient.from('completed_projects').select('project_number');
    if (error) {
        console.error('completed_projects 読み込みエラー:', error);
        _completedProjectNumbers = new Set();
        return;
    }
    _completedProjectNumbers = new Set(
        (data || []).map(r => String(r.project_number || '').trim()).filter(Boolean)
    );
}

function _isProjectCompletedOnMasterSchedule(projectNumber) {
    return _completedProjectNumbers.has(String(projectNumber || '').trim());
}

/** task_type または is_business_trip フラグで出張タスクか判定（全体工程表と同じ基準） */
function _isTripTask(task) {
    return String(task.task_type) === 'business_trip'
        || task.is_business_trip === true
        || String(task.is_business_trip).toUpperCase() === 'TRUE';
}

/** 出張タスクの期限切れ判定（parsedTasks の DHTMLX 排他的 end_date を使用）
 *  終了日(inclusive)+7日 を超えていれば期限切れとみなす */
function _isTripTaskExpired(task) {
    if (!task || task.has_no_date || !task.end_date) return false;
    try {
        const e = task.end_date instanceof Date
            ? new Date(task.end_date.getFullYear(), task.end_date.getMonth(), task.end_date.getDate())
            : null;
        if (!e || isNaN(e.getTime())) return false;
        // DHTMLX end_date は排他的（DB end_date + 1日）なので -1+7 = +6 日
        const expiry = new Date(e);
        expiry.setDate(expiry.getDate() + 6);
        const today = new Date(); today.setHours(0, 0, 0, 0);
        return today > expiry;
    } catch(_) { return false; }
}

/** 出張タスクの期限切れ判定（DB の end_date 文字列 "YYYY-MM-DD" 包括的を使用） */
function _isTripTaskExpiredDb(dbEndDate) {
    if (!dbEndDate) return false;
    try {
        const m = String(dbEndDate).trim().match(/^(\d{4})-(\d{2})-(\d{2})/);
        if (!m) return false;
        const incEnd = new Date(+m[1], +m[2]-1, +m[3]);
        const expiry = new Date(incEnd);
        expiry.setDate(expiry.getDate() + 7);
        const today = new Date(); today.setHours(0, 0, 0, 0);
        return today > expiry;
    } catch(_) { return false; }
}

// データ読み込み
async function loadData() {
    await _refreshCompletedProjectNumbers();
    const { data, error } = await supabaseClient
        .from('tasks')
        .select('*')
        .neq('is_archived', true)
        .order('project_number', { ascending: true })
        .order('id', { ascending: true })
        .limit(10000);

    if (error) {
        console.error("Supabase error:", error);
        return;
    }

    const today = new Date().toISOString().split('T')[0];

    const parsedTasks = data.map(t => {
        const hasNoStart = !t.start_date;
        const hasNoDate  = !t.end_date;

        const startDate = t.start_date
            ? _parseSupabaseDate(t.start_date)
            : new Date(today + 'T00:00:00Z');
        // end_dateがnullの場合はダミーの終了日を設定（gantt内部用、バーは非表示）
        const endDate = t.end_date
            ? gantt.date.add(_parseSupabaseDate(t.end_date), 1, 'day')
            : gantt.date.add(startDate, 1, 'day');

        let totalSheets = _normalizeTotalSheetsLoad(t.total_sheets);
        let completedSheets = _normalizeCompletedSheetsLoad(t.completed_sheets);
        if (totalSheets == null && completedSheets != null && completedSheets <= 0) {
            completedSheets = null;
        }

        return {
            ...t,
            start_date: startDate,
            end_date:   endDate,
            has_no_start: hasNoStart,
            has_no_date: hasNoDate,
            total_sheets: totalSheets,
            completed_sheets: completedSheets
        };
    });

    // sort_order 順（null の場合は id * 1000 で代替）にソート
    parsedTasks.sort((a, b) => {
        if (String(a.project_number) < String(b.project_number)) return -1;
        if (String(a.project_number) > String(b.project_number)) return 1;
        const sa = (a.sort_order != null) ? a.sort_order : a.id * 1000;
        const sb = (b.sort_order != null) ? b.sort_order : b.id * 1000;
        return sa - sb;
    });

    // 全体工程表で完了済みになった工事番号のタスクを除外。
    // ただし期限内の出張タスク（business_trip）は完了後も表示を維持する
    const activeTasks = parsedTasks.filter(t => {
        if (!_isProjectCompletedOnMasterSchedule(t.project_number)) return true;
        return _isTripTask(t) && !_isTripTaskExpired(t);
    });

    // データ更新時は選択をリセット
    _gridSelection.clear();
    _lastGridClickId = null;

    gantt.clearAll();
    gantt.parse({
        data: activeTasks
    });

    _rebuildMachineFilterFromRows(data);
    _rebuildUnitFilterFromRows(data);
    _rebuildOwnerFilterFromRows(data);

    // 追加：データ読み込み完了直後にリソースデータを更新
    if (isResourceView) {
        updateResourceData();
        gantt.render();
    } else {
        gantt.render();
    }
}

// グローバル変数の定義
let projectMap = new Map();
let currentTaskTypeFilter = null; // null = 全表示
let currentProjectFilter = [];    // 空配列 = 全工事番号

// 休日セット（"YYYY-MM-DD" 形式で保持）
let HOLIDAYS = new Set();

async function loadHolidays() {
    const { data, error } = await supabaseClient.from('holidays').select('date');
    if (error) { console.error('休日読み込みエラー:', error); return; }
    HOLIDAYS = new Set(data.map(row => {
        // "2026/3/20" → "2026-03-20" に正規化
        const parts = String(row.date).split('/');
        if (parts.length !== 3) return null;
        return parts[0] + '-' + String(parts[1]).padStart(2,'0') + '-' + String(parts[2]).padStart(2,'0');
    }).filter(Boolean));
}

function _isHoliday(date) {
    const key = date.getFullYear() + '-' +
        String(date.getMonth() + 1).padStart(2,'0') + '-' +
        String(date.getDate()).padStart(2,'0');
    return HOLIDAYS.has(key);
}
let currentOwnerFilter = [];      // 空配列 = 全担当者
let currentMachineFilter = [];    // 空配列 = 機械で絞り込みなし
let currentUnitFilter = [];       // 空配列 = ユニットで絞り込みなし

// グリッド列ヘッダーの▼フィルター（工事番号・機械・ユニット・担当者以外の列）
// colName -> 選択値の配列。空配列 = 全表示
let columnFilters = {};
// 現在、共有ドロップダウンで開いている列名（閉じているときはnull）
let _openColFilterName = null;

// フィルターで「全解除（何も表示しない）」を表すセンチネル値
const FILTER_NONE = ' __none__';
let _clearingEndDateId = null;   // 完了予定日クリア中のタスクID
let isResourceFullscreen = false;

function _escapeHtmlAttr(s) {
    return String(s)
        .replace(/&/g, '&amp;')
        .replace(/"/g, '&quot;')
        .replace(/</g, '&lt;');
}

/** onBeforeTaskDisplay と同じ：詳細行（ガントに出る行）のみ true */
function _isDetailedTaskRow(row) {
    return row.is_detailed === true || String(row.is_detailed).toUpperCase() === 'TRUE';
}

function _taskPassesCommonFilters(task) {
    if (!_isDetailedTaskRow(task)) return false;
    if (currentProjectFilter.length > 0 && !currentProjectFilter.includes(String(task.project_number))) return false;
    if (currentTaskTypeFilter && String(task.task_type) !== currentTaskTypeFilter) return false;
    // 出張タスクが期限切れ（終了日から7日以上経過）の場合は非表示
    if (_isTripTask(task) && _isTripTaskExpired(task)) return false;
    return true;
}

/**
 * 機械フィルター以外（担当者まで）でガントに表示される行か（機械候補一覧用）
 * gantt-setup.js と同期すること
 */
function _taskVisibleIgnoringMachineFilter(task) {
    if (!_taskPassesCommonFilters(task)) return false;
    if (currentOwnerFilter.length > 0) {
        const taskOwners = String(task.owner || '').split(/[,、\s]+/).map(o => o.trim());
        if (!currentOwnerFilter.some(f => taskOwners.includes(f))) return false;
    }
    if (currentUnitFilter.length > 0) {
        const u = String(task.unit || '').trim();
        if (!currentUnitFilter.includes(u)) return false;
    }
    return true;
}

/**
 * 担当者フィルター以外（機械まで）でガントに表示される行か（担当者候補一覧用）
 * gantt-setup.js と同期すること
 */
function _taskVisibleIgnoringOwnerFilter(task) {
    if (!_taskPassesCommonFilters(task)) return false;
    if (currentMachineFilter.length > 0) {
        const m = String(task.machine || '').trim();
        if (!currentMachineFilter.includes(m)) return false;
    }
    if (currentUnitFilter.length > 0) {
        const u = String(task.unit || '').trim();
        if (!currentUnitFilter.includes(u)) return false;
    }
    return true;
}

/**
 * ユニットフィルター以外（機械・担当者まで）でガントに表示される行か（ユニット候補一覧用）
 */
function _taskVisibleIgnoringUnitFilter(task) {
    if (!_taskPassesCommonFilters(task)) return false;
    if (currentMachineFilter.length > 0) {
        const m = String(task.machine || '').trim();
        if (!currentMachineFilter.includes(m)) return false;
    }
    if (currentOwnerFilter.length > 0) {
        const taskOwners = String(task.owner || '').split(/[,、\s]+/).map(o => o.trim());
        if (!currentOwnerFilter.some(f => taskOwners.includes(f))) return false;
    }
    return true;
}

/** 機械・担当者フィルター込みでガントに表示される行か */
function _taskVisibleOnGantt(task) {
    if (!_taskVisibleIgnoringOwnerFilter(task)) return false;
    if (!_taskVisibleIgnoringMachineFilter(task)) return false;
    if (!_taskVisibleIgnoringUnitFilter(task)) return false;
    if (!_taskPassesGenericColumnFilters(task)) return false;
    return true;
}

// ------------------------------------------------------------
// グリッド列ヘッダーの▼フィルター（工事番号・機械・ユニット・担当者以外の列）
// ------------------------------------------------------------

// 列名からタスクのフィールド名へのマッピング（一致しないものだけ列挙）
const _COLUMN_FIELD_MAP = { dash: 'hyphen' };

// 実データ列を持たない計算列のソート用アクセサ（タスクから比較値を算出）
const _COLUMN_SORT_VALUE_ACCESSORS = { progress: _computeProgressPercent };

/** 現在の列セット（gantt.config.columns）から列定義を取得 */
function _findColumnDef(colName) {
    return (gantt.config.columns || []).find(c => c.name === colName);
}

/** 列定義とタスクから、その列に表示されている値（フィルター比較用の文字列）を取得 */
function _colFilterValueForTask(col, task) {
    let v;
    if (typeof col.template === 'function') {
        v = col.template(task);
    } else {
        const field = _COLUMN_FIELD_MAP[col.name] || col.name;
        v = task[field];
    }
    if (v == null) return '';
    return String(v).replace(/<[^>]*>/g, '').trim();
}

/** 指定列の絞り込みだけを無視して（他の全フィルターは適用して）表示対象か判定（候補値の再計算用） */
function _taskVisibleIgnoringColumnFilter(task, colName) {
    if (!_taskVisibleIgnoringOwnerFilter(task)) return false;
    if (!_taskVisibleIgnoringMachineFilter(task)) return false;
    if (!_taskVisibleIgnoringUnitFilter(task)) return false;
    for (const name in columnFilters) {
        if (name === colName) continue;
        const vals = columnFilters[name];
        if (!vals || vals.length === 0) continue;
        const col = _findColumnDef(name);
        if (!col) continue;
        if (vals[0] === FILTER_NONE) return false;
        if (!vals.includes(_colFilterValueForTask(col, task))) return false;
    }
    return true;
}

/** 列ヘッダーフィルター（工事番号・機械・ユニット・担当者以外）をすべて適用した判定 */
function _taskPassesGenericColumnFilters(task) {
    for (const name in columnFilters) {
        const vals = columnFilters[name];
        if (!vals || vals.length === 0) continue;
        const col = _findColumnDef(name);
        if (!col) continue;
        if (vals[0] === FILTER_NONE) return false;
        if (!vals.includes(_colFilterValueForTask(col, task))) return false;
    }
    return true;
}

/** 指定列の候補値一覧を、現在の他フィルターを反映して収集（空欄セルがあれば先頭に''として含める） */
function _collectColumnFilterValues(colName) {
    const col = _findColumnDef(colName);
    if (!col) return [];
    const set = new Set();
    let hasEmpty = false;
    gantt.eachTask(function(task) {
        if (!_taskVisibleIgnoringColumnFilter(task, colName)) return;
        const v = _colFilterValueForTask(col, task);
        if (v !== '') set.add(v); else hasEmpty = true;
    });
    const sorted = Array.from(set).sort((a, b) => a.localeCompare(b, 'ja', { numeric: true }));
    if (hasEmpty) sorted.unshift('');
    return sorted;
}

function _collectMachineValues(rows) {
    const set = new Set();
    (rows || []).forEach(row => {
        if (!_taskVisibleIgnoringMachineFilter(row)) return;
        const m = row.machine != null ? String(row.machine).trim() : '';
        if (m) set.add(m);
    });
    return Array.from(set).sort((a, b) => a.localeCompare(b, 'ja'));
}

function _collectUnitValues(rows) {
    const set = new Set();
    (rows || []).forEach(row => {
        if (!_taskVisibleIgnoringUnitFilter(row)) return;
        const u = row.unit != null ? String(row.unit).trim() : '';
        if (u) set.add(u);
    });
    return Array.from(set).sort((a, b) => a.localeCompare(b, 'ja'));
}

/** 現在のガント内タスクから機械フィルター候補を再計算 */
function _rebuildMachineFilterOptionsFromGantt() {
    if (typeof gantt === 'undefined' || !gantt.eachTask) return;
    const rows = [];
    gantt.eachTask(function(task) { rows.push(task); });
    _rebuildMachineFilterFromRows(rows);
}

/** 現在のガント内タスクからユニットフィルター候補を再計算 */
function _rebuildUnitFilterOptionsFromGantt() {
    if (typeof gantt === 'undefined' || !gantt.eachTask) return;
    const rows = [];
    gantt.eachTask(function(task) { rows.push(task); });
    _rebuildUnitFilterFromRows(rows);
}

function _collectOwnerFilterOptions(rows) {
    const set = new Set();
    (rows || []).forEach(row => {
        if (!_taskVisibleIgnoringOwnerFilter(row)) return;
        String(row.owner || '').split(/[,、\s]+/).forEach(o => {
            const t = o.trim();
            if (t) set.add(t);
        });
    });
    return Array.from(set).sort((a, b) => a.localeCompare(b, 'ja'));
}

/** タスク行データから担当者チェックリストを再構築（選択は候補に残る名前のみ維持） */
function _rebuildOwnerFilterFromRows(rows) {
    const list = document.getElementById('owner_chk_list');
    if (!list) return;
    const names = _collectOwnerFilterOptions(rows);
    const prev = new Set(currentOwnerFilter);
    if (currentOwnerFilter.length > 0 && currentOwnerFilter[0] !== FILTER_NONE) {
        currentOwnerFilter = [...prev].filter(n => names.includes(n));
    }
    const allSelected = currentOwnerFilter.length === 0;
    const esc = _escapeHtmlAttr;
    list.innerHTML = names.map(n => {
        const checked = (allSelected || currentOwnerFilter.includes(n)) ? ' checked' : '';
        const ev = esc(n);
        return `<label style="display:block; padding:4px 10px; cursor:pointer; white-space:nowrap; font-size:13px; font-family:'メイリオ',Meiryo,sans-serif;">
            <input type="checkbox" class="owner-chk-item" value="${ev}" onchange="ownerFilterItemChanged()"${checked}> ${ev}</label>`;
    }).join('');
    const allChk = document.getElementById('owner_chk_all');
    if (allChk) {
        if (allSelected) {
            allChk.checked = true;
            allChk.indeterminate = false;
        } else {
            const visibleCount = currentOwnerFilter.filter(v => v !== FILTER_NONE).length;
            allChk.checked = visibleCount >= names.length;
            allChk.indeterminate = visibleCount > 0 && visibleCount < names.length;
        }
    }
    _updateOwnerFilterBtn();
}

function _rebuildOwnerFilterOptionsFromGantt() {
    if (typeof gantt === 'undefined' || !gantt.eachTask) return;
    const rows = [];
    gantt.eachTask(function(task) { rows.push(task); });
    _rebuildOwnerFilterFromRows(rows);
}

/** タスク行データからユニットチェックリストを再構築（選択は存在するユニットのみ維持） */
function _rebuildUnitFilterFromRows(rows) {
    const list = document.getElementById('unit_chk_list');
    if (!list) return;
    const units = _collectUnitValues(rows);
    const prev = new Set(currentUnitFilter);
    if (currentUnitFilter.length > 0 && currentUnitFilter[0] !== FILTER_NONE) {
        currentUnitFilter = [...prev].filter(u => units.includes(u));
    }
    const allSelected = currentUnitFilter.length === 0;
    const esc = _escapeHtmlAttr;
    list.innerHTML = units.map(u => {
        const checked = (allSelected || currentUnitFilter.includes(u)) ? ' checked' : '';
        const ev = esc(u);
        return `<label style="display:block; padding:4px 10px; cursor:pointer; white-space:nowrap; font-size:13px; font-family:'メイリオ',Meiryo,sans-serif;">
            <input type="checkbox" class="unit-chk-item" value="${ev}" onchange="unitFilterItemChanged()"${checked}> ${ev}</label>`;
    }).join('');
    const allChk = document.getElementById('unit_chk_all');
    if (allChk) {
        if (allSelected) {
            allChk.checked = true;
            allChk.indeterminate = false;
        } else {
            const visibleCount = currentUnitFilter.filter(v => v !== FILTER_NONE).length;
            allChk.checked = visibleCount >= units.length;
            allChk.indeterminate = visibleCount > 0 && visibleCount < units.length;
        }
    }
    _updateUnitFilterBtn();
}

/** タスク行データから機械チェックリストを再構築（選択は存在する機械のみ維持） */
function _rebuildMachineFilterFromRows(rows) {
    const list = document.getElementById('machine_chk_list');
    if (!list) return;
    const machines = _collectMachineValues(rows);
    const prev = new Set(currentMachineFilter);
    if (currentMachineFilter.length > 0 && currentMachineFilter[0] !== FILTER_NONE) {
        currentMachineFilter = [...prev].filter(m => machines.includes(m));
    }
    const allSelected = currentMachineFilter.length === 0;
    const esc = _escapeHtmlAttr;
    list.innerHTML = machines.map(m => {
        const checked = (allSelected || currentMachineFilter.includes(m)) ? ' checked' : '';
        const ev = esc(m);
        return `<label style="display:block; padding:4px 10px; cursor:pointer; white-space:nowrap; font-size:13px; font-family:'メイリオ',Meiryo,sans-serif;">
            <input type="checkbox" class="machine-chk-item" value="${ev}" onchange="machineFilterItemChanged()"${checked}> ${ev}</label>`;
    }).join('');
    const allChk = document.getElementById('machine_chk_all');
    if (allChk) {
        if (allSelected) {
            allChk.checked = true;
            allChk.indeterminate = false;
        } else {
            const visibleCount = currentMachineFilter.filter(v => v !== FILTER_NONE).length;
            allChk.checked = visibleCount >= machines.length;
            allChk.indeterminate = visibleCount > 0 && visibleCount < machines.length;
        }
    }
    _updateMachineFilterBtn();
}

// フィルタードロップダウン共通ヘルパー（既存4種＋列ヘッダー共有パネル）
const _ALL_FILTER_DROPDOWN_IDS = [
    'project_filter_dropdown', 'machine_filter_dropdown', 'unit_filter_dropdown',
    'owner_filter_dropdown', 'col_filter_dropdown'
];

function _closeAllFilterDropdowns() {
    _ALL_FILTER_DROPDOWN_IDS.forEach(id => {
        const el = document.getElementById(id);
        if (el) el.style.display = 'none';
    });
    _openColFilterName = null;
}

/** クリックされたボタン（または列ヘッダーセル）の直下にドロップダウンを固定位置で表示 */
function _positionDropdownNear(dd, triggerEl) {
    if (!triggerEl) return;
    const anchor = triggerEl.closest('.gantt_grid_head_cell') || triggerEl;
    const r = anchor.getBoundingClientRect();
    dd.style.position = 'fixed';
    dd.style.top = (r.bottom + 2) + 'px';
    dd.style.left = r.left + 'px';
}

/** 開閉トグル共通処理。ダブルクリック等での取り違えを避けるため他は必ず閉じてから開く */
function _toggleFilterDropdown(ddId, e) {
    if (e) e.stopPropagation();
    const dd = document.getElementById(ddId);
    if (!dd) return;
    const wasOpen = dd.style.display !== 'none' && dd.style.display !== '';
    _closeAllFilterDropdowns();
    if (!wasOpen) {
        _positionDropdownNear(dd, e ? (e.currentTarget || e.target) : null);
        dd.style.display = 'block';
    }
}

function toggleProjectFilterDropdown(e) {
    _toggleFilterDropdown('project_filter_dropdown', e);
}

function projectFilterAllChanged(checkbox) {
    checkbox.indeterminate = false;
    if (checkbox.checked) {
        document.querySelectorAll('.project-chk-item').forEach(chk => { chk.checked = true; });
        currentProjectFilter = [];
    } else {
        document.querySelectorAll('.project-chk-item').forEach(chk => { chk.checked = false; });
        currentProjectFilter = [FILTER_NONE];
    }
    gantt.render();
    _updateProjectFilterBtn();
    _rebuildMachineFilterOptionsFromGantt();
    _rebuildUnitFilterOptionsFromGantt();
    _rebuildOwnerFilterOptionsFromGantt();
    updateDisplay();
}

function projectFilterItemChanged() {
    const allItems = document.querySelectorAll('.project-chk-item');
    const checked = [...allItems].filter(c => c.checked).map(c => c.value);
    const total = allItems.length;
    if (checked.length === total) {
        currentProjectFilter = [];
    } else if (checked.length === 0) {
        currentProjectFilter = [FILTER_NONE];
    } else {
        currentProjectFilter = checked;
    }
    const allChk = document.getElementById('project_chk_all');
    if (allChk) {
        allChk.checked = checked.length === total;
        allChk.indeterminate = checked.length > 0 && checked.length < total;
    }
    gantt.render();
    _updateProjectFilterBtn();
    _rebuildMachineFilterOptionsFromGantt();
    _rebuildUnitFilterOptionsFromGantt();
    _rebuildOwnerFilterOptionsFromGantt();
    updateDisplay();
}

// 新規工事番号をプルダウンに追加して選択状態にする
function addNewProjectFilter() {
    const input = document.getElementById('new_project_input');
    const val = (input.value || '').trim();
    if (!val) { alert('工事番号を入力してください。'); return; }

    const list = document.getElementById('project_chk_list');

    // 既存チェックをすべて外す
    document.querySelectorAll('.project-chk-item').forEach(chk => { chk.checked = false; });
    const allChk = document.getElementById('project_chk_all');
    if (allChk) allChk.checked = false;

    // 既存リストに同じ番号があればそれを選択、なければ先頭に追加
    let existing = list.querySelector(`.project-chk-item[value="${CSS.escape(val)}"]`);
    if (!existing) {
        const label = document.createElement('label');
        label.style.cssText = 'display:block; padding:4px 10px; cursor:pointer; white-space:nowrap; font-size:13px; font-family:\'メイリオ\',Meiryo,sans-serif;';
        label.innerHTML = `<input type="checkbox" class="project-chk-item" value="${val}" onchange="projectFilterItemChanged()"> ${val}`;
        list.prepend(label);
        existing = label.querySelector('.project-chk-item');
    }

    existing.checked = true;
    input.value = '';
    projectFilterItemChanged();

    // ドロップダウンを閉じる
    const dd = document.getElementById('project_filter_dropdown');
    if (dd) dd.style.display = 'none';
}

function _updateProjectFilterBtn() {
    const btn = document.getElementById('project_filter_btn');
    if (!btn) return;
    if (currentProjectFilter.length === 0) {
        btn.textContent = '工事番号: 全表示';
    } else if (currentProjectFilter[0] === FILTER_NONE) {
        btn.textContent = '工事番号: ---';
    } else if (currentProjectFilter.length === 1) {
        btn.textContent = currentProjectFilter[0];
    } else {
        btn.textContent = currentProjectFilter[0] + ' 他' + (currentProjectFilter.length - 1) + '件';
    }
}

function toggleOwnerFilterDropdown(e) {
    _toggleFilterDropdown('owner_filter_dropdown', e);
}

function ownerFilterAllChanged(checkbox) {
    checkbox.indeterminate = false;
    if (checkbox.checked) {
        document.querySelectorAll('.owner-chk-item').forEach(chk => { chk.checked = true; });
        currentOwnerFilter = [];
    } else {
        document.querySelectorAll('.owner-chk-item').forEach(chk => { chk.checked = false; });
        currentOwnerFilter = [FILTER_NONE];
    }
    _updateOwnerFilterBtn();
    updateDisplay();
}

function ownerFilterItemChanged() {
    const allItems = document.querySelectorAll('.owner-chk-item');
    const checked = [...allItems].filter(c => c.checked).map(c => c.value);
    const total = allItems.length;
    if (checked.length === total) {
        currentOwnerFilter = [];
    } else if (checked.length === 0) {
        currentOwnerFilter = [FILTER_NONE];
    } else {
        currentOwnerFilter = checked;
    }
    const allChk = document.getElementById('owner_chk_all');
    if (allChk) {
        allChk.checked = checked.length === total;
        allChk.indeterminate = checked.length > 0 && checked.length < total;
    }
    _updateOwnerFilterBtn();
    updateDisplay();
}

function _updateOwnerFilterBtn() {
    const btn = document.getElementById('owner_filter_btn');
    if (!btn) return;
    if (currentOwnerFilter.length === 0) {
        btn.textContent = '担当者: 全員';
    } else if (currentOwnerFilter[0] === FILTER_NONE) {
        btn.textContent = '担当者: ---';
    } else if (currentOwnerFilter.length === 1) {
        btn.textContent = currentOwnerFilter[0];
    } else {
        btn.textContent = currentOwnerFilter[0] + ' 他' + (currentOwnerFilter.length - 1) + '名';
    }
}

function toggleMachineFilterDropdown(e) {
    _toggleFilterDropdown('machine_filter_dropdown', e);
}

function machineFilterAllChanged(checkbox) {
    checkbox.indeterminate = false;
    if (checkbox.checked) {
        document.querySelectorAll('.machine-chk-item').forEach(chk => { chk.checked = true; });
        currentMachineFilter = [];
    } else {
        document.querySelectorAll('.machine-chk-item').forEach(chk => { chk.checked = false; });
        currentMachineFilter = [FILTER_NONE];
    }
    gantt.render();
    _updateMachineFilterBtn();
    updateDisplay();
}

function machineFilterItemChanged() {
    const allItems = document.querySelectorAll('.machine-chk-item');
    const checked = [...allItems].filter(c => c.checked).map(c => c.value);
    const total = allItems.length;
    if (checked.length === total) {
        currentMachineFilter = [];
    } else if (checked.length === 0) {
        currentMachineFilter = [FILTER_NONE];
    } else {
        currentMachineFilter = checked;
    }
    const allChk = document.getElementById('machine_chk_all');
    if (allChk) {
        allChk.checked = checked.length === total;
        allChk.indeterminate = checked.length > 0 && checked.length < total;
    }
    gantt.render();
    _updateMachineFilterBtn();
    updateDisplay();
}

function _updateMachineFilterBtn() {
    const btn = document.getElementById('machine_filter_btn');
    if (!btn) return;
    if (currentMachineFilter.length === 0) {
        btn.textContent = '機械: すべて';
    } else if (currentMachineFilter[0] === FILTER_NONE) {
        btn.textContent = '機械: ---';
    } else if (currentMachineFilter.length === 1) {
        btn.textContent = currentMachineFilter[0];
    } else {
        btn.textContent = currentMachineFilter[0] + ' 他' + (currentMachineFilter.length - 1) + '件';
    }
}

function toggleUnitFilterDropdown(e) {
    _toggleFilterDropdown('unit_filter_dropdown', e);
}

function unitFilterAllChanged(checkbox) {
    checkbox.indeterminate = false;
    if (checkbox.checked) {
        document.querySelectorAll('.unit-chk-item').forEach(chk => { chk.checked = true; });
        currentUnitFilter = [];
    } else {
        document.querySelectorAll('.unit-chk-item').forEach(chk => { chk.checked = false; });
        currentUnitFilter = [FILTER_NONE];
    }
    gantt.render();
    _updateUnitFilterBtn();
    updateDisplay();
}

function unitFilterItemChanged() {
    const allItems = document.querySelectorAll('.unit-chk-item');
    const checked = [...allItems].filter(c => c.checked).map(c => c.value);
    const total = allItems.length;
    if (checked.length === total) {
        currentUnitFilter = [];
    } else if (checked.length === 0) {
        currentUnitFilter = [FILTER_NONE];
    } else {
        currentUnitFilter = checked;
    }
    const allChk = document.getElementById('unit_chk_all');
    if (allChk) {
        allChk.checked = checked.length === total;
        allChk.indeterminate = checked.length > 0 && checked.length < total;
    }
    gantt.render();
    _updateUnitFilterBtn();
    updateDisplay();
}

function _updateUnitFilterBtn() {
    const btn = document.getElementById('unit_filter_btn');
    if (!btn) return;
    if (currentUnitFilter.length === 0) {
        btn.textContent = 'ユニット: すべて';
    } else if (currentUnitFilter[0] === FILTER_NONE) {
        btn.textContent = 'ユニット: ---';
    } else if (currentUnitFilter.length === 1) {
        btn.textContent = currentUnitFilter[0];
    } else {
        btn.textContent = currentUnitFilter[0] + ' 他' + (currentUnitFilter.length - 1) + '件';
    }
}

// ドロップダウン外クリックで閉じる
// キャプチャフェーズで登録：dhtmlxガント側のグリッド行・タイムラインのクリック処理が
// バブリング途中でstopPropagationしても、documentへの到達前（キャプチャ段階）で確実に検知する
document.addEventListener('click', function(e) {
    const t = e.target;

    // フィルタートリガー自身のクリックは、各ボタンのonclick（開閉・排他制御）に処理を任せる
    if (t.closest && t.closest('.col-filter-btn')) {
        return;
    }

    const archiveBtnWrap = document.getElementById('archive_btn_wrap');
    if (archiveBtnWrap && !archiveBtnWrap.contains(t)) {
        const menu = document.getElementById('archive_dropdown_menu');
        if (menu) menu.classList.remove('open');
    }

    _ALL_FILTER_DROPDOWN_IDS.forEach(id => {
        const dd = document.getElementById(id);
        if (dd && dd.style.display !== 'none' && !dd.contains(t)) {
            dd.style.display = 'none';
            if (id === 'col_filter_dropdown') _openColFilterName = null;
        }
    });
}, true);

// ------------------------------------------------------------
// 列ヘッダー▼ボタンのクリック処理（工事番号・機械・ユニット・担当者は既存パネルを流用、
// それ以外の列は共有パネル col_filter_dropdown を使い回す）
// ------------------------------------------------------------
const _LEGACY_HEADER_FILTER_TOGGLERS = {
    project_number: toggleProjectFilterDropdown,
    machine: toggleMachineFilterDropdown,
    unit: toggleUnitFilterDropdown,
    owner: toggleOwnerFilterDropdown
};

/** フィルタードロップダウンの昇順・降順ボタン。colName省略時は現在開いている列（共有パネル）を対象にする */
function applyColumnSort(direction, colName) {
    const name = colName || _openColFilterName;
    if (!name) return;
    const field = _COLUMN_FIELD_MAP[name] || name;
    const accessor = _COLUMN_SORT_VALUE_ACCESSORS[name];
    const desc = direction === 'desc';
    gantt.sort(function(a, b) {
        let av = accessor ? accessor(a) : a[field];
        let bv = accessor ? accessor(b) : b[field];
        if (av instanceof Date) av = av.getTime();
        if (bv instanceof Date) bv = bv.getTime();
        const aEmpty = (av == null || av === '');
        const bEmpty = (bv == null || bv === '');
        if (aEmpty || bEmpty) {
            if (aEmpty && bEmpty) return 0;
            return aEmpty ? 1 : -1; // 空欄は昇順・降順どちらでも常に末尾へ
        }
        let cmp;
        if (typeof av === 'string' || typeof bv === 'string') {
            cmp = String(av).localeCompare(String(bv), 'ja', { numeric: true });
        } else {
            cmp = av < bv ? -1 : (av > bv ? 1 : 0);
        }
        return desc ? -cmp : cmp;
    });
    gantt.render();
    _closeAllFilterDropdowns();
}

function onColumnFilterBtnClick(e, colName) {
    const legacyToggle = _LEGACY_HEADER_FILTER_TOGGLERS[colName];
    if (legacyToggle) {
        legacyToggle(e);
        return;
    }
    _openGenericColumnFilter(colName, e);
}

function _openGenericColumnFilter(colName, e) {
    const dd = document.getElementById('col_filter_dropdown');
    if (!dd) return;
    const wasOpenSame = dd.style.display === 'block' && _openColFilterName === colName;
    _closeAllFilterDropdowns();
    if (wasOpenSame) return;
    _openColFilterName = colName;
    _renderGenericColumnFilterList(colName);
    _positionDropdownNear(dd, e ? (e.currentTarget || e.target) : null);
    dd.style.display = 'block';
}

// 年月日ツリー表示の対象とする列（開始日・完了予定日・出図希望日などの日付列）
const _DATE_COLUMNS = new Set(['wish_date', 'start_date', 'end_date']);

/** "YY/MM/DD" 形式の表示値を年月日に分解（一致しなければnull） */
function _parseDateFilterValue(v) {
    const m = /^(\d{2})\/(\d{2})\/(\d{2})$/.exec(v);
    if (!m) return null;
    return { year: 2000 + Number(m[1]), month: Number(m[2]), day: Number(m[3]) };
}

/** 日付列フィルター：Excelのオートフィルターのような年→月→日のツリーHTMLを構築 */
function _buildDateFilterTreeHtml(values, checkedSet) {
    const esc = _escapeHtmlAttr;
    const tree = new Map(); // year -> Map(month -> [{day, value}])
    values.forEach(v => {
        const d = _parseDateFilterValue(v);
        if (!d) return;
        if (!tree.has(d.year)) tree.set(d.year, new Map());
        const monthMap = tree.get(d.year);
        if (!monthMap.has(d.month)) monthMap.set(d.month, []);
        monthMap.get(d.month).push({ day: d.day, value: v });
    });
    const years = Array.from(tree.keys()).sort((a, b) => a - b);
    let html = '';
    years.forEach(year => {
        const monthMap = tree.get(year);
        const months = Array.from(monthMap.keys()).sort((a, b) => a - b);
        const yearValues = [];
        months.forEach(m => monthMap.get(m).forEach(d => yearValues.push(d.value)));
        html += `<div class="col-filter-tree-node">
            <label class="col-filter-tree-row col-filter-tree-year">
                <span class="col-filter-tree-toggle" onclick="event.preventDefault(); _toggleDateTreeNode(this)">-</span>
                <input type="checkbox" class="col-filter-chk-year" data-values='${esc(JSON.stringify(yearValues))}' onchange="_dateFilterGroupChanged(this)"> ${year}年
            </label>
            <div class="col-filter-tree-children">`;
        months.forEach(m => {
            const days = monthMap.get(m).slice().sort((a, b) => a.day - b.day);
            const monthValues = days.map(d => d.value);
            html += `<div class="col-filter-tree-node">
                <label class="col-filter-tree-row col-filter-tree-month">
                    <span class="col-filter-tree-toggle" onclick="event.preventDefault(); _toggleDateTreeNode(this)">+</span>
                    <input type="checkbox" class="col-filter-chk-month" data-values='${esc(JSON.stringify(monthValues))}' onchange="_dateFilterGroupChanged(this)"> ${m}月
                </label>
                <div class="col-filter-tree-children" style="display:none;">`;
            days.forEach(d => {
                const checked = checkedSet.has(d.value) ? ' checked' : '';
                html += `<label class="col-filter-tree-row col-filter-tree-day"><span class="col-filter-tree-toggle"></span><input type="checkbox" class="col-filter-chk-item" value="${esc(d.value)}" onchange="colFilterItemChanged(); _syncDateFilterTreeState();"${checked}> ${d.day}日</label>`;
            });
            html += `</div></div>`;
        });
        html += `</div></div>`;
    });
    return html;
}

/** ツリーの展開／折りたたみ切り替え */
function _toggleDateTreeNode(toggleEl) {
    const node = toggleEl.closest('.col-filter-tree-node');
    if (!node) return;
    const children = node.querySelector(':scope > .col-filter-tree-children');
    if (!children) return;
    const collapsed = children.style.display === 'none';
    children.style.display = collapsed ? '' : 'none';
    toggleEl.textContent = collapsed ? '-' : '+';
}

/** 年・月チェックボックスの checked/indeterminate を、配下の日チェックボックスの状態から再計算 */
function _syncDateFilterTreeState() {
    const itemChecked = new Map();
    document.querySelectorAll('#col_filter_chk_list .col-filter-chk-item').forEach(it => {
        itemChecked.set(it.value, it.checked);
    });
    document.querySelectorAll('#col_filter_chk_list .col-filter-chk-year, #col_filter_chk_list .col-filter-chk-month').forEach(cb => {
        let vals = [];
        try { vals = JSON.parse(cb.dataset.values || '[]'); } catch (_) { vals = []; }
        if (!vals.length) { cb.checked = false; cb.indeterminate = false; return; }
        const checkedCount = vals.filter(v => itemChecked.get(String(v))).length;
        cb.checked = checkedCount === vals.length;
        cb.indeterminate = checkedCount > 0 && checkedCount < vals.length;
    });
}

/** 年・月チェックボックスの変更 → 配下の日チェックボックスをまとめて切り替え */
function _dateFilterGroupChanged(checkbox) {
    checkbox.indeterminate = false;
    let vals = [];
    try { vals = JSON.parse(checkbox.dataset.values || '[]'); } catch (_) { vals = []; }
    const valueSet = new Set(vals.map(String));
    document.querySelectorAll('#col_filter_chk_list .col-filter-chk-item').forEach(item => {
        if (valueSet.has(item.value)) item.checked = checkbox.checked;
    });
    colFilterItemChanged();
    _syncDateFilterTreeState();
}

function _renderGenericColumnFilterList(colName) {
    const listEl = document.getElementById('col_filter_chk_list');
    const allChk = document.getElementById('col_filter_chk_all');
    if (!listEl) return;
    const values = _collectColumnFilterValues(colName);
    let current = columnFilters[colName] || [];
    if (current.length > 0 && current[0] !== FILTER_NONE) {
        current = current.filter(v => values.includes(v));
    }
    columnFilters[colName] = current;
    const allSelected = current.length === 0;
    const checkedSet = new Set(allSelected ? values : current);
    const esc = _escapeHtmlAttr;

    const nonEmptyValues = values.filter(v => v !== '');
    const isDateTree = _DATE_COLUMNS.has(colName) && nonEmptyValues.length > 0 && nonEmptyValues.every(v => _parseDateFilterValue(v));
    if (isDateTree) {
        let html = '';
        if (values.includes('')) {
            const checked = checkedSet.has('') ? ' checked' : '';
            html += `<label class="col-filter-tree-row"><span class="col-filter-tree-toggle"></span><input type="checkbox" class="col-filter-chk-item" value=""${checked} onchange="colFilterItemChanged(); _syncDateFilterTreeState();"> (空欄)</label>`;
        }
        html += _buildDateFilterTreeHtml(nonEmptyValues, checkedSet);
        listEl.innerHTML = html;
        _syncDateFilterTreeState();
    } else {
        listEl.innerHTML = values.map(v => {
            const checked = checkedSet.has(v) ? ' checked' : '';
            const ev = esc(v);
            const labelText = v === '' ? '(空欄)' : ev;
            return `<label><input type="checkbox" class="col-filter-chk-item" value="${ev}" onchange="colFilterItemChanged()"${checked}> ${labelText}</label>`;
        }).join('');
    }

    if (allChk) {
        allChk.onchange = function() { colFilterAllChanged(this); };
        if (allSelected) {
            allChk.checked = true;
            allChk.indeterminate = false;
        } else {
            const visibleCount = current.filter(v => v !== FILTER_NONE).length;
            allChk.checked = values.length > 0 && visibleCount >= values.length;
            allChk.indeterminate = visibleCount > 0 && visibleCount < values.length;
        }
    }
}

function colFilterAllChanged(checkbox) {
    const colName = _openColFilterName;
    if (!colName) return;
    checkbox.indeterminate = false;
    const items = document.querySelectorAll('#col_filter_chk_list .col-filter-chk-item');
    if (checkbox.checked) {
        items.forEach(c => { c.checked = true; });
        columnFilters[colName] = [];
    } else {
        items.forEach(c => { c.checked = false; });
        columnFilters[colName] = [FILTER_NONE];
    }
    _syncDateFilterTreeState();
    updateDisplay();
}

function colFilterItemChanged() {
    const colName = _openColFilterName;
    if (!colName) return;
    const allItems = document.querySelectorAll('#col_filter_chk_list .col-filter-chk-item');
    const checked = [...allItems].filter(c => c.checked).map(c => c.value);
    const total = allItems.length;
    if (checked.length === total) {
        columnFilters[colName] = [];
    } else if (checked.length === 0) {
        columnFilters[colName] = [FILTER_NONE];
    } else {
        columnFilters[colName] = checked;
    }
    const allChk = document.getElementById('col_filter_chk_all');
    if (allChk) {
        allChk.checked = checked.length === total;
        allChk.indeterminate = checked.length > 0 && checked.length < total;
    }
    updateDisplay();
}

/** 列名がフィルターで絞り込み中かどうか（▼ボタンのハイライト表示用） */
function _isColumnFilterActive(colName) {
    if (colName === 'project_number') return currentProjectFilter.length > 0;
    if (colName === 'machine') return currentMachineFilter.length > 0;
    if (colName === 'unit') return currentUnitFilter.length > 0;
    if (colName === 'owner') return currentOwnerFilter.length > 0;
    return (columnFilters[colName] || []).length > 0;
}

/** グリッド再描画のたびに、列ヘッダー▼ボタンのハイライト状態を反映し直す */
function _refreshColumnFilterBtnStyles() {
    document.querySelectorAll('.col-filter-btn').forEach(btn => {
        const colName = btn.getAttribute('data-col');
        btn.classList.toggle('col-filter-active', _isColumnFilterActive(colName));
    });
}
gantt.attachEvent('onGanttRender', _refreshColumnFilterBtnStyles);

function updateFilterButtons() {
    document.getElementById('resource_home_btn').classList.toggle('active', isResourceFullscreen);
    document.getElementById('plan_filter_btn').classList.toggle('active', currentTaskTypeFilter === 'planning');
    document.getElementById('drawing_filter_btn').classList.toggle('active', currentTaskTypeFilter === 'drawing');
    document.getElementById('longterm_filter_btn').classList.toggle('active', currentTaskTypeFilter === 'long_lead_item');
    document.getElementById('trip_filter_btn').classList.toggle('active', currentTaskTypeFilter === 'business_trip');
    // 担当別モード中はボタン行の上下余白を均等にして行を調整
    const filterBtnRow = document.getElementById('filter_btn_row');
    if (filterBtnRow) filterBtnRow.style.minHeight = '';
    const headerPanel = document.querySelector('.header-panel');
    if (headerPanel) headerPanel.style.padding = isResourceFullscreen ? '6px 10px 3px 10px' : '';
    // 担当別モード中は2・3行目を非表示、新規タスク追加ボタンも非表示
    const projectInfoRow = document.getElementById('project_info_row');
    if (projectInfoRow) projectInfoRow.style.display = isResourceFullscreen ? 'none' : '';
    const dropdownsRow = document.getElementById('dropdowns_row');
    if (dropdownsRow) dropdownsRow.style.display = isResourceFullscreen ? 'none' : '';
    // 担当者・機械フィルターは非担当別モードのみ表示
    const ownerWrap = document.getElementById('owner_filter_wrap');
    if (ownerWrap) ownerWrap.style.display = isResourceFullscreen ? 'none' : '';
    const machineWrap = document.getElementById('machine_filter_wrap');
    if (machineWrap) machineWrap.style.display = isResourceFullscreen ? 'none' : '';
    const unitWrap = document.getElementById('unit_filter_wrap');
    if (unitWrap) unitWrap.style.display = isResourceFullscreen ? 'none' : '';
    const addBtn = document.getElementById('create_task_btn');
    if (addBtn) addBtn.style.display = (isResourceFullscreen || !_isEditor) ? 'none' : '';
}

// タスクバークリック時の編集（担当別モードでは無効）
function _showResourceLightbox(id) {
    if (isResourceFullscreen) return;
    gantt.showLightbox(id);
}

gantt.attachEvent('onAfterLightbox', function() {
    if (isResourceFullscreen) {
        // ライトボックスを閉じたらガントを再び非表示に戻す
        const ganttEl = document.getElementById('gantt_here');
        ganttEl.style.cssText = 'display:none;';
    }
});

function returnToResourceView() {
    if (isResourceFullscreen) return; // すでに担当別表示中
    currentTaskTypeFilter = null;
    updateFilterButtons();
    _enterResourceFullscreen();
}

function _colSetName(filterType) {
    if (filterType === 'long_lead_item') return 'longterm';
    if (filterType === 'business_trip')  return 'trip';
    if (filterType === 'planning')        return 'trip';
    return 'default';
}

function setTaskTypeFilter(type) {
    const prevColSet = _colSetName(currentTaskTypeFilter);
    currentTaskTypeFilter = (currentTaskTypeFilter === type) ? null : type;
    updateFilterButtons();

    if (currentTaskTypeFilter === null) {
        // フィルター全オフ → リソース全画面に戻す
        _enterResourceFullscreen();
        _rebuildMachineFilterOptionsFromGantt();
        _rebuildUnitFilterOptionsFromGantt();
        _rebuildOwnerFilterOptionsFromGantt();
    } else {
        // フィルターON → ガントビューに切り替え
        if (isResourceFullscreen) {
            _exitResourceFullscreen();
        }
        if (_colSetName(currentTaskTypeFilter) !== prevColSet) {
            switchColumns(currentTaskTypeFilter);
        } else {
            gantt.refreshData();
        }
        _rebuildMachineFilterOptionsFromGantt();
        _rebuildUnitFilterOptionsFromGantt();
        _rebuildOwnerFilterOptionsFromGantt();
        // ブラウザの描画確定後にズームレベルを再設定してカレンダーヘッダーを完全再描画
        setTimeout(() => {
            gantt.setSizes();
            const currentLevel = document.querySelector('.zoom-btn.active')?.textContent === '週単位' ? 'week' : 'day';
            gantt.ext.zoom.setLevel(currentLevel);
            // モード切替時の初期表示は今日の日付位置にする
            gantt.showDate(new Date());
        }, 0);
    }
}

function togglePlanFilter()     { setTaskTypeFilter('planning'); }
function toggleDrawingFilter()  { setTaskTypeFilter('drawing'); }
function toggleLongtermFilter() { setTaskTypeFilter('long_lead_item'); }
function toggleTripFilter()     { setTaskTypeFilter('business_trip'); }

// 工事番号セレクトボックスの表示更新
function updateDisplay() {

    if (isResourceView) {
        updateResourceData();
    }
    gantt.render();
    setTimeout(() => {
        gantt.setSizes();
        const currentLevel = document.querySelector('.zoom-btn.active')?.textContent === '週単位' ? 'week' : 'day';
        gantt.ext.zoom.setLevel(currentLevel);
    }, 0);
}

// 工事番号フィルターの初期化
async function initProjectSelect(projectParam) {
    await _refreshCompletedProjectNumbers();
    const { data } = await supabaseClient
        .from('tasks')
        .select('project_number, customer_name, project_details, machine, unit, is_detailed, task_type, is_business_trip, end_date, owner')
        .neq('is_archived', true);
    if (!data) return;

    // 完了済み工番のタスクを除外。ただし期限内の出張タスク（business_trip）は完了後も表示を維持する
    const activeData = data.filter(t => {
        if (!_isProjectCompletedOnMasterSchedule(t.project_number)) return true;
        return _isTripTask(t) && !_isTripTaskExpiredDb(t.end_date);
    });

    // 工事番号ごとの情報をマップに格納
    projectMap = new Map();
    activeData.forEach(item => {
        if (item.project_number) {
            const existing = projectMap.get(item.project_number);
            const customer = item.customer_name || (existing ? existing.customer : "");
            const details = item.project_details || (existing ? existing.details : "");
            projectMap.set(item.project_number, { customer, details });
        }
    });

    const nums = Array.from(projectMap.keys()).sort();
    const list = document.getElementById('project_chk_list');

    // URLパラメータで初期選択（リスト構築前にフィルター状態を確定）
    if (projectParam) {
        currentProjectFilter = [String(projectParam)];
    }

    list.innerHTML = nums.map(n => {
        const isChecked = currentProjectFilter.length === 0 || currentProjectFilter.includes(n);
        return `<label style="display:block; padding:4px 10px; cursor:pointer; white-space:nowrap; font-size:13px; font-family:'メイリオ',Meiryo,sans-serif;">
            <input type="checkbox" class="project-chk-item" value="${n}" onchange="projectFilterItemChanged()"${isChecked ? ' checked' : ''}> ${n}
        </label>`;
    }).join('');

    const allChk = document.getElementById('project_chk_all');
    if (allChk) {
        if (currentProjectFilter.length === 0) {
            allChk.checked = true;
            allChk.indeterminate = false;
        } else {
            const total = nums.length;
            const visCount = currentProjectFilter.filter(v => v !== FILTER_NONE).length;
            allChk.checked = visCount >= total;
            allChk.indeterminate = visCount > 0 && visCount < total;
        }
    }

    _updateProjectFilterBtn();
    _rebuildMachineFilterFromRows(activeData);
    _rebuildUnitFilterFromRows(activeData);
    _rebuildOwnerFilterFromRows(activeData);
    updateDisplay();
}

// 初期化関数
async function initialize() {
    const urlParams = new URLSearchParams(window.location.search);
    const projectParam = urlParams.get('project_no') || urlParams.get('project');
    console.log("URLパラメータ:", projectParam);

    // 0. プラグイン有効化は gantt-setup.js 先頭に移動済み

    // 1. Gantt初期化
    // onAuthStateChange は非同期のため initialize() より先に発火して _isEditor が
    // 確定していることがある。ここで無条件に true を上書きするとその判定を消してしまうため、
    // 現在の _isEditor（未確定なら false）を反映する。
    gantt.config.readonly = !_isEditor;
    gantt.config.columns = _applyColumnFilterButtons(_getDrawingColumns());
    gantt.config._columnFilterType = 'drawing';
    _setLayout(_getColsSum(gantt.config.columns));

    gantt.init("gantt_here");

    // インライン編集の input がログイン用パスワード欄と同ページにあると、
    // ブラウザ／拡張が「パスワードを保存」と誤検知することがあるため、
    // エディタ表示直後に autocomplete と誤認抑止属性を付与する。
    if (gantt.ext && gantt.ext.inlineEditors) {
        function _disableInlineEditorPasswordHeuristics() {
            var root = document.getElementById("gantt_here");
            if (!root) return;
            root.querySelectorAll(
                ".gantt_grid_editor_placeholder input, .gantt_grid_editor_placeholder select, .gantt_grid_editor_placeholder textarea"
            ).forEach(function (el) {
                if (el.type === "password") return;
                el.setAttribute("autocomplete", "off");
                el.setAttribute("data-lpignore", "true");
                el.setAttribute("data-1p-ignore", "true");
                el.setAttribute("data-form-type", "other");
            });
        }
        gantt.ext.inlineEditors.attachEvent("onEditStart", function () {
            requestAnimationFrame(_disableInlineEditorPasswordHeuristics);
            setTimeout(_disableInlineEditorPasswordHeuristics, 0);
        });
    }

    // === グリッド操作設定 ===
    function _syncSelectionActionButtons() {
        if (typeof _updateMultiDeleteBtn === "function") {
            _updateMultiDeleteBtn();
        }
    }

    // タスク選択が変わるたびに選択削除ボタンを更新
    gantt.attachEvent("onTaskClick", function(id, e) {
        setTimeout(_syncSelectionActionButtons, 0);
        return true;
    });
    gantt.attachEvent("onEmptyClick", function(e) {
        _gridSelection.clear();
        _lastGridClickId = null;
        _applyGridSelection();
        setTimeout(_syncSelectionActionButtons, 0);
        return true;
    });
    // 再描画後にグリッド選択ハイライトを復元
    gantt.attachEvent("onGanttRender", function() {
        _applyGridSelection();
        _syncSelectionActionButtons();
    });
    // スクロール後にグリッド選択ハイライトを復元
    gantt.attachEvent("onGanttScroll", function() {
        _applyGridSelection();
    });

    // キャプチャフェーズでグリッドセルのクリックを横取り
    // → dhtmlxGanttのバブルリスナー（インライン編集起動）に届かせない
    // シングルクリック: バーが見えるようタイムラインをスクロール
    // ＋ボタン（.custom_add_btn）は横取りせずそのまま通過させる
    document.getElementById("gantt_here").addEventListener("click", function(e) {
        if (e.target.closest(".custom_add_btn")) return;
        const cell = e.target.closest(".gantt_cell");
        if (!cell) return;
        e.stopImmediatePropagation();
        const row = cell.closest("[task_id]");
        if (!row) return;
        const taskId = row.getAttribute("task_id");

        if (e.ctrlKey || e.metaKey) {
            // Ctrl+クリック：トグル選択
            if (_gridSelection.has(taskId)) {
                _gridSelection.delete(taskId);
            } else {
                _gridSelection.add(taskId);
            }
            _lastGridClickId = taskId;
        } else if (e.shiftKey && _lastGridClickId) {
            // Shift+クリック：範囲選択（既存選択を置き換え、アンカーは維持）
            // DOMではなくganttデータモデルからvisIds構築（仮想スクロール対応）
            const visIds = [];
            gantt.eachTask(function(task) {
                if (typeof _taskVisibleOnGantt === 'function' ? _taskVisibleOnGantt(task) : true) {
                    visIds.push(String(task.id));
                }
            });
            const a = visIds.indexOf(String(_lastGridClickId));
            const b = visIds.indexOf(String(taskId));
            _gridSelection.clear();
            if (a >= 0 && b >= 0) {
                const [from, to] = a <= b ? [a, b] : [b, a];
                for (let i = from; i <= to; i++) _gridSelection.add(visIds[i]);
            } else {
                _gridSelection.add(taskId);
            }
        } else {
            // 通常クリック：単一選択＋バースクロール（完了予定日／終了日基準）
            _gridSelection.clear();
            _gridSelection.add(taskId);
            _lastGridClickId = taskId;
            const scrollY = gantt.getScrollState().y;
            _scrollTimelineToTaskEnd(taskId);
            gantt.scrollTo(null, scrollY);
        }
        _applyGridSelection();
        _syncSelectionActionButtons();
    }, true);

    // ダブルクリック: インラインエディタを開く（ライトボックスはブロック）
    // バーのダブルクリックは .gantt_cell を持たないため通過し、デフォルトのライトボックスが開く
    document.getElementById("gantt_here").addEventListener("dblclick", function(e) {
        if (!_isEditor) return;
        const cell = e.target.closest(".gantt_cell");
        if (!cell) return;
        e.stopImmediatePropagation();
        const row = cell.closest("[task_id]");
        if (!row) return;
        const taskId = row.getAttribute("task_id");
        if (!taskId) return;
        const cells = [...row.querySelectorAll(".gantt_cell")];
        const colIndex = cells.indexOf(cell);
        const col = gantt.config.columns[colIndex];
        if (col && col.editor) {
            gantt.ext.inlineEditors.startEdit(taskId, col.name);
        }
    }, true);

    // 右クリックコンテキストメニュー（コピー・削除）
    const _ctxMenu = document.createElement('div');
    _ctxMenu.id = 'gantt_ctx_menu';
    _ctxMenu.innerHTML =
        '<div id="gantt_ctx_copy"       class="gantt_ctx_item">このタスクをコピー</div>' +
        '<div id="gantt_ctx_copy_multi" class="gantt_ctx_item">選択した行をコピー（<span id="gantt_ctx_copy_multi_count">0</span>件）</div>' +
        '<div class="gantt_ctx_sep"></div>' +
        '<div id="gantt_ctx_edit_multi" class="gantt_ctx_item">このタスクを編集</div>' +
        '<div class="gantt_ctx_sep"></div>' +
        '<div id="gantt_ctx_paste"      class="gantt_ctx_item disabled">コピーした行を貼り付け</div>' +
        '<div class="gantt_ctx_sep"></div>' +
        '<div id="gantt_ctx_delete"     class="gantt_ctx_item">このタスクを削除</div>';
    document.body.appendChild(_ctxMenu);

    let _ctxTaskId = null;
    let _copiedTasks = []; // 複数行コピーのバッファ

    document.getElementById("gantt_here").addEventListener("contextmenu", function(e) {
        if (!_isEditor) return;
        const row = e.target.closest("[task_id]");
        if (!row) return;
        e.preventDefault();
        _ctxTaskId = row.getAttribute("task_id");
        // 選択件数を更新
        document.getElementById("gantt_ctx_copy_multi_count").textContent = _gridSelection.size;
        // 単一選択時は「このタスクをコピー」、複数選択時は「選択した行をコピー」を表示
        const isMultiCopy = _gridSelection.size > 1 && _gridSelection.has(String(_ctxTaskId));
        document.getElementById("gantt_ctx_copy").style.display = isMultiCopy ? "none" : "";
        document.getElementById("gantt_ctx_copy_multi").style.display = isMultiCopy ? "" : "none";
        // 一括編集は複数選択時のみ表示（単一選択時は非表示）
        document.getElementById("gantt_ctx_edit_multi").style.display = isMultiCopy ? "" : "none";
        // 削除ラベルを選択数に応じて切り替え
        const isMultiDelete = _gridSelection.size > 1 && _gridSelection.has(String(_ctxTaskId));
        const isMultiEdit = _gridSelection.size > 1 && _gridSelection.has(String(_ctxTaskId));
        document.getElementById("gantt_ctx_delete").textContent =
            isMultiDelete ? `選択した ${_gridSelection.size} 件を削除` : "このタスクを削除";
        document.getElementById("gantt_ctx_edit_multi").textContent =
            isMultiEdit ? `選択した ${_gridSelection.size} 件を編集` : "このタスクを編集";
        // コピーの有効/無効（工事番号が1つ選択されていない場合は不可）
        const _copyDisabled = currentProjectFilter.length !== 1 || currentProjectFilter[0] === FILTER_NONE;
        document.getElementById("gantt_ctx_copy").classList.toggle('disabled', _copyDisabled);
        document.getElementById("gantt_ctx_copy_multi").classList.toggle('disabled', _copyDisabled);
        // 貼り付けの有効/無効
        document.getElementById("gantt_ctx_paste").classList.toggle('disabled', _copiedTasks.length === 0);
        _ctxMenu.style.display = 'block';
        const menuH = _ctxMenu.offsetHeight;
        const menuW = _ctxMenu.offsetWidth;
        const top = (e.clientY + menuH > window.innerHeight) ? e.clientY - menuH : e.clientY;
        const left = (e.clientX + menuW > window.innerWidth) ? e.clientX - menuW : e.clientX;
        _ctxMenu.style.top = (top + window.scrollY) + 'px';
        _ctxMenu.style.left = (left + window.scrollX) + 'px';
    });

    // コピー項目設定
    const COPY_FIELDS = [
        { key: 'project_number',  label: '工事番号',   default: true },
        { key: 'machine',         label: '機械',       default: true },
        { key: 'unit',            label: 'ユニ',       default: false },
        { key: 'unit2',           label: 'ユニ2',      default: true },
        { key: 'text',            label: 'タスク名',   default: false },
        { key: 'model_type',      label: '機種',       default: true },
        { key: 'part_number',     label: '型式・図番', default: true },
        { key: 'quantity',        label: '個数',       default: true },
        { key: 'manufacturer',    label: 'メーカー',   default: true },
        { key: 'status',          label: '状態',       default: true },
        { key: 'customer_name',   label: '客先名',     default: true },
        { key: 'project_details', label: '案件詳細',   default: true },
        { key: 'characteristic',  label: '特性',       default: true },
        { key: 'derivation',      label: '派生',       default: true },
        { key: 'owner',           label: '担当',       default: true },
        { key: 'start_date',      label: '開始日',     default: true },
        { key: 'end_date',        label: '完了予定日', default: false },
        { key: 'total_sheets',    label: '総枚数',     default: false },
        { key: 'completed_sheets',label: '完了枚数',   default: false },
    ];
    const COPY_OPTS_KEY = 'gantt_copy_opts';

    // コピーモーダルの生成
    const _copyOverlay = document.createElement('div');
    _copyOverlay.id = 'copy_options_overlay';
    _copyOverlay.innerHTML = `
        <div id="copy_options_dialog">
            <h3>コピーする項目を選択</h3>
            <div class="copy-opts-grid">
                ${COPY_FIELDS.map(f => `
                    <label>
                        <input type="checkbox" data-copy-key="${f.key}">
                        ${f.label}
                    </label>`).join('')}
            </div>
            <div class="copy-opts-actions">
                <button class="btn" id="copy_opts_cancel">キャンセル</button>
                <button class="btn btn-primary" id="copy_opts_exec">コピー実行</button>
            </div>
        </div>`;
    document.body.appendChild(_copyOverlay);

    // チェック状態をlocalStorageから復元
    function _loadCopyOpts() {
        try {
            return JSON.parse(localStorage.getItem(COPY_OPTS_KEY) || 'null');
        } catch { return null; }
    }
    function _saveCopyOpts() {
        const state = {};
        _copyOverlay.querySelectorAll('[data-copy-key]').forEach(cb => {
            state[cb.dataset.copyKey] = cb.checked;
        });
        localStorage.setItem(COPY_OPTS_KEY, JSON.stringify(state));
    }
    function _applyDefaultOpts() {
        const saved = _loadCopyOpts();
        _copyOverlay.querySelectorAll('[data-copy-key]').forEach(cb => {
            const key = cb.dataset.copyKey;
            const field = COPY_FIELDS.find(f => f.key === key);
            cb.checked = saved ? (saved[key] ?? field.default) : field.default;
        });
    }

    let _copySourceId = null;

    // コピーメニュークリック → モーダル表示
    document.getElementById("gantt_ctx_copy").addEventListener("click", function() {
        _copySourceId = _ctxTaskId;
        _ctxMenu.style.display = 'none';
        _ctxTaskId = null;
        if (!_copySourceId || !gantt.isTaskExists(_copySourceId)) return;
        _applyDefaultOpts();
        _copyOverlay.classList.add('open');
    });

    document.getElementById("copy_opts_cancel").addEventListener("click", function() {
        _copyOverlay.classList.remove('open');
        _copySourceId = null;
    });

    // コピー元の直下に挿入する sort_order を計算するヘルパー
    function _calcInsertAfterSortOrder(sourceId) {
        const src = gantt.getTask(sourceId);
        const projectNumber = src.project_number;
        const taskType = src.task_type;
        const _getSO = t => (t.sort_order != null) ? t.sort_order : t.id * 1000;
        const allTasks = gantt.getTaskByTime().filter(t => {
            const isDetailed = (t.is_detailed === true || String(t.is_detailed).toUpperCase() === 'TRUE');
            if (!isDetailed) return false;
            if (String(t.project_number) !== String(projectNumber)) return false;
            if (taskType && String(t.task_type) !== String(taskType)) return false;
            return true;
        }).sort((a, b) => _getSO(a) - _getSO(b));
        const idx = allTasks.findIndex(t => String(t.id) === String(sourceId));
        if (idx < 0) return _getSO(src) + 1000;
        const afterSO = _getSO(allTasks[idx]);
        if (idx + 1 < allTasks.length) {
            return Math.round((afterSO + _getSO(allTasks[idx + 1])) / 2);
        }
        return afterSO + 1000;
    }

    // 単一コピー実行
    document.getElementById("copy_opts_exec").addEventListener("click", async function() {
        _saveCopyOpts();
        _copyOverlay.classList.remove('open');
        if (!_copySourceId || !gantt.isTaskExists(_copySourceId)) return;

        const src = gantt.getTask(_copySourceId);
        const insertSortOrder = _calcInsertAfterSortOrder(_copySourceId);
        _copySourceId = null;

        // チェック状態を収集
        const checked = {};
        _copyOverlay.querySelectorAll('[data-copy-key]').forEach(cb => {
            checked[cb.dataset.copyKey] = cb.checked;
        });

        const _v  = (key, fallback) => checked[key] ? (src[key] || fallback) : fallback;
        const _n  = (key) => checked[key] ? (Number(src[key]) || 0) : 0;
        const _dt = (key) => {
            if (!checked[key]) return null;
            if (key === 'end_date') {
                return src.end_date instanceof Date
                    ? _toDateStr(gantt.date.add(new Date(src.end_date), -1, 'day'))
                    : src.end_date;
            }
            return src[key] instanceof Date ? _toDateStr(src[key]) : src[key];
        };

        showLoading();
        try {
            const _lb = (typeof window._getCurrentEditorName === 'function' ? window._getCurrentEditorName() : '') || '';
            const { data, error } = await supabaseClient
                .from('tasks')
                .insert([Object.assign({
                    text:             _v('text', ""),
                    start_date:       _dt('start_date'),
                    end_date:         _dt('end_date'),
                    project_number:   _v('project_number', ""),
                    machine:          _v('machine', ""),
                    unit:             _v('unit', ""),
                    unit2:            _v('unit2', ""),
                    model_type:       _v('model_type', ""),
                    part_number:      _v('part_number', ""),
                    quantity:         _n('quantity'),
                    manufacturer:     _v('manufacturer', ""),
                    status:           _v('status', ""),
                    customer_name:    _v('customer_name', ""),
                    project_details:  _v('project_details', ""),
                    characteristic:   _v('characteristic', ""),
                    derivation:       _v('derivation', ""),
                    owner:            _v('owner', ""),
                    total_sheets:     checked['total_sheets'] ? _totalSheetsToDb(src.total_sheets) : null,
                    completed_sheets: checked['completed_sheets'] ? _completedSheetsToDb(src.completed_sheets) : null,
                    wish_date:        src.wish_date || null,
                    task_type:        currentTaskTypeFilter || src.task_type || "drawing",
                    is_detailed:      true,
                    sort_order:       insertSortOrder
                }, _lb ? { last_updated_by: _lb } : {})])
                .select();

            if (error) {
                console.error("Error copying task:", error);
                alert("タスクのコピーに失敗しました。\n" + error.message);
                return;
            }

            await loadData();
            if (data && data[0]) gantt.showTask(data[0].id);
        } finally {
            hideLoading();
        }
    });

    // 複数行コピー
    document.getElementById("gantt_ctx_copy_multi").addEventListener("click", function() {
        _ctxMenu.style.display = 'none';
        if (_gridSelection.size === 0) { alert("行を選択してからコピーしてください。"); return; }
        _copiedTasks = [..._gridSelection]
            .map(id => gantt.isTaskExists(id) ? gantt.getTask(id) : null)
            .filter(Boolean);
        alert(`${_copiedTasks.length} 行をコピーしました。\n貼り付け先の工事番号を選択して右クリック →「コピーした行を貼り付け」してください。`);
        _ctxTaskId = null;
    });

    // 複数行一括編集
    document.getElementById("gantt_ctx_edit_multi").addEventListener("click", function() {
        _ctxMenu.style.display = "none";
        if (_ctxTaskId && (!_gridSelection.has(String(_ctxTaskId)) || _gridSelection.size <= 1)) {
            _gridSelection.clear();
            _gridSelection.add(String(_ctxTaskId));
            _applyGridSelection();
            _syncSelectionActionButtons();
        }
        openMultiEditModal();
        _ctxTaskId = null;
    });

    // 複数行貼り付け
    document.getElementById("gantt_ctx_paste").addEventListener("click", async function() {
        _ctxMenu.style.display = 'none';
        if (_copiedTasks.length === 0) return;
        if (currentProjectFilter.length !== 1 || currentProjectFilter[0] === FILTER_NONE) {
            alert("貼り付け先の工事番号を1つ選択してください。");
            return;
        }
        const destProject = currentProjectFilter[0];

        // 現在表示中タスクの末尾 sort_order を求める
        const _getSO = t => (t.sort_order != null) ? t.sort_order : t.id * 1000;
        const visibleTasks = gantt.getTaskByTime().filter(t => {
            const isDetailed = (t.is_detailed === true || String(t.is_detailed).toUpperCase() === 'TRUE');
            if (!isDetailed) return false;
            if (String(t.project_number) !== String(destProject)) return false;
            if (currentTaskTypeFilter && String(t.task_type) !== currentTaskTypeFilter) return false;
            return true;
        }).sort((a, b) => _getSO(a) - _getSO(b));

        let baseSO = visibleTasks.length > 0 ? _getSO(visibleTasks[visibleTasks.length - 1]) : 0;

        // コピー元タスクをsort_order順に並べて貼り付け順序を維持
        const sortedCopied = [..._copiedTasks].sort((a, b) => _getSO(a) - _getSO(b));

        const _lb = (typeof window._getCurrentEditorName === 'function' ? window._getCurrentEditorName() : '') || '';

        const insertRows = sortedCopied.map((src, i) => {
            // ① 日付なしタスクは null のまま（ダミー日付を変換しない）
            const endDate = src.has_no_date ? null
                : src.end_date instanceof Date
                    ? _toDateStr(gantt.date.add(new Date(src.end_date), -1, 'day'))
                    : src.end_date;
            const startDate = src.has_no_start ? null
                : src.start_date instanceof Date
                    ? _toDateStr(src.start_date)
                    : src.start_date;
            return Object.assign({
                text:             src.text             || "",
                start_date:       startDate,
                end_date:         endDate,
                project_number:   destProject,
                machine:          src.machine          || "",
                unit:             src.unit             || "",
                unit2:            src.unit2            || "",
                model_type:       src.model_type       || "",
                part_number:      src.part_number      || "",
                quantity:         Number(src.quantity) || 0,
                manufacturer:     src.manufacturer     || "",
                status:           src.status           || "",
                customer_name:    src.customer_name    || "",
                project_details:  src.project_details  || "",
                characteristic:   src.characteristic   || "",
                derivation:       src.derivation       || "",
                owner:            src.owner            || "",
                total_sheets:     _totalSheetsToDb(src.total_sheets),
                completed_sheets: _completedSheetsToDb(src.completed_sheets),
                wish_date:        src.wish_date        || null,
                task_type:        currentTaskTypeFilter || src.task_type || "drawing",
                is_detailed:      true,
                is_archived:      false,
                sort_order:       baseSO + (i + 1) * 1000
            }, _lb ? { last_updated_by: _lb } : {});
        });

        showLoading();
        try {
            const { error } = await supabaseClient.from('tasks').insert(insertRows);
            if (error) {
                console.error("Error pasting tasks:", error);
                // ② エラー時もloadDataを呼んでDB状態をブラウザに反映（③重複sort_order防止）
                await loadData();
                alert("保存時にエラーが発生しました。\nデータが保存されている場合は画面に反映されます。保存されていなければ再度操作してください。\n\n詳細: " + error.message);
                return;
            }

            await loadData();
            _ctxTaskId = null;
        } finally {
            hideLoading();
        }
    });

    // 削除
    document.getElementById("gantt_ctx_delete").addEventListener("click", async function() {
        _ctxMenu.style.display = 'none';
        // 複数選択中かつ右クリック行が選択に含まれる場合 → 一括削除
        if (_gridSelection.size > 1 && _ctxTaskId && _gridSelection.has(String(_ctxTaskId))) {
            const ids = [..._gridSelection].map(id => Number(id));
            if (!confirm(`選択した ${ids.length} 件のタスクを削除しますか？`)) { _ctxTaskId = null; return; }
            showLoading();
            try {
                const { error } = await supabaseClient.from('tasks').delete().in('id', ids);
                if (error) { alert("削除に失敗しました。\n" + error.message); _ctxTaskId = null; return; }
                await loadData();
            } finally {
                hideLoading();
            }
        } else if (_ctxTaskId) {
            if (confirm("このタスクを削除しますか？")) gantt.deleteTask(_ctxTaskId);
        }
        _ctxTaskId = null;
    });

    document.addEventListener("click", function(e) {
        if (!e.target.closest('#gantt_ctx_menu')) {
            _ctxMenu.style.display = 'none';
        }
    });

    // 2. 休日データを読み込む
    await loadHolidays();

    // 3. セレクトボックスを構築（パラメータがあれば selected になる）
    await initProjectSelect(projectParam);
    
    // 3. マーカー追加（edge版でプラグインが未登録でもクラッシュしないよう guard）
    const today = new Date();
    if (typeof gantt.addMarker === 'function') {
        gantt.addMarker({
            start_date: today,
            css: "today-line",
            text: "今日",
            title: "今日: " + gantt.templates.date_grid(today)
        });
    } else {
        console.warn('[Gantt] marker plugin not available (gantt.addMarker is not a function). Today line will not be shown.');
    }

    // 4. データを読み込む
    await loadData();

    // 5. フィルタ適用
    updateDisplay();

    // 6. 再描画
    gantt.render();

    // 6b. 今日の日付へスクロール（ガントモード表示時の初期位置）
    gantt.showDate(new Date());

    // 7. 初期表示モードを設定
    // task_type パラメータがある場合（全体工程表から遷移）はガントモードで起動
    //   - task_type=long_lead_item → 長納期品モード
    //   - task_type=drawing        → 図面モード
    // task_type パラメータがない場合（直接アクセス）は担当別モードで起動
    const taskTypeParam = urlParams.get('task_type');
    requestAnimationFrame(() => {
        if (taskTypeParam) {
            // 全体工程表からの遷移：指定モードのガントビューで起動
            currentTaskTypeFilter = taskTypeParam;
            updateFilterButtons();
            switchColumns(taskTypeParam);
            _rebuildMachineFilterOptionsFromGantt();
            _rebuildUnitFilterOptionsFromGantt();
            _rebuildOwnerFilterOptionsFromGantt();
            // フィルターボタンクリック時と同様にズームレベルを再設定してカレンダーヘッダーを完全再描画
            setTimeout(() => {
                gantt.setSizes();
                const currentLevel = document.querySelector('.zoom-btn.active')?.textContent === '週単位' ? 'week' : 'day';
                gantt.ext.zoom.setLevel(currentLevel);
                const overlay = document.getElementById('page_loading_overlay');
                if (overlay) overlay.remove();
            }, 0);
        } else {
            // 直接アクセス：担当別モードで起動
            _enterResourceFullscreen();
            setTimeout(() => {
                const overlay = document.getElementById('page_loading_overlay');
                if (overlay) overlay.remove();
            }, 60);
        }
    });
}

