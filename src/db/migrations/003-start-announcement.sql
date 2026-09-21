-- requires-foreign-keys-off

ALTER TABLE announcement_settings ADD COLUMN start_announcement TEXT NOT NULL
  DEFAULT 'A new round has started. Begin at {start}.'
  CHECK (length(start_announcement) BETWEEN 1 AND 1900);

ALTER TABLE round_templates ADD COLUMN start_announcement_override TEXT
  CHECK (
    start_announcement_override IS NULL OR length(start_announcement_override) BETWEEN 1 AND 1900
  );

CREATE TABLE discord_outbox_new (
  id TEXT PRIMARY KEY,
  channel_id TEXT NOT NULL,
  sequence_number INTEGER NOT NULL CHECK (sequence_number BETWEEN 1 AND 9007199254740991),
  predecessor_id TEXT REFERENCES discord_outbox_new(id),
  operation_type TEXT NOT NULL CHECK (operation_type IN (
    'canonical_message',
    'delete_original',
    'start_announcement',
    'bonus_announcement',
    'reset_announcement',
    'completion_announcement',
    'cancellation_announcement',
    'leaderboard_publication'
  )),
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  nonce TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('pending', 'delivering', 'delivered', 'retry_wait', 'needs_review', 'abandoned')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count BETWEEN 0 AND 9007199254740991),
  next_attempt_at TEXT,
  last_error TEXT,
  discord_message_id TEXT,
  created_at TEXT NOT NULL,
  resolved_at TEXT,
  UNIQUE (channel_id, sequence_number),
  CHECK (predecessor_id IS NULL OR predecessor_id <> id)
) STRICT;

INSERT INTO discord_outbox_new (
  id,
  channel_id,
  sequence_number,
  predecessor_id,
  operation_type,
  payload_json,
  nonce,
  status,
  attempt_count,
  next_attempt_at,
  last_error,
  discord_message_id,
  created_at,
  resolved_at
)
SELECT
  id,
  channel_id,
  sequence_number,
  predecessor_id,
  operation_type,
  payload_json,
  nonce,
  status,
  attempt_count,
  next_attempt_at,
  last_error,
  discord_message_id,
  created_at,
  resolved_at
FROM discord_outbox;

DROP TABLE discord_outbox;
ALTER TABLE discord_outbox_new RENAME TO discord_outbox;

CREATE INDEX discord_outbox_pending
  ON discord_outbox (channel_id, sequence_number)
  WHERE status IN ('pending', 'delivering', 'retry_wait', 'needs_review');
