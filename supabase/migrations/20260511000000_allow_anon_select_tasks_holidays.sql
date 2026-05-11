-- =============================================================================
-- 設計工程表: ログアウト（未認証 / anon）でもタスクと休日を閲覧できるようにする
--
-- 適用方法（いずれか）:
--   1. Supabase ダッシュボード → SQL Editor → 本ファイルを貼り付けて実行
--   2. Supabase CLI: supabase db push 等でマイグレーションを適用
--
-- 注意:
--   - INSERT / UPDATE / DELETE は既存ポリシーのまま（編集者のみ等）にしてください。
--   - 本マイグレーションは SELECT のみ anon / authenticated に追加します。
--   - ポリシー名が既に存在する場合は、先にダッシュボードで名前を変更するか
--     DROP POLICY 行を調整してください。
-- =============================================================================

-- 念のため RLS を有効化（既に有効な場合は何も変わりません）
ALTER TABLE public.tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.holidays ENABLE ROW LEVEL SECURITY;

-- 誰でも読める行はない／認証済みのみ、といった既存 SELECT ポリシーがあっても、
-- Postgres の RLS は同じコマンドに対する複数ポリシーを OR で評価するため、
-- 下記があれば anon でも行が返ります。

DROP POLICY IF EXISTS "tasks_select_public_read" ON public.tasks;
CREATE POLICY "tasks_select_public_read"
  ON public.tasks
  FOR SELECT
  TO anon, authenticated
  USING (true);

DROP POLICY IF EXISTS "holidays_select_public_read" ON public.holidays;
CREATE POLICY "holidays_select_public_read"
  ON public.holidays
  FOR SELECT
  TO anon, authenticated
  USING (true);
