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

// タスクタイプ別のバッジの色（担当者のバーよりさらに薄い地の色。文字はどれも同じ濃いグレー）
const TASK_TYPE_COLORS = {
    planning:       { bg: '#e9f0fa', color: '#3e4c59' }, // 計画：青
    drawing:        { bg: '#e7f5ec', color: '#3e4c59' }, // 図面：緑
    long_lead_item: { bg: '#fdf0e2', color: '#3e4c59' }, // 長納期品：オレンジ
    business_trip:  { bg: '#f1ebf8', color: '#3e4c59' }, // 出張：紫
};

// ===== 新デザイン：期限切れ・期日超過 =====
let _resourceOnly = null; // null=すべて / 'late'=期限切れのみ / 'wish'=期日超過のみ
const _ICON_LATE = '<svg class="mark-late" width="15" height="15" viewBox="0 0 16 16"><path d="M8 1.5 15 14H1z" fill="#1f2933" stroke="#1f2933" stroke-width="1" stroke-linejoin="round"/><rect x="7.2" y="5.5" width="1.6" height="4.6" rx="0.8" fill="#fff"/><circle cx="8" cy="12" r="0.95" fill="#fff"/></svg>';
const _ICON_WISH = '<svg class="mark-wish" width="14" height="14" viewBox="0 0 16 16"><rect x="2.5" y="1.5" width="1.6" height="13" rx="0.8" fill="#1f2933"/><path d="M4 2h9l-2.2 3.2L13 8.5H4z" fill="#1f2933"/></svg>';
function _resTodayStart() { const d = new Date(); d.setHours(0, 0, 0, 0); return d; }
function _resIsDone(t) { return typeof _isCompletedForDisplay === 'function' ? _isCompletedForDisplay(t) : false; }
/** 期限切れ：完了予定日を過ぎて未完了（計画・出張は対象外）。end_date は完了予定日の翌日0時 */
function _resIsLate(t) {
    const tt = String(t.task_type);
    if (tt === 'planning' || tt === 'business_trip') return false;
    if (_resIsDone(t) || t.has_no_date || !t.end_date) return false;
    return new Date(t.end_date) < _resTodayStart();
}
function _resWishDate(t) {
    if (!t.wish_date) return null;
    const p = String(t.wish_date).split('-');
    if (p.length !== 3) return null;
    return new Date(+p[0], +p[1] - 1, +p[2]);
}
/** 期日超過：出図希望日（図面）・手配期日（長納期品）を過ぎて未完了 */
function _resIsWish(t) {
    const tt = String(t.task_type);
    if (tt !== 'drawing' && tt !== 'long_lead_item') return false;
    if (_resIsDone(t)) return false;
    const w = _resWishDate(t);
    return !!w && w < _resTodayStart();
}
function _resAlertChip(ownerName, kind, n) {
    const icon = kind === 'late' ? _ICON_LATE : _ICON_WISH;
    const label = kind === 'late' ? '期限切れ' : '期日超過';
    return `<span class="res-alert-chip" onclick="event.stopPropagation(); showOwnerDetail('${ownerName}', '${kind}')" title="押すと該当タスクだけ表示">${icon}<span>${label}</span><b>${n}件</b></span>`;
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

function _getActiveGanttZoomLevel() {
    return document.getElementById('zoom_week_btn')?.classList.contains('active') ? 'week' : 'day';
}

/**
 * メインガントのタイムライン日付ヘッダーは setSizes だけでは再描画されず空になることがある。
 * ズームの再適用でセルを描き直す。withScrollNudge が true のときは微小横スクロールも行う（toggleResourceView と同じ）。
 * @param {boolean} [withScrollNudge=true]
 */
function _refreshMainGanttTimelineScale(withScrollNudge) {
    if (!window.gantt) return;
    if (typeof isResourceFullscreen !== 'undefined' && isResourceFullscreen) return;
    const ge = document.getElementById('gantt_here');
    if (!ge || ge.style.display === 'none') return;
    if (withScrollNudge === undefined) withScrollNudge = true;

    // クラスで制御：zoom.setLevel() でDOMが再構築されても親要素のクラスは維持される
    ge.classList.add('gantt-scale-hiding');

    gantt.setSizes();
    if (gantt.ext && gantt.ext.zoom) {
        gantt.ext.zoom.setLevel(_getActiveGanttZoomLevel());
    }

    // 2フレーム待機してDOM再構築を完全に終えてから表示を戻す
    requestAnimationFrame(() => {
        requestAnimationFrame(() => {
            if (!window.gantt) return;
            ge.classList.remove('gantt-scale-hiding');
            if (!withScrollNudge) return;
            const s = gantt.getScrollState();
            gantt.scrollTo(s.x + 1, s.y);
            requestAnimationFrame(() => {
                if (!window.gantt) return;
                gantt.scrollTo(s.x, s.y);
            });
        });
    });
}

/** 他タブ・他画面から戻った直後はレイアウト確定前に setSizes すると日付ヘッダーが空のまま残るため、2 フレーム後に再描画する */
function _scheduleRefreshMainGanttAfterShow() {
    requestAnimationFrame(function () {
        requestAnimationFrame(function () {
            _refreshMainGanttTimelineScale(true);
        });
    });
}

document.addEventListener('visibilitychange', function () {
    if (document.visibilityState !== 'visible') return;
    _scheduleRefreshMainGanttAfterShow();
});

window.addEventListener('pageshow', function (ev) {
    if (ev.persisted) _scheduleRefreshMainGanttAfterShow();
});

// リサイズ機能
(function() {
    let isResizing = false;
    let animationFrameId = null;
    /** flex 確定後に setSizes するため 2 フレーム遅延（同一フレームだと高さ 0 扱いで日付が消えることがある） */
    let ganttSizeRaf1 = null;
    let ganttSizeRaf2 = null;
    const minHeight = 50;
    const maxHeight = 800;

    function _cancelPendingGanttSizeRaf() {
        if (ganttSizeRaf1 != null) {
            cancelAnimationFrame(ganttSizeRaf1);
            ganttSizeRaf1 = null;
        }
        if (ganttSizeRaf2 != null) {
            cancelAnimationFrame(ganttSizeRaf2);
            ganttSizeRaf2 = null;
        }
    }

    /** 連続呼び出しは 1 サイクルにまとめる（第 2 rAF は直前の予約を差し替え） */
    function _queueGanttSetSizesAfterFlexTwoFrames(requireResizing) {
        if (!window.gantt) return;
        if (typeof isResourceFullscreen !== 'undefined' && isResourceFullscreen) return;
        const ge = document.getElementById('gantt_here');
        if (ge && ge.style.display === 'none') return;
        if (ganttSizeRaf1 != null) return;
        ganttSizeRaf1 = requestAnimationFrame(() => {
            ganttSizeRaf1 = null;
            if (ganttSizeRaf2 != null) cancelAnimationFrame(ganttSizeRaf2);
            ganttSizeRaf2 = requestAnimationFrame(() => {
                ganttSizeRaf2 = null;
                if (!window.gantt) return;
                if (typeof isResourceFullscreen !== 'undefined' && isResourceFullscreen) return;
                if (requireResizing && !isResizing) return;
                const el = document.getElementById('gantt_here');
                if (el && el.style.display === 'none') return;
                // ドラッグ中は横の微スクロールを省略（画面の揺れ防止）。ズーム再適用で日付を復元する。
                _refreshMainGanttTimelineScale(!requireResizing);
            });
        });
    }

    window.addEventListener('DOMContentLoaded', () => {
        const resizer = document.getElementById('resource_resizer');
        const panel = document.getElementById('resource_panel');
        const ganttHost = document.getElementById('gantt_host');

        if (!resizer || !panel) return;

        resizer.setAttribute('title', 'メイン工程表とリソース表示の境界の高さを変更');

        // メインガント領域の flex 高さが変わったときに DHTMLX のレイアウトを追従
        if (ganttHost && window.ResizeObserver) {
            const ro = new ResizeObserver(() => {
                if (isResizing) return; // ドラッグ中は mousemove 側で setSizes（二重適用を避ける）
                if (!window.gantt) return;
                if (typeof isResourceFullscreen !== 'undefined' && isResourceFullscreen) return;
                const ge = document.getElementById('gantt_here');
                if (ge && ge.style.display === 'none') return;
                _queueGanttSetSizesAfterFlexTwoFrames(false);
            });
            ro.observe(ganttHost);
        }

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
                // ガントのカレンダーヘッダー（scale_height=60px）＋横スクロール＋最低1行分を常に確保
                const headerEl = document.querySelector('.header-panel');
                const headerH = headerEl ? headerEl.offsetHeight : 100;
                // グリッドヘッダー + タイムラインスケール(60) + 横スクロール + 最低1データ行
                const minGanttBody = 180; // .gantt-host の min-height と揃える
                const maxByGantt = windowHeight - headerH - minGanttBody;
                if (newHeight > maxByGantt) newHeight = maxByGantt;

                panel.style.height = newHeight + 'px';
                _queueGanttSetSizesAfterFlexTwoFrames(true);

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
                _cancelPendingGanttSizeRaf();
                if (window.gantt) {
                    requestAnimationFrame(() => {
                        requestAnimationFrame(() => {
                            _refreshMainGanttTimelineScale(true);
                        });
                    });
                }
            }
        });
    });
})();

// リソース表示の列幅定数（担当者名 / 詳細タスク名）
const RESOURCE_OVERVIEW_COL_WIDTH = 300;  // 担当者名列
// 担当別モード（全画面）で、期間が重なるバーを段に分けて表示する（false にすると元の1行表示に戻る）
const RESOURCE_STACK_LANES = true;
const RESOURCE_LANE_HEIGHT = 24; // 1段の高さ（バー22px＋すき間2px）
const RESOURCE_MAX_LANES = 10;   // 種別ごとの段数の上限（入りきらないバーは描かず「+N件」で知らせる）

/** 段の上限があるときの優先順位：0=開始日が今日以降、1=今日をまたいで進行中、2=終わったもの、3=完了済み（日付に関係なく一番後回し） */
function _resLanePriority(t, today) {
    if (_resIsDone(t)) return 3;
    if (t.start_date >= today) return 0;
    if (t.end_date > today) return 1;
    return 2;
}

/** 重ならないように段を割り当てる：優先順位の高い順（同じ順位の中は開始日順）に、上の段から空いている所に入れる。
 *  上限の段数に入りきらないのは優先順位の低いタスク（＝先に終わったもの）になる。
 *  戻り値 { lanes: 段数, laneOf: Map(task→段番号), hidden: 上限で入りきらなかったタスク } */
function _resAssignLanes(tasks) {
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const sorted = tasks.slice().sort((a, b) =>
        _resLanePriority(a, today) - _resLanePriority(b, today) || a.start_date - b.start_date || b.end_date - a.end_date);
    const lanes = []; // 各段に置いたバーの期間 [{s, e}]
    const laneOf = new Map();
    const hidden = [];
    const fits = (lane, t) => lane.every(r => r.e <= t.start_date || t.end_date <= r.s);
    sorted.forEach(t => {
        let idx = lanes.findIndex(lane => fits(lane, t));
        if (idx === -1) {
            if (lanes.length >= RESOURCE_MAX_LANES) { hidden.push(t); return; }
            idx = lanes.length; lanes.push([]);
        }
        lanes[idx].push({ s: t.start_date, e: t.end_date });
        laneOf.set(t, idx);
    });
    return { lanes: Math.max(1, lanes.length), laneOf, hidden };
}
const RESOURCE_DETAIL_COL_WIDTH   = 350;  // 詳細表示（工事番号＋タスク名列）
/** バーを描くか：日付なし、または開始日なしで完了予定日が過ぎている（終わりが始まりより前の）タスクは描かない。
 *  開始日なしのタスクは開始日が「今日」で読み込まれるため、描くと今日の列に細い縦線が出てしまう */
function _resHasBar(t) {
    return !t.has_no_date && !!t.start_date && !!t.end_date && t.end_date > t.start_date;
}
let _resDetailColWidth = RESOURCE_DETAIL_COL_WIDTH; // 担当別（全画面）の詳細表示で、タスク名が全部見える幅

// ===== 個人の詳細表示：並び替え・絞り込み =====
const _RES_TYPE_ORDER = { planning: 0, drawing: 1, long_lead_item: 2, business_trip: 3 };
const _RES_TYPE_LABEL = { planning: '計画', drawing: '図面', long_lead_item: '長納期品', business_trip: '出張' };
const _resNumCmp = (a, b) => a.localeCompare(b, 'ja', { numeric: true });
/** 空欄は並び替えで常に最後（昇順・降順どちらでも下）にしたいので、ここでは最大扱い */
const _resBlankLast = (va, vb, cmp) => (va === '' && vb === '') ? 0 : va === '' ? 1 : vb === '' ? -1 : cmp(va, vb);

/** 列の定義：value=絞り込みに使う値、label=選択肢の表示、compare=並び替え */
const _RES_DETAIL_COLS = {
    type: { title: '種別', value: t => String(t.task_type || ''), label: v => _RES_TYPE_LABEL[v] || v || '（空欄）',
            compare: (a, b) => (_RES_TYPE_ORDER[a.task_type] ?? 99) - (_RES_TYPE_ORDER[b.task_type] ?? 99),
            optOrder: (a, b) => (_RES_TYPE_ORDER[a] ?? 99) - (_RES_TYPE_ORDER[b] ?? 99) },
    pj:   { title: '工番', value: t => String(t.project_number || '').trim(), label: v => v || '（空欄）',
            compare: (a, b) => _resBlankLast(String(a.project_number || '').trim(), String(b.project_number || '').trim(), _resNumCmp) },
    mach: { title: '機械', value: t => String(t.machine || '').trim(), label: v => v || '（空欄）',
            compare: (a, b) => _resBlankLast(String(a.machine || '').trim(), String(b.machine || '').trim(), _resNumCmp) },
    unit: { title: 'ユニ', value: t => String(t.unit || '').trim(), label: v => v || '（空欄）',
            compare: (a, b) => _resBlankLast(String(a.unit || '').trim(), String(b.unit || '').trim(), _resNumCmp) },
};

/** 開始日順（同じ開始日は終了日順、開始日のない・バーを描かないタスクは一番下） */
function _resCompareStart(a, b) {
    const ha = _resHasBar(a), hb = _resHasBar(b);
    if (ha !== hb) return ha ? -1 : 1;
    if (!ha) return 0;
    return (a.start_date - b.start_date) || (a.end_date - b.end_date);
}

// 並び替え（sortKey=null は開始日順、sortDir 1=昇順 -1=降順）と絞り込み（列ごとに選んだ値の Set。null は絞り込みなし）
let _resDetailView = { owner: null, sortKey: null, sortDir: 1, filters: {}, options: {}, cols: null };
function _resetResDetailView(owner) {
    _resDetailView = { owner, sortKey: null, sortDir: 1, filters: {}, options: {}, cols: null };
}

/** 絞り込みの選択肢（列ごとの値の一覧） */
function _resDetailOptions(tasks) {
    const opts = {};
    Object.keys(_RES_DETAIL_COLS).forEach(k => {
        const col = _RES_DETAIL_COLS[k];
        if (col.noFilter) return;
        const vals = [...new Set(tasks.map(col.value))];
        vals.sort(col.optOrder || ((a, b) => _resBlankLast(a, b, _resNumCmp)));
        opts[k] = vals;
    });
    return opts;
}

/** 並び替えを決める（key=null は開始日順に戻す、dir 1=昇順 -1=降順） */
function setResDetailSort(key, dir) {
    _resDetailView.sortKey = key;
    _resDetailView.sortDir = dir || 1;
    closeResDetailFilter();
    if (_resourceDetailOwner) renderOwnerDetailTimeline(_resourceDetailOwner);
}

const RES_DETAIL_TYPE_W = 72; // 種別の列幅（見出し「種別」＋並び替えの矢印＋ボタンが入る幅）

/** 担当別の詳細表示の見出し（カレンダーの左上に重ねる）。見出しのボタンで、並び替え・絞り込みのメニューを開く */
function _resDetailHeaderHtml(gridWidth) {
    const c = _resDetailView.cols;
    if (!c) return '';
    const cell = (key, width, extra) => {
        const col = _RES_DETAIL_COLS[key];
        const sorted = _resDetailView.sortKey === key;
        const arrow = sorted ? (_resDetailView.sortDir === 1 ? '▲' : '▼') : '';
        const filtered = !!_resDetailView.filters[key];
        const tip = col.noFilter ? '並び替え' : '並び替え・絞り込み';
        return `<div class="res-dh-cell" style="${width ? `width:${width}px;flex-shrink:0;` : 'flex:1;min-width:0;'}${extra || ''}"
                     title="${tip}" onclick="openResDetailFilter('${key}', this.querySelector('.res-dh-btn'))">
                    <span class="res-dh-label">${col.title}</span><span class="res-dh-arrow">${arrow}</span>
                    <button type="button" class="res-dh-btn${filtered ? ' active' : ''}" onclick="event.stopPropagation();openResDetailFilter('${key}', this)"></button>
                </div>`;
    };
    // 種別・工番・機械・ユニは中央寄せ（下の行の値も中央寄せ）。タスク名は並び替え・絞り込みなし
    return `<div class="res-detail-head" style="width:${gridWidth}px;">
        ${cell('type', RES_DETAIL_TYPE_W)}
        ${cell('pj', c.pj, 'justify-content:center;')}
        ${cell('mach', c.mach, 'justify-content:center;')}
        ${cell('unit', c.unit, 'justify-content:center;')}
        <div style="width:34px;flex-shrink:0;"></div>
        <div class="res-dh-cell res-dh-plain" style="flex:1;min-width:0;"><span class="res-dh-label">タスク名</span></div>
    </div>`;
}

/** 並び替え・絞り込みのメニューを開く（図面モードなどの列フィルターと同じ形：上に昇順・降順、下にチェックボックス） */
function openResDetailFilter(key, anchor) {
    const open = document.getElementById('res_detail_filter_pop');
    if (open && open.dataset.key === key) { closeResDetailFilter(); return; } // 同じボタンをもう一度押したら閉じる
    closeResDetailFilter();
    const col = _RES_DETAIL_COLS[key];
    const v = _resDetailView;
    const vals = v.options[key] || [];
    const sel = v.filters[key];
    const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
    const mark = dir => (v.sortKey === key && v.sortDir === dir) ? '<span class="res-dfp-check">✓</span>' : '';
    const pop = document.createElement('div');
    pop.id = 'res_detail_filter_pop';
    pop.dataset.key = key;
    pop.className = 'col-filter-dropdown';
    pop.innerHTML = `
        <div class="col-filter-sort-row" onclick="setResDetailSort('${key}', 1)"><span class="col-filter-sort-icon">A↓</span>昇順${mark(1)}</div>
        <div class="col-filter-sort-row" onclick="setResDetailSort('${key}', -1)"><span class="col-filter-sort-icon">Z↓</span>降順${mark(-1)}</div>
        ${v.sortKey === key ? `<div class="col-filter-sort-row" onclick="setResDetailSort(null)"><span class="col-filter-sort-icon">⟲</span>開始日順に戻す</div>` : ''}
        ${col.noFilter ? '' : `
        <div class="col-filter-dropdown-sep"></div>
        <label><input type="checkbox" data-all="1" ${!sel ? 'checked' : ''}> 全選択</label>
        <div class="col-filter-dropdown-sep"></div>
        <div class="col-filter-dropdown-list">
            ${vals.map((val, i) => `<label><input type="checkbox" data-i="${i}" ${!sel || sel.has(val) ? 'checked' : ''}> ${esc(col.label(val))}</label>`).join('')}
        </div>`}`;
    document.body.appendChild(pop);
    const r = anchor.getBoundingClientRect();
    pop.style.left = Math.max(8, Math.min(r.left, window.innerWidth - pop.offsetWidth - 8)) + 'px';
    pop.style.top = (r.bottom + 4) + 'px';

    if (!col.noFilter) {
        const items = [...pop.querySelectorAll('input[data-i]')];
        const allChk = pop.querySelector('input[data-all]');
        pop.addEventListener('change', e => {
            if (e.target === allChk) items.forEach(x => { x.checked = allChk.checked; });
            else allChk.checked = items.every(x => x.checked);
            const checked = items.filter(x => x.checked).map(x => vals[+x.dataset.i]);
            v.filters[key] = checked.length === vals.length ? null : new Set(checked);
            if (_resourceDetailOwner) renderOwnerDetailTimeline(_resourceDetailOwner);
        });
    }
    setTimeout(() => document.addEventListener('mousedown', _resDetailFilterOutside), 0);
    document.addEventListener('keydown', _resDetailFilterEsc);
}
/** Esc キーでメニューを閉じる */
function _resDetailFilterEsc(e) {
    if (e.key === 'Escape') closeResDetailFilter();
}
function _resDetailFilterOutside(e) {
    const pop = document.getElementById('res_detail_filter_pop');
    if (!pop || pop.contains(e.target)) return;
    if (e.target.closest && e.target.closest('.res-dh-cell')) return; // 見出しのボタンは openResDetailFilter 側で開閉する
    closeResDetailFilter();
}
function closeResDetailFilter() {
    const pop = document.getElementById('res_detail_filter_pop');
    if (pop) pop.remove();
    document.removeEventListener('mousedown', _resDetailFilterOutside);
    document.removeEventListener('keydown', _resDetailFilterEsc);
}

/** 詳細表示の列幅（工事番号・機械・ユニット）を、中身の文字が全部見える幅で測る。行ごとに列の位置がそろうよう固定幅にする。
 *  見出し（工番・機械・ユニ＋並び替えの矢印＋絞り込みの▾）が入る幅を下限にする */
function _calcResDetailCols(tasks) {
    const cols = { pj: 72, mach: 72, unit: 72, text: 0 };
    try {
        const cv = _calcResDetailCols._cv || (_calcResDetailCols._cv = document.createElement('canvas'));
        const ctx = cv.getContext('2d');
        ctx.font = '13px ' + getComputedStyle(document.body).fontFamily;
        tasks.forEach(t => {
            cols.pj   = Math.max(cols.pj,   ctx.measureText(String(t.project_number || '-')).width);
            cols.mach = Math.max(cols.mach, ctx.measureText(String(t.machine || '').trim()).width);
            cols.unit = Math.max(cols.unit, ctx.measureText(String(t.unit || '').trim()).width);
            cols.text = Math.max(cols.text, ctx.measureText(String(t.text || '')).width);
        });
    } catch (e) { /* 測れないときは最小幅のまま */ }
    cols.pj = Math.ceil(cols.pj); cols.mach = Math.ceil(cols.mach); cols.unit = Math.ceil(cols.unit); cols.text = Math.ceil(cols.text);
    return cols;
}

/** 担当別（全画面）の詳細表示：タスク名が全部見えるグリッド幅を計算する（下限350・画面幅−200pxで頭打ち） */
function _calcResDetailColWidth(tasks) {
    const c = _calcResDetailCols(tasks);
    // 左右余白12 + バッジ52 + 工番 + 機械 + ユニット + マーク34 + 間隔8×5 + 名前 + 余裕16
    const need = 12 + RES_DETAIL_TYPE_W + c.pj + c.mach + c.unit + 34 + 40 + c.text + 16;
    return Math.max(RESOURCE_DETAIL_COL_WIDTH, Math.min(need, window.innerWidth - 200));
}

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

    const gridBackground = `repeating-linear-gradient(to right, transparent, transparent ${columnWidth - 1}px, #eef0f3 ${columnWidth - 1}px, #eef0f3 ${columnWidth}px), repeating-linear-gradient(to bottom, transparent, transparent 29px, #eef0f3 29px, #eef0f3 30px)`;
    
    let weekendBackgroundHtml = "";
    if (gantt.getState().scale_unit === "day") {
        scale.trace_x.forEach((date, i) => {
            if (date.getDay() === 0 || date.getDay() === 6 || _isHoliday(date)) {
                weekendBackgroundHtml += `<div style="position: absolute; top: 0; bottom: 0; left: ${i * columnWidth}px; width: ${columnWidth}px; background: #eaecef; z-index: 0;"></div>`;
            }
            // 今日の列は薄い紫（ほかのモードと同じ）
            if (typeof _isTodayDate === 'function' && _isTodayDate(date)) {
                weekendBackgroundHtml += `<div style="position: absolute; top: 0; bottom: 0; left: ${i * columnWidth}px; width: ${columnWidth}px; background: #f1edfd; z-index: 0;"></div>`;
            }
            // 週の境目（月曜の左端）に線（ほかのモードと同じ色）
            if (date.getDay() === 1) {
                weekendBackgroundHtml += `<div style="position: absolute; top: 0; bottom: 0; left: ${i * columnWidth}px; width: 1px; background: #cbd2d9; z-index: 0;"></div>`;
            }
        });
    }
    
    const backgroundStyle = `background-image: ${gridBackground}; background-position: ${-firstPos}px 0; background-size: ${columnWidth}px 30px; height: 100%;`;
    const _today0 = new Date(); _today0.setHours(0, 0, 0, 0);
    const todayPos = gantt.posFromDate(_today0); // 今日のセルの左端
    const todayLineLeft = actualGridWidth + todayPos;

    let html = `<div style="width: ${totalWidth}px; position: relative;">`; // 全体の幅を指定するコンテナを追加
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
        const textColor = "inherit";

        const _alerts = [];
        const _nLate = allOwnerTasks.filter(_resIsLate).length, _nWish = allOwnerTasks.filter(_resIsWish).length;
        if (_nLate) _alerts.push(['late', _nLate]);
        if (_nWish) _alerts.push(['wish', _nWish]);

        // 4行（タスク種別ごと）を描画
        TASK_TYPE_ROWS.forEach((rowDef, rowIndex) => {
            const rowTasks = allOwnerTasks.filter(t => String(t.task_type) === rowDef.type);
            // 段分け（担当別モードのみ）
            const stack = RESOURCE_STACK_LANES && isResourceFullscreen;
            const laneInfo = stack ? _resAssignLanes(rowTasks.filter(_resHasBar)) : null;
            const rowHeight = stack ? Math.max(30, laneInfo.lanes * RESOURCE_LANE_HEIGHT + 6) : 30;
            const isFirstRow = rowIndex === 0;
            const isLastRow  = rowIndex === TASK_TYPE_ROWS.length - 1;

            // 担当者の区切り線（先頭行の上に太線）
            const borderTop    = isFirstRow ? 'border-top: 1px solid #9aa5b1;' : '';
            const borderBottom = isLastRow  ? 'border-bottom: 1px solid #9aa5b1;' : 'border-bottom: 1px solid #eef0f3;';

            // 左セル：先頭行は担当者名＋ラベル、2行目以降はラベルのみ
            const typeClr = TASK_TYPE_COLORS[rowDef.type] || { bg: '#e0e0e0', color: '#555' };
            const leftCellContent = isFirstRow
                ? (isResourceFullscreen
                    ? `<div style="width:100%;display:flex;align-items:center;justify-content:space-between;padding:0 5px;box-sizing:border-box;">
                           <div style="flex:1;min-width:0;display:flex;align-items:center;gap:10px;">
                               <div style="font-weight:bold;font-size:14px;color:#1f2933;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0;">${ownerName}</div>
                               <span class="res-open-detail" onclick="showOwnerDetail('${ownerName}')" title="${ownerName}さんのタスクを一覧で表示">詳細を開く ›</span>
                           </div>
                           <div style="font-size:12px;color:${typeClr.color};background:${typeClr.bg};border-radius:2px;height:16px;line-height:16px;padding:0 4px;margin-left:3px;white-space:nowrap;font-weight:bold;">${rowDef.label}</div>
                       </div>`
                    : `<div style="width:100%;display:flex;align-items:center;justify-content:flex-end;padding:0 8px 0 5px;box-sizing:border-box;gap:10px;">
                           <div class="resource-owner-link" onclick="showOwnerDetail('${ownerName}')" title="クリックして詳細表示" style="font-weight:bold;font-size:14px;color:#1f2933;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:0 0 110px;width:110px;text-align:left;padding:1px 2px;">${ownerName}</div>
                           <div style="font-size:12px;color:${typeClr.color};background:${typeClr.bg};border-radius:2px;height:16px;line-height:16px;padding:0 4px;white-space:nowrap;font-weight:bold;flex-shrink:0;">${rowDef.label}</div>
                       </div>`)
                : `<div style="width:100%;display:flex;align-items:center;justify-content:space-between;gap:6px;padding:0 5px 0 ${isResourceFullscreen ? 18 : 5}px;box-sizing:border-box;">
                       ${(isResourceFullscreen && _alerts[rowIndex - 1]) ? _resAlertChip(ownerName, _alerts[rowIndex - 1][0], _alerts[rowIndex - 1][1]) : '<span></span>'}
                       <div style="font-size:12px;color:${typeClr.color};background:${typeClr.bg};border-radius:2px;height:16px;line-height:16px;padding:0 4px;white-space:nowrap;font-weight:bold;">${rowDef.label}</div>
                   </div>`;

            html += `
                <div class="resource-item" style="display:flex;${borderTop}${borderBottom}min-height:30px;height:${rowHeight}px;align-items:stretch;width:${totalWidth}px;">
                    <div class="resource-grid-container" style="width:${actualGridWidth}px;min-width:${actualGridWidth}px;flex-shrink:0;display:flex;${stack ? 'align-items:flex-start;' : ''}border-right:1px solid #cbd2d9;background:#fff;position:sticky;left:0;z-index:40;">
                        ${stack ? `<div style="width:100%;display:flex;flex-direction:column;">
                            <div style="height:30px;width:100%;display:flex;">${leftCellContent}</div>
                            ${laneInfo.hidden.length ? `<div style="display:flex;justify-content:flex-end;padding:0 5px;"><span class="resource-owner-link" onclick="showOwnerDetail('${ownerName}', null, '${rowDef.type}')" title="${RESOURCE_MAX_LANES}段に入りきらない${rowDef.label}タスクがあります。クリックで${rowDef.label}だけを詳細表示" style="font-size:11px;font-weight:bold;color:#b42318;background:#fef3f2;border:1px solid #fecdca;border-radius:3px;padding:1px 6px;cursor:pointer;">ほか ${laneInfo.hidden.length}件 ›</span></div>` : ''}
                        </div>` : leftCellContent}
                    </div>
                    <div class="resource-timeline" style="width:${timelineWidth}px;flex-shrink:0;position:relative;background:#fff;">
                        <div style="position:absolute;top:0;left:0;right:0;bottom:0;z-index:0;">${weekendBackgroundHtml}</div>
                        <div style="position:absolute;top:0;left:0;right:0;bottom:0;${backgroundStyle}${stack ? 'background-size:' + columnWidth + 'px ' + rowHeight + 'px;' : ''}z-index:1;"></div>
                        <div style="position:absolute;top:0;left:0;right:0;bottom:0;z-index:2;">
            `;

            rowTasks.forEach(t => {
                if (!_resHasBar(t)) return; // メインの表と同じく、日付なし・幅0のバーは描かない
                if (stack && !laneInfo.laneOf.has(t)) return; // 段の上限で入りきらないバー
                const left  = gantt.posFromDate(t.start_date);
                const right = gantt.posFromDate(t.end_date);
                const width = Math.max(2, right - left);
                const top = stack ? 4 + laneInfo.laneOf.get(t) * RESOURCE_LANE_HEIGHT : 4;
                html += `
                    <div class="resource-cell-bar ${colorClass}${_resIsDone(t) ? ' res-bar-completed' : ''}"
                         style="position:absolute;top:${top}px;height:22px;left:${left}px;width:${width}px;z-index:10;"
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
    html += `<div class="resource-today-line" style="left:${todayLineLeft}px;z-index:30;"></div></div>`; // 全体に1本だけ表示

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
    let actualGridWidth = isResourceFullscreen ? RESOURCE_DETAIL_COL_WIDTH : (_getRenderedGanttGridWidth());
    let totalWidth = actualGridWidth + timelineWidth;
    const firstPos = gantt.posFromDate(scale.trace_x[0]);

    const gridBackground = `repeating-linear-gradient(to right, transparent, transparent ${columnWidth - 1}px, #eef0f3 ${columnWidth - 1}px, #eef0f3 ${columnWidth}px), repeating-linear-gradient(to bottom, transparent, transparent 29px, #eef0f3 29px, #eef0f3 30px)`;

    let weekendBackgroundHtml = "";
    if (gantt.getState().scale_unit === "day") {
        scale.trace_x.forEach((date, i) => {
            if (date.getDay() === 0 || date.getDay() === 6 || _isHoliday(date)) {
                weekendBackgroundHtml += `<div style="position: absolute; top: 0; bottom: 0; left: ${i * columnWidth}px; width: ${columnWidth}px; background: #eaecef; z-index: 0;"></div>`;
            }
            // 今日の列は薄い紫（ほかのモードと同じ）
            if (typeof _isTodayDate === 'function' && _isTodayDate(date)) {
                weekendBackgroundHtml += `<div style="position: absolute; top: 0; bottom: 0; left: ${i * columnWidth}px; width: ${columnWidth}px; background: #f1edfd; z-index: 0;"></div>`;
            }
            // 週の境目（月曜の左端）に線（ほかのモードと同じ色）
            if (date.getDay() === 1) {
                weekendBackgroundHtml += `<div style="position: absolute; top: 0; bottom: 0; left: ${i * columnWidth}px; width: 1px; background: #cbd2d9; z-index: 0;"></div>`;
            }
        });
    }

    const backgroundStyle = `background-image: ${gridBackground}; background-position: ${-firstPos}px 0; background-size: ${columnWidth}px 30px;`;
    const _today0 = new Date(); _today0.setHours(0, 0, 0, 0);
    const todayPos = gantt.posFromDate(_today0); // 今日のセルの左端
    let todayLineLeft = actualGridWidth + todayPos;

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

    if (_resourceOnly === 'late' || _resourceOnly === 'wish') {
        const keep = ownerTasks.filter(_resourceOnly === 'late' ? _resIsLate : _resIsWish);
        ownerTasks.length = 0; keep.forEach(t => ownerTasks.push(t));
    }

    if (ownerTasks.length === 0) {
        container.innerHTML = `<div style="padding:20px; text-align:center; color:#999;">タスクがありません</div>`;
        return;
    }

    // 担当者を替えたら、並び替え・絞り込みを解除して開始日順に戻す
    if (_resDetailView.owner !== ownerName) _resetResDetailView(ownerName);
    const allTasksForWidth = ownerTasks.slice(); // 絞り込んでも列幅が変わらないよう、絞り込み前で測る
    _resDetailView.options = _resDetailOptions(ownerTasks); // 絞り込みの選択肢（絞り込み前のタスクから作る）

    // 絞り込み（担当別モードのみ。見出しは担当別モードにしか出ないため）
    if (isResourceFullscreen) {
        const keep = ownerTasks.filter(t => Object.keys(_RES_DETAIL_COLS).every(k => {
            const sel = _resDetailView.filters[k];
            return !sel || sel.has(_RES_DETAIL_COLS[k].value(t));
        }));
        ownerTasks.length = 0; keep.forEach(t => ownerTasks.push(t));
    }

    // 並び順：既定は開始日順（同じ開始日は終了日順、開始日のないタスクは一番下）。
    // 見出しをクリックした列があれば、その列の昇順・降順（同じ値の中は開始日順）
    const sortKey = isResourceFullscreen ? _resDetailView.sortKey : null;
    const sortDir = _resDetailView.sortDir;
    ownerTasks.sort((a, b) => {
        if (sortKey) {
            const c = _RES_DETAIL_COLS[sortKey].compare(a, b);
            if (c !== 0) return c * sortDir;
        }
        return _resCompareStart(a, b);
    });

    // 担当別（全画面）ではタスク名が全部見える幅まで広げる
    if (isResourceFullscreen) {
        _resDetailColWidth = _calcResDetailColWidth(allTasksForWidth);
        actualGridWidth = _resDetailColWidth;
        totalWidth = actualGridWidth + timelineWidth;
        todayLineLeft = actualGridWidth + todayPos;
    }

    const TASK_TYPE_LABEL = {
        planning:       '計画',
        drawing:        '図面',
        long_lead_item: '長納期品',
        business_trip:  '出張',
    };

    const colorClass = getOwnerColorClass(ownerName);
    const textColor = "inherit";
    const dCols = _calcResDetailCols(allTasksForWidth); // 工事番号・機械・ユニットの列幅
    _resDetailView.cols = dCols; // 見出し（カレンダーの左上）を同じ幅で描くため

    let html = `<div style="width: ${totalWidth}px; position: relative;">`;
    if (ownerTasks.length === 0) {
        html += `<div style="position:sticky;left:0;width:${actualGridWidth}px;padding:20px;box-sizing:border-box;text-align:center;color:#999;">絞り込みに合うタスクがありません</div>`;
    }
    ownerTasks.forEach(t => {
        const hasDate = _resHasBar(t);
        const left = hasDate ? gantt.posFromDate(t.start_date) : 0;
        const right = hasDate ? gantt.posFromDate(t.end_date) : 0;
        const barWidth = hasDate ? Math.max(2, right - left) : 0;
        const typeLabel = TASK_TYPE_LABEL[String(t.task_type)] || String(t.task_type || '');
        const typeClr = TASK_TYPE_COLORS[String(t.task_type)] || { bg: '#e0e0e0', color: '#555' };

        html += `
            <div class="resource-item" style="display: flex; border-bottom: 1px solid #eef0f3; min-height: 30px; height: 30px; align-items: stretch; width: ${totalWidth}px;">
                <div class="resource-grid-container" style="width: ${actualGridWidth}px; min-width: ${actualGridWidth}px; flex-shrink: 0; display: flex; border-right: 1px solid #cbd2d9; background: #fff; position: sticky; left: 0; z-index: 40; overflow: hidden;">
                    <div style="display: flex; align-items: center; padding: 0 6px; font-size: 13px; color: #1f2933; width: 100%; overflow: hidden; white-space: nowrap; gap: 8px;">
                        <span style="flex-shrink: 0; box-sizing: border-box; width: ${RES_DETAIL_TYPE_W}px; text-align: center; font-size: 12px; color: ${typeClr.color}; background: ${typeClr.bg}; border-radius: 2px; height: 16px; line-height: 16px; padding: 0; font-weight: bold;">${typeLabel}</span>
                        <span style="flex-shrink: 0; color: #1f2933; width: ${dCols.pj}px; text-align: center;">${t.project_number || '-'}</span>
                        <span title="機械" style="flex-shrink: 0; color: #1f2933; width: ${dCols.mach}px; text-align: center;">${String(t.machine || '').trim()}</span>
                        <span title="ユニット" style="flex-shrink: 0; color: #1f2933; width: ${dCols.unit}px; text-align: center;">${String(t.unit || '').trim()}</span>
                        <span style="flex-shrink: 0; display: flex; align-items: center; gap: 2px;"><span title="${_resIsLate(t) ? '期限切れ' : ''}" style="display:flex; justify-content:center; width:16px;">${_resIsLate(t) ? _ICON_LATE : ''}</span><span title="${_resIsWish(t) ? '期日超過' : ''}" style="display:flex; justify-content:center; width:16px;">${_resIsWish(t) ? _ICON_WISH : ''}</span></span>
                        <span style="flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis;">${t.text}</span>
                    </div>
                </div>
                <div class="resource-timeline" style="width: ${timelineWidth}px; flex-shrink: 0; position: relative; background: #fff; overflow: hidden; z-index: 2;">
                    <div style="position: absolute; top: 0; left: 0; right: 0; bottom: 0; z-index: 0;">${weekendBackgroundHtml}</div>
                    <div style="position: absolute; top: 0; left: 0; right: 0; bottom: 0; ${backgroundStyle} z-index: 1;"></div>
                    ${hasDate ? `
                    <div class="resource-cell-bar ${colorClass}${_resIsDone(t) ? ' res-bar-completed' : ''}"
                         style="position: absolute; top: 4px; height: 22px; left: ${left}px; width: ${barWidth}px; z-index: 10;"
                         title="${t.text} (${t.project_number})">
                         <span class="resource-bar-text" style="color:${textColor}; font-size:11px; font-weight:bold;">${t.project_number || ""} ${t.text}</span>
                    </div>` : ''}
                    ${(() => { const tt = String(t.task_type); const w = _resWishDate(t); if (!w || (tt !== 'drawing' && tt !== 'long_lead_item')) return ''; const x = gantt.posFromDate(w) + columnWidth / 2; return `<div title="${tt === 'long_lead_item' ? '手配期日' : '出図希望日'}: ${t.wish_date}" style="position:absolute;top:0;left:${x}px;transform:translateX(-50%);font-size:12px;line-height:1;color:#3e4c59;z-index:11;">▼</div>`; })()}
                </div>
            </div>
        `;
    });
    html += `<div class="resource-today-line" style="left:${todayLineLeft}px;z-index:30;"></div></div>`;
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
        ? (_resourceDetailOwner ? _resDetailColWidth : RESOURCE_OVERVIEW_COL_WIDTH)
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

    // 月行HTML（日単位のときは、ほかのモードと同じ「11/9 の週」の週ごと）
    let monthHtml = '';
    if (unit === 'day' && typeof _weekScaleLabel === 'function') {
        let start = 0;
        for (let i = 1; i <= dates.length; i++) {
            if (i < dates.length && dates[i].getDay() !== 1) continue;
            const monday = new Date(dates[start]);
            monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7));
            const w = (i - start) * columnWidth;
            monthHtml += `<div class="resource-cal-cell resource-cal-month" style="width:${w}px;min-width:${w}px;height:22px;">${_weekScaleLabel(monday)}</div>`;
            start = i;
        }
    } else {
        months.forEach(m => {
            const w = m.count * columnWidth;
            monthHtml += `<div class="resource-cal-cell resource-cal-month" style="width:${w}px;min-width:${w}px;height:22px;">${m.year}/${m.month + 1}</div>`;
        });
    }

    // 日/週行HTML・曜日行HTML（日単位のみ曜日行あり）
    let dayHtml = '';
    let dowHtml = '';
    dates.forEach(date => {
        const dow = date.getDay();
        const isSun = dow === 0;
        const isSat = dow === 6;
        const isHol = _isHoliday(date);
        const isToday = typeof _isTodayDate === 'function' && _isTodayDate(date);
        const wkCls = (isToday ? ' resource-cal-today' : '') + (unit === 'day' && dow === 1 ? ' week-start' : '');
        const dowColor = isSun || isHol ? 'color:#c62828;' : isSat ? 'color:#1565C0;' : '';
        const d = date.getDate();

        if (unit === 'day') {
            dayHtml += `<div class="resource-cal-cell${wkCls}${isToday ? ' resource-cal-today-num' : ''}" style="width:${columnWidth}px;min-width:${columnWidth}px;height:18px;${isToday ? '' : dowColor}">${d}</div>`;
            dowHtml += `<div class="resource-cal-cell${wkCls}${isToday ? ' resource-cal-today-dow' : ''}" style="width:${columnWidth}px;min-width:${columnWidth}px;height:18px;${isToday ? '' : dowColor}">${_DOW_NAMES[dow]}</div>`;
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
        ${_resourceDetailOwner ? _resDetailHeaderHtml(actualGridWidth) : ''}
    `;
}

// 担当別モード（全画面）と、ほかのモードの下に出るリソースで、開いている担当者を別々に覚える
let _resStateFull  = { owner: null, only: null }; // 担当別モード
let _resStatePanel = { owner: null, only: null }; // ほかのモードの下のリソース

/** 見出し（担当者名・←・マーク凡例）を、いま開いている担当者に合わせて表示する */
function _applyResourceHeaderUI() {
    const lg = document.getElementById('resource_mark_legend');
    const bar = document.querySelector(".resource-header-bar");
    if (_resourceDetailOwner) {
        const suffix = _resourceOnly === 'late' ? '（期限切れ）' : _resourceOnly === 'wish' ? '（期日超過）' : '';
        document.getElementById('resource_title').textContent = `${_resourceDetailOwner}さんのタスク${suffix}`;
        if (lg) lg.style.display = '';
        document.getElementById('resource_back_btn').style.display = '';
        bar.style.display = '';
    } else {
        document.getElementById('resource_title').textContent = '担当者別リソース';
        if (lg) lg.style.display = 'none';
        document.getElementById('resource_back_btn').style.display = 'none';
        bar.style.display = 'none';
    }
}

function showOwnerDetail(ownerName, only, taskType) {
    // 一覧から開き直したときは、並び替え・絞り込みを解除して開始日順に戻す
    closeResDetailFilter();
    _resetResDetailView(ownerName);
    // 「ほか N件」から開いたときは、その種別だけに絞り込んだ状態で開く（種別の漏斗ボタンで解除できる）
    if (taskType) _resDetailView.filters.type = new Set([taskType]);
    _resourceDetailOwner = ownerName;
    _resourceOnly = only || null;
    const suffix = _resourceOnly === 'late' ? '（期限切れ）' : _resourceOnly === 'wish' ? '（期日超過）' : '';
    document.getElementById('resource_title').textContent = `${ownerName}さんのタスク${suffix}`;
    const lg = document.getElementById('resource_mark_legend'); if (lg) lg.style.display = '';
    document.getElementById('resource_back_btn').style.display = '';
    document.querySelector(".resource-header-bar").style.display = '';
    renderOwnerDetailTimeline(ownerName);
}

function showOwnerOverview() {
    closeResDetailFilter();
    _resourceDetailOwner = null;
    _resourceOnly = null;
    const lg = document.getElementById('resource_mark_legend'); if (lg) lg.style.display = 'none';
    document.getElementById('resource_title').textContent = '担当者別リソース';
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
    if (!isResourceFullscreen) {
        // 下のリソースで開いていた担当者を退避し、担当別モードで開いていた担当者に戻す
        _resStatePanel = { owner: _resourceDetailOwner, only: _resourceOnly };
        _resourceDetailOwner = _resStateFull.owner;
        _resourceOnly = _resStateFull.only;
    }
    isResourceFullscreen = true;
    isResourceView = true;
    // 担当者・機械フィルターをリセット
    currentOwnerFilter = [];
    _updateOwnerFilterBtn();
    currentMachineFilter = [];
    _updateMachineFilterBtn();
    _rebuildOwnerFilterOptionsFromGantt();
    _rebuildMachineFilterOptionsFromGantt();
    const panel = document.getElementById("resource_panel");
    const ganttEl = document.getElementById("gantt_here");
    const ganttHost = document.getElementById("gantt_host");
    const btn = document.getElementById("resource_toggle");
    panel.classList.add('resource-fullscreen');
    // ガントを一時的に表示したままリサイズを確定させてからリソース描画
    ganttEl.style.visibility = "hidden";
    gantt.setSizes();
    updateResourceData();
    ganttEl.style.visibility = "";
    ganttEl.style.display = "none";
    if (ganttHost) ganttHost.style.display = "none";
    panel.style.display = "flex";
    void panel.offsetHeight; // 強制リフロー：レイアウトを確定させる
    btn.style.display = "none";
    const _cm = document.getElementById("col_menu_btn"); if (_cm) _cm.style.display = "none";
    document.getElementById("resource_close_btn").style.display = "none";
    // 個人の詳細を開いたまま別モードから戻ってきたときは、担当者名と←を表示したままにする
    _applyResourceHeaderUI();
    // リソースズームバーを表示して現在のズームレベルを同期
    const rZoomBar = document.getElementById('resource_zoom_bar');
    if (rZoomBar) {
        const lvl = gantt.getState ? (gantt.getState().scale_unit || 'day') : 'day';
        rZoomBar.style.display = 'flex'; // 上のツールバー（日・週・今日へ）は隠れるので、ここに出す
        const rdBtn = document.getElementById('resource_zoom_day_btn');
        const rwBtn = document.getElementById('resource_zoom_week_btn');
        if (rdBtn) rdBtn.classList.toggle('active', lvl === 'day');
        if (rwBtn) rwBtn.classList.toggle('active', lvl === 'week');
    }
    updateFilterButtons();
    // レイアウト確定後にスクロール位置を設定
    setTimeout(resourceScrollToToday, 50);
}

/** 担当別モード：今日の日付までスクロールする（今日が左から300pxの位置に来るように） */
function resourceScrollToToday() {
    const _t = new Date(); _t.setHours(0, 0, 0, 0);
    const scrollX = Math.max(0, gantt.posFromDate(_t) - 300);
    const resourceContent = document.querySelector('.resource-content');
    if (resourceContent) resourceContent.scrollLeft = scrollX;
    _syncCalendarHeaderScroll(scrollX);
}

/** 担当別モード：日・週を切り替える。表示していた位置（左端の日付）はそのまま保つ */
function setResourceZoom(level) {
    const rc = document.querySelector('.resource-content');
    const leftDate = rc ? gantt.dateFromPos(rc.scrollLeft) : null;
    // ガントが非表示のままだと目盛りが計算し直されないので、見えない状態で一時的に表示して切り替える
    const ganttEl = document.getElementById('gantt_here');
    const ganttHost = document.getElementById('gantt_host');
    if (ganttHost) ganttHost.style.display = '';
    ganttEl.style.visibility = 'hidden';
    ganttEl.style.display = '';
    gantt.ext.zoom.setLevel(level);
    gantt.setSizes();
    ganttEl.style.display = 'none';
    ganttEl.style.visibility = '';
    if (ganttHost) ganttHost.style.display = 'none';
    // ボタンの選択状態（担当別のボタンと上のツールバーのボタンの両方）
    [['resource_zoom_day_btn', 'day'], ['resource_zoom_week_btn', 'week'], ['zoom_day_btn', 'day'], ['zoom_week_btn', 'week']]
        .forEach(([id, lv]) => { const b = document.getElementById(id); if (b) b.classList.toggle('active', lv === level); });
    updateResourceData();
    if (rc && leftDate) {
        const x = Math.max(0, gantt.posFromDate(leftDate));
        rc.scrollLeft = x;
        _syncCalendarHeaderScroll(x);
    }
}

// リソース全画面モードを抜けてガントビューへ
function _exitResourceFullscreen() {
    if (isResourceFullscreen) {
        // 担当別モードで開いていた担当者を退避し、下のリソースで開いていた担当者に戻す
        _resStateFull = { owner: _resourceDetailOwner, only: _resourceOnly };
        _resourceDetailOwner = _resStatePanel.owner;
        _resourceOnly = _resStatePanel.only;
        _applyResourceHeaderUI();
    }
    isResourceFullscreen = false;
    isResourceView = false;
    const panel = document.getElementById("resource_panel");
    const ganttEl = document.getElementById("gantt_here");
    const ganttHost = document.getElementById("gantt_host");
    const btn = document.getElementById("resource_toggle");
    panel.classList.remove('resource-fullscreen');
    panel.style.display = "none";
    if (ganttHost) ganttHost.style.display = "";
    ganttEl.style.display = "";
    btn.style.display = ""; // リソースボタンを復元
    btn.innerText = "担当者別リソース";
    btn.classList.remove('active'); // 下のリソースは閉じた状態で戻るので、ボタンも押していない表示にそろえる
    document.getElementById("resource_close_btn").style.display = "";
    const _cm = document.getElementById("col_menu_btn"); if (_cm) _cm.style.display = "";
    // リソースズームバーを非表示にしてメインのズームボタンを復元
    const rZoomBar = document.getElementById('resource_zoom_bar');
    if (rZoomBar) {
        const lvl = gantt.getState ? (gantt.getState().scale_unit || 'day') : 'day';
        rZoomBar.style.display = 'none';
        const dBtn = document.getElementById('zoom_day_btn');
        const wBtn = document.getElementById('zoom_week_btn');
        if (dBtn) dBtn.classList.toggle('active', lvl === 'day');
        if (wBtn) wBtn.classList.toggle('active', lvl === 'week');
    }
    updateFilterButtons();
    setTimeout(() => { _refreshMainGanttTimelineScale(true); }, 50);
}

function toggleResourceView() {
    if (isResourceFullscreen) return; // 全画面モード中は通常トグル不可
    isResourceView = !isResourceView;
    const btn = document.getElementById("resource_toggle");
    const panel = document.getElementById("resource_panel");

    if (isResourceView) {
        btn.innerText = "担当者別リソース";
        btn.classList.add('active');
        // コンテンツを描画してからパネルを表示（古い内容が一瞬見えるのを防ぐ）
        updateResourceData();
        panel.style.display = "flex";
    } else {
        btn.innerText = "担当者別リソース";
        btn.classList.remove('active');
        panel.style.display = "none";
        // 詳細モードをリセット
        _resourceDetailOwner = null;
        document.getElementById('resource_title').textContent = '担当者別リソース';
        _resourceOnly = null;
        document.getElementById('resource_back_btn').style.display = 'none';
    }

    setTimeout(() => { _refreshMainGanttTimelineScale(true); }, 50);
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
        line.style.cssText = 'position:absolute;bottom:0;width:2px;background:#7048e8;z-index:6;pointer-events:none;';
        taskEl.appendChild(line);
    }
    // dataArea.offsetLeft = −スクロール量（DHTMLX がスクロール時に left を負に設定）
    // posFromDate(today) = タイムライン絶対座標
    // 合計 = .gantt_task 内でのビュー座標（正しい表示位置）
    // 今日のセルの左端（今日の 0:00）に引く
    const today0 = new Date(); today0.setHours(0, 0, 0, 0);
    line.style.left = (dataArea.offsetLeft + gantt.posFromDate(today0)) + 'px';
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
    const _lb = (typeof window._getCurrentEditorName === 'function' ? window._getCurrentEditorName() : '') || '';
    const { error } = await supabaseClient
        .from('tasks')
        .update(Object.assign({ wish_date: dateStr }, _lb ? { last_updated_by: _lb } : {}))
        .eq('id', taskId);
    if (error) console.error('wish_date 保存エラー:', error);
}

// onBeforeTaskDisplay と同じフィルター条件を手動で判定（data.js の _taskVisibleOnGantt と同期）
function _isTaskDisplayed(task) {
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
}

let _wishDateDragging = false;

function _renderWishDateMarks() {
    if (_wishDateDragging) return;
    const dataArea = document.querySelector('#gantt_here .gantt_data_area');
    if (!dataArea) return;
    dataArea.querySelectorAll('.wish-date-mark').forEach(el => el.remove());
    // 計画・出張モードでは▼マークを表示しない
    if (currentTaskTypeFilter === 'planning' || currentTaskTypeFilter === 'business_trip') return;

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
        if (isOverdue) { el.style.color = '#c62828'; } // 期日超過は赤（白い縁取りは付けない）
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
            const startScrollX = gantt.getScrollState().x;
            let   currentLeft  = startLeft;
            let   lastClientX  = startClientX;
            let   scrollDir    = 0;
            let   rafId        = null;
            el.classList.add('dragging');
            _wishDateDragging = true;

            const timelineContainer = document.querySelector('#gantt_here .gantt_task');
            const SCROLL_ZONE  = 60;
            const SCROLL_SPEED = 10;

            function scrollLoop() {
                if (scrollDir !== 0) {
                    const prevScroll = gantt.getScrollState().x;
                    const newScrollX = Math.max(0, prevScroll + scrollDir * SCROLL_SPEED);
                    gantt.scrollTo(newScrollX, null);
                    const actualScroll = gantt.getScrollState().x;
                    currentLeft = startLeft + (lastClientX - startClientX) + (actualScroll - startScrollX);
                    el.style.left = currentLeft + 'px';
                }
                rafId = requestAnimationFrame(scrollLoop);
            }
            rafId = requestAnimationFrame(scrollLoop);

            function onMove(e) {
                lastClientX = e.clientX;
                const currentScrollX = gantt.getScrollState().x;
                currentLeft = startLeft + (e.clientX - startClientX) + (currentScrollX - startScrollX);
                el.style.left = currentLeft + 'px';
                if (timelineContainer) {
                    const rect = timelineContainer.getBoundingClientRect();
                    scrollDir = e.clientX < rect.left + SCROLL_ZONE ? -1
                              : e.clientX > rect.right - SCROLL_ZONE ? 1 : 0;
                }
            }
            function onUp() {
                document.removeEventListener('mousemove', onMove);
                document.removeEventListener('mouseup',   onUp);
                if (rafId) cancelAnimationFrame(rafId);
                scrollDir = 0;
                _wishDateDragging = false;
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

