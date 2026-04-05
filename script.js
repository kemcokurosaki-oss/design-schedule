// グリッド複数行選択
let _gridSelection = new Set();
let _lastGridClickId = null;

// リソース表示状態
let isResourceView = false;
let lastOwnerName = '';
let currentResourceOwnerFilter = "";
let _resourceDetailOwner = null; // null=一覧表示, string=特定担当者の詳細表示
const dayNames = ['日', '月', '火', '水', '木', '金', '土'];
const GRID_WIDTH = 1000; // gantt_design.htmlの既存設定に合わせる
// 列幅（gantt_design.htmlの既存設定に合わせる）
const COLUMN_WIDTHS = [55, 55, 250, 50, 60, 30, 40, 40, 60, 60, 60, 60, 110, 44]; 

// 担当者とCSSクラスのマップ
const ownerColorMap = {
    "藤山": "owner-fujiyama",
    "田中(善)": "owner-tanaka",
    "田中": "owner-tanaka",
    "安岡": "owner-yasuoka",
    "川邊": "owner-kawabe",
    "檀": "owner-dan",
    "堀井": "owner-horii",
    "宮﨑": "owner-miyazaki",
    "津田": "owner-tsuda",
    "古村": "owner-komura",
    "柴田": "owner-shibata",
    "橋本": "owner-hashimoto",
    "松本(英)": "owner-matsumoto"
};

function getOwnerColorClass(ownerStr) {
    if (!ownerStr) return "owner-default";
    const owners = String(ownerStr).split(/[,、\s]+/).map(o => o.trim());
    for (const owner of owners) {
        if (ownerColorMap[owner]) return ownerColorMap[owner];
    }
    return "owner-default";
}

// レイアウト定義
const mainLayout = {
    css: "gantt_container",
    rows: [
        {
            cols: [
                { view: "grid", group: "grids", scrollY: "scrollVer" },
                { resizer: true, width: 1 },
                { view: "timeline", scrollX: "scrollHor", scrollY: "scrollVer" },
                { view: "scrollbar", id: "scrollVer" }
            ]
        },
        { view: "scrollbar", id: "scrollHor", height: 20 }
    ]
};

// リサイズ機能
(function() {
    let isResizing = false;
    let animationFrameId = null;
    const minHeight = 50;
    const maxHeight = 800;

    window.addEventListener('DOMContentLoaded', () => {
        const resizer = document.getElementById('resource_resizer');
        const panel = document.getElementById('resource_panel');
        const ganttContainer = document.getElementById('gantt_here');

        if (!resizer || !panel) return;

        resizer.addEventListener('mousedown', (e) => {
            isResizing = true;
            document.body.style.cursor = 'ns-resize';
            document.body.style.userSelect = 'none';
            e.preventDefault();
        });

        window.addEventListener('mousemove', (e) => {
            if (!isResizing) return;
            
            if (animationFrameId) return; // すでに処理待ちならスキップ

            animationFrameId = requestAnimationFrame(() => {
                const windowHeight = window.innerHeight;
                let newHeight = windowHeight - e.clientY;
                
                if (newHeight < minHeight) newHeight = minHeight;
                if (newHeight > maxHeight) newHeight = maxHeight;
                if (newHeight > windowHeight * 0.8) newHeight = windowHeight * 0.8;
                
                // パネルの高さを更新（flexboxによりメインガントは自動で縮む）
                panel.style.height = newHeight + 'px';
                
                // ガントのサイズ調整（描画を伴うので負荷が高い）
                if (window.gantt) {
                    gantt.setSizes();
                }
                
                animationFrameId = null;
            });
        });

        window.addEventListener('mouseup', () => {
            if (isResizing) {
                isResizing = false;
                document.body.style.cursor = 'default';
                document.body.style.userSelect = '';
                if (animationFrameId) {
                    cancelAnimationFrame(animationFrameId);
                    animationFrameId = null;
                }
                // 最後に確実にサイズを合わせる
                if (window.gantt) {
                    gantt.setSizes();
                }
            }
        });
    });
})();

// リソース表示の列幅定数（担当者名 / 詳細タスク名）
const RESOURCE_OVERVIEW_COL_WIDTH = 120;  // 担当者名列
const RESOURCE_DETAIL_COL_WIDTH   = 350;  // 詳細表示（工事番号＋タスク名列）

// ガントのタイムライン開始位置を取得（グリッド幅＋リサイザー幅を含む正確な値）
function _getRenderedGanttGridWidth() {
    // .gantt_task の offsetLeft がタイムライン開始ピクセルと完全一致する
    const taskEl = document.querySelector('#gantt_here .gantt_task');
    if (taskEl && taskEl.offsetLeft > 0) return taskEl.offsetLeft;
    const gridEl = document.querySelector('#gantt_here .gantt_grid');
    return gridEl ? gridEl.offsetWidth : (gantt.config.grid_width || 834);
}

function updateResourceData() {
    // 指定された担当者の並び順（藤山～松本(英)、外注は除外）
    const targetOwners = ["藤山", "田中(善)", "安岡", "川邊", "檀", "堀井", "宮﨑", "津田", "古村", "柴田", "橋本", "松本(英)"];
    
    const activeOwners = [];
    
    // 各担当者について、該当するタスクがあるかチェック
    targetOwners.forEach(ownerName => {
        let hasTask = false;
        gantt.eachTask(function(task){
            if (hasTask) return;
            const isDetailed = (task.is_detailed === true || String(task.is_detailed).toLowerCase() === "true" || String(task.is_detailed).toLowerCase() === "t" || String(task.is_detailed) === "1");
            if (isDetailed && task.owner) {
                const owners = String(task.owner).split(/[,、\s]+/).map(o => o.trim());
                // 田中(善)の場合、"田中(善)" または "田中" が含まれているかチェック
                if (ownerName === "田中(善)") {
                    if (owners.includes("田中(善)") || owners.includes("田中")) {
                        hasTask = true;
                    }
                } else if (owners.includes(ownerName)) {
                    hasTask = true;
                }
            }
        });
        
        if (hasTask) {
            activeOwners.push(ownerName);
        }
    });

    console.log("Found active owners for resource view:", activeOwners);
    if (_resourceDetailOwner) {
        renderOwnerDetailTimeline(_resourceDetailOwner);
    } else {
        renderResourceTimeline(activeOwners);
    }
}

function renderResourceTimeline(owners) {
    const container = document.getElementById("resource_content_inner");
    if (!container) return;
    container.innerHTML = "";

    if (owners.length === 0) {
        container.innerHTML = `<div class="resource-placeholder" style="padding:20px; text-align:center; color:#999;">詳細タスク（is_detailed: true）に担当者が設定されていません</div>`;
        renderResourceCalendarHeader();
        return;
    }

    const scale = gantt.getScale();
    const timelineWidth = scale.full_width;
    const columnWidth = scale.col_width;
    // 全画面時は専用幅、ボトムパネル時はガントのグリッド幅に合わせる
    const actualGridWidth = isResourceFullscreen ? RESOURCE_OVERVIEW_COL_WIDTH : (_getRenderedGanttGridWidth());
    const totalWidth = actualGridWidth + timelineWidth;
    const firstPos = gantt.posFromDate(scale.trace_x[0]);

    const gridBackground = `repeating-linear-gradient(to right, transparent, transparent ${columnWidth - 1}px, #ebebeb ${columnWidth - 1}px, #ebebeb ${columnWidth}px), repeating-linear-gradient(to bottom, transparent, transparent 29px, #ebebeb 29px, #ebebeb 30px)`;
    
    let weekendBackgroundHtml = "";
    if (gantt.getState().scale_unit === "day") {
        scale.trace_x.forEach((date, i) => {
            if (date.getDay() === 0 || date.getDay() === 6 || _isHoliday(date)) {
                weekendBackgroundHtml += `<div style="position: absolute; top: 0; bottom: 0; left: ${i * columnWidth}px; width: ${columnWidth}px; background: #f4f4f4; z-index: 0;"></div>`;
            }
        });
    }
    
    const backgroundStyle = `background-image: ${gridBackground}; background-position: ${-firstPos}px 0; background-size: ${columnWidth}px 30px; height: 100%;`;
    const todayPos = gantt.posFromDate(new Date());
    const todayLineHtml = `<div class="resource-today-line" style="left: ${todayPos}px;"></div>`;

    let html = `<div style="width: ${totalWidth}px;">`; // 全体の幅を指定するコンテナを追加
    // 担当者1人につき4行（計画・図面・長納期品・出張）で表示
    const TASK_TYPE_ROWS = [
        { type: 'planning',       label: '計画' },
        { type: 'drawing',        label: '図面' },
        { type: 'long_lead_item', label: '長納期品' },
        { type: 'business_trip',  label: '出張' },
    ];

    owners.forEach((ownerName) => {
        // この担当者の全タスクを収集
        const allOwnerTasks = [];
        gantt.eachTask(t => {
            const isDetailed = (t.is_detailed === true || String(t.is_detailed).toLowerCase() === "true" || String(t.is_detailed).toLowerCase() === "t" || String(t.is_detailed) === "1");
            let isMatch = false;
            if (isDetailed && t.owner) {
                const taskOwners = String(t.owner).split(/[,、\s]+/).map(o => o.trim());
                if (ownerName === "田中(善)") {
                    isMatch = taskOwners.includes("田中(善)") || taskOwners.includes("田中");
                } else {
                    isMatch = taskOwners.includes(ownerName);
                }
            }
            if (isMatch) allOwnerTasks.push(t);
        });

        const colorClass = getOwnerColorClass(ownerName);
        const textColor = (["owner-tsuda", "owner-shibata", "owner-matsumoto"].includes(colorClass)) ? "#222" : "#fff";

        // 4行（タスク種別ごと）を描画
        TASK_TYPE_ROWS.forEach((rowDef, rowIndex) => {
            const rowTasks = allOwnerTasks.filter(t => String(t.task_type) === rowDef.type);
            const isFirstRow = rowIndex === 0;
            const isLastRow  = rowIndex === TASK_TYPE_ROWS.length - 1;

            // 担当者の区切り線（先頭行の上に太線）
            const borderTop    = isFirstRow ? 'border-top: 2px solid #aaa;' : '';
            const borderBottom = isLastRow  ? 'border-bottom: 2px solid #aaa;' : 'border-bottom: 1px solid #eee;';

            // 左セル：先頭行は担当者名＋ラベル、2行目以降はラベルのみ
            const leftCellContent = isFirstRow
                ? `<div style="width:100%;display:flex;align-items:center;justify-content:space-between;padding:0 5px;box-sizing:border-box;">
                       <div class="resource-owner-link" onclick="showOwnerDetail('${ownerName}')" title="クリックして詳細表示" style="font-weight:bold;font-size:11px;color:#333;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;">${ownerName}</div>
                       <div style="font-size:10px;color:#555;background:#ddd;border-radius:2px;padding:1px 4px;margin-left:3px;white-space:nowrap;">${rowDef.label}</div>
                   </div>`
                : `<div style="width:100%;display:flex;align-items:center;justify-content:flex-end;padding-right:5px;">
                       <div style="font-size:10px;color:#555;background:#eee;border-radius:2px;padding:1px 4px;white-space:nowrap;">${rowDef.label}</div>
                   </div>`;

            html += `
                <div class="resource-item" style="display:flex;${borderTop}${borderBottom}min-height:30px;height:30px;align-items:stretch;width:${totalWidth}px;">
                    <div class="resource-grid-container" style="width:${actualGridWidth}px;min-width:${actualGridWidth}px;flex-shrink:0;display:flex;border-right:1px solid #ddd;background:${isFirstRow ? '#efefef' : '#f9f9f9'};position:sticky;left:0;z-index:5;">
                        ${leftCellContent}
                    </div>
                    <div class="resource-timeline" style="width:${timelineWidth}px;flex-shrink:0;position:relative;background:#fff;">
                        <div style="position:absolute;top:0;left:0;right:0;bottom:0;z-index:0;">${weekendBackgroundHtml}</div>
                        <div style="position:absolute;top:0;left:0;right:0;bottom:0;${backgroundStyle}z-index:1;"></div>
                        ${todayLineHtml}
                        <div style="position:absolute;top:0;left:0;right:0;bottom:0;z-index:2;">
            `;

            rowTasks.forEach(t => {
                const left  = gantt.posFromDate(t.start_date);
                const right = gantt.posFromDate(t.end_date);
                const width = Math.max(2, right - left);
                html += `
                    <div class="resource-cell-bar ${colorClass}"
                         style="position:absolute;top:4px;height:22px;left:${left}px;width:${width}px;z-index:10;"
                         title="${t.text} (${t.project_number})">
                         <span class="resource-bar-text" style="color:${textColor};font-size:11px;font-weight:bold;">${t.project_number || ""} ${t.text}</span>
                    </div>
                `;
            });

            html += `
                        </div>
                    </div>
                </div>
            `;
        });
    });
    html += `</div>`; // 閉じタグを追加

    container.innerHTML = html;
    renderResourceCalendarHeader();
    syncResourceScroll();
}

function renderOwnerDetailTimeline(ownerName) {
    const container = document.getElementById("resource_content_inner");
    if (!container) return;
    container.innerHTML = "";

    const scale = gantt.getScale();
    const timelineWidth = scale.full_width;
    const columnWidth = scale.col_width;
    // 全画面時は専用幅、ボトムパネル時はガントのグリッド幅に合わせる
    const actualGridWidth = isResourceFullscreen ? RESOURCE_DETAIL_COL_WIDTH : (_getRenderedGanttGridWidth());
    const totalWidth = actualGridWidth + timelineWidth;
    const firstPos = gantt.posFromDate(scale.trace_x[0]);

    const gridBackground = `repeating-linear-gradient(to right, transparent, transparent ${columnWidth - 1}px, #ebebeb ${columnWidth - 1}px, #ebebeb ${columnWidth}px), repeating-linear-gradient(to bottom, transparent, transparent 29px, #ebebeb 29px, #ebebeb 30px)`;

    let weekendBackgroundHtml = "";
    if (gantt.getState().scale_unit === "day") {
        scale.trace_x.forEach((date, i) => {
            if (date.getDay() === 0 || date.getDay() === 6 || _isHoliday(date)) {
                weekendBackgroundHtml += `<div style="position: absolute; top: 0; bottom: 0; left: ${i * columnWidth}px; width: ${columnWidth}px; background: #f4f4f4; z-index: 0;"></div>`;
            }
        });
    }

    const backgroundStyle = `background-image: ${gridBackground}; background-position: ${-firstPos}px 0; background-size: ${columnWidth}px 30px;`;
    const todayPos = gantt.posFromDate(new Date());
    const todayLineHtml = `<div class="resource-today-line" style="left: ${todayPos}px;"></div>`;

    // 担当者のタスクを収集
    const ownerTasks = [];
    gantt.eachTask(t => {
        const isDetailed = (t.is_detailed === true || String(t.is_detailed).toLowerCase() === "true" || String(t.is_detailed).toLowerCase() === "t" || String(t.is_detailed) === "1");
        let isMatch = false;
        if (isDetailed && t.owner) {
            const taskOwners = String(t.owner).split(/[,、\s]+/).map(o => o.trim());
            if (ownerName === "田中(善)") {
                isMatch = taskOwners.includes("田中(善)") || taskOwners.includes("田中");
            } else {
                isMatch = taskOwners.includes(ownerName);
            }
        }
        if (isMatch) ownerTasks.push(t);
    });

    // 開始日順でソート
    const TASK_TYPE_ORDER = { planning: 0, drawing: 1, long_lead_item: 2, business_trip: 3 };
    ownerTasks.sort((a, b) => {
        const ta = TASK_TYPE_ORDER[a.task_type] ?? 99;
        const tb = TASK_TYPE_ORDER[b.task_type] ?? 99;
        if (ta !== tb) return ta - tb;
        const pa = String(a.project_number || '');
        const pb = String(b.project_number || '');
        return pa.localeCompare(pb, undefined, { numeric: true });
    });

    if (ownerTasks.length === 0) {
        container.innerHTML = `<div style="padding:20px; text-align:center; color:#999;">タスクがありません</div>`;
        return;
    }

    const TASK_TYPE_LABEL = {
        planning:       '計画',
        drawing:        '図面',
        long_lead_item: '長納期品',
        business_trip:  '出張',
    };

    const colorClass = getOwnerColorClass(ownerName);
    const textColor = (["owner-tsuda", "owner-shibata", "owner-matsumoto"].includes(colorClass)) ? "#222" : "#fff";

    let html = `<div style="width: ${totalWidth}px;">`;
    ownerTasks.forEach(t => {
        const hasDate = !t.has_no_date && t.start_date && t.end_date;
        const left = hasDate ? gantt.posFromDate(t.start_date) : 0;
        const right = hasDate ? gantt.posFromDate(t.end_date) : 0;
        const barWidth = hasDate ? Math.max(2, right - left) : 0;
        const typeLabel = TASK_TYPE_LABEL[String(t.task_type)] || String(t.task_type || '');

        html += `
            <div class="resource-item" style="display: flex; border-bottom: 1px solid #eee; min-height: 30px; height: 30px; align-items: stretch; width: ${totalWidth}px;">
                <div class="resource-grid-container" style="width: ${actualGridWidth}px; min-width: ${actualGridWidth}px; flex-shrink: 0; display: flex; border-right: 1px solid #ddd; background: #f9f9f9; position: sticky; left: 0; z-index: 5; overflow: hidden;">
                    <div style="display: flex; align-items: center; padding: 0 6px; font-size: 12px; color: #333; width: 100%; overflow: hidden; white-space: nowrap; gap: 6px;">
                        <span style="flex-shrink: 0; font-size: 10px; color: #555; background: #e0e0e0; border-radius: 2px; padding: 1px 4px;">${typeLabel}</span>
                        <span style="flex-shrink: 0; font-weight: bold; color: #546e7a; min-width: 60px;">${t.project_number || '-'}</span>
                        <span style="overflow: hidden; text-overflow: ellipsis;">${t.text}</span>
                    </div>
                </div>
                <div class="resource-timeline" style="width: ${timelineWidth}px; flex-shrink: 0; position: relative; background: #fff; overflow: hidden; z-index: 2;">
                    <div style="position: absolute; top: 0; left: 0; right: 0; bottom: 0; z-index: 0;">${weekendBackgroundHtml}</div>
                    <div style="position: absolute; top: 0; left: 0; right: 0; bottom: 0; ${backgroundStyle} z-index: 1;"></div>
                    ${todayLineHtml}
                    ${hasDate ? `
                    <div class="resource-cell-bar ${colorClass}"
                         style="position: absolute; top: 4px; height: 22px; left: ${left}px; width: ${barWidth}px; z-index: 10;"
                         title="${t.text} (${t.project_number})">
                         <span class="resource-bar-text" style="color:${textColor}; font-size:11px; font-weight:bold;">${t.project_number || ""} ${t.text}</span>
                    </div>` : ''}
                </div>
            </div>
        `;
    });
    html += `</div>`;
    container.innerHTML = html;
    renderResourceCalendarHeader();
    syncResourceScroll();
}

const _DOW_NAMES = ['日', '月', '火', '水', '木', '金', '土'];

function renderResourceCalendarHeader() {
    const header = document.getElementById('resource_calendar_header');
    if (!header) return;
    // ボトムパネル時はカレンダーヘッダー不要
    if (!isResourceFullscreen) {
        header.style.display = 'none';
        return;
    }
    header.style.display = '';

    const scale = gantt.getScale();
    const timelineWidth = scale.full_width;
    const columnWidth = scale.col_width;
    // 全画面時は専用幅、ボトムパネル時はガントのグリッド幅に合わせる
    const actualGridWidth = isResourceFullscreen
        ? (_resourceDetailOwner ? RESOURCE_DETAIL_COL_WIDTH : RESOURCE_OVERVIEW_COL_WIDTH)
        : (_getRenderedGanttGridWidth());
    const dates = scale.trace_x;
    const unit = gantt.getState().scale_unit;

    // 月グループを作成
    const months = [];
    let curMonth = -1, curYear = -1, monthStart = 0;
    dates.forEach((date, i) => {
        const m = date.getMonth(), y = date.getFullYear();
        if (m !== curMonth || y !== curYear) {
            if (curMonth !== -1) months.push({ month: curMonth, year: curYear, count: i - monthStart });
            curMonth = m; curYear = y; monthStart = i;
        }
    });
    if (dates.length > 0) months.push({ month: curMonth, year: curYear, count: dates.length - monthStart });

    // 月行HTML
    let monthHtml = '';
    months.forEach(m => {
        const w = m.count * columnWidth;
        monthHtml += `<div class="resource-cal-cell resource-cal-month" style="width:${w}px;min-width:${w}px;height:22px;">${m.year}年${m.month + 1}月</div>`;
    });

    // 日/週行HTML・曜日行HTML（日単位のみ曜日行あり）
    let dayHtml = '';
    let dowHtml = '';
    dates.forEach(date => {
        const dow = date.getDay();
        const isSun = dow === 0;
        const isSat = dow === 6;
        const isHol = _isHoliday(date);
        const wkCls = (isSun || isSat || isHol) ? ' resource-cal-weekend' : '';
        const dowColor = isSun || isHol ? 'color:#ef9a9a;' : isSat ? 'color:#90caf9;' : '';
        const d = date.getDate();

        if (unit === 'day') {
            dayHtml += `<div class="resource-cal-cell${wkCls}" style="width:${columnWidth}px;min-width:${columnWidth}px;height:18px;${dowColor}">${d}</div>`;
            dowHtml += `<div class="resource-cal-cell${wkCls}" style="width:${columnWidth}px;min-width:${columnWidth}px;height:18px;${dowColor}">${_DOW_NAMES[dow]}</div>`;
        } else {
            // 週単位：日付のみ表示（曜日行なし）
            dayHtml += `<div class="resource-cal-cell" style="width:${columnWidth}px;min-width:${columnWidth}px;height:18px;">${d}</div>`;
        }
    });

    const dowRow = unit === 'day' ? `
        <div class="cal-row" style="height:18px;">
            <div class="cal-spacer" style="width:${actualGridWidth}px;min-width:${actualGridWidth}px;height:18px;"></div>
            <div id="resource_cal_scroll3" style="overflow:hidden;flex:1;">
                <div style="display:flex;width:${timelineWidth}px;">${dowHtml}</div>
            </div>
        </div>` : '';

    header.innerHTML = `
        <div class="cal-row" style="height:22px;">
            <div class="cal-spacer" style="width:${actualGridWidth}px;min-width:${actualGridWidth}px;height:22px;"></div>
            <div id="resource_cal_scroll" style="overflow:hidden;flex:1;">
                <div style="display:flex;width:${timelineWidth}px;">${monthHtml}</div>
            </div>
        </div>
        <div class="cal-row" style="height:18px;">
            <div class="cal-spacer" style="width:${actualGridWidth}px;min-width:${actualGridWidth}px;height:18px;"></div>
            <div id="resource_cal_scroll2" style="overflow:hidden;flex:1;">
                <div style="display:flex;width:${timelineWidth}px;">${dayHtml}</div>
            </div>
        </div>
        ${dowRow}
    `;
}

function showOwnerDetail(ownerName) {
    _resourceDetailOwner = ownerName;
    document.getElementById('resource_title').textContent = `${ownerName}さんの詳細リソース状況`;
    document.getElementById('resource_back_btn').style.display = '';
    document.querySelector(".resource-header-bar").style.display = '';
    renderOwnerDetailTimeline(ownerName);
}

function showOwnerOverview() {
    _resourceDetailOwner = null;
    document.getElementById('resource_title').textContent = '担当者別リソース状況';
    document.getElementById('resource_back_btn').style.display = 'none';
    document.querySelector(".resource-header-bar").style.display = 'none';
    updateResourceData();
}

function syncResourceScroll() {
    const left = gantt.getScrollState().x;
    const resourceContent = document.querySelector(".resource-content");
    if (resourceContent) resourceContent.scrollLeft = left;
    _syncCalendarHeaderScroll(left);
}

function _syncCalendarHeaderScroll(left) {
    const s1 = document.getElementById('resource_cal_scroll');
    const s2 = document.getElementById('resource_cal_scroll2');
    const s3 = document.getElementById('resource_cal_scroll3');
    if (s1) s1.scrollLeft = left;
    if (s2) s2.scrollLeft = left;
    if (s3) s3.scrollLeft = left;
}

// リソース全画面モードに入る（フィルターなし初期表示用）
function _enterResourceFullscreen() {
    isResourceFullscreen = true;
    isResourceView = true;
    // 担当者フィルターをリセット
    currentOwnerFilter = [];
    document.querySelectorAll('.owner-chk-item').forEach(chk => { chk.checked = false; });
    const allChk = document.getElementById('owner_chk_all');
    if (allChk) allChk.checked = true;
    _updateOwnerFilterBtn();
    const panel = document.getElementById("resource_panel");
    const ganttEl = document.getElementById("gantt_here");
    const btn = document.getElementById("resource_toggle");
    panel.classList.add('resource-fullscreen');
    // ガントを一時的に表示したままリサイズを確定させてからリソース描画
    ganttEl.style.visibility = "hidden";
    gantt.setSizes();
    updateResourceData();
    ganttEl.style.visibility = "";
    ganttEl.style.display = "none";
    panel.style.display = "flex";
    void panel.offsetHeight; // 強制リフロー：レイアウトを確定させる
    btn.style.display = "none";
    document.getElementById("resource_close_btn").style.display = "none";
    document.querySelector(".resource-header-bar").style.display = "none";
    updateFilterButtons();
    // レイアウト確定後にスクロール位置を設定
    setTimeout(() => {
        const todayX = gantt.posFromDate(new Date());
        const scrollX = Math.max(0, todayX - 300);
        const resourceContent = document.querySelector('.resource-content');
        if (resourceContent) resourceContent.scrollLeft = scrollX;
        _syncCalendarHeaderScroll(scrollX);
    }, 50);
}

// リソース全画面モードを抜けてガントビューへ
function _exitResourceFullscreen() {
    isResourceFullscreen = false;
    isResourceView = false;
    const panel = document.getElementById("resource_panel");
    const ganttEl = document.getElementById("gantt_here");
    const btn = document.getElementById("resource_toggle");
    panel.classList.remove('resource-fullscreen');
    panel.style.display = "none";
    ganttEl.style.display = "";
    btn.style.display = ""; // リソースボタンを復元
    btn.innerText = "リソース表示";
    document.getElementById("resource_close_btn").style.display = "";
    updateFilterButtons();
    setTimeout(() => {
        gantt.setSizes();
        const currentLevel = document.querySelector('.zoom-btn.active')?.textContent === '週単位' ? 'week' : 'day';
        gantt.ext.zoom.setLevel(currentLevel);
        // スクロールを微小に動かしてタイムラインを強制再描画
        const s = gantt.getScrollState();
        gantt.scrollTo(s.x + 1, s.y);
        requestAnimationFrame(() => gantt.scrollTo(s.x, s.y));
    }, 50);
}

function toggleResourceView() {
    if (isResourceFullscreen) return; // 全画面モード中は通常トグル不可
    isResourceView = !isResourceView;
    const btn = document.getElementById("resource_toggle");
    const panel = document.getElementById("resource_panel");

    if (isResourceView) {
        btn.innerText = "リソース表示中 ✕";
        btn.classList.add('active');
        // コンテンツを描画してからパネルを表示（古い内容が一瞬見えるのを防ぐ）
        updateResourceData();
        panel.style.display = "flex";
    } else {
        btn.innerText = "リソース表示";
        btn.classList.remove('active');
        panel.style.display = "none";
        // 詳細モードをリセット
        _resourceDetailOwner = null;
        document.getElementById('resource_title').textContent = '担当者別リソース状況';
        document.getElementById('resource_back_btn').style.display = 'none';
    }

    setTimeout(() => {
        gantt.setSizes();
        const currentLevel = document.querySelector('.zoom-btn.active')?.textContent === '週単位' ? 'week' : 'day';
        gantt.ext.zoom.setLevel(currentLevel);
        // スクロールを微小に動かしてタイムラインを強制再描画
        const s = gantt.getScrollState();
        gantt.scrollTo(s.x + 1, s.y);
        requestAnimationFrame(() => gantt.scrollTo(s.x, s.y));
    }, 50);
}

// 今日の赤線：.gantt_task（ビューポート全高）に配置し、
// .gantt_data_area の offsetLeft でスクロール量を自動取得して位置補正
function _drawMainTodayLine() {
    const taskEl = document.querySelector('#gantt_here .gantt_task');
    if (!taskEl) return;
    const dataArea = taskEl.querySelector('.gantt_data_area');
    if (!dataArea) return;

    let line = document.getElementById('main_today_line');
    if (!line) {
        line = document.createElement('div');
        line.id = 'main_today_line';
        line.style.cssText = 'position:absolute;bottom:0;width:2px;background:#ff4d4d;z-index:6;pointer-events:none;';
        taskEl.appendChild(line);
    }
    // dataArea.offsetLeft = −スクロール量（DHTMLX がスクロール時に left を負に設定）
    // posFromDate(today) = タイムライン絶対座標
    // 合計 = .gantt_task 内でのビュー座標（正しい表示位置）
    line.style.left = (dataArea.offsetLeft + gantt.posFromDate(new Date())) + 'px';
    line.style.top = (gantt.config.scale_height || 60) + 'px';
}
gantt.attachEvent("onGanttRender", _drawMainTodayLine);
gantt.attachEvent("onGanttRender", function() { requestAnimationFrame(_renderWishDateMarks); });
gantt.attachEvent("onGanttScroll",  function() { _renderWishDateMarks(); });

function _toDateStr(d) {
    return d.getFullYear() + '-' +
        String(d.getMonth() + 1).padStart(2, '0') + '-' +
        String(d.getDate()).padStart(2, '0');
}

async function _saveWishDate(taskId, dateStr) {
    const { error } = await supabaseClient
        .from('tasks')
        .update({ wish_date: dateStr })
        .eq('id', taskId);
    if (error) console.error('wish_date 保存エラー:', error);
}

// onBeforeTaskDisplay と同じフィルター条件を手動で判定
function _isTaskDisplayed(task) {
    const isDetailed = (task.is_detailed === true || String(task.is_detailed).toUpperCase() === 'TRUE');
    if (!isDetailed) return false;
    if (currentProjectFilter.length > 0 && !currentProjectFilter.includes(String(task.project_number))) return false;
    if (currentTaskTypeFilter && String(task.task_type) !== currentTaskTypeFilter) return false;
    if (currentOwnerFilter.length > 0) {
        const taskOwners = String(task.owner || '').split(/[,、\s]+/).map(o => o.trim());
        if (!currentOwnerFilter.some(f => taskOwners.includes(f))) return false;
    }
    return true;
}

function _renderWishDateMarks() {
    const dataArea = document.querySelector('#gantt_here .gantt_data_area');
    if (!dataArea) return;
    dataArea.querySelectorAll('.wish-date-mark').forEach(el => el.remove());

    const label = currentTaskTypeFilter === 'long_lead_item' ? '手配期日' : '出希望日';

    gantt.eachTask(function(task) {
        if (!task.wish_date) return;
        if (!_isTaskDisplayed(task)) return;

        const parts = String(task.wish_date).split('-');
        if (parts.length !== 3) return;
        const wishDate = new Date(+parts[0], +parts[1] - 1, +parts[2]);
        if (isNaN(wishDate.getTime())) return;

        // getTaskPosition でDOM不要の垂直位置を取得（タイムライン範囲外でも動作）
        let top;
        if (typeof gantt.getTaskPosition === 'function') {
            const pos = gantt.getTaskPosition(task, task.start_date, task.end_date);
            if (!pos) return;
            top = pos.top;
        } else {
            const taskNode = gantt.getTaskNode(task.id);
            if (!taskNode) return;
            top = taskNode.classList.contains('hidden_bar')
                ? (parseInt(taskNode.style.top) || 0)
                : taskNode.offsetTop;
        }

        // 完了予定日/手配予定日が希望日を過ぎていたら赤
        let isOverdue = false;
        if (!task.has_no_date && task.end_date) {
            // gantt内部のend_date は排他的終了日（+1日）なので-1日して実際の完了日と比較
            const actualEnd = gantt.date.add(new Date(task.end_date), -1, 'day');
            actualEnd.setHours(0, 0, 0, 0);
            const wishDay = new Date(wishDate);
            wishDay.setHours(0, 0, 0, 0);
            isOverdue = actualEnd > wishDay;
        }

        const x = gantt.posFromDate(gantt.date.add(wishDate, 1, 'day'));
        const el = document.createElement('div');
        el.className = 'wish-date-mark';
        el.style.left = x + 'px';
        el.style.top  = top + 'px';
        if (isOverdue) { el.style.color = '#c62828'; el.style.webkitTextStroke = '3.5px #fff'; el.style.paintOrder = 'stroke fill'; }
        el.title = label + ': ' + task.wish_date;
        el.textContent = '▼';
        dataArea.appendChild(el);

        // ドラッグで wish_date を変更（編集権限がある場合のみ）
        el.addEventListener('mousedown', function(e) {
            if (!_isEditor) return;
            e.stopPropagation();
            e.preventDefault();
            const startClientX = e.clientX;
            const startLeft    = parseFloat(el.style.left);
            let   currentLeft  = startLeft;
            el.classList.add('dragging');

            function onMove(e) {
                currentLeft = startLeft + (e.clientX - startClientX);
                el.style.left = currentLeft + 'px';
            }
            function onUp() {
                document.removeEventListener('mousemove', onMove);
                document.removeEventListener('mouseup',   onUp);
                el.classList.remove('dragging');
                const newDate = gantt.dateFromPos
                    ? gantt.dateFromPos(currentLeft)
                    : null;
                if (!newDate) return;
                const dateStr = _toDateStr(newDate);
                task.wish_date = dateStr;
                el.title = label + ': ' + dateStr;
                _saveWishDate(task.id, dateStr);
                requestAnimationFrame(_renderWishDateMarks);
            }
            document.addEventListener('mousemove', onMove);
            document.addEventListener('mouseup',   onUp);
        });
    });
}

// スクロール同期のイベント登録
gantt.attachEvent("onGanttScroll", function (left, top){
    _drawMainTodayLine(); // 横スクロール時に赤線位置を追従
    if (!isResourceFullscreen) {
        // ガント表示中のみリソースパネルと同期（全画面モード中は干渉しない）
        const resourceContent = document.querySelector(".resource-content");
        if (resourceContent) resourceContent.scrollLeft = left;
        _syncCalendarHeaderScroll(left);
    }
});

window.addEventListener('DOMContentLoaded', () => {
    const resourceContent = document.querySelector(".resource-content");
    if (resourceContent) {
        resourceContent.addEventListener('scroll', function() {
            // カレンダーヘッダーは常に同期
            _syncCalendarHeaderScroll(this.scrollLeft);
            // ガント表示中のみガントと同期（全画面モード中は非表示のガントに触らない）
            if (!isResourceFullscreen) {
                const ganttScroll = gantt.getScrollState();
                if (Math.abs(ganttScroll.x - this.scrollLeft) > 1) {
                    gantt.scrollTo(this.scrollLeft, null);
                }
            }
        });
    }
    document.getElementById('resource_close_btn').onclick = toggleResourceView;
});

// Supabase 設定
const S_URL = "https://dgekjzkrybrswsxlcbvh.supabase.co";
const S_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImRnZWtqemtyeWJyc3dzeGxjYnZoIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Njg4ODQ3MjIsImV4cCI6MjA4NDQ2MDcyMn0.BsEj53lV3p76yE9fMPTaLn7ocKTNzYPTqIAnBafYItU";
// createClient呼び出し前にURLのtype情報を保存（Supabaseがhashを処理・クリアする前に取得）
const _pageInitType = new URLSearchParams(window.location.hash.replace('#', '?')).get('type')
                   || new URLSearchParams(window.location.search).get('type');
const supabaseClient = supabase.createClient(S_URL, S_KEY);

// ===== 認証管理 =====
// 編集可能なメールアドレスリスト
const EDITORS = [
    'm2-kusakabe@kusakabe.com', // 常務
    'e-kurosaki@kusakabe.com',  // 工程管理者
    's-morimura@kusakabe.com',  // 工程管理者
    's-fujiyama@kusakabe.com',  // 藤山
    'y2-tanaka@kusakabe.com',   // 田中
    'm-yasuoka@kusakabe.com',   // 安岡
    'k-miyazaki@kusakabe.com',  // 宮﨑
    'h-kawabe@kusakabe.com',    // 川邊
    'y-dan@kusakabe.com',       // 檀
    'm-horii@kusakabe.com',     // 堀井
    'm-tsuda@kusakabe.com',     // 津田
];
let _isEditor = false;

function _updateUIForAuth(isEditor) {
    _isEditor = isEditor;
    gantt.config.readonly = !isEditor;
    document.getElementById('create_task_btn').style.display  = isEditor ? '' : 'none';
    document.getElementById('multi_delete_btn').style.display  = isEditor ? '' : 'none';
    document.getElementById('archive_btn_wrap').style.display  = isEditor ? '' : 'none';
    const authBtn = document.getElementById('auth_btn');
    if (authBtn) {
        authBtn.textContent = isEditor ? 'ログアウト' : 'ログイン';
        authBtn.classList.toggle('logged-in', isEditor);
    }
    gantt.render();
}

function handleAuthBtn() {
    if (_isEditor) {
        if (confirm('ログアウトしますか？')) doLogout();
    } else {
        openLoginDialog();
    }
}

// ===== ヘルプツールチップ =====
// 表示モードボタン（activeなものだけ表示）
var MODE_FILTER_IDS = ['resource_home_btn', 'plan_filter_btn', 'drawing_filter_btn', 'longterm_filter_btn', 'trip_filter_btn'];
var MODE_FILTER_TIPS = {
    'resource_home_btn':   { title: '担当別（表示中）',   text: '担当者別リソースを全画面表示中\nクリックで通常のガントチャートに戻ります' },
    'plan_filter_btn':     { title: '計画（表示中）',     text: '計画タスクのみ表示中\nクリックで解除します' },
    'drawing_filter_btn':  { title: '図面（表示中）',     text: '図面タスクのみ表示中（デフォルト）\nクリックで解除します' },
    'longterm_filter_btn': { title: '長納期品（表示中）', text: '長納期部品タスクのみ表示中\nクリックで解除します' },
    'trip_filter_btn':     { title: '出張（表示中）',     text: '出張タスクのみ表示中\nクリックで解除します' },
};
var HELP_TIPS = [
    { id: 'zoom_day_btn',        title: '日単位',            text: '1日単位で詳細表示（デフォルト）' },
    { id: 'zoom_week_btn',       title: '週単位',            text: '週単位で全体スケジュールを把握' },
    { id: 'auth_btn',            title: 'ログイン',           text: '編集者としてログイン\nタスクの追加・編集・削除が可能になります' },
    { id: 'project_filter_btn',  title: '工事番号フィルター',   text: 'クリックで工事番号を選択\n複数選択可。「全表示」で全件に戻す' },
    { id: 'owner_filter_btn',    title: '担当者フィルター',    text: '特定担当者のみ絞り込み（複数選択可）\nリソース表示時に表示されます' },
    { id: 'resource_toggle',     title: 'リソース表示',       text: 'ガントチャート下部に\n担当者別の業務状況を並列表示' },
    { id: 'create_task_btn',     title: '新規タスク追加',     text: 'タスクを末尾に追加します（要ログイン）' },
    { id: 'archive_btn_wrap',    title: 'アーカイブ',         text: '完了工事の保管・参照\n▼クリックでメニュー表示（要ログイン）' },
];
var GRID_TIP = {
    title: 'グリッド（左側）',
    text: 'シングルクリック → タスク開始日へスクロール\nダブルクリック → インライン編集ポップアップ\nCtrl+クリック → 複数行選択\n右クリック → コピー・貼り付け・削除メニュー'
};
var TIMELINE_TIP = {
    title: 'タイムライン（右側）',
    text: 'バーをドラッグ → 開始日・完了日をまとめて変更\n右端をドラッグ → 完了日のみ変更\nダブルクリック → 詳細編集ダイアログ\n▼マーク（図面）→ ドラッグで出図希望日を変更'
};
var RESOURCE_GRID_TIP = {
    title: '担当者名列',
    text: 'クリック → その担当者の詳細ビューに切替\n詳細ビューでは担当者のタスクをタスクタイプ別に一覧表示'
};
var RESOURCE_TIMELINE_TIP = {
    title: 'リソースタイムライン',
    text: '各担当者の担当タスクがバーで表示されます\n左右にスクロールして期間を確認\n赤い縦線 → 本日の位置'
};

function openHelp() {
    var helpBtn = document.getElementById('help_btn');
    if (helpBtn.classList.contains('help-active')) { closeHelp(); return; }
    helpBtn.classList.add('help-active');
    var container = document.getElementById('help_tips_container');
    container.innerHTML = '<div id="help_overlay_bg"></div>';
    document.getElementById('help_overlay_bg').addEventListener('click', closeHelp);
    container.classList.add('open');

    // 表示モードボタン：activeなものだけ
    MODE_FILTER_IDS.forEach(function(id) {
        var el = document.getElementById(id);
        if (!el || !el.classList.contains('active')) return;
        var rect = el.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) return;
        addHelpItem(container, MODE_FILTER_TIPS[id], rect);
    });

    // その他のボタン
    HELP_TIPS.forEach(function(tipDef) {
        var el = document.getElementById(tipDef.id);
        if (!el) return;
        var rect = el.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) return;
        var cs = window.getComputedStyle(el);
        if (cs.display === 'none' || cs.visibility === 'hidden') return;
        addHelpItem(container, tipDef, rect);
    });

    // グリッド（左側）とタイムライン（右側）を別々にハイライト
    if (typeof isResourceFullscreen !== 'undefined' && isResourceFullscreen) {
        // 担当別全画面: リソースパネルの担当者名列とタイムライン列
        var rcEl        = document.querySelector('#resource_panel .resource-content');
        var firstGridEl = document.querySelector('#resource_content_inner .resource-grid-container');
        if (rcEl && firstGridEl) {
            var rcRect = rcEl.getBoundingClientRect();
            var fgRect = firstGridEl.getBoundingClientRect();
            if (fgRect.width > 0 && rcRect.height > 0) {
                // 担当者名列（全行分の高さ）
                var resGridRect = { top: rcRect.top, bottom: rcRect.bottom, left: fgRect.left, right: fgRect.right };
                // タイムライン列（担当者名列の右〜コンテンツ右端）
                var resTlRect   = { top: rcRect.top, bottom: rcRect.bottom, left: fgRect.right, right: rcRect.right };
                addHelpItem(container, RESOURCE_GRID_TIP, resGridRect);
                if (resTlRect.right > resTlRect.left) addHelpItem(container, RESOURCE_TIMELINE_TIP, resTlRect);
            }
        }
    } else {
        // 通常ガント表示
        var gridEl     = document.querySelector('#gantt_here .gantt_grid');
        var timelineEl = document.querySelector('#gantt_here .gantt_task');
        if (gridEl) {
            var gr = gridEl.getBoundingClientRect();
            if (gr.width > 0 && gr.height > 0) addHelpItem(container, GRID_TIP, gr);
        }
        if (timelineEl) {
            var tr = timelineEl.getBoundingClientRect();
            if (tr.width > 0 && tr.height > 0) addHelpItem(container, TIMELINE_TIP, tr);
        }
    }
}

// ハイライト枠＋吹き出しを1セット作成
function addHelpItem(container, tip, rect) {
    var w = rect.right  - rect.left;
    var h = rect.bottom - rect.top;

    // ハイライト枠（ボタンに重ねる）
    var hl = document.createElement('div');
    hl.className = 'help-highlight';
    hl.style.top    = rect.top  + 'px';
    hl.style.left   = rect.left + 'px';
    hl.style.width  = w + 'px';
    hl.style.height = h + 'px';
    container.appendChild(hl);

    // 吹き出し
    var tipDiv = document.createElement('div');
    tipDiv.className = 'help-tip';
    tipDiv.innerHTML = '<div class="help-tip-title">' + (tip.title || '') + '</div>' + tip.text.replace(/\n/g, '<br>');
    container.appendChild(tipDiv);

    // 吹き出しの位置を決める
    requestAnimationFrame(function() {
        var vw = window.innerWidth;
        var vh = window.innerHeight;
        var tw = tipDiv.offsetWidth;
        var th = tipDiv.offsetHeight;
        var top  = rect.bottom + 8;
        var left = rect.left;
        if (left + tw > vw - 8) left = vw - tw - 8;
        if (left < 4) left = 4;
        if (top + th > vh - 8) {
            top = rect.top - th - 8;
            if (top < 4) top = 4;
            tipDiv.classList.add('tip-above');
        }
        tipDiv.style.top  = top  + 'px';
        tipDiv.style.left = left + 'px';
    });

    // ホバーで吹き出しを表示/非表示
    hl.addEventListener('mouseenter', function() { tipDiv.classList.add('tip-visible'); });
    hl.addEventListener('mouseleave', function() { tipDiv.classList.remove('tip-visible'); });
}

function closeHelp() {
    document.getElementById('help_btn').classList.remove('help-active');
    var container = document.getElementById('help_tips_container');
    container.classList.remove('open');
    container.innerHTML = '';
}
document.addEventListener('keydown', function(e) {
    if (e.key === 'Escape') closeHelp();
});

function openLoginDialog() {
    document.getElementById('login_email').value = '';
    document.getElementById('login_password').value = '';
    document.getElementById('login_error').style.display = 'none';
    document.getElementById('login_overlay').classList.add('open');
    setTimeout(() => document.getElementById('login_email').focus(), 100);
}

function closeLoginDialog() {
    document.getElementById('login_overlay').classList.remove('open');
}

async function doLogin() {
    const email    = document.getElementById('login_email').value.trim();
    const password = document.getElementById('login_password').value;
    const errEl    = document.getElementById('login_error');
    errEl.style.display = 'none';
    document.getElementById('login_btn_submit').textContent = '処理中...';
    const { error } = await supabaseClient.auth.signInWithPassword({ email, password });
    document.getElementById('login_btn_submit').textContent = 'ログイン';
    if (error) {
        errEl.textContent = 'メールアドレスまたはパスワードが正しくありません';
        errEl.style.display = 'block';
    } else {
        closeLoginDialog();
    }
}

async function doLogout() {
    await supabaseClient.auth.signOut();
}

function openSetPasswordDialog() {
    document.getElementById('setpw_pw1').value = '';
    document.getElementById('setpw_pw2').value = '';
    document.getElementById('setpw_error').style.display = 'none';
    document.getElementById('setpw_overlay').classList.add('open');
    setTimeout(() => document.getElementById('setpw_pw1').focus(), 100);
}

async function doSetPassword() {
    const pw1 = document.getElementById('setpw_pw1').value;
    const pw2 = document.getElementById('setpw_pw2').value;
    const errEl = document.getElementById('setpw_error');
    errEl.style.display = 'none';

    if (pw1.length < 8) {
        errEl.textContent = 'パスワードは8文字以上で入力してください';
        errEl.style.display = 'block';
        return;
    }
    if (pw1 !== pw2) {
        errEl.textContent = 'パスワードが一致しません';
        errEl.style.display = 'block';
        return;
    }

    document.getElementById('setpw_btn_submit').textContent = '処理中...';
    const { error } = await supabaseClient.auth.updateUser({ password: pw1 });
    document.getElementById('setpw_btn_submit').textContent = 'パスワードを設定する';

    if (error) {
        errEl.textContent = 'エラーが発生しました: ' + error.message;
        errEl.style.display = 'block';
    } else {
        document.getElementById('setpw_overlay').classList.remove('open');
        // URLのハッシュをクリア
        history.replaceState(null, '', window.location.pathname + window.location.search);
        _updateUIForAuth(true);
    }
}

// 認証状態の変化を監視（ページロード時・ログイン・ログアウト時に自動で呼ばれる）
supabaseClient.auth.onAuthStateChange((_event, session) => {
    if (_event === 'PASSWORD_RECOVERY' || (_event === 'SIGNED_IN' && _pageInitType === 'invite')) {
        // 招待メール・パスワードリセットのリンクからのアクセス
        openSetPasswordDialog();
    } else {
        const email = session?.user?.email || '';
        _updateUIForAuth(!!session && EDITORS.includes(email));
    }
});

// Gantt 基本構成
gantt.config.date_format = "%Y-%m-%d";

// 担当者プルダウン用インラインエディタ
const OWNER_OPTIONS = ['藤山','田中','安岡','川邊','檀','堀井','宮﨑','津田','古村','柴田','橋本','松本(英)'];
gantt.config.editor_types.owner_select = {
    show: function(id, column, config, placeholder) {
        const opts = OWNER_OPTIONS.map(n =>
            `<option value="${n}">${n}</option>`
        ).join('');
        placeholder.innerHTML = `<select style="width:100%;height:100%;border:1px solid #7986cb;font-family:メイリオ,sans-serif;font-size:13px;box-sizing:border-box;"><option value=""></option>${opts}</select>`;
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
        placeholder.innerHTML = `<select style="width:100%;height:100%;border:1px solid #7986cb;font-family:メイリオ,sans-serif;font-size:13px;box-sizing:border-box;">
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
        placeholder.innerHTML = '<input type="date" style="width:100%;height:100%;border:1px solid #7986cb;font-family:メイリオ,sans-serif;font-size:12px;box-sizing:border-box;">';
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
        placeholder.innerHTML = '<input type="date" name="' + column.name + '">';
        placeholder.querySelector('input').addEventListener('change', function() {
            if (!this.value) _completionDateClear(id);
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

// 新規タスク追加
// gantt.createTask() を使わず Supabase に直接保存して loadData() でリフレッシュする
// afterTaskId: グリッドの+ボタンから呼ばれた場合は対象行のID、ヘッダーボタンから呼ばれた場合は undefined
async function createTask(afterTaskId) {
    if (currentProjectFilter.length !== 1) {
        alert("工事番号を選択してからタスクを追加してください。");
        return;
    }
    const projectNumber = currentProjectFilter[0];

    // 現在表示中のタスク一覧を sort_order 順（nullの場合は id で代替）でソート
    const visibleTasks = gantt.getTaskByTime().filter(t => {
        const isDetailed = (t.is_detailed === true || String(t.is_detailed).toUpperCase() === 'TRUE');
        if (!isDetailed) return false;
        if (String(t.project_number) !== String(projectNumber)) return false;
        if (currentTaskTypeFilter && String(t.task_type) !== currentTaskTypeFilter) return false;
        return true;
    }).sort((a, b) => {
        const sa = (a.sort_order != null) ? a.sort_order : a.id;
        const sb = (b.sort_order != null) ? b.sort_order : b.id;
        return sa - sb;
    });

    // sort_order と machine の決定
    // sort_order が null の行は id * 1000 を仮想値として使用（整数列でも小数にならないよう大きな間隔を確保）
    const _getSO = t => (t.sort_order != null) ? t.sort_order : t.id * 1000;

    let newSortOrder;
    let inheritMachine = "";

    if (afterTaskId != null) {
        // グリッドの+ボタン：クリックした行の1行下に挿入
        const afterIdx = visibleTasks.findIndex(t => String(t.id) === String(afterTaskId));
        if (afterIdx >= 0) {
            const afterTask = visibleTasks[afterIdx];
            inheritMachine = afterTask.machine || "";
            if (afterIdx + 1 < visibleTasks.length) {
                const nextTask = visibleTasks[afterIdx + 1];
                newSortOrder = Math.round((_getSO(afterTask) + _getSO(nextTask)) / 2);
            } else {
                newSortOrder = _getSO(afterTask) + 1000;
            }
        } else {
            // 見つからない場合は末尾
            newSortOrder = visibleTasks.length > 0 ? (_getSO(visibleTasks[visibleTasks.length - 1]) + 1000) : 1000;
            inheritMachine = visibleTasks.length > 0 ? (visibleTasks[visibleTasks.length - 1].machine || "") : "";
        }
    } else {
        // ヘッダーの「新規タスク追加」ボタン：末尾に追加
        newSortOrder = visibleTasks.length > 0 ? (_getSO(visibleTasks[visibleTasks.length - 1]) + 1000) : 1000;
        inheritMachine = visibleTasks.length > 0 ? (visibleTasks[visibleTasks.length - 1].machine || "") : "";
    }

    const today = new Date();
    // 完了予定日=今日、期間=2週間（14日）のデフォルト設定
    const startDate = new Date(today);
    startDate.setDate(startDate.getDate() - 13); // 13日前から開始 → 完了日=今日で14日間

    const { data, error } = await supabaseClient
        .from('tasks')
        .insert([{
            text: "",
            start_date: _toDateStr(startDate),
            end_date: _toDateStr(today), // 完了日=今日（loadData時に+1日してgantの排他的終了日にする）
            project_number: projectNumber,
            machine: inheritMachine,
            unit: "",
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
            task_type: currentTaskTypeFilter || "drawing",
            wish_date: _toDateStr(today),
            is_detailed: true,
            sort_order: newSortOrder
        }])
        .select();

    if (error) {
        console.error("Error adding task:", error);
        alert("タスクの追加に失敗しました。\n" + error.message);
        return;
    }

    // データ再読み込みしてからインライン編集を起動
    await loadData();

    if (data && data[0]) {
        const newId = data[0].id;
        gantt.showTask(newId);
        const editCol = gantt.config.columns.find(c => c.name === "text");
        if (editCol && editCol.editor) {
            setTimeout(() => {
                gantt.ext.inlineEditors.startEdit(newId, "text");
            }, 100);
        }
    }
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
    // createTask() からは呼ばれない（直接Supabase保存のため）
    // ライトボックス経由の追加など他の経路で使われる場合のみ動作
});

gantt.attachEvent("onAfterTaskUpdate", async function(id, item) {
    try {
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
        { name: "text",             label: "組立図面名",     width: 135, tree: true,      editor: { type: "text",   map_to: "text" } },
        { name: "model_type",       label: "機種",           width: 30, align: "center", editor: { type: "text",   map_to: "model_type" } },
        { name: "unit2",            label: "ユニ<br>2",      width: 30, align: "center", editor: { type: "text",   map_to: "unit2" } },
        { name: "dash",             label: "-",              width: 25, align: "center", template: (task) => task.hyphen ?? "-", editor: { type: "text", map_to: "hyphen" } },
        { name: "characteristic",   label: "特性",           width: 30, align: "center", editor: { type: "text",   map_to: "characteristic" } },
        { name: "derivation",       label: "派生",           width: 30, align: "center", editor: { type: "text",   map_to: "derivation" } },
        { name: "owner",            label: "担当",           width: 30, align: "center", editor: { type: "owner_select", map_to: "owner" } },
        { name: "total_sheets",     label: "総<br>枚数",     width: 30, align: "center", editor: { type: "number", map_to: "total_sheets",     min: 0 } },
        { name: "completed_sheets", label: "完了<br>枚数",   width: 30, align: "center", editor: { type: "number", map_to: "completed_sheets", min: 0 } },
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
        { name: "text",       label: "品名",           width: 103, tree: true,      editor: { type: "text",   map_to: "text" } },
        { name: "part_number", label: "型式・図番",     width: 85,  align: "left", editor: { type: "text",   map_to: "part_number" } },
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

// 列設定の初期化
gantt.config.columns = _getDrawingColumns();

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

// 列セット切り替え
function switchColumns(filterType) {
    let cols;
    if (filterType === 'long_lead_item') cols = _getLongtermColumns();
    else if (filterType === 'business_trip' || filterType === 'planning') cols = _getTripColumns();
    else cols = _getDrawingColumns();
    gantt.config.columns = cols;
    _setLayout(_getColsSum(cols));
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

// フィルタリング（is_detailedのみ表示、かつ工事番号フィルタ）
gantt.attachEvent("onBeforeTaskDisplay", function(id, task) {
    // is_detailed が TRUE または "TRUE" のもののみ表示
    const isDetailed = (task.is_detailed === true || String(task.is_detailed).toUpperCase() === 'TRUE');
    if (!isDetailed) return false;

    // 工事番号フィルタ
    if (currentProjectFilter.length > 0) {
        if (!currentProjectFilter.includes(String(task.project_number))) return false;
    }

    // task_typeフィルタ
    if (currentTaskTypeFilter) {
        if (String(task.task_type) !== currentTaskTypeFilter) return false;
    }

    // 担当者フィルタ（複数選択対応）
    if (currentOwnerFilter.length > 0) {
        const taskOwners = String(task.owner || '').split(/[,、\s]+/).map(o => o.trim());
        if (!currentOwnerFilter.some(f => taskOwners.includes(f))) return false;
    }

    return true;
});

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

// ---- アーカイブ機能 ----
let _archiveCopySrc = null;

function toggleArchiveMenu(e) {
    e.stopPropagation();
    document.getElementById('archive_dropdown_menu').classList.toggle('open');
}

async function openArchiveManager() {
    document.getElementById('archive_dropdown_menu').classList.remove('open');
    const { data, error } = await supabaseClient
        .from('tasks')
        .select('project_number, customer_name, project_details, is_detailed')
        .neq('is_archived', true);
    if (error) { alert('読み込みエラー: ' + error.message); return; }

    // is_detailed=trueが存在する工事番号のセット
    const detailedProjects = new Set();
    (data || []).forEach(t => { if (t.project_number && t.is_detailed) detailedProjects.add(t.project_number); });

    // 全タスクから顧客名・工事概要を収集（is_detailedのある工事番号のみ）
    const map = new Map();
    (data || []).forEach(t => {
        if (t.project_number && detailedProjects.has(t.project_number)) {
            const existing = map.get(t.project_number);
            const customer = t.customer_name || (existing ? existing.customer : '');
            const details = t.project_details || (existing ? existing.details : '');
            map.set(t.project_number, { customer, details });
        }
    });
    const rows = Array.from(map.entries()).sort((a, b) => String(a[0]).localeCompare(String(b[0])));
    const tableDiv = document.getElementById('archive_manager_table');
    if (rows.length === 0) {
        tableDiv.innerHTML = '<div style="padding:20px; text-align:center; color:#888;">現役の工事番号がありません</div>';
    } else {
        tableDiv.innerHTML = `<table>
            <thead><tr><th>工事番号</th><th>顧客名</th><th>工事概要</th><th>操作</th></tr></thead>
            <tbody>${rows.map(([num, info]) => `
                <tr>
                    <td>${num}</td>
                    <td>${info.customer}</td>
                    <td>${info.details}</td>
                    <td><button class="btn" style="font-size:11px;padding:2px 8px;" onclick="archiveProject('${num}')">アーカイブへ</button></td>
                </tr>`).join('')}
            </tbody></table>`;
    }
    document.getElementById('archive_manager_overlay').classList.add('open');
}

function closeArchiveManager() {
    document.getElementById('archive_manager_overlay').classList.remove('open');
}

async function archiveProject(projectNumber) {
    if (!confirm(`「${projectNumber}」をアーカイブに移動しますか？\n（アーカイブ一覧から復元・コピーできます）`)) return;
    const today = new Date().toISOString().split('T')[0];
    const { error } = await supabaseClient
        .from('tasks')
        .update({ is_archived: true, archived_at: today })
        .eq('project_number', projectNumber)
        .eq('is_detailed', true);
    if (error) { alert('エラー: ' + error.message); return; }
    closeArchiveManager();
    await loadData();
    await initProjectSelect(null);
}

async function openArchiveList() {
    document.getElementById('archive_dropdown_menu').classList.remove('open');
    const tableDiv = document.getElementById('archive_list_table');
    tableDiv.innerHTML = '<div style="padding:20px;text-align:center;color:#888;">読み込み中...</div>';

    const { data, error } = await supabaseClient
        .from('tasks')
        .select('project_number, customer_name, project_details, archived_at, is_detailed')
        .eq('is_archived', true);
    if (error) { alert('読み込みエラー: ' + error.message); return; }

    const detailedProjects = new Set();
    (data || []).forEach(t => { if (t.project_number && t.is_detailed) detailedProjects.add(t.project_number); });

    const map = new Map();
    (data || []).forEach(t => {
        if (t.project_number && detailedProjects.has(t.project_number)) {
            const existing = map.get(t.project_number);
            const customer = t.customer_name || (existing ? existing.customer : '');
            const details = t.project_details || (existing ? existing.details : '');
            const archived_at = t.archived_at || (existing ? existing.archived_at : '');
            map.set(t.project_number, { customer, details, archived_at });
        }
    });
    const rows = Array.from(map.entries()).sort((a, b) => String(a[0]).localeCompare(String(b[0])));
    if (rows.length === 0) {
        tableDiv.innerHTML = '<div style="padding:20px;text-align:center;color:#888;">アーカイブされた工事はありません</div>';
    } else {
        tableDiv.innerHTML = `<table>
            <thead><tr><th>工事番号</th><th>顧客名</th><th>工事概要</th><th>アーカイブ日</th><th>操作</th></tr></thead>
            <tbody>${rows.map(([num, info]) => `
                <tr>
                    <td>${num}</td>
                    <td>${info.customer}</td>
                    <td>${info.details}</td>
                    <td>${info.archived_at}</td>
                    <td style="white-space:nowrap;">
                        <button class="btn" style="font-size:11px;padding:2px 8px;" onclick="openArchiveDetail('${num}')">詳細</button>
                        <button class="btn" style="font-size:11px;padding:2px 8px;margin-left:4px;" onclick="restoreProject('${num}')">戻す</button>
                    </td>
                </tr>`).join('')}
            </tbody></table>`;
    }
    document.getElementById('archive_list_overlay').classList.add('open');
}

function closeArchiveList() {
    document.getElementById('archive_list_overlay').classList.remove('open');
}

let _archiveDetailProjectNumber = null;
let _archiveDetailTaskType = 'drawing';

async function openArchiveDetail(projectNumber) {
    _archiveDetailProjectNumber = projectNumber;
    _archiveDetailTaskType = currentTaskTypeFilter || 'drawing';
    document.getElementById('archive_detail_title').textContent = `${projectNumber} のタスク一覧`;
    document.getElementById('archive_detail_overlay').classList.add('open');
    await _loadArchiveDetailTable();
}

function switchArchiveDetailTab(taskType) {
    _archiveDetailTaskType = taskType;
    _loadArchiveDetailTable();
}

async function _loadArchiveDetailTable() {
    const typeFilter = _archiveDetailTaskType;
    ['drawing', 'long_lead_item', 'business_trip', 'planning'].forEach(t => {
        const btn = document.getElementById('dtab_' + t);
        if (btn) btn.classList.toggle('active', t === typeFilter);
    });

    const tableDiv = document.getElementById('archive_detail_table');
    tableDiv.innerHTML = '<div style="padding:20px;text-align:center;color:#888;">読み込み中...</div>';

    const { data, error } = await supabaseClient
        .from('tasks')
        .select('*')
        .eq('project_number', _archiveDetailProjectNumber)
        .eq('is_archived', true)
        .eq('is_detailed', true)
        .eq('task_type', typeFilter)
        .order('sort_order', { ascending: true });
    if (error) { alert('読み込みエラー: ' + error.message); return; }

    if (!data || data.length === 0) {
        tableDiv.innerHTML = '<div style="padding:20px;text-align:center;color:#888;">このモードのタスクはありません</div>';
    } else {
        tableDiv.innerHTML = `<table>
            <thead><tr>
                <th>タスク名</th><th>機械</th><th>ユニット</th>
                <th>担当</th><th>開始日</th><th>完了予定日</th><th>状態</th>
            </tr></thead>
            <tbody>${data.map(t => `
                <tr>
                    <td>${t.text || ''}</td>
                    <td>${t.machine || ''}</td>
                    <td>${t.unit || ''}</td>
                    <td>${t.owner || ''}</td>
                    <td>${t.start_date ? t.start_date.substring(0,10) : ''}</td>
                    <td>${t.end_date ? t.end_date.substring(0,10) : ''}</td>
                    <td>${t.status || ''}</td>
                </tr>`).join('')}
            </tbody></table>`;
    }
}

function closeArchiveDetail() {
    document.getElementById('archive_detail_overlay').classList.remove('open');
}

function openArchiveCopyFromDetail() {
    openArchiveCopy(_archiveDetailProjectNumber);
}

async function restoreProject(projectNumber) {
    if (!confirm(`「${projectNumber}」を現役に戻しますか？`)) return;
    const { error } = await supabaseClient
        .from('tasks')
        .update({ is_archived: false, archived_at: null })
        .eq('project_number', projectNumber)
        .eq('is_detailed', true);
    if (error) { alert('エラー: ' + error.message); return; }
    closeArchiveList();
    await loadData();
    await initProjectSelect(null);
}

function openArchiveCopy(projectNumber) {
    _archiveCopySrc = projectNumber;
    document.getElementById('archive_copy_src').textContent = projectNumber;
    document.getElementById('archive_copy_input').value = '';
    document.getElementById('archive_copy_overlay').classList.add('open');
}

function closeArchiveCopy() {
    document.getElementById('archive_copy_overlay').classList.remove('open');
    _archiveCopySrc = null;
}

async function executeArchiveCopy() {
    const newNum = document.getElementById('archive_copy_input').value.trim();
    if (!newNum) { alert('工事番号を入力してください'); return; }
    if (!_archiveCopySrc) return;

    const { data, error } = await supabaseClient
        .from('tasks')
        .select('*')
        .eq('project_number', _archiveCopySrc)
        .eq('is_archived', true)
        .eq('is_detailed', true)
        .eq('task_type', _archiveDetailTaskType);
    if (error || !data || data.length === 0) { alert('コピー元データの取得に失敗しました'); return; }

    const srcNum = _archiveCopySrc;
    const copies = data.map(t => {
        const copy = { ...t };
        delete copy.id;
        copy.project_number = newNum;
        copy.is_archived = false;
        copy.archived_at = null;
        return copy;
    });

    const { error: insertError } = await supabaseClient.from('tasks').insert(copies);
    if (insertError) { alert('コピーに失敗しました: ' + insertError.message); return; }

    closeArchiveCopy();
    closeArchiveList();
    await loadData();
    await initProjectSelect(null);
    alert(`「${srcNum}」を「${newNum}」としてコピーしました`);
}

// 実行
initialize();
