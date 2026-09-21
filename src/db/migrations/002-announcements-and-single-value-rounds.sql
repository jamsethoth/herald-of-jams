-- requires-foreign-keys-off

CREATE TABLE announcement_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  bonus_announcement TEXT NOT NULL CHECK (length(bonus_announcement) BETWEEN 1 AND 1900),
  reset_announcement TEXT NOT NULL CHECK (length(reset_announcement) BETWEEN 1 AND 1900),
  completion_announcement TEXT NOT NULL CHECK (length(completion_announcement) BETWEEN 1 AND 1900),
  cancellation_announcement TEXT NOT NULL CHECK (length(cancellation_announcement) BETWEEN 1 AND 1900),
  updated_at TEXT NOT NULL
) STRICT;

INSERT INTO announcement_settings (
  id,
  bonus_announcement,
  reset_announcement,
  completion_announcement,
  cancellation_announcement,
  updated_at
) VALUES (
  1,
  '{player} earned {bonusPoints} provisional bonus points.',
  'The attempt was reset. Provisional rewards were discarded; penalties remain. Start again at {start}.',
  'The round is complete. Final rewards have been recorded.',
  'The round was cancelled. All provisional rewards and round penalties were discarded.',
  CURRENT_TIMESTAMP
);

CREATE TABLE round_templates_new (
  id TEXT PRIMARY KEY,
  private_name TEXT NOT NULL,
  notes TEXT,
  channel_id TEXT NOT NULL,
  start_value INTEGER NOT NULL CHECK (start_value BETWEEN 0 AND 9007199254740991),
  target_value INTEGER NOT NULL CHECK (target_value BETWEEN 0 AND 9007199254740991),
  step_value INTEGER NOT NULL CHECK (step_value BETWEEN 1 AND 9007199254740991),
  rules_json TEXT NOT NULL CHECK (json_valid(rules_json)),
  bonus_announcement_override TEXT CHECK (
    bonus_announcement_override IS NULL OR length(bonus_announcement_override) BETWEEN 1 AND 1900
  ),
  reset_announcement_override TEXT CHECK (
    reset_announcement_override IS NULL OR length(reset_announcement_override) BETWEEN 1 AND 1900
  ),
  completion_announcement_override TEXT CHECK (
    completion_announcement_override IS NULL OR length(completion_announcement_override) BETWEEN 1 AND 1900
  ),
  cancellation_announcement_override TEXT CHECK (
    cancellation_announcement_override IS NULL OR length(cancellation_announcement_override) BETWEEN 1 AND 1900
  ),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (target_value >= start_value)
) STRICT;

INSERT INTO round_templates_new (
  id,
  private_name,
  notes,
  channel_id,
  start_value,
  target_value,
  step_value,
  rules_json,
  bonus_announcement_override,
  reset_announcement_override,
  completion_announcement_override,
  cancellation_announcement_override,
  created_at,
  updated_at
)
SELECT
  id,
  private_name,
  notes,
  channel_id,
  start_value,
  target_value,
  step_value,
  rules_json,
  NULL,
  NULL,
  NULL,
  NULL,
  created_at,
  updated_at
FROM round_templates;

DROP TABLE round_templates;
ALTER TABLE round_templates_new RENAME TO round_templates;

DELETE FROM score_ledger
WHERE entry_type = 'penalty'
  AND round_id IN (SELECT id FROM rounds WHERE state = 'cancelled');

DELETE FROM round_player_penalties
WHERE round_id IN (SELECT id FROM rounds WHERE state = 'cancelled');
