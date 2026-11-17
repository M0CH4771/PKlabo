-- 開封演出（青→赤→金→虹）の段階を賞ごとに設定できるようにする。以前に schema.sql を実行したデータベースで一度だけ実行
--   npx wrangler d1 execute pklabo-db --remote --file=./migrations/004_prize_fx.sql
ALTER TABLE oripa_prizes ADD COLUMN fx INTEGER;
