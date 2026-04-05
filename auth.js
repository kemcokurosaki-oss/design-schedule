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

