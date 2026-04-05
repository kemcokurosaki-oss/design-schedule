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
