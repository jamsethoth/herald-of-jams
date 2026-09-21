import type { AdminRepository } from "../db/admin-repository.js";
import type { GameRepository, LeaderboardEntry } from "../db/game-repository.js";
import {
  cancelRound as cancelEngineRound,
  evaluateSubmission,
  pauseRound as pauseEngineRound,
  resumeRound as resumeEngineRound,
  type EngineState,
} from "../domain/game-engine.js";
import { parseNumericSubmission } from "../domain/numeric-submission.js";
import { compileRound } from "../domain/round-compiler.js";
import { additionalPenalty, participationAwards, type PenaltyTotal } from "../domain/scoring.js";
import type { CompiledRound } from "../domain/types.js";
import type {
  Clock,
  IdGenerator,
  InboundDiscordMessage,
  MessageDisposition,
} from "./contracts.js";

interface RoundRow {
  id: string;
  channel_id: string;
  state: EngineState["roundState"];
  paused_from_state: "waiting_for_start" | "counting" | null;
  compiled_config_json: string;
  season_id: string;
}

interface AttemptRow {
  id: string;
}

type OutboxOperation =
  | "canonical_message"
  | "delete_original"
  | "bonus_announcement"
  | "reset_announcement"
  | "completion_announcement"
  | "cancellation_announcement"
  | "leaderboard_publication";

export class GameService {
  constructor(
    private readonly repository: GameRepository,
    private readonly adminRepository: AdminRepository,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
  ) {}

  private get database() {
    return this.repository.database;
  }

  private activeRound(): RoundRow | undefined {
    return this.database
      .prepare(
        `SELECT id, channel_id, state, paused_from_state, compiled_config_json, season_id
         FROM rounds WHERE state IN ('waiting_for_start', 'counting', 'paused')`,
      )
      .get() as RoundRow | undefined;
  }

  private requireActiveRound(): RoundRow {
    const round = this.activeRound();
    if (round === undefined) {
      throw new Error("no active round");
    }
    return round;
  }

  private assertNoUnsettledTerminalRound(): void {
    const unsettled = this.database
      .prepare(
        `SELECT id FROM rounds
         WHERE state IN ('completed', 'cancelled') AND operationally_settled_at IS NULL
         LIMIT 1`,
      )
      .get();
    if (unsettled !== undefined) {
      throw new Error("terminal Discord work must be delivered or explicitly abandoned first");
    }
  }

  private ensureSeason(now: string): string {
    const current = this.database
      .prepare("SELECT id FROM seasons WHERE ended_at IS NULL LIMIT 1")
      .get() as { id: string } | undefined;
    if (current !== undefined) {
      return current.id;
    }
    const id = this.ids.next();
    this.database.prepare("INSERT INTO seasons (id, started_at) VALUES (?, ?)").run(id, now);
    return id;
  }

  private audit(eventType: string, roundId: string | null, actorId: string | null, details: unknown): void {
    this.database
      .prepare(
        `INSERT INTO audit_events (id, event_type, round_id, actor_id, details_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        this.ids.next(),
        eventType,
        roundId,
        actorId,
        JSON.stringify(details),
        this.clock.now().toISOString(),
      );
  }

  private enqueue(
    channelId: string,
    operationType: OutboxOperation,
    payload: unknown,
  ): string {
    const predecessor = this.database
      .prepare(
        `SELECT id, sequence_number FROM discord_outbox
         WHERE channel_id = ? ORDER BY sequence_number DESC LIMIT 1`,
      )
      .get(channelId) as { id: string; sequence_number: number } | undefined;
    const id = this.ids.next();
    this.database
      .prepare(
        `INSERT INTO discord_outbox
          (id, channel_id, sequence_number, predecessor_id, operation_type, payload_json,
           nonce, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
      )
      .run(
        id,
        channelId,
        (predecessor?.sequence_number ?? 0) + 1,
        predecessor?.id ?? null,
        operationType,
        JSON.stringify(payload),
        `outbox:${id}`,
        this.clock.now().toISOString(),
      );
    return id;
  }

  private ensurePlayer(playerId: string, displayName: string): void {
    this.database
      .prepare(
        `INSERT INTO players (discord_user_id, latest_display_name, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(discord_user_id) DO UPDATE SET
           latest_display_name = excluded.latest_display_name,
           updated_at = excluded.updated_at`,
      )
      .run(playerId, displayName, this.clock.now().toISOString());
  }

  async activateRound(templateId: string): Promise<string> {
    return this.repository.immediate(() => {
      if (this.activeRound() !== undefined) {
        throw new Error("an active round already exists");
      }
      this.assertNoUnsettledTerminalRound();
      const input = this.adminRepository.getTemplate(templateId);
      const compiled = compileRound(input);
      const now = this.clock.now().toISOString();
      const seasonId = this.ensureSeason(now);
      const roundId = this.ids.next();
      this.database
        .prepare(
          `INSERT INTO rounds
            (id, template_id, season_id, channel_id, state, compiled_config_json, activated_at)
           VALUES (?, ?, ?, ?, 'waiting_for_start', ?, ?)`,
        )
        .run(roundId, templateId, seasonId, input.channelId, JSON.stringify(compiled), now);
      const insertEntry = this.database.prepare(
        `INSERT INTO compiled_entries (round_id, position, value, bonus_rule_ids_json)
         VALUES (?, ?, ?, ?)`,
      );
      for (const entry of compiled.entries) {
        insertEntry.run(roundId, entry.position, entry.value, JSON.stringify(entry.bonusRuleIds));
      }
      this.audit("round_activated", roundId, null, { templateId });
      return roundId;
    });
  }

  async processMessage(
    message: InboundDiscordMessage,
    options: { deferResetAnnouncement?: boolean } = {},
  ): Promise<MessageDisposition> {
    return this.repository.immediate(() => {
      const duplicate = this.database
        .prepare("SELECT 1 FROM submissions WHERE message_id = ?")
        .get(message.id);
      if (duplicate !== undefined) {
        return { kind: "duplicate" };
      }

      const round = this.activeRound();
      if (round === undefined || round.channel_id !== message.channelId) {
        return { kind: "conversation" };
      }
      const parsed = parseNumericSubmission(message.content);
      if (parsed.kind === "conversation") {
        return { kind: "conversation" };
      }

      const compiled = JSON.parse(round.compiled_config_json) as CompiledRound;
      const attempt = this.database
        .prepare("SELECT id FROM attempts WHERE round_id = ? AND state = 'active'")
        .get(round.id) as AttemptRow | undefined;
      const accepted =
        attempt === undefined
          ? []
          : (this.database
              .prepare(
                `SELECT author_id FROM submissions
                 WHERE attempt_id = ? AND decision = 'accepted' ORDER BY rowid`,
              )
              .all(attempt.id) as { author_id: string }[]);
      const bans = this.database
        .prepare("SELECT player_id FROM round_bans WHERE round_id = ?")
        .all(round.id) as { player_id: string }[];
      const engineState: EngineState = {
        roundState: round.state,
        ...(round.paused_from_state === null ? {} : { pausedFrom: round.paused_from_state }),
        nextPosition: accepted.length,
        ...(accepted.length === 0
          ? {}
          : { previousAcceptedPlayerId: accepted[accepted.length - 1]!.author_id }),
        acceptedCount: accepted.length,
        bannedPlayerIds: new Set(bans.map(({ player_id }) => player_id)),
      };
      const decision = evaluateSubmission(engineState, {
        playerId: message.authorId,
        parsed,
        compiled,
      });
      if (decision.kind === "conversation") {
        return { kind: "conversation" };
      }

      this.ensurePlayer(message.authorId, message.displayName);
      const outboxOperationIds: string[] = [];
      const originalDigits = parsed.digits;
      const normalizedValue = parsed.kind === "safe_integer" ? parsed.value : null;

      if (decision.kind === "delete_without_effect") {
        const storedDecision = `${decision.reason}_deleted`;
        this.database
          .prepare(
            `INSERT INTO submissions
              (message_id, round_id, attempt_id, author_id, original_digits, normalized_value,
               decision, received_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            message.id,
            round.id,
            attempt?.id ?? null,
            message.authorId,
            originalDigits,
            normalizedValue,
            storedDecision,
            message.createdAt,
          );
        outboxOperationIds.push(
          this.enqueue(round.channel_id, "delete_original", { messageId: message.id }),
        );
        this.audit("submission_deleted_without_effect", round.id, message.authorId, {
          messageId: message.id,
          reason: decision.reason,
        });
        return { kind: "recorded", decision: storedDecision, outboxOperationIds };
      }

      let attemptId = attempt?.id;
      if (decision.kind === "accepted" && attemptId === undefined) {
        attemptId = this.ids.next();
        this.database
          .prepare("INSERT INTO attempts (id, round_id, state, started_at) VALUES (?, ?, 'active', ?)")
          .run(attemptId, round.id, this.clock.now().toISOString());
      }
      if (attemptId === undefined) {
        throw new Error("active counting round has no attempt");
      }

      if (decision.kind === "accepted") {
        this.database
          .prepare(
            `INSERT INTO submissions
              (message_id, round_id, attempt_id, author_id, original_digits, normalized_value,
               decision, received_at)
             VALUES (?, ?, ?, ?, ?, ?, 'accepted', ?)`,
          )
          .run(
            message.id,
            round.id,
            attemptId,
            message.authorId,
            originalDigits,
            normalizedValue,
            message.createdAt,
          );
        this.database
          .prepare(
            `INSERT INTO attempt_contributions (attempt_id, player_id, accepted_count, bonus_points)
             VALUES (?, ?, 1, ?)
             ON CONFLICT(attempt_id, player_id) DO UPDATE SET
               accepted_count = accepted_count + 1,
               bonus_points = bonus_points + excluded.bonus_points`,
          )
          .run(attemptId, message.authorId, decision.bonusRuleIds.length);
        this.database
          .prepare("UPDATE rounds SET state = 'counting', paused_from_state = NULL WHERE id = ?")
          .run(round.id);
        this.audit("submission_accepted", round.id, message.authorId, {
          messageId: message.id,
          position: decision.position,
        });
        outboxOperationIds.push(
          this.enqueue(round.channel_id, "canonical_message", {
            content: `${message.displayName}: ${normalizedValue}`,
            submissionId: message.id,
          }),
          this.enqueue(round.channel_id, "delete_original", { messageId: message.id }),
        );
        if (decision.bonusRuleIds.length > 0) {
          outboxOperationIds.push(
            this.enqueue(round.channel_id, "bonus_announcement", {
              content: `${message.displayName} earned ${decision.bonusRuleIds.length} provisional bonus point${decision.bonusRuleIds.length === 1 ? "" : "s"}.`,
              submissionId: message.id,
            }),
          );
        }
        if (decision.completesRound) {
          this.completeRound(round, attemptId, outboxOperationIds);
        }
        return { kind: "recorded", decision: "accepted", outboxOperationIds };
      }

      const storedDecision = `broken_${decision.reason}`;
      this.database
        .prepare(
          `INSERT INTO submissions
            (message_id, round_id, attempt_id, author_id, original_digits, normalized_value,
             decision, received_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          message.id,
          round.id,
          attemptId,
          message.authorId,
          originalDigits,
          normalizedValue,
          storedDecision,
          message.createdAt,
        );
      const now = this.clock.now().toISOString();
      this.database
        .prepare(
          "UPDATE attempts SET state = 'broken', ended_at = ?, broken_by_submission_id = ? WHERE id = ?",
        )
        .run(now, message.id, attemptId);
      this.database
        .prepare("UPDATE rounds SET state = 'waiting_for_start', paused_from_state = NULL WHERE id = ?")
        .run(round.id);
      const previous = this.database
        .prepare(
          "SELECT worst_severity FROM round_player_penalties WHERE round_id = ? AND player_id = ?",
        )
        .get(round.id, message.authorId) as { worst_severity: PenaltyTotal } | undefined;
      const delta = additionalPenalty(previous?.worst_severity ?? 0, decision.severity);
      if (previous === undefined || decision.severity < previous.worst_severity) {
        this.database
          .prepare(
            `INSERT INTO round_player_penalties (round_id, player_id, worst_severity)
             VALUES (?, ?, ?)
             ON CONFLICT(round_id, player_id) DO UPDATE SET worst_severity = excluded.worst_severity`,
          )
          .run(round.id, message.authorId, decision.severity);
      }
      if (delta !== 0) {
        this.database
          .prepare(
            `INSERT INTO score_ledger
              (id, season_id, round_id, attempt_id, player_id, entry_type, delta, source_key, created_at)
             VALUES (?, ?, ?, ?, ?, 'penalty', ?, ?, ?)`,
          )
          .run(
            this.ids.next(),
            round.season_id,
            round.id,
            attemptId,
            message.authorId,
            delta,
            `penalty:${round.id}:${message.authorId}:${decision.severity}`,
            now,
          );
      }
      this.database.prepare("DELETE FROM attempt_contributions WHERE attempt_id = ?").run(attemptId);
      this.audit("attempt_broken", round.id, message.authorId, {
        messageId: message.id,
        reason: decision.reason,
        severity: decision.severity,
        delta,
      });
      outboxOperationIds.push(
        this.enqueue(round.channel_id, "canonical_message", {
          content: `${message.displayName}: ${originalDigits}`,
          submissionId: message.id,
        }),
        this.enqueue(round.channel_id, "delete_original", { messageId: message.id }),
      );
      if (options.deferResetAnnouncement !== true) {
        outboxOperationIds.push(
          this.enqueue(round.channel_id, "reset_announcement", {
            content: `The attempt was reset. Provisional rewards were discarded; penalties remain. Start again at ${compiled.input.start}.`,
            submissionId: message.id,
          }),
        );
      }
      return { kind: "recorded", decision: storedDecision, outboxOperationIds };
    });
  }

  async invalidateAfterReconnectBreak(
    message: InboundDiscordMessage,
    breakingMessageId: string,
  ): Promise<MessageDisposition> {
    return this.repository.immediate(() => {
      if (this.repository.submission(message.id) !== undefined) {
        return { kind: "duplicate" };
      }
      const breaking = this.database
        .prepare(
          `SELECT submissions.round_id, rounds.channel_id
           FROM submissions JOIN rounds ON rounds.id = submissions.round_id
           WHERE submissions.message_id = ? AND submissions.decision LIKE 'broken_%'`,
        )
        .get(breakingMessageId) as { round_id: string; channel_id: string } | undefined;
      if (breaking === undefined || breaking.channel_id !== message.channelId) {
        throw new Error("reconnect break submission was not found for this channel");
      }
      const parsed = parseNumericSubmission(message.content);
      if (parsed.kind === "conversation") {
        return { kind: "conversation" };
      }
      this.ensurePlayer(message.authorId, message.displayName);
      this.database
        .prepare(
          `INSERT INTO submissions
            (message_id, round_id, attempt_id, author_id, original_digits, normalized_value,
             decision, received_at)
           VALUES (?, ?, NULL, ?, ?, ?, 'invalidated_after_reconnect_break', ?)`,
        )
        .run(
          message.id,
          breaking.round_id,
          message.authorId,
          parsed.digits,
          parsed.kind === "safe_integer" ? parsed.value : null,
          message.createdAt,
        );
      const operationId = this.enqueue(breaking.channel_id, "delete_original", {
        messageId: message.id,
        invalidatedAfterBreakingSubmissionId: breakingMessageId,
      });
      this.audit("submission_invalidated_after_reconnect_break", breaking.round_id, message.authorId, {
        messageId: message.id,
        breakingMessageId,
      });
      return {
        kind: "recorded",
        decision: "invalidated_after_reconnect_break",
        outboxOperationIds: [operationId],
      };
    });
  }

  async ensureReconnectReset(breakingMessageId: string): Promise<string> {
    return this.repository.immediate(() => {
      const existing = this.database
        .prepare(
          `SELECT id FROM discord_outbox
           WHERE operation_type = 'reset_announcement'
             AND json_extract(payload_json, '$.submissionId') = ?`,
        )
        .get(breakingMessageId) as { id: string } | undefined;
      if (existing !== undefined) {
        return existing.id;
      }
      const breaking = this.database
        .prepare(
          `SELECT rounds.id AS round_id, rounds.channel_id, rounds.compiled_config_json
           FROM submissions JOIN rounds ON rounds.id = submissions.round_id
           WHERE submissions.message_id = ? AND submissions.decision LIKE 'broken_%'`,
        )
        .get(breakingMessageId) as
        | { round_id: string; channel_id: string; compiled_config_json: string }
        | undefined;
      if (breaking === undefined) {
        throw new Error("reconnect break submission was not found");
      }
      const compiled = JSON.parse(breaking.compiled_config_json) as CompiledRound;
      return this.enqueue(breaking.channel_id, "reset_announcement", {
        content: `The attempt was reset. Provisional rewards were discarded; penalties remain. Start again at ${compiled.input.start}.`,
        submissionId: breakingMessageId,
      });
    });
  }

  private completeRound(round: RoundRow, attemptId: string, outboxIds: string[]): void {
    const now = this.clock.now().toISOString();
    const contributions = this.database
      .prepare(
        `SELECT player_id, accepted_count, bonus_points
         FROM attempt_contributions WHERE attempt_id = ?`,
      )
      .all(attemptId) as { player_id: string; accepted_count: number; bonus_points: number }[];
    const awards = participationAwards(
      new Map(contributions.map(({ player_id, accepted_count }) => [player_id, accepted_count])),
    );
    const insertLedger = this.database.prepare(
      `INSERT INTO score_ledger
        (id, season_id, round_id, attempt_id, player_id, entry_type, delta, source_key, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const contribution of contributions) {
      insertLedger.run(
        this.ids.next(),
        round.season_id,
        round.id,
        attemptId,
        contribution.player_id,
        "participation",
        awards.get(contribution.player_id),
        `participation:${round.id}:${contribution.player_id}`,
        now,
      );
      if (contribution.bonus_points > 0) {
        insertLedger.run(
          this.ids.next(),
          round.season_id,
          round.id,
          attemptId,
          contribution.player_id,
          "bonus",
          contribution.bonus_points,
          `bonus:${round.id}:${contribution.player_id}`,
          now,
        );
      }
    }
    this.database
      .prepare("UPDATE attempts SET state = 'completed', ended_at = ? WHERE id = ?")
      .run(now, attemptId);
    this.database
      .prepare(
        "UPDATE rounds SET state = 'completed', completed_at = ?, paused_from_state = NULL WHERE id = ?",
      )
      .run(now, round.id);
    this.database.prepare("DELETE FROM round_bans WHERE round_id = ?").run(round.id);
    const leaderboard = this.repository.leaderboard();
    outboxIds.push(
      this.enqueue(round.channel_id, "completion_announcement", {
        content: "The round is complete. Final rewards have been recorded.",
        roundId: round.id,
      }),
      this.enqueue(round.channel_id, "leaderboard_publication", {
        content: this.renderLeaderboard(leaderboard),
        roundId: round.id,
        leaderboard,
      }),
    );
    this.audit("round_completed", round.id, null, { attemptId });
  }

  private renderLeaderboard(entries: readonly LeaderboardEntry[]): string {
    if (entries.length === 0) {
      return "The seasonal leaderboard is empty.";
    }
    return entries
      .map((entry, index) => `${index + 1}. ${entry.displayName}: ${entry.total}`)
      .join("\n");
  }

  async pauseRound(actorId: string | null = null): Promise<void> {
    this.repository.immediate(() => {
      const round = this.requireActiveRound();
      const state: EngineState = {
        roundState: round.state,
        ...(round.paused_from_state === null ? {} : { pausedFrom: round.paused_from_state }),
        nextPosition: 0,
        acceptedCount: 0,
        bannedPlayerIds: new Set(),
      };
      const paused = pauseEngineRound(state);
      this.database
        .prepare("UPDATE rounds SET state = 'paused', paused_from_state = ? WHERE id = ?")
        .run(paused.pausedFrom, round.id);
      this.audit("round_paused", round.id, actorId, {});
    });
  }

  async resumeRound(actorId: string | null = null): Promise<void> {
    this.repository.immediate(() => {
      const round = this.requireActiveRound();
      const resumed = resumeEngineRound({
        roundState: round.state,
        ...(round.paused_from_state === null ? {} : { pausedFrom: round.paused_from_state }),
        nextPosition: 0,
        acceptedCount: 0,
        bannedPlayerIds: new Set(),
      });
      this.database
        .prepare("UPDATE rounds SET state = ?, paused_from_state = NULL WHERE id = ?")
        .run(resumed.roundState, round.id);
      this.audit("round_resumed", round.id, actorId, {});
    });
  }

  async cancelRound(actorId: string | null = null): Promise<void> {
    this.repository.immediate(() => {
      const round = this.requireActiveRound();
      cancelEngineRound({
        roundState: round.state,
        ...(round.paused_from_state === null ? {} : { pausedFrom: round.paused_from_state }),
        nextPosition: 0,
        acceptedCount: 0,
        bannedPlayerIds: new Set(),
      });
      const now = this.clock.now().toISOString();
      const activeAttempt = this.database
        .prepare("SELECT id FROM attempts WHERE round_id = ? AND state = 'active'")
        .get(round.id) as AttemptRow | undefined;
      if (activeAttempt !== undefined) {
        this.database.prepare("DELETE FROM attempt_contributions WHERE attempt_id = ?").run(activeAttempt.id);
        this.database
          .prepare("UPDATE attempts SET state = 'cancelled', ended_at = ? WHERE id = ?")
          .run(now, activeAttempt.id);
      }
      this.database
        .prepare(
          `UPDATE rounds SET state = 'cancelled', cancelled_at = ?, paused_from_state = NULL
           WHERE id = ?`,
        )
        .run(now, round.id);
      this.database.prepare("DELETE FROM round_bans WHERE round_id = ?").run(round.id);
      this.enqueue(round.channel_id, "cancellation_announcement", {
        content: "The round was cancelled. Provisional rewards were discarded; penalties remain.",
        roundId: round.id,
      });
      this.audit("round_cancelled", round.id, actorId, {});
    });
  }

  async banPlayer(playerId: string, displayName: string, actorId: string): Promise<void> {
    this.repository.immediate(() => {
      const round = this.requireActiveRound();
      this.ensurePlayer(playerId, displayName);
      this.database
        .prepare(
          `INSERT INTO round_bans (round_id, player_id, banned_at) VALUES (?, ?, ?)
           ON CONFLICT(round_id, player_id) DO NOTHING`,
        )
        .run(round.id, playerId, this.clock.now().toISOString());
      this.audit("player_banned", round.id, actorId, { playerId });
    });
  }

  async unbanPlayer(playerId: string, actorId: string): Promise<void> {
    this.repository.immediate(() => {
      const round = this.requireActiveRound();
      this.database
        .prepare("DELETE FROM round_bans WHERE round_id = ? AND player_id = ?")
        .run(round.id, playerId);
      this.audit("player_unbanned", round.id, actorId, { playerId });
    });
  }

  async resetSeason(actorId: string | null = null): Promise<string> {
    return this.repository.immediate(() => {
      if (this.activeRound() !== undefined) {
        throw new Error("cannot reset season while an active round exists");
      }
      this.assertNoUnsettledTerminalRound();
      const now = this.clock.now().toISOString();
      this.database.prepare("UPDATE seasons SET ended_at = ? WHERE ended_at IS NULL").run(now);
      const seasonId = this.ids.next();
      this.database.prepare("INSERT INTO seasons (id, started_at) VALUES (?, ?)").run(seasonId, now);
      this.audit("season_reset", null, actorId, { seasonId });
      return seasonId;
    });
  }
}
