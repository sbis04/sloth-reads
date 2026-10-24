-- Sloth Reads on Tiger Cloud (TimescaleDB + pgvector). Runs on every boot, so everything is idempotent.
CREATE EXTENSION IF NOT EXISTS timescaledb;
CREATE EXTENSION IF NOT EXISTS vector;
CREATE SCHEMA IF NOT EXISTS sloth;
SET search_path = sloth, public;

-- Everything you saved to read later, and what the sloth made of it overnight.
CREATE TABLE IF NOT EXISTS items (
  id            BIGSERIAL PRIMARY KEY,
  url           TEXT NOT NULL UNIQUE,
  source        TEXT NOT NULL,                     -- dev | link
  dev_id        BIGINT,
  title         TEXT NOT NULL DEFAULT '',
  author        TEXT NOT NULL DEFAULT '',
  site          TEXT NOT NULL DEFAULT '',
  cover         TEXT,
  read_minutes  INT NOT NULL DEFAULT 0,            -- how long it would take to read yourself
  words         INT NOT NULL DEFAULT 0,
  text          TEXT,                              -- the readable article text the model and the voice use
  added_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  status        TEXT NOT NULL DEFAULT 'queued',    -- queued | done | failed
  error         TEXT,
  processed_at  TIMESTAMPTZ,
  summary       TEXT,
  takeaways     TEXT[] NOT NULL DEFAULT '{}',
  verdict       TEXT,                              -- read | skim | skip
  reason        TEXT,
  tags          TEXT[] NOT NULL DEFAULT '{}',
  embedding     vector(1024),                      -- bge-m3, the same model locally and on DigitalOcean
  search        tsvector,
  finished_at   TIMESTAMPTZ                        -- you marked it done
);
CREATE INDEX IF NOT EXISTS items_status ON items (status, added_at);
CREATE INDEX IF NOT EXISTS items_search ON items USING gin (search);
CREATE INDEX IF NOT EXISTS items_embedding ON items USING hnsw (embedding vector_cosine_ops);

-- One spoken brief per morning.
CREATE TABLE IF NOT EXISTS briefs (
  day         DATE PRIMARY KEY,
  item_ids    BIGINT[] NOT NULL,
  script      TEXT NOT NULL,
  read_minutes INT NOT NULL DEFAULT 0,             -- reading time of everything it covers
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Generated speech, cached so a replay never costs a second time.
CREATE TABLE IF NOT EXISTS audio (
  key         TEXT PRIMARY KEY,                    -- brief:<day> | item:<id>
  voice       TEXT NOT NULL,
  chars       INT NOT NULL,
  seconds     REAL,
  mp3         BYTEA NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE audio ADD COLUMN IF NOT EXISTS alignment JSONB;  -- word start times, for the live highlight
-- Whose post it is: full text and voice are public only for the owner's own posts; everyone else's stay private.
ALTER TABLE items ADD COLUMN IF NOT EXISTS author_handle TEXT;

-- Every overnight run: the sloth's pace, as a time series.
CREATE TABLE IF NOT EXISTS runs (
  time       TIMESTAMPTZ NOT NULL DEFAULT now(),
  trigger    TEXT NOT NULL,                        -- schedule | manual
  synced     INT NOT NULL DEFAULT 0,
  processed  INT NOT NULL DEFAULT 0,
  failed     INT NOT NULL DEFAULT 0,
  briefed    BOOLEAN NOT NULL DEFAULT false,
  ms         INT NOT NULL DEFAULT 0
);
SELECT create_hypertable('sloth.runs', by_range('time', INTERVAL '7 days'), if_not_exists => TRUE);

-- The lazy payoff: minutes you didn't spend, per event.
CREATE TABLE IF NOT EXISTS saved (
  time     TIMESTAMPTZ NOT NULL DEFAULT now(),
  item_id  BIGINT,
  kind     TEXT NOT NULL,                          -- skipped | summary | brief
  minutes  REAL NOT NULL
);
SELECT create_hypertable('sloth.saved', by_range('time', INTERVAL '7 days'), if_not_exists => TRUE);
CREATE INDEX IF NOT EXISTS saved_item ON saved (item_id, kind);

CREATE MATERIALIZED VIEW IF NOT EXISTS saved_daily
WITH (timescaledb.continuous) AS
SELECT time_bucket(INTERVAL '1 day', time) AS day, sum(minutes) AS minutes, count(*) AS events
FROM saved GROUP BY day
WITH NO DATA;
SELECT add_continuous_aggregate_policy('sloth.saved_daily',
  start_offset => INTERVAL '60 days', end_offset => INTERVAL '1 hour',
  schedule_interval => INTERVAL '30 minutes', if_not_exists => TRUE);
ALTER MATERIALIZED VIEW saved_daily SET (timescaledb.materialized_only = false);
