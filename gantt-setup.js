// Gantt 基本構成
gantt.config.date_format = "%Y-%m-%d";

// date入力で値を選択した時点でインライン編集を確定する
function _commitInlineDateEdit(inputEl) {
    if (!inputEl) return;
    setTimeout(function() {
        try { inputEl.blur(); } catch (e) {}
        try {
            if (gantt.ext && gantt.ext.inlineEditors && gantt.ext.inlineEditors.save) {
                gantt.ext.inlineEditors.save();
            }
        } catch (e) {}
        try {
            if (gantt.ext && gantt.ext.inlineEditors && gantt.ext.inlineEditors.hide) {
                gantt.ext.inlineEditors.hide();
            }
        } catch (e) {}
    }, 0);
}

// 担当者プルダウン用インラインエディタ
const OWNER_OPTIONS = ['藤山','田中','安岡','川邊','檀','堀井','宮﨑','津田','古村','柴田','橋本','松本(英)'];
gantt.config.editor_types.owner_select = {
    show: function(id, column, config, placeholder) {
        const opts = OWNER_OPTIONS.map(n =>
            `<option value="${n}">${n}</option>`
        ).join('');
        placeholder.innerHTML = `<select autocomplete="off" data-lpignore="true" data-1p-ignore="true" data-form-type="other" style="width:100%;height:100%;border:1px solid #7986cb;font-family:メイリオ,sans-serif;font-size:13px;box-sizing:border-box;"><option value=""></option>${opts}</select>`;
    },
    hide: function() {},
    set_value: function(value, id, column, node) {
        node.querySelector('select').value = value || '';
    },
    get_value: function(id, column, node) {
        return node.querySelector('select').value;
    },
    is_changed: function(value, id, column, node) {
        return value !== this.get_value(id, column, node);
    },
    is_valid: function() { return true; },
    save: function() {},
    focus: function(node) {
        var sel = node.querySelector('select');
        if (sel) sel.focus();
    }
};

// ステータスプルダウン用インラインエディタ
gantt.config.editor_types.status_select = {
    show: function(id, column, config, placeholder) {
        placeholder.innerHTML = `<select autocomplete="off" data-lpignore="true" data-1p-ignore="true" data-form-type="other" style="width:100%;height:100%;border:1px solid #7986cb;font-family:メイリオ,sans-serif;font-size:13px;box-sizing:border-box;">
            <option value=""></option>
            <option value="未">未</option>
            <option value="完了">完了</option>
        </select>`;
    },
    hide: function() {},
    set_value: function(value, id, column, node) {
        node.querySelector('select').value = value || '';
    },
    get_value: function(id, column, node) {
        return node.querySelector('select').value;
    },
    is_changed: function(value, id, column, node) {
        return value !== this.get_value(id, column, node);
    },
    is_valid: function() { return true; },
    save: function() {},
    focus: function(node) {
        var sel = node.querySelector('select');
        if (sel) sel.focus();
    }
};

// 開始日インラインエディタ（計画・出張モード用）
gantt.config.editor_types.start_date_editor = {
    show: function(id, column, config, placeholder) {
        placeholder.innerHTML = '<input type="date" autocomplete="off" data-lpignore="true" data-1p-ignore="true" data-form-type="other" style="width:100%;height:100%;border:1px solid #7986cb;font-family:メイリオ,sans-serif;font-size:12px;box-sizing:border-box;">';
        var inp = placeholder.querySelector('input');
        if (inp) {
            inp.addEventListener('change', function() {
                _commitInlineDateEdit(inp);
            });
        }
    },
    hide: function() {},
    set_value: function(value, id, column, node) {
        const inp = node.querySelector('input');
        if (!value) { inp.value = ''; return; }
        inp.value = _toDateStr(new Date(value));
    },
    get_value: function(id, column, node) {
        const val = node.querySelector('input').value;
        if (!val) return gantt.getTask(id).start_date;
        const parts = val.split('-').map(Number);
        return new Date(parts[0], parts[1] - 1, parts[2]);
    },
    is_changed: function(value, id, column, node) {
        const nv = this.get_value(id, column, node);
        if (!value || !nv) return true;
        return value.getTime() !== nv.getTime();
    },
    is_valid: function() { return true; },
    save: function() {},
    focus: function(node) {
        const inp = node.querySelector('input');
        if (inp) { inp.focus(); if (inp.showPicker) try { inp.showPicker(); } catch(e) {} }
    }
};

// 完了予定日専用インラインエディタ
// Supabaseには実際の完了日(YYYY-MM-DD)を保存し、gantt内部では+1日した排他的終了日を使う
gantt.config.editor_types.completion_date = {
    show: function(id, column, config, placeholder) {
        placeholder.innerHTML = '<input type="date" name="' + column.name + '" autocomplete="off" data-lpignore="true" data-1p-ignore="true" data-form-type="other">';
        var inp = placeholder.querySelector('input');
        inp.addEventListener('change', function() {
            if (!this.value) {
                _completionDateClear(id);
                return;
            }
            _commitInlineDateEdit(inp);
        });
    },
    hide: function() {},
    set_value: function(value, id, column, node) {
        var inp = node.querySelector('input');
        if (!value || gantt.getTask(id).has_no_date) { inp.value = ''; return; }
        var d = gantt.date.add(new Date(value), -1, 'day');
        inp.value = _toDateStr(d);
    },
    get_value: function(id, column, node) {
        var val = node.querySelector('input').value;
        if (!val) {
            _clearingEndDateId = id;
            var task = gantt.getTask(id);
            var base = (task.start_date instanceof Date) ? task.start_date : new Date();
            return gantt.date.add(base, 1, 'day');
        }
        _clearingEndDateId = null;
        gantt.getTask(id).has_no_date = false; // 日付再入力時にフラグリセット
        var parts = val.split('-').map(Number);
        var completion = new Date(parts[0], parts[1] - 1, parts[2]);
        return gantt.date.add(completion, 1, 'day');
    },
    is_changed: function(value, id, column, node) {
        var val = node.querySelector('input').value;
        var origNoDate = !!gantt.getTask(id).has_no_date;
        var newNoDate  = !val;
        if (origNoDate && newNoDate) return false;
        if (origNoDate !== newNoDate) return true;
        var nv = this.get_value(id, column, node);
        if (!value || !nv) return true;
        return value.getTime() !== nv.getTime();
    },
    is_valid: function() { return true; },
    save: function() {},
    focus: function(node) {
        var inp = node.querySelector('input');
        if (!inp) return;
        inp.focus();
        if (inp.showPicker) try { inp.showPicker(); } catch(e) {}
    }
};

// 完了予定日クリアボタン：エディタAPIを使わずタスクを直接更新
function _completionDateClear(taskId) {
    // インラインエディターを閉じる（APIがあれば使う）
    try {
        if (gantt.ext && gantt.ext.inlineEditors) {
            gantt.ext.inlineEditors.hide();
        }
    } catch(e) {}

    var task = gantt.getTask(taskId);
    if (!task) return;
    var base = (task.start_date instanceof Date) ? task.start_date : new Date();
    task.end_date = gantt.date.add(base, 1, 'day');
    task.has_no_date = true;
    _clearingEndDateId = taskId;
    gantt.updateTask(taskId);
}
gantt.config.auto_scheduling = true; // 自動スケジューリングを有効化
gantt.config.drag_links = false; // バー周辺のリンク作成用ハンドル（▲）を非表示
gantt.config.drag_progress = false; // バー上の進捗ドラッグハンドルを非表示
gantt.config.start_date = new Date(2025, 0, 1);  // 2025年1月1日
gantt.config.end_date = new Date(2027, 0, 1);    // 2026年12月31日まで含める
gantt.config.fit_tasks = false; // 自動調整を無効化

// グリッド幅をレイアウトで固定する関数（dhtmlxGanttの自動スケーリングを防ぐ）
function _setLayout(gridWidth) {
    gantt.config.layout = {
        css: "gantt_container",
        rows: [
            {
                cols: [
                    {
                        width: gridWidth,
                        min_width: 80,
                        rows: [
                            { view: "grid", scrollX: "scrollHor", scrollY: "scrollVer" }
                        ]
                    },
                    { resizer: true, width: 1 },
                    { view: "timeline", scrollX: "scrollHor", scrollY: "scrollVer" },
                    { view: "scrollbar", id: "scrollVer" }
                ]
            },
            { view: "scrollbar", id: "scrollHor" }
        ]
    };
    gantt.config.grid_width = gridWidth;
}

function _getColsSum(cols) {
    return cols.reduce((sum, c) => sum + (c.width || 0), 0);
}

_setLayout(_getColsSum(_getDrawingColumns()));
gantt.config.min_column_width = 22; // カレンダーの列幅を22に設定
gantt.config.inline_editors_save_on_blur = true; // フォーカスが外れたとき自動保存
gantt.config.row_height = 30;
gantt.config.scale_height = 60; // 3段構成（20px * 3）に合わせて調整
// マーカープラグインは initialize() 内で有効化するため、ここでは行わない

// ズーム設定
const zoomConfig = {
    levels: [
        {
            name: "day",
            scale_height: 60, // 3段構成（20px * 3）
            min_column_width: 22,
            scales: [
                {unit: "month", step: 1, format: "%Y/%n"},
                {unit: "day", step: 1, format: "%j", css: function(date) {
                    const dow = date.getDay();
                    if (dow === 0) return 'gantt-scale-sun';
                    if (_isHoliday(date)) return 'gantt-scale-holiday';
                    if (dow === 6) return 'gantt-scale-sat';
                    return '';
                }},
                {unit: "day", step: 1, format: (date) => ["日", "月", "火", "水", "木", "金", "土"][date.getDay()], css: function(date) {
                    const dow = date.getDay();
                    if (dow === 0) return 'gantt-scale-sun';
                    if (_isHoliday(date)) return 'gantt-scale-holiday';
                    if (dow === 6) return 'gantt-scale-sat';
                    return '';
                }}
            ]
        },
        {
            name: "week",
            scale_height: 60, // 2段構成（30px * 2）
            min_column_width: 22,
            scales: [
                {unit: "month", step: 1, format: "%Y/%n"},
                {unit: "week", step: 1, format: "%j"}
            ]
        }
    ]
};
gantt.ext.zoom.init(zoomConfig);
gantt.ext.zoom.setLevel("day");

function setZoom(level, btn) {
    gantt.ext.zoom.setLevel(level);
    document.querySelectorAll('.zoom-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    if (isResourceView) updateResourceData();
}

// 選択削除ボタンの表示更新
function _updateMultiDeleteBtn() {
    const btn = document.getElementById('multi_delete_btn');
    if (!btn) return;
    if (_isEditor && _gridSelection.size >= 1) {
        document.getElementById('multi_delete_count').textContent = _gridSelection.size;
        btn.style.display = '';
    } else {
        btn.style.display = 'none';
    }
}

// グリッド選択ハイライトを DOM に反映
function _applyGridSelection() {
    document.querySelectorAll('#gantt_here .gantt_row[task_id]').forEach(el => {
        el.classList.toggle('grid-row-selected', _gridSelection.has(el.getAttribute('task_id')));
    });
}

// 複数タスク一括削除
async function deleteSelectedTasks() {
    const ids = [..._gridSelection].map(id => Number(id));
    if (ids.length === 0) return;
    if (!confirm(`選択した ${ids.length} 件のタスクを削除しますか？`)) return;

    const { error } = await supabaseClient
        .from('tasks')
        .delete()
        .in('id', ids);

    if (error) {
        console.error("Error deleting tasks:", error);
        alert("削除に失敗しました。\n" + error.message);
        return;
    }

    await loadData();
    document.getElementById('multi_delete_btn').style.display = 'none';
}

// ライトボックスで入力してから Supabase に保存する仮タスク（createTask 用）
let _pendingNewTaskLightboxId = null;
// ライトボックス「保存」後、フォーム反映済みのタスクで INSERT する（onAfterTaskUpdate が発火しない環境向け）
let _postLightboxInsertTaskId = null;
let _finalizePendingInsertInProgress = false;
// クライアントのみ削除（DBに触れない）するとき onAfterTaskDelete を抑止する
let _suppressTaskDeleteId = null;

async function _finalizePendingNewTaskToDb(id) {
    if (_finalizePendingInsertInProgress) return;
    if (_pendingNewTaskLightboxId == null || String(_pendingNewTaskLightboxId) !== String(id)) return;
    if (!gantt.isTaskExists(id)) {
        _pendingNewTaskLightboxId = null;
        return;
    }

    _finalizePendingInsertInProgress = true;
    try {
        const item = gantt.getTask(id);
        const taskTypeResolved = item.task_type || currentTaskTypeFilter || "drawing";
        const newSortOrder = _computeSortOrderForInsert(
            item.project_number,
            item.machine,
            item.unit,
            taskTypeResolved,
            id
        );

        const endDateStr = item.has_no_date
            ? null
            : _toDateStr(gantt.date.add(new Date(item.end_date), -1, "day"));

        const insertRow = {
            text: item.text || "",
            start_date: _toDateStr(item.start_date),
            end_date: endDateStr,
            project_number: item.project_number,
            machine: item.machine || "",
            unit: item.unit || "",
            unit2: item.unit2 || "",
            model_type: item.model_type || "",
            part_number: item.part_number || "",
            quantity: Number(item.quantity) || 0,
            manufacturer: item.manufacturer || "",
            status: item.status || "",
            customer_name: item.customer_name || "",
            project_details: item.project_details || "",
            characteristic: item.characteristic || "",
            derivation: item.derivation || "",
            owner: item.owner || "",
            total_sheets: Number(item.total_sheets) || 0,
            completed_sheets: Number(item.completed_sheets) || 0,
            task_type: taskTypeResolved,
            wish_date: item.wish_date || null,
            is_detailed: true,
            sort_order: newSortOrder,
            hyphen: item.hyphen ?? null
        };

        const { data, error } = await supabaseClient
            .from("tasks")
            .insert([insertRow])
            .select();

        if (error) {
            console.error("Error adding task:", error);
            alert("タスクの追加に失敗しました。\n" + error.message);
            _pendingNewTaskLightboxId = null;
            _suppressTaskDeleteId = id;
            if (gantt.isTaskExists(id)) gantt.deleteTask(id);
            _suppressTaskDeleteId = null;
            return;
        }

        _pendingNewTaskLightboxId = null;
        _suppressTaskDeleteId = id;
        if (gantt.isTaskExists(id)) gantt.deleteTask(id);
        _suppressTaskDeleteId = null;

        await loadData();

        if (data && data[0]) {
            gantt.showTask(data[0].id);
        }
    } catch (e) {
        console.error("Exception in _finalizePendingNewTaskToDb:", e);
        alert("タスク追加処理中にエラーが発生しました。");
        _pendingNewTaskLightboxId = null;
    } finally {
        _finalizePendingInsertInProgress = false;
    }
}

function _sortOrderValue(t) {
    return (t.sort_order != null) ? t.sort_order : (Number(t.id) * 1000);
}

function _normKey(s) {
    return String(s || '').trim();
}

/**
 * 保存時の工事番号・機械・ユニットに基づき sort_order を決める。
 * 同じ3つを持つ行があれば、その並びの末尾の直後に入る。なければその工事番号＋タスク種の末尾。
 * excludeTaskId: 仮追加行を候補から外す
 */
function _computeSortOrderForInsert(projectNumber, machine, unit, taskType, excludeTaskId) {
    const tt = String(taskType || currentTaskTypeFilter || 'drawing');
    const pn = String(projectNumber || '').trim();
    const m = _normKey(machine);
    const u = _normKey(unit);

    const candidates = [];
    gantt.eachTask(function(task) {
        if (excludeTaskId != null && String(task.id) === String(excludeTaskId)) return;
        const isDetailed = (task.is_detailed === true || String(task.is_detailed).toUpperCase() === 'TRUE');
        if (!isDetailed) return;
        if (String(task.project_number || '').trim() !== pn) return;
        if (String(task.task_type || 'drawing') !== tt) return;
        candidates.push(task);
    });
    candidates.sort((a, b) => _sortOrderValue(a) - _sortOrderValue(b));

    let lastMatchIdx = -1;
    for (let i = 0; i < candidates.length; i++) {
        if (_normKey(candidates[i].machine) === m && _normKey(candidates[i].unit) === u) {
            lastMatchIdx = i;
        }
    }

    if (lastMatchIdx >= 0) {
        const afterTask = candidates[lastMatchIdx];
        if (lastMatchIdx + 1 < candidates.length) {
            const nextTask = candidates[lastMatchIdx + 1];
            return Math.round((_sortOrderValue(afterTask) + _sortOrderValue(nextTask)) / 2);
        }
        return _sortOrderValue(afterTask) + 1000;
    }

    if (candidates.length > 0) {
        return _sortOrderValue(candidates[candidates.length - 1]) + 1000;
    }
    return 1000;
}

// 新規タスク追加：まずライトボックスで入力 → 保存で Supabase に挿入
// afterTaskId: グリッドの+ボタンから呼ばれた場合はその行の機械・ユニットを初期値に使う
function createTask(afterTaskId) {
    if (currentProjectFilter.length !== 1) {
        alert("工事番号を選択してからタスクを追加してください。");
        return;
    }
    if (_pendingNewTaskLightboxId != null) {
        alert("新規追加の編集画面が開いています。先に保存またはキャンセルしてください。");
        return;
    }
    const projectNumber = currentProjectFilter[0];
    const pf = String(projectNumber);

    const visibleTasks = gantt.getTaskByTime().filter(t => {
        const isDetailed = (t.is_detailed === true || String(t.is_detailed).toUpperCase() === 'TRUE');
        if (!isDetailed) return false;
        if (String(t.project_number) !== pf) return false;
        if (currentTaskTypeFilter && String(t.task_type) !== currentTaskTypeFilter) return false;
        return true;
    }).sort((a, b) => _sortOrderValue(a) - _sortOrderValue(b));

    let inheritMachine = "";
    let inheritUnit = "";
    if (afterTaskId != null) {
        const t = gantt.getTask(afterTaskId);
        if (t) {
            inheritMachine = t.machine || "";
            inheritUnit = t.unit || "";
        }
    } else if (visibleTasks.length > 0) {
        const last = visibleTasks[visibleTasks.length - 1];
        inheritMachine = last.machine || "";
        inheritUnit = last.unit || "";
    }

    const today = new Date();
    const startDate = new Date(today);
    startDate.setDate(startDate.getDate() - 13);
    const taskType = currentTaskTypeFilter || "drawing";

    const newId = gantt.uid();
    _pendingNewTaskLightboxId = newId;

    const wishDefault = (taskType === 'planning' || taskType === 'business_trip') ? null : _toDateStr(today);

    gantt.addTask({
        id: newId,
        $new: true,
        text: "",
        start_date: startDate,
        end_date: gantt.date.add(today, 1, 'day'),
        project_number: projectNumber,
        machine: inheritMachine,
        unit: inheritUnit,
        unit2: "",
        model_type: "",
        part_number: "",
        quantity: 0,
        manufacturer: "",
        status: "",
        customer_name: "",
        project_details: "",
        characteristic: "",
        derivation: "",
        owner: "",
        total_sheets: 0,
        completed_sheets: 0,
        task_type: taskType,
        wish_date: wishDefault,
        is_detailed: true,
        sort_order: 0,
        has_no_date: false
    });

    gantt.showLightbox(newId);
}

// 完了予定日クリア時：フラグを元にhas_no_dateを設定
gantt.attachEvent("onBeforeTaskUpdate", function(id, task) {
    if (_clearingEndDateId === id) {
        task.has_no_date = true;
        _clearingEndDateId = null;
    }
    return true;
});

// Supabase への保存処理（バーのドラッグ等、gantt内部でタスクが追加された場合の安全網）
gantt.attachEvent("onAfterTaskAdd", async function(id, item) {
    // createTask() は gantt.addTask で仮行を作り、保存時に onAfterTaskUpdate で INSERT する
});

gantt.attachEvent("onAfterTaskUpdate", async function(id, item) {
    try {
        // 新規（createTask の仮行）の DB 反映は onAfterLightbox 経由の _finalizePendingNewTaskToDb で行う
        if (_pendingNewTaskLightboxId != null && String(id) === String(_pendingNewTaskLightboxId)) {
            return;
        }

        // has_no_dateの場合はend_dateをnullで保存、それ以外は-1日して完了日を保存
        const endDateStr = item.has_no_date
            ? null
            : _toDateStr(gantt.date.add(new Date(item.end_date), -1, 'day'));

        const { error } = await supabaseClient
            .from('tasks')
            .update({
                text: item.text,
                start_date: _toDateStr(item.start_date),
                end_date: endDateStr,
                project_number: item.project_number,
                machine: item.machine,
                unit: item.unit,
                unit2: item.unit2,
                model_type: item.model_type,
                part_number: item.part_number,
                quantity: item.quantity,
                manufacturer: item.manufacturer,
                status: item.status,
                customer_name: item.customer_name,
                project_details: item.project_details,
                hyphen: item.hyphen ?? null,
                characteristic: item.characteristic,
                derivation: item.derivation,
                owner: item.owner,
                total_sheets: Number(item.total_sheets) || 0,
                completed_sheets: Number(item.completed_sheets) || 0,
                duration: item.duration,
                task_type: item.task_type || currentTaskTypeFilter || "drawing",
                wish_date: item.wish_date || null
            })
            .eq('id', id);

        if (error) {
            console.error("Error updating task:", error);
            alert("タスクの更新に失敗しました。\n" + error.message);
        } else {
            if (isResourceView) updateResourceData();
            // ▼マークの色を即時更新
            requestAnimationFrame(_renderWishDateMarks);
        }
    } catch (e) {
        console.error("Exception in onAfterTaskUpdate:", e);
        alert("タスク更新中に予期せぬエラーが発生しました。");
    }
});

// ドラッグ（移動・リサイズ）後にSupabaseへ保存
gantt.attachEvent("onAfterTaskDrag", async function(id, mode, e) {
    if (_pendingNewTaskLightboxId != null && String(_pendingNewTaskLightboxId) === String(id)) {
        return;
    }
    const item = gantt.getTask(id);
    const completionDate = gantt.date.add(new Date(item.end_date), -1, 'day');
    try {
        const { error } = await supabaseClient
            .from('tasks')
            .update({
                start_date: _toDateStr(item.start_date),
                end_date: _toDateStr(completionDate),
            })
            .eq('id', id);
        if (error) console.error("Error saving drag:", error);
        else if (isResourceView) updateResourceData();
    } catch(e) {
        console.error("Exception in onAfterTaskDrag:", e);
    }
});

gantt.attachEvent("onAfterTaskDelete", async function(id, item) {
    if (_suppressTaskDeleteId != null && String(_suppressTaskDeleteId) === String(id)) {
        _suppressTaskDeleteId = null;
        return;
    }
    try {
        const { error } = await supabaseClient
            .from('tasks')
            .delete()
            .eq('id', id);
        
        if (error) {
            console.error("Error deleting task:", error);
            alert("タスクの削除に失敗しました。\n" + error.message);
        }
    } catch (e) {
        console.error("Exception in onAfterTaskDelete:", e);
        alert("タスク削除中に予期せぬエラーが発生しました。");
    }
});

// 編集画面（ライトボックス）のセクション定義（タスクタイプ別）
function _getLightboxSections(taskType) {
    if (taskType === 'long_lead_item') {
        return [
            { name: "project_number",   height: 30, map_to: "project_number", type: "textarea" },
            { name: "machine",          height: 30, map_to: "machine",         type: "textarea" },
            { name: "unit",             height: 30, map_to: "unit",            type: "textarea" },
            { name: "description",      height: 30, map_to: "text",            type: "textarea_full" },
            { name: "part_number",      height: 30, map_to: "part_number",     type: "textarea" },
            { name: "quantity",         height: 30, map_to: "quantity",        type: "textarea" },
            { name: "manufacturer",            height: 30, map_to: "manufacturer",           type: "textarea" },
            { name: "owner",            height: 30, map_to: "owner",           type: "owner_select_lb" },
            { name: "end_date",         height: 30, map_to: "end_date",        type: "template" },
            { name: "wish_date_lb",     height: 30, map_to: "wish_date",       type: "wish_date_lb" },
        ];
    } else if (taskType === 'planning' || taskType === 'business_trip') {
        return [
            { name: "project_number",  height: 30, map_to: "project_number",  type: "textarea" },
            { name: "customer_name",   height: 30, map_to: "customer_name",   type: "textarea" },
            { name: "project_details", height: 30, map_to: "project_details", type: "textarea" },
            { name: "description",     height: 30, map_to: "text",            type: "textarea_full" },
            { name: "owner",           height: 30, map_to: "owner",           type: "owner_select_lb" },
            { name: "date_range",      height: 30, map_to: "start_date",      type: "date_range" },
        ];
    } else {
        // drawing（デフォルト）
        return [
            { name: "project_number",   height: 30, map_to: "project_number",  type: "textarea" },
            { name: "machine",          height: 30, map_to: "machine",          type: "textarea" },
            { name: "unit",             height: 30, map_to: "unit",             type: "textarea" },
            { name: "description",      height: 30, map_to: "text",             type: "textarea_full" },
            { name: "model_type",       height: 30, map_to: "model_type",       type: "textarea" },
            { name: "unit2",            height: 30, map_to: "unit2",            type: "textarea" },
            { name: "characteristic",   height: 30, map_to: "characteristic",   type: "textarea" },
            { name: "derivation",       height: 30, map_to: "derivation",       type: "textarea" },
            { name: "owner",            height: 30, map_to: "owner",            type: "owner_select_lb" },
            { name: "sheets_pair",      height: 30, map_to: "total_sheets",     type: "sheets_pair" },
            { name: "date_range",       height: 30, map_to: "start_date",       type: "date_range" },
            { name: "wish_date_lb",     height: 30, map_to: "wish_date",        type: "wish_date_lb" },
        ];
    }
}

gantt.config.lightbox.sections = _getLightboxSections('drawing');

gantt.locale.labels.section_project_number   = "工事番号";
gantt.locale.labels.section_machine          = "機械";
gantt.locale.labels.section_unit             = "ユニット";
gantt.locale.labels.section_description      = "組立図面名 / 品名 / タスク";
gantt.locale.labels.section_model_type       = "機種";
gantt.locale.labels.section_unit2            = "ユニット2";
gantt.locale.labels.section_characteristic   = "特性";
gantt.locale.labels.section_derivation       = "派生";
gantt.locale.labels.section_owner            = "担当";
gantt.locale.labels.section_total_sheets     = "総枚数";
gantt.locale.labels.section_completed_sheets = "完了枚数";
gantt.locale.labels.section_sheets_pair      = "枚数";
gantt.locale.labels.section_start_date       = "開始日";
gantt.locale.labels.section_end_date         = "完了予定日";
gantt.locale.labels.section_date_range       = "期間";
gantt.locale.labels.section_part_number      = "型式・図番";
gantt.locale.labels.section_quantity         = "個数";
gantt.locale.labels.section_manufacturer            = "メーカー";
gantt.locale.labels.section_customer_name    = "客先";
gantt.locale.labels.section_project_details  = "工事名";
gantt.locale.labels.section_wish_date_lb     = "出図希望日 / 手配期日";

// カスタムテンプレート（input type="date"）
// 全幅テキストエリア（組立図面名・品名など）
gantt.form_blocks["textarea_full"] = {
    render: function(sns) {
        return "<div class='gantt_cal_ltext'><textarea class='lb-textarea-full' style='height:26px;font-size:12px;line-height:18px;padding:4px 4px 0 4px;box-sizing:border-box;resize:none;overflow:hidden;border:1px solid #ccc;border-radius:4px;'></textarea></div>";
    },
    set_value: function(node, value, task, sns) {
        node.querySelector("textarea").value = value || '';
    },
    get_value: function(node, task, sns) {
        return node.querySelector("textarea").value;
    },
    focus: function(node) {
        node.querySelector("textarea").focus();
    }
};

// 担当プルダウン（ライトボックス用）
gantt.form_blocks["owner_select_lb"] = {
    render: function(sns) {
        const opts = ['', ...OWNER_OPTIONS].map(n =>
            `<option value="${n}">${n || '-- 未選択 --'}</option>`).join('');
        return `<div class='gantt_cal_ltext'><select style='width:100%;height:30px;border:1px solid #ccc;border-radius:4px;padding:0 5px;'>${opts}</select></div>`;
    },
    set_value: function(node, value, task, sns) {
        node.querySelector("select").value = value || '';
    },
    get_value: function(node, task, sns) {
        return node.querySelector("select").value;
    },
    focus: function(node) {
        node.querySelector("select").focus();
    }
};

// 出図希望日 / 手配期日（wish_date、文字列 YYYY-MM-DD）ライトボックス用
gantt.form_blocks["wish_date_lb"] = {
    render: function(sns) {
        return "<div class='gantt_cal_ltext'><input type='date' style='width:110px;height:26px;border:1px solid #ccc;border-radius:4px;padding:0 4px;font-size:12px;'></div>";
    },
    set_value: function(node, value, task, sns) {
        node.querySelector("input").value = value || '';
    },
    get_value: function(node, task, sns) {
        return node.querySelector("input").value || null;
    },
    focus: function(node) {
        node.querySelector("input").focus();
    }
};

gantt.form_blocks["template"] = {
    render: function(sns) {
        return "<div class='gantt_cal_ltext'><input type='date' id='cal_" + sns.name + "' style='width:110px;height:26px;border:1px solid #ccc;border-radius:4px;padding:0 4px;font-size:12px;'></div>";
    },
    set_value: function(node, value, task, sns) {
        const input = node.querySelector("input");
        if (value) {
            const date = new Date(value);
            const y = date.getFullYear();
            const m = ("0" + (date.getMonth() + 1)).slice(-2);
            const d = ("0" + date.getDate()).slice(-2);
            input.value = `${y}-${m}-${d}`;
        }
    },
    get_value: function(node, task, sns) {
        return node.querySelector("input").value;
    },
    focus: function(node) {
        node.querySelector("input").focus();
    }
};

// 総枚数と完了枚数を横並びで表示するカスタムフォームブロック
gantt.form_blocks["sheets_pair"] = {
    render: function(sns) {
        return `<div class='gantt_cal_ltext' style='display:flex;gap:6px;align-items:center;'>
            <span style='font-size:11px;white-space:nowrap;color:#555;'>総枚数</span>
            <input type='number' id='lb_total_sheets' min='0' style='width:60px;height:26px;border:1px solid #ccc;border-radius:4px;padding:0 4px;font-size:12px;'>
            <span style='font-size:11px;white-space:nowrap;color:#555;'>完了枚数</span>
            <input type='number' id='lb_completed_sheets' min='0' style='width:60px;height:26px;border:1px solid #ccc;border-radius:4px;padding:0 4px;font-size:12px;'>
        </div>`;
    },
    set_value: function(node, value, task, sns) {
        document.getElementById('lb_total_sheets').value     = task.total_sheets     || '';
        document.getElementById('lb_completed_sheets').value = task.completed_sheets || '';
    },
    get_value: function(node, task, sns) {
        task.total_sheets     = document.getElementById('lb_total_sheets').value;
        task.completed_sheets = document.getElementById('lb_completed_sheets').value;
        return task.total_sheets;
    },
    focus: function(node) {
        const el = document.getElementById('lb_total_sheets');
        if (el) el.focus();
    }
};

// 開始日と完了予定日を横並びで表示するカスタムフォームブロック
gantt.form_blocks["date_range"] = {
    render: function(sns) {
        return `<div class='gantt_cal_ltext' style='display:flex;gap:6px;align-items:center;'>
            <span style='font-size:11px;white-space:nowrap;color:#555;'>開始日</span>
            <input type='date' id='cal_start_date' style='width:110px;height:26px;border:1px solid #ccc;border-radius:4px;padding:0 4px;font-size:12px;'>
            <span style='font-size:11px;white-space:nowrap;color:#555;'>完了予定日</span>
            <input type='date' id='cal_end_date' style='width:110px;height:26px;border:1px solid #ccc;border-radius:4px;padding:0 4px;font-size:12px;'>
        </div>`;
    },
    set_value: function(node, value, task, sns) {
        const startInput = document.getElementById('cal_start_date');
        const endInput   = document.getElementById('cal_end_date');
        if (task.start_date) {
            const d = new Date(task.start_date);
            startInput.value = `${d.getFullYear()}-${("0"+(d.getMonth()+1)).slice(-2)}-${("0"+d.getDate()).slice(-2)}`;
        }
        if (task.end_date) {
            // end_date はDHTMLX排他的終了（翌日0時）なので1日引いて表示
            const d = new Date(task.end_date.getTime() - 24*60*60*1000);
            endInput.value = `${d.getFullYear()}-${("0"+(d.getMonth()+1)).slice(-2)}-${("0"+d.getDate()).slice(-2)}`;
        }
    },
    get_value: function(node, task, sns) {
        // 実際の保存処理は onLightboxSave で行う
        return task.start_date;
    },
    focus: function(node) {
        const el = document.getElementById('cal_start_date');
        if (el) el.focus();
    }
};

// 完了予定日と期間から開始日を計算するロジック
gantt.attachEvent("onTaskLoading", function(task){
    if (task.start_date && task.end_date) {
        // 初期読み込み時はそのまま
    }
    return true;
});

// ライトボックス保存時の処理
gantt.attachEvent("onLightboxSave", function(id, task, is_new){
    const startEl = document.getElementById("cal_start_date");
    const endEl   = document.getElementById("cal_end_date");
    const startStr = startEl ? startEl.value : "";
    const endStr   = endEl   ? endEl.value   : "";
    const duration = parseInt(task.duration) || 1;

    if (startStr && endStr) {
        task.start_date = new Date(startStr);
        task.end_date = new Date(endStr);
        task.end_date = gantt.date.add(task.end_date, 1, "day");
        task.duration = gantt.calculateDuration(task.start_date, task.end_date);
    } else if (startStr && duration) {
        task.start_date = new Date(startStr);
        task.end_date = gantt.date.add(task.start_date, duration, "day");
    } else if (endStr && duration) {
        task.end_date = new Date(endStr);
        task.end_date = gantt.date.add(task.end_date, 1, "day");
        task.start_date = gantt.date.add(task.end_date, -duration, "day");
    }

    if (_pendingNewTaskLightboxId != null && String(_pendingNewTaskLightboxId) === String(id)) {
        _postLightboxInsertTaskId = id;
    }

    return true;
});

// ライトボックス表示前の処理（担当別モード時は非表示）
gantt.attachEvent("onBeforeLightbox", function(id) {
    if (isResourceFullscreen) return false;
    const task = gantt.getTask(id);
    const taskType = task ? (task.task_type || 'drawing') : 'drawing';
    gantt.config.lightbox.sections = _getLightboxSections(taskType);

    if (taskType === 'long_lead_item') {
        gantt.locale.labels.section_description  = "品名";
        gantt.locale.labels.section_wish_date_lb = "手配期日";
    } else if (taskType === 'planning' || taskType === 'business_trip') {
        gantt.locale.labels.section_description  = "タスク";
    } else {
        gantt.locale.labels.section_description  = "組立図面名";
        gantt.locale.labels.section_wish_date_lb = "出図希望日";
    }

    return true;
});

// ライトボックスを閉じた時の後処理
gantt.attachEvent("onAfterLightbox", function() {
    const insertId = _postLightboxInsertTaskId;
    _postLightboxInsertTaskId = null;
    if (insertId != null) {
        setTimeout(function() {
            _finalizePendingNewTaskToDb(insertId);
        }, 0);
    }
    return true;
});

gantt.attachEvent("onLightboxCancel", function(id) {
    if (_postLightboxInsertTaskId != null && String(_postLightboxInsertTaskId) === String(id)) {
        _postLightboxInsertTaskId = null;
    }
    if (_pendingNewTaskLightboxId != null && String(_pendingNewTaskLightboxId) === String(id)) {
        _pendingNewTaskLightboxId = null;
        _suppressTaskDeleteId = id;
        if (gantt.isTaskExists(id)) gantt.deleteTask(id);
        _suppressTaskDeleteId = null;
    }
    return true;
});

// 日付フォーマット共通テンプレート
function _fmtDate(obj) {
    if (obj.has_no_date || !obj.end_date) return "";
    // end_dateはdhtmlxGanttの排他的終了（完了日の翌日0時）なので1日引いて完了日を表示
    const date = new Date(obj.end_date.getTime() - 24 * 60 * 60 * 1000);
    const y = String(date.getFullYear()).slice(-2);
    const m = ("0" + (date.getMonth() + 1)).slice(-2);
    const d = ("0" + date.getDate()).slice(-2);
    return `${y}/${m}/${d}`;
}

// 進捗テンプレート
function _progressTemplate(obj) {
    const total = parseFloat(obj.total_sheets) || 0;
    const completed = parseFloat(obj.completed_sheets) || 0;
    let progress = 0;
    if (total > 0) {
        progress = Math.min(100, Math.round((completed / total) * 100));
    }
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const isOverdue = (progress === 0 && obj.end_date && obj.end_date < today);
    const fillClass = isOverdue ? "progress-fill progress-overdue" : "progress-fill";
    const fillWidth = isOverdue ? "100%" : `${progress}%`;
    return `<div class="progress-cell-container">
                <div class="${fillClass}" style="width:${fillWidth};"></div>
                <span style="position:relative; z-index:2; color:black; font-weight:normal;">${progress}%</span>
            </div>`;
}

// 図面列定義（デフォルト）
function _getDrawingColumns() {
    return [
        { name: "project_number",   label: "工事<br>番号",   width: 35, align: "center", editor: { type: "text",   map_to: "project_number" } },
        { name: "machine",          label: "機械",           width: 35, align: "center", editor: { type: "text",   map_to: "machine" } },
        { name: "unit",             label: "ユニ",           width: 35, align: "center", editor: { type: "text",   map_to: "unit" } },
        { name: "text",             label: "組立図面名",     width: 235, tree: true,      editor: { type: "text",   map_to: "text" } },
        { name: "model_type",       label: "機種",           width: 30, align: "center", editor: { type: "text",   map_to: "model_type" } },
        { name: "unit2",            label: "ユニ<br>2",      width: 30, align: "center", editor: { type: "text",   map_to: "unit2" } },
        { name: "dash",             label: "-",              width: 25, align: "center", template: (task) => task.hyphen ?? "-", editor: { type: "text", map_to: "hyphen" } },
        { name: "characteristic",   label: "特性",           width: 30, align: "center", editor: { type: "text",   map_to: "characteristic" } },
        { name: "derivation",       label: "派生",           width: 30, align: "center", editor: { type: "text",   map_to: "derivation" } },
        { name: "owner",            label: "担当",           width: 30, align: "center", editor: { type: "owner_select", map_to: "owner" } },
        { name: "total_sheets",     label: "総<br>枚数",     width: 40, align: "center", editor: { type: "number", map_to: "total_sheets",     min: 0 } },
        { name: "completed_sheets", label: "完了<br>枚数",   width: 40, align: "center", editor: { type: "number", map_to: "completed_sheets", min: 0 } },
        { name: "progress",         label: "進捗",           width: 40, align: "center", template: _progressTemplate },
        { name: "end_date",         label: "完了<br>予定日", width: 65, align: "center", template: _fmtDate, editor: { type: "completion_date", map_to: "end_date" } },
        { name: "add_btn",          label: "",               width: 30, align: "center", template: (task) => _isEditor ? `<div class='custom_add_btn' onclick='createTask(${task.id})'>+</div>` : '' }
    ];
}
// 図面列合計: 18+18+120+16+16+14+16+16+16+16+16+20+20+20 = 342px

// 長納期品列定義
function _getLongtermColumns() {
    return [
        { name: "project_number", label: "工事<br>番号", width: 35,  align: "center", editor: { type: "text",   map_to: "project_number" } },
        { name: "machine",    label: "機械",           width: 32,  align: "center", editor: { type: "text",   map_to: "machine" } },
        { name: "unit",       label: "ユニ",           width: 32,  align: "center", editor: { type: "text",   map_to: "unit" } },
        { name: "text",       label: "品名",           width: 173, tree: true,      editor: { type: "text",   map_to: "text" } },
        { name: "part_number", label: "型式・図番",     width: 115, align: "left", editor: { type: "text",   map_to: "part_number" } },
        { name: "quantity",   label: "個数",           width: 28,  align: "center", editor: { type: "number", map_to: "quantity", min: 0 } },
        { name: "manufacturer",      label: "メーカー",       width: 70,  align: "center", editor: { type: "text",   map_to: "manufacturer" } },
        { name: "owner",      label: "担当",           width: 32,  align: "center", editor: { type: "owner_select", map_to: "owner" } },
        { name: "end_date",   label: "手配<br>予定日", width: 60,  align: "center", template: _fmtDate, editor: { type: "completion_date", map_to: "end_date" } },
        { name: "status",     label: "状態",           width: 32,  align: "center",
          template: function(task) {
              const v = task.status || '';
              if (v === '未') return `<span style="display:block;width:100%;background:#e53935;color:#000;border-radius:2px;">${v}</span>`;
              return v;
          },
          editor: { type: "status_select", map_to: "status" } },
        { name: "add_btn",    label: "",               width: 25,  align: "center", template: (task) => _isEditor ? `<div class='custom_add_btn' onclick='createTask(${task.id})'>+</div>` : '' }
    ];
}
// 長納期品列合計: 32+42+190+85+28+70+32+60+20 = 559px

// 列設定の初期化（固定初期幅）
gantt.config.columns = _getDrawingColumns();
gantt.config._columnFilterType = 'drawing';

// 出張列定義
function _getTripColumns() {
    return [
        { name: "project_number",  label: "工事番号", width: 60,  align: "center", editor: { type: "text", map_to: "project_number" } },
        { name: "machine",         label: "機械",     width: 40,  align: "center", editor: { type: "text", map_to: "machine" } },
        { name: "unit",            label: "ユニ",     width: 40,  align: "center", editor: { type: "text", map_to: "unit" } },
        { name: "text",            label: "タスク",   width: 230, tree: true,      editor: { type: "text", map_to: "text" } },
        { name: "owner",           label: "担当",     width: 40,  align: "center", editor: { type: "owner_select", map_to: "owner" } },
        { name: "start_date",      label: "開始日",   width: 65,  align: "center",
          template: function(task) {
            if (!task.start_date) return "";
            const d = task.start_date;
            const yy = String(d.getFullYear()).slice(-2);
            const mm = String(d.getMonth() + 1).padStart(2, '0');
            const dd = String(d.getDate()).padStart(2, '0');
            return yy + '/' + mm + '/' + dd;
          },
          editor: { type: "start_date_editor", map_to: "start_date" } },
        { name: "end_date",        label: "終了日",   width: 65,  align: "center", template: _fmtDate, editor: { type: "completion_date", map_to: "end_date" } },
        { name: "add_btn",         label: "",         width: 25,  align: "center", template: (task) => _isEditor ? `<div class='custom_add_btn' onclick='createTask(${task.id})'>+</div>` : '' }
    ];
}
// 計画/出張列合計: 60+35+35+245+35+65+65+25 = 565px

function _colSetKeyFromFilter(filterType) {
    if (filterType === 'long_lead_item') return 'longterm';
    if (filterType === 'business_trip' || filterType === 'planning') return 'trip';
    return 'default';
}

// 列セット切り替え
function switchColumns(filterType) {
    var baseCols;
    if (filterType === 'long_lead_item') baseCols = _getLongtermColumns();
    else if (filterType === 'business_trip' || filterType === 'planning') baseCols = _getTripColumns();
    else baseCols = _getDrawingColumns();
    gantt.config.columns = baseCols;
    gantt.config._columnFilterType = filterType;
    _setLayout(_getColsSum(baseCols));
    gantt.render();
}

// スタイルとテンプレート
gantt.templates.task_text = function(start, end, task) {
    const colorClass = getOwnerColorClass(task.owner);
    const textColor = (["owner-tsuda", "owner-shibata", "owner-matsumoto"].includes(colorClass)) ? "#222" : "#fff";
    return `<span style="color:${textColor};">${task.text}</span>`;
};

gantt.templates.task_class = function(start, end, task) {
    let css = task.has_no_date ? "hidden_bar " : "";
    css += getOwnerColorClass(task.owner);
    return css;
};
gantt.templates.timeline_cell_class = function(task, date) {
    if (gantt.getState().scale_unit === "day" &&
        (date.getDay() === 0 || date.getDay() === 6 || _isHoliday(date))) return "weekend";
    return "";
};

gantt.templates.grid_row_class = function(start, end, task) {
    return "";
};
// スケールヘッダーの土日・社内休日セルにクラスを付与（描画時に適用されるためスクロールで崩れない）
gantt.templates.scale_cell_class = function(date) {
    const dow = date.getDay();
    if (dow === 0) return 'gantt-scale-sun';
    if (_isHoliday(date)) return 'gantt-scale-holiday';
    if (dow === 6) return 'gantt-scale-sat';
    return '';
};

// フィルタリング（is_detailedのみ表示、かつ各種フィルタ）— data.js の _taskVisibleOnGantt と同期
gantt.attachEvent("onBeforeTaskDisplay", function(id, task) {
    if (typeof _taskVisibleOnGantt === 'function') {
        return _taskVisibleOnGantt(task);
    }
    const isDetailed = (task.is_detailed === true || String(task.is_detailed).toUpperCase() === 'TRUE');
    if (!isDetailed) return false;
    if (currentProjectFilter.length > 0 && !currentProjectFilter.includes(String(task.project_number))) return false;
    if (currentTaskTypeFilter && String(task.task_type) !== currentTaskTypeFilter) return false;
    if (currentOwnerFilter.length > 0) {
        const taskOwners = String(task.owner || '').split(/[,、\s]+/).map(o => o.trim());
        if (!currentOwnerFilter.some(f => taskOwners.includes(f))) return false;
    }
    if (currentMachineFilter.length > 0) {
        const m = String(task.machine || '').trim();
        if (!currentMachineFilter.includes(m)) return false;
    }
    return true;
});

