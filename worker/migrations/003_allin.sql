-- 「残り全部引く」の追加。以前に schema.sql を実行したデータベースで一度だけ実行
--   npx wrangler d1 execute pklabo-db --remote --file=./migrations/003_allin.sql
ALTER TABLE oripas ADD COLUMN allin_under INTEGER NOT NULL DEFAULT 0;
