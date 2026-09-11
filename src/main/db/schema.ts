/**
 * 库结构与 PRAGMA。所有 DDL 都写成幂等形式，启动时无条件执行一遍，
 * 版本号存在 meta 表里，后续结构变化通过 MIGRATIONS 追加。
 */
export const SCHEMA_VERSION = 1

export const PRAGMAS = `
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA foreign_keys = ON;
PRAGMA temp_store = MEMORY;
PRAGMA cache_size = -32000;
PRAGMA mmap_size = 268435456;
PRAGMA busy_timeout = 5000;
`

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS folders (
  id           INTEGER PRIMARY KEY,
  path         TEXT    NOT NULL UNIQUE,
  added_at     INTEGER NOT NULL,
  last_scan_at INTEGER,
  enabled      INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS places (
  id          INTEGER PRIMARY KEY,
  -- 聚类键：命中地名库时是城市在库里的序号，没命中时是坐标网格编号。
  -- 有了它，增量扫描进来的新照片能稳定并入已有地点，而不是每次重新生成一批。
  geo_key     TEXT NOT NULL UNIQUE,
  name        TEXT NOT NULL,
  admin2      TEXT,
  admin1      TEXT,
  country     TEXT,
  lat         REAL NOT NULL,
  lon         REAL NOT NULL,
  radius_m    REAL NOT NULL DEFAULT 0,
  custom_name TEXT
);

CREATE TABLE IF NOT EXISTS photos (
  id              INTEGER PRIMARY KEY,
  folder_id       INTEGER NOT NULL REFERENCES folders(id) ON DELETE CASCADE,
  path            TEXT    NOT NULL UNIQUE,
  filename        TEXT    NOT NULL,
  ext             TEXT    NOT NULL,
  kind            TEXT    NOT NULL,
  size            INTEGER NOT NULL,
  mtime           INTEGER NOT NULL,
  width           INTEGER,
  height          INTEGER,
  orientation     INTEGER,
  duration_ms     INTEGER,
  taken_at        INTEGER,
  taken_at_source TEXT,
  tz_offset_min   INTEGER,
  gps_lat         REAL,
  gps_lon         REAL,
  gps_alt         REAL,
  place_id        INTEGER REFERENCES places(id) ON DELETE SET NULL,
  camera_make     TEXT,
  camera_model    TEXT,
  lens            TEXT,
  f_number        REAL,
  exposure_time   REAL,
  iso             INTEGER,
  focal_length    REAL,
  dhash           TEXT,
  content_hash    TEXT,
  meta_state      INTEGER NOT NULL DEFAULT 0,
  thumb_state     INTEGER NOT NULL DEFAULT 0,
  error           TEXT,
  rating          INTEGER NOT NULL DEFAULT 0,
  favorite        INTEGER NOT NULL DEFAULT 0,
  indexed_at      INTEGER NOT NULL,
  search_text     TEXT NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS ix_photos_taken   ON photos(taken_at DESC);
CREATE INDEX IF NOT EXISTS ix_photos_folder  ON photos(folder_id);
CREATE INDEX IF NOT EXISTS ix_photos_place   ON photos(place_id, taken_at DESC);
CREATE INDEX IF NOT EXISTS ix_photos_meta    ON photos(meta_state) WHERE meta_state = 0;
CREATE INDEX IF NOT EXISTS ix_photos_thumb   ON photos(thumb_state) WHERE thumb_state = 0;
CREATE INDEX IF NOT EXISTS ix_photos_dhash   ON photos(dhash) WHERE dhash IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_photos_chash   ON photos(content_hash) WHERE content_hash IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_photos_fav     ON photos(favorite) WHERE favorite = 1;
CREATE INDEX IF NOT EXISTS ix_photos_gps     ON photos(gps_lat, gps_lon) WHERE gps_lat IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_photos_sig     ON photos(size, mtime);

CREATE TABLE IF NOT EXISTS tags (
  id    INTEGER PRIMARY KEY,
  name  TEXT NOT NULL UNIQUE,
  color TEXT
);

CREATE TABLE IF NOT EXISTS photo_tags (
  photo_id INTEGER NOT NULL REFERENCES photos(id) ON DELETE CASCADE,
  tag_id   INTEGER NOT NULL REFERENCES tags(id)   ON DELETE CASCADE,
  PRIMARY KEY (photo_id, tag_id)
);
CREATE INDEX IF NOT EXISTS ix_phototags_tag ON photo_tags(tag_id);

-- 批量整理的操作日志，用于"撤销上一次整理"
CREATE TABLE IF NOT EXISTS organize_log (
  id        INTEGER PRIMARY KEY,
  batch_id  TEXT    NOT NULL,
  photo_id  INTEGER,
  from_path TEXT    NOT NULL,
  to_path   TEXT    NOT NULL,
  op        TEXT    NOT NULL,
  done_at   INTEGER NOT NULL,
  undone    INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS ix_organize_batch ON organize_log(batch_id);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`

/** 后续每次结构变更往这里追加一条，index+1 即为目标版本号。 */
export const MIGRATIONS: string[] = []
