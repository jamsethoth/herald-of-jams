import type Database from "better-sqlite3";

export interface LeaderboardEntry {
  playerId: string;
  displayName: string;
  total: number;
}

export interface StoredSubmission {
  messageId: string;
  roundId: string;
  decision: string;
}

export class GameRepository {
  constructor(readonly database: Database.Database) {}

  immediate<T>(work: () => T): T {
    return this.database.transaction(work).immediate();
  }

  leaderboard(): readonly LeaderboardEntry[] {
    const rows = this.database
      .prepare(
        `SELECT ledger.player_id AS playerId,
                players.latest_display_name AS displayName,
                SUM(ledger.delta) AS total
         FROM score_ledger AS ledger
         JOIN seasons ON seasons.id = ledger.season_id AND seasons.ended_at IS NULL
         JOIN players ON players.discord_user_id = ledger.player_id
         GROUP BY ledger.player_id, players.latest_display_name
         ORDER BY total DESC, players.latest_display_name COLLATE NOCASE, ledger.player_id`,
      )
      .all() as LeaderboardEntry[];
    return rows;
  }

  submission(messageId: string): StoredSubmission | undefined {
    return this.database
      .prepare(
        `SELECT message_id AS messageId, round_id AS roundId, decision
         FROM submissions WHERE message_id = ?`,
      )
      .get(messageId) as StoredSubmission | undefined;
  }

  activeRoundState(): string | undefined {
    return (
      this.database
        .prepare("SELECT state FROM rounds WHERE state IN ('waiting_for_start', 'counting', 'paused')")
        .get() as { state: string } | undefined
    )?.state;
  }

  pendingReconnectBreak(channelId: string): string | undefined {
    return (
      this.database
        .prepare(
          `SELECT submissions.message_id
           FROM submissions
           JOIN rounds ON rounds.id = submissions.round_id
           WHERE rounds.channel_id = ?
             AND submissions.decision LIKE 'broken_%'
             AND NOT EXISTS (
               SELECT 1 FROM discord_outbox
               WHERE operation_type = 'reset_announcement'
                 AND json_extract(payload_json, '$.submissionId') = submissions.message_id
             )
           ORDER BY submissions.rowid DESC LIMIT 1`,
        )
        .get(channelId) as { message_id: string } | undefined
    )?.message_id;
  }
}
