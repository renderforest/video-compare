import fs from 'node:fs'
import Database from 'better-sqlite3'
import config from './config.js'

fs.mkdirSync(config.DATA_DIR, { recursive: true })

const db = new Database(config.DB_PATH)
db.pragma('journal_mode = WAL')

db.exec(`
  CREATE TABLE IF NOT EXISTS workflows (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    json TEXT NOT NULL,
    bindings_json TEXT NOT NULL,
    sha1 TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    csv_path TEXT NOT NULL,
    csv_rows INTEGER NOT NULL DEFAULT 0,
    sample_seed INTEGER NOT NULL,
    per_cell INTEGER NOT NULL DEFAULT 5,
    workflow_id INTEGER REFERENCES workflows(id),
    settings_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- every CSV row lands here; only rows with sampled = 1 are generated
  CREATE TABLE IF NOT EXISTS instances (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id INTEGER NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
    source_id TEXT,
    created_at_src TEXT,
    user_id TEXT,
    video_model TEXT,
    mode TEXT NOT NULL,
    quality INTEGER NOT NULL,
    aspect TEXT NOT NULL,
    aspect_source TEXT NOT NULL DEFAULT 'row',
    duration REAL NOT NULL,
    duration_bucket TEXT NOT NULL,
    style_id TEXT,
    style_name TEXT,
    video_type TEXT,
    video_type_name TEXT,
    flow TEXT,
    scenario_key TEXT NOT NULL,
    prompt TEXT NOT NULL,
    first_frame_url TEXT,
    last_frame_url TEXT,
    audio_url TEXT,
    audio_start REAL,
    ref_images_json TEXT NOT NULL DEFAULT '[]',
    ref_audios_json TEXT NOT NULL DEFAULT '[]',
    prod_video_url TEXT NOT NULL,
    prod_video_path TEXT,
    prod_width INTEGER,
    prod_height INTEGER,
    sampled INTEGER NOT NULL DEFAULT 0,
    seed INTEGER,
    workflow_id INTEGER,
    gen_key TEXT,
    reused INTEGER NOT NULL DEFAULT 0,
    comfy_prompt_id TEXT,
    output_path TEXT,
    duration_ms INTEGER,
    probe_json TEXT,
    checks_json TEXT,
    status TEXT NOT NULL DEFAULT 'pending'
      CHECK (status IN ('pending', 'running', 'done', 'failed', 'unsupported')),
    error TEXT,
    attempt INTEGER NOT NULL DEFAULT 0,
    rating TEXT CHECK (rating IN ('prod', 'local', 'tie')),
    rated_at TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_instances_run ON instances (run_id, sampled, status);
  CREATE INDEX IF NOT EXISTS idx_instances_scenario ON instances (run_id, scenario_key);
  CREATE INDEX IF NOT EXISTS idx_instances_gen_key ON instances (gen_key);

  CREATE TABLE IF NOT EXISTS comments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    instance_id INTEGER NOT NULL REFERENCES instances(id) ON DELETE CASCADE,
    author TEXT NOT NULL,
    body TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_comments_instance ON comments (instance_id, id);
`)

// additive migrations for DBs created before a column existed
for (const [table, column] of [
  ['instances', 'note TEXT'],
  ['workflows', 'detector_version INTEGER NOT NULL DEFAULT 1'],
  ['instances', 'output_thumb TEXT'],
  ['instances', 'prod_thumb TEXT'],
  ['runs', 'wanted_active INTEGER NOT NULL DEFAULT 0'],
  ['runs', 'last_stop TEXT'],
  ['instances', 'rated_by TEXT'],
  ["comments", "side TEXT NOT NULL DEFAULT 'local' CHECK (side IN ('prod', 'local'))"],
  ['instances', 'finished_at TEXT']
]) {
  try {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column}`)
  } catch {
    // column already exists
  }
}

export default db

db.exec('CREATE INDEX IF NOT EXISTS idx_instances_finished ON instances (run_id, finished_at)')
