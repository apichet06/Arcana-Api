ALTER TABLE Store
    ADD COLUMN is_platform_store TINYINT(1) NOT NULL DEFAULT 0;

UPDATE Store
SET is_platform_store = 1,
    st_status = 'ACTIVE'
WHERE st_id = 1;
