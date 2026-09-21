import type Database from "better-sqlite3";

export interface LeaderboardEntry {
  playerId: string;
  displayName: string;
  total: number;
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
}
