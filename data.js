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

// データ読み込み
async function loadData() {
    const { data, error } = await supabaseClient
        .from('tasks')
        .select('*')
        .neq('is_archived', true)
        .order('project_number', { ascending: true })
        .order('id', { ascending: true });

    if (error) {
        console.error("Supabase error:", error);
        return;
    }

    const today = new Date().toISOString().split('T')[0];

    const parsedTasks = data.map(t => {
        // end_dateがnullの場合はバー非表示（has_no_date=true）
        const hasNoDate = !t.end_date;

        const startDate = t.start_date
            ? _parseSupabaseDate(t.start_date)
            : new Date(today + 'T00:00:00Z');
        // end_dateがnullの場合はダミーの終了日を設定（gantt内部用、バーは非表示）
        const endDate = t.end_date
            ? gantt.date.add(_parseSupabaseDate(t.end_date), 1, 'day')
            : gantt.date.add(startDate, 1, 'day');

        return {
            ...t,
            start_date: startDate,
            end_date:   endDate,
            has_no_date: hasNoDate
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

    // データ更新時は選択をリセット
    _gridSelection.clear();
    _lastGridClickId = null;

    gantt.clearAll();
    gantt.parse({
        data: parsedTasks
    });

    // 追加：データ読み込み完了直後にリソースデータを更新
    if (isResourceView) {
        updateResourceData();
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
let _clearingEndDateId = null;   // 完了予定日クリア中のタスクID
let isResourceFullscreen = false;

function _initOwnerFilterDropdown() {
    const list = document.getElementById('owner_chk_list');
    if (!list) return;
    list.innerHTML = OWNER_OPTIONS.map(name => `
        <label style="display:block; padding:4px 10px; cursor:pointer; white-space:nowrap; font-size:13px; font-family:'メイリオ',Meiryo,sans-serif;">
            <input type="checkbox" class="owner-chk-item" value="${name}" onchange="ownerFilterItemChanged()"> ${name}
        </label>
    `).join('');
}

function toggleProjectFilterDropdown() {
    const dd = document.getElementById('project_filter_dropdown');
    if (dd) dd.style.display = dd.style.display === 'none' ? '' : 'none';
}

function projectFilterAllChanged(checkbox) {
    document.querySelectorAll('.project-chk-item').forEach(chk => { chk.checked = false; });
    currentProjectFilter = [];
    gantt.render();
    _updateProjectFilterBtn();
    updateDisplay();
}

function projectFilterItemChanged() {
    const selected = [];
    document.querySelectorAll('.project-chk-item:checked').forEach(chk => selected.push(chk.value));
    currentProjectFilter = selected;
    const allChk = document.getElementById('project_chk_all');
    if (allChk) allChk.checked = selected.length === 0;
    gantt.render();
    _updateProjectFilterBtn();
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
    } else if (currentProjectFilter.length === 1) {
        btn.textContent = currentProjectFilter[0];
    } else {
        btn.textContent = currentProjectFilter[0] + ' 他' + (currentProjectFilter.length - 1) + '件';
    }
}

function toggleOwnerFilterDropdown() {
    const dd = document.getElementById('owner_filter_dropdown');
    if (dd) dd.style.display = dd.style.display === 'none' ? '' : 'none';
}

function ownerFilterAllChanged(checkbox) {
    document.querySelectorAll('.owner-chk-item').forEach(chk => { chk.checked = false; });
    currentOwnerFilter = [];
    gantt.render();
    _updateOwnerFilterBtn();
}

function ownerFilterItemChanged() {
    const selected = [];
    document.querySelectorAll('.owner-chk-item:checked').forEach(chk => selected.push(chk.value));
    currentOwnerFilter = selected;
    const allChk = document.getElementById('owner_chk_all');
    if (allChk) allChk.checked = selected.length === 0;
    gantt.render();
    _updateOwnerFilterBtn();
}

function _updateOwnerFilterBtn() {
    const btn = document.getElementById('owner_filter_btn');
    if (!btn) return;
    if (currentOwnerFilter.length === 0) {
        btn.textContent = '担当者: 全員';
    } else if (currentOwnerFilter.length === 1) {
        btn.textContent = currentOwnerFilter[0];
    } else {
        btn.textContent = currentOwnerFilter[0] + ' 他' + (currentOwnerFilter.length - 1) + '名';
    }
}

// ドロップダウン外クリックで閉じる
document.addEventListener('click', function(e) {
    const ownerWrap = document.getElementById('owner_filter_wrap');
    if (ownerWrap && !ownerWrap.contains(e.target)) {
        const dd = document.getElementById('owner_filter_dropdown');
        if (dd) dd.style.display = 'none';
    }
    const projectWrap = document.getElementById('project_filter_wrap');
    if (projectWrap && !projectWrap.contains(e.target)) {
        const dd = document.getElementById('project_filter_dropdown');
        if (dd) dd.style.display = 'none';
    }
    const archiveBtnWrap = document.getElementById('archive_btn_wrap');
    if (archiveBtnWrap && !archiveBtnWrap.contains(e.target)) {
        const menu = document.getElementById('archive_dropdown_menu');
        if (menu) menu.classList.remove('open');
    }
});

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
    // 担当者フィルターは非担当別モードのみ表示
    const ownerWrap = document.getElementById('owner_filter_wrap');
    if (ownerWrap) ownerWrap.style.display = isResourceFullscreen ? 'none' : '';
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
        // ブラウザの描画確定後にズームレベルを再設定してカレンダーヘッダーを完全再描画
        setTimeout(() => {
            gantt.setSizes();
            const currentLevel = document.querySelector('.zoom-btn.active')?.textContent === '週単位' ? 'week' : 'day';
            gantt.ext.zoom.setLevel(currentLevel);
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
}

// 工事番号フィルターの初期化
async function initProjectSelect(projectParam) {
    const { data } = await supabaseClient
        .from('tasks')
        .select('project_number, customer_name, project_details')
        .neq('is_archived', true);
    if (!data) return;

    // 工事番号ごとの情報をマップに格納
    projectMap = new Map();
    data.forEach(item => {
        if (item.project_number) {
            const existing = projectMap.get(item.project_number);
            const customer = item.customer_name || (existing ? existing.customer : "");
            const details = item.project_details || (existing ? existing.details : "");
            projectMap.set(item.project_number, { customer, details });
        }
    });

    const nums = Array.from(projectMap.keys()).sort();
    const list = document.getElementById('project_chk_list');
    list.innerHTML = nums.map(n => `
        <label style="display:block; padding:4px 10px; cursor:pointer; white-space:nowrap; font-size:13px; font-family:'メイリオ',Meiryo,sans-serif;">
            <input type="checkbox" class="project-chk-item" value="${n}" onchange="projectFilterItemChanged()"> ${n}
        </label>`).join('');

    // URLパラメータで初期選択
    if (projectParam) {
        const chk = list.querySelector(`.project-chk-item[value="${projectParam}"]`);
        if (chk) {
            chk.checked = true;
            currentProjectFilter = [String(projectParam)];
            const allChk = document.getElementById('project_chk_all');
            if (allChk) allChk.checked = false;
        }
    }

    _updateProjectFilterBtn();
    updateDisplay();
}

// 初期化関数
async function initialize() {
    const urlParams = new URLSearchParams(window.location.search);
    const projectParam = urlParams.get('project_no') || urlParams.get('project');
    console.log("URLパラメータ:", projectParam);

    // 0. プラグインの有効化
    gantt.plugins({
        marker: true,
        multiselect: true
    });

    // 1. Gantt初期化（デフォルトは読み取り専用、ログイン後に解除）
    gantt.config.readonly = true;
    gantt.config.columns = _getDrawingColumns();
    _setLayout(_getColsSum(gantt.config.columns));

    gantt.init("gantt_here");

    // === グリッド操作設定 ===

    // タスク選択が変わるたびに選択削除ボタンを更新
    gantt.attachEvent("onTaskClick", function(id, e) {
        setTimeout(_updateMultiDeleteBtn, 0);
        return true;
    });
    gantt.attachEvent("onEmptyClick", function(e) {
        _gridSelection.clear();
        _lastGridClickId = null;
        _applyGridSelection();
        setTimeout(_updateMultiDeleteBtn, 0);
        return true;
    });
    // 再描画後にグリッド選択ハイライトを復元
    gantt.attachEvent("onGanttRender", function() {
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
            // Shift+クリック：範囲選択
            const visIds = [...document.querySelectorAll('#gantt_here .gantt_grid_data .gantt_row[task_id]')]
                .map(el => el.getAttribute('task_id'));
            const a = visIds.indexOf(String(_lastGridClickId));
            const b = visIds.indexOf(String(taskId));
            if (a >= 0 && b >= 0) {
                const [from, to] = a <= b ? [a, b] : [b, a];
                for (let i = from; i <= to; i++) _gridSelection.add(visIds[i]);
            } else {
                _gridSelection.add(taskId);
            }
        } else {
            // 通常クリック：単一選択＋バースクロール
            _gridSelection.clear();
            _gridSelection.add(taskId);
            _lastGridClickId = taskId;
            const scrollY = gantt.getScrollState().y;
            gantt.showTask(taskId);
            gantt.scrollTo(null, scrollY);
        }
        _applyGridSelection();
        _updateMultiDeleteBtn();
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
        // 削除ラベルを選択数に応じて切り替え
        const isMultiDelete = _gridSelection.size > 1 && _gridSelection.has(String(_ctxTaskId));
        document.getElementById("gantt_ctx_delete").textContent =
            isMultiDelete ? `選択した ${_gridSelection.size} 件を削除` : "このタスクを削除";
        // コピーの有効/無効（工事番号が1つ選択されていない場合は不可）
        const _copyDisabled = currentProjectFilter.length !== 1;
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

        const { data, error } = await supabaseClient
            .from('tasks')
            .insert([{
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
                total_sheets:     _n('total_sheets'),
                completed_sheets: _n('completed_sheets'),
                wish_date:        src.wish_date || null,
                task_type:        currentTaskTypeFilter || src.task_type || "drawing",
                is_detailed:      true,
                sort_order:       insertSortOrder
            }])
            .select();

        if (error) {
            console.error("Error copying task:", error);
            alert("タスクのコピーに失敗しました。\n" + error.message);
            return;
        }

        await loadData();
        if (data && data[0]) gantt.showTask(data[0].id);
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

    // 複数行貼り付け
    document.getElementById("gantt_ctx_paste").addEventListener("click", async function() {
        _ctxMenu.style.display = 'none';
        if (_copiedTasks.length === 0) return;
        if (currentProjectFilter.length !== 1) {
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

        const insertRows = sortedCopied.map((src, i) => {
            const endDate = src.end_date instanceof Date
                ? _toDateStr(gantt.date.add(new Date(src.end_date), -1, 'day'))
                : src.end_date;
            const startDate = src.start_date instanceof Date
                ? _toDateStr(src.start_date)
                : src.start_date;
            return {
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
                total_sheets:     Number(src.total_sheets)     || 0,
                completed_sheets: Number(src.completed_sheets) || 0,
                wish_date:        src.wish_date        || null,
                task_type:        currentTaskTypeFilter || src.task_type || "drawing",
                is_detailed:      true,
                sort_order:       baseSO + (i + 1) * 1000
            };
        });

        const { error } = await supabaseClient.from('tasks').insert(insertRows);
        if (error) {
            console.error("Error pasting tasks:", error);
            alert("貼り付けに失敗しました。\n" + error.message);
            return;
        }

        await loadData();
        _ctxTaskId = null;
    });

    // 削除
    document.getElementById("gantt_ctx_delete").addEventListener("click", async function() {
        _ctxMenu.style.display = 'none';
        // 複数選択中かつ右クリック行が選択に含まれる場合 → 一括削除
        if (_gridSelection.size > 1 && _ctxTaskId && _gridSelection.has(String(_ctxTaskId))) {
            const ids = [..._gridSelection].map(id => Number(id));
            if (!confirm(`選択した ${ids.length} 件のタスクを削除しますか？`)) { _ctxTaskId = null; return; }
            const { error } = await supabaseClient.from('tasks').delete().in('id', ids);
            if (error) { alert("削除に失敗しました。\n" + error.message); _ctxTaskId = null; return; }
            await loadData();
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
    
    // 3. マーカー追加
    const today = new Date();
    gantt.addMarker({
        start_date: today,
        css: "today-line",
        text: "今日",
        title: "今日: " + gantt.templates.date_grid(today)
    });

    // 4. データを読み込む
    await loadData();

    // 5. フィルタ適用
    updateDisplay();

    // 担当者フィルタードロップダウンのチェックボックスを生成
    _initOwnerFilterDropdown();

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

