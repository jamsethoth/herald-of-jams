CREATE TABLE schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL
) STRICT;

CREATE TABLE seasons (
  id TEXT PRIMARY KEY,
  started_at TEXT NOT NULL,
  ended_at TEXT
) STRICT;

CREATE TABLE players (
  discord_user_id TEXT PRIMARY KEY,
  latest_display_name TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE round_templates (
  id TEXT PRIMARY KEY,
  private_name TEXT NOT NULL,
  notes TEXT,
  channel_id TEXT NOT NULL,
  start_value INTEGER NOT NULL CHECK (start_value BETWEEN 0 AND 9007199254740991),
  target_value INTEGER NOT NULL CHECK (target_value BETWEEN 0 AND 9007199254740991),
  step_value INTEGER NOT NULL CHECK (step_value BETWEEN 1 AND 9007199254740991),
  rules_json TEXT NOT NULL CHECK (json_valid(rules_json)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (target_value > start_value)
) STRICT;

CREATE TABLE rounds (
  id TEXT PRIMARY KEY,
  template_id TEXT REFERENCES round_templates(id),
  season_id TEXT NOT NULL REFERENCES seasons(id),
  channel_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('waiting_for_start', 'counting', 'paused', 'completed', 'cancelled')),
  paused_from_state TEXT CHECK (paused_from_state IN ('waiting_for_start', 'counting')),
  compiled_config_json TEXT NOT NULL CHECK (json_valid(compiled_config_json)),
  activated_at TEXT NOT NULL,
  completed_at TEXT,
  cancelled_at TEXT,
  operationally_settled_at TEXT,
  CHECK ((state = 'paused') = (paused_from_state IS NOT NULL)),
  CHECK ((state = 'completed') = (completed_at IS NOT NULL)),
  CHECK ((state = 'cancelled') = (cancelled_at IS NOT NULL))
) STRICT;

CREATE UNIQUE INDEX rounds_one_active
  ON rounds ((1))
  WHERE state IN ('waiting_for_start', 'counting', 'paused');

CREATE TABLE compiled_entries (
  round_id TEXT NOT NULL REFERENCES rounds(id) ON DELETE CASCADE,
  position INTEGER NOT NULL CHECK (position BETWEEN 0 AND 9007199254740991),
  value INTEGER NOT NULL CHECK (value BETWEEN 0 AND 9007199254740991),
  bonus_rule_ids_json TEXT NOT NULL CHECK (json_valid(bonus_rule_ids_json)),
  PRIMARY KEY (round_id, position),
  UNIQUE (round_id, value)
) STRICT;

CREATE TABLE attempts (
  id TEXT PRIMARY KEY,
  round_id TEXT NOT NULL REFERENCES rounds(id),
  state TEXT NOT NULL CHECK (state IN ('active', 'broken', 'completed', 'cancelled')),
  started_at TEXT NOT NULL,
  ended_at TEXT,
  broken_by_submission_id TEXT,
  CHECK ((state = 'active') = (ended_at IS NULL))
) STRICT;

CREATE TABLE submissions (
  message_id TEXT PRIMARY KEY,
  round_id TEXT NOT NULL REFERENCES rounds(id),
  attempt_id TEXT REFERENCES attempts(id),
  author_id TEXT NOT NULL,
  original_digits TEXT NOT NULL,
  normalized_value INTEGER CHECK (normalized_value BETWEEN 0 AND 9007199254740991),
  decision TEXT NOT NULL CHECK (decision IN (
    'accepted',
    'waiting_deleted',
    'paused_deleted',
    'banned_deleted',
    'broken_unexpected',
    'broken_same_player',
    'broken_out_of_range',
    'invalidated_after_reconnect_break'
  )),
  received_at TEXT NOT NULL
) STRICT;

CREATE TABLE attempt_contributions (
  attempt_id TEXT NOT NULL REFERENCES attempts(id) ON DELETE CASCADE,
  player_id TEXT NOT NULL REFERENCES players(discord_user_id),
  accepted_count INTEGER NOT NULL CHECK (accepted_count BETWEEN 0 AND 9007199254740991),
  bonus_points INTEGER NOT NULL CHECK (bonus_points BETWEEN 0 AND 9007199254740991),
  PRIMARY KEY (attempt_id, player_id)
) STRICT;

CREATE TABLE round_player_penalties (
  round_id TEXT NOT NULL REFERENCES rounds(id) ON DELETE CASCADE,
  player_id TEXT NOT NULL REFERENCES players(discord_user_id),
  worst_severity INTEGER NOT NULL CHECK (worst_severity IN (-2, -3, -4, -5)),
  PRIMARY KEY (round_id, player_id)
) STRICT;

CREATE TABLE round_bans (
  round_id TEXT NOT NULL REFERENCES rounds(id) ON DELETE CASCADE,
  player_id TEXT NOT NULL REFERENCES players(discord_user_id),
  banned_at TEXT NOT NULL,
  PRIMARY KEY (round_id, player_id)
) STRICT;

CREATE TABLE score_ledger (
  id TEXT PRIMARY KEY,
  season_id TEXT NOT NULL REFERENCES seasons(id),
  round_id TEXT NOT NULL REFERENCES rounds(id),
  attempt_id TEXT REFERENCES attempts(id),
  player_id TEXT NOT NULL REFERENCES players(discord_user_id),
  entry_type TEXT NOT NULL CHECK (entry_type IN ('participation', 'bonus', 'penalty')),
  delta INTEGER NOT NULL CHECK (delta BETWEEN -5 AND 9007199254740991),
  source_key TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  CHECK (
    (entry_type = 'penalty' AND delta < 0) OR
    (entry_type IN ('participation', 'bonus') AND delta > 0)
  )
) STRICT;

CREATE INDEX score_ledger_season_player
  ON score_ledger (season_id, player_id);

CREATE TABLE discord_outbox (
  id TEXT PRIMARY KEY,
  channel_id TEXT NOT NULL,
  sequence_number INTEGER NOT NULL CHECK (sequence_number BETWEEN 1 AND 9007199254740991),
  predecessor_id TEXT REFERENCES discord_outbox(id),
  operation_type TEXT NOT NULL CHECK (operation_type IN (
    'canonical_message',
    'delete_original',
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

CREATE INDEX discord_outbox_pending
  ON discord_outbox (channel_id, sequence_number)
  WHERE status IN ('pending', 'delivering', 'retry_wait', 'needs_review');

CREATE TABLE channel_checkpoints (
  channel_id TEXT PRIMARY KEY,
  last_examined_message_id TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE audit_events (
  id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  round_id TEXT REFERENCES rounds(id),
  actor_id TEXT,
  details_json TEXT NOT NULL CHECK (json_valid(details_json)),
  created_at TEXT NOT NULL
) STRICT;

CREATE INDEX audit_events_created_at
  ON audit_events (created_at);

CREATE TABLE admin_sessions (
  session_id TEXT PRIMARY KEY,
  data_json TEXT NOT NULL CHECK (json_valid(data_json)),
  expires_at TEXT NOT NULL
) STRICT;

CREATE INDEX admin_sessions_expires_at
  ON admin_sessions (expires_at);

CREATE TABLE login_attempts (
  key TEXT PRIMARY KEY,
  window_started_at TEXT NOT NULL,
  attempt_count INTEGER NOT NULL CHECK (attempt_count BETWEEN 0 AND 9007199254740991),
  blocked_until TEXT
) STRICT;
