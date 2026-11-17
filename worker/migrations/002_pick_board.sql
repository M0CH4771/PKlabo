-- 「パックを選んで開ける（ボード形式）」の追加。以前に schema.sql を実行したデータベースで一度だけ実行
--   npx wrangler d1 execute pklabo-db --remote --file=./migrations/002_pick_board.sql
ALTER TABLE oripas ADD COLUMN pick_mode INTEGER NOT NULL DEFAULT 0;
ALTER TABLE oripa_draws ADD COLUMN slot INTEGER;
CREATE UNIQUE INDEX IF NOT EXISTS idx_draws_slot ON oripa_draws(oripa_id, slot) WHERE slot IS NOT NULL;
