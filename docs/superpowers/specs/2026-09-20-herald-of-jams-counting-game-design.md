# Herald of Jams Counting Game Design

**Date:** 2026-09-20
**Status:** Approved base design; announcement and cancellation revision awaiting implementation planning

## Purpose

Herald of Jams will facilitate and moderate a hidden-pattern cooperative counting game in one Discord text channel. Players submit whole numbers in an ascending sequence without skipping or repeating an expected value and without the same player making two accepted submissions in succession. A broken attempt restarts from the configured starting number. Successful participation, hidden bonuses, and bounded penalties contribute to a persistent seasonal leaderboard.

The first release is for one Discord server, one configured game channel, and one active round at a time. Administration happens through a password-protected web interface available on the private network. Players interact through ordinary Discord messages and a public leaderboard slash command.

## Goals

- Let an administrator privately construct reusable rounds from safe structured rules.
- Let an administrator edit global announcement defaults and override them per round template.
- Keep sequence, skip, and bonus rules hidden from players.
- Compile each round into a deterministic, immutable sequence before activation.
- Preserve a clear Discord-visible record of accepted and count-breaking numeric submissions.
- Recover safely from Discord disconnects, API failures, duplicate events, and process restarts.
- Maintain an ongoing seasonal leaderboard across multiple rounds.
- Bound each player's negative score exposure so mistakes do not make continued play pointless.
- Provide manual, round-scoped controls for excluding disruptive players from game submissions without silencing ordinary conversation.

## Non-goals

- Arbitrary administrator-authored JavaScript or mathematical expressions.
- Multiple Discord servers, multiple game channels, or concurrent rounds.
- Public-internet administration in the first release.
- Automatic detection of malicious intent.
- Automatic escalating game lockouts.
- Voice-channel gameplay, Discord Activities, prefix commands, or direct-message gameplay.
- Preventing Discord administrators from deleting bot-authored canonical messages.

## Technology Direction

- TypeScript on Node.js
- discord.js for Discord Gateway events and application commands
- A small TypeScript HTTP server and browser interface in the same deployed service
- SQLite for persistent game, audit, and scoring state
- pnpm for package management
- Vitest for automated testing

Exact framework and package versions will be pinned in the implementation plan after checking current supported releases.

## System Boundaries

The service is divided into focused units:

1. **Discord adapter** connects to Discord, receives message events, registers the leaderboard command, and delivers canonical game output.
2. **Submission parser** determines whether a Discord message is an eligible numeric submission.
3. **Round compiler** converts structured rules into a finite immutable sequence and evaluates bonus matches.
4. **Game engine** applies submissions to a deterministic state machine without depending directly on Discord or SQLite.
5. **Scoring service** calculates participation awards, stacked bonuses, and bounded penalties.
6. **Persistence layer** transactionally stores seasons, rounds, attempts, submissions, moderation, score ledger entries, audit records, and pending Discord work.
7. **Administration server** authenticates an administrator and exposes private configuration, preview, control, moderation, scoring, and audit pages.

Discord and HTTP handlers translate external input into application commands. Domain decisions remain in the compiler, game engine, and scoring service so they can be tested without network services.

## Round Configuration

A reusable round template contains:

- Private name and optional administrator notes
- Discord game channel
- Non-negative starting number
- Positive integer step size
- Target number greater than or equal to the starting number
- Zero or more skip rules
- Zero or more bonus rules
- Optional per-template overrides for bonus, reset, completion, and cancellation announcements

The first release supports these predicates for skip and bonus rules:

- The value is prime.
- The value is divisible by a configured positive integer.
- The value equals one of a configured set of explicit values.
- The value falls within a configured inclusive range.

Skip predicates are combined with logical OR: a candidate matching any skip rule is omitted. Bonus predicates are evaluated independently and stack. An accepted value matching three bonus rules earns three provisional bonus points.

## Sequence Compilation

The compiler generates an ordered list before a round may be activated:

1. Include the configured starting number.
2. Add the configured step to produce the next candidate.
3. Omit candidates after the starting value when they match any skip predicate.
4. Include each remaining candidate in ascending order.
5. Stop only when the configured target is included.

The compiler also records every bonus rule matched by every included value. It rejects a configuration when:

- Start, step, or target is not a non-negative JavaScript safe integer.
- Step is zero or negative.
- Target is less than start.
- A divisor is zero or invalid.
- A range has invalid or reversed bounds.
- The target is skipped when it is distinct from the always-included starting value.
- Stepping passes the target without reaching it exactly.
- Generation would exceed 100,000 included entries or the corresponding bounded candidate-iteration limit.
- Any generated result is repeated, non-integer, decreasing, or outside the safe-integer range.

The private preview shows the complete generated sequence, total required submissions, bonus values, number of bonus rules matching each value, and progress thresholds used for penalties. Activating a round copies this output into an immutable compiled-round record. Later edits to the reusable template cannot change the active round.

A template whose target equals its starting number compiles to exactly one required submission. Accepting that submission starts and completes the attempt in the same transaction, making single-player completion testing possible without weakening the consecutive-player rule for longer rounds.

## Announcement Configuration

The administration interface provides editable global defaults for four Discord announcements:

- Provisional bonus earned
- Attempt reset after a break
- Round completed
- Round cancelled

Each reusable round template has an optional override for each announcement. A blank override inherits the current global default. Preview shows the effective announcement templates that activation would use. Activation resolves global defaults and template overrides into the immutable compiled-round snapshot, so edits made after activation affect only future rounds.

Announcement templates support a small context-specific placeholder allowlist:

- Bonus: `{player}` and `{bonusPoints}`
- Reset: `{start}`
- Completion: no dynamic placeholders
- Cancellation: no dynamic placeholders

Unknown or context-inappropriate placeholders are rejected. Global defaults must be non-empty; per-template overrides may be blank only to request inheritance. Stored templates are length-bounded so every rendered Discord message remains within Discord's 2,000-character limit. Rendering performs literal placeholder substitution only; announcement configuration cannot execute code, access hidden state, or introduce arbitrary expressions.

The built-in initial defaults preserve the existing bonus, reset, and completion intent. The cancellation default states that all provisional rewards and round penalties were discarded. Existing templates inherit global defaults automatically. Existing active compiled rounds that predate announcement snapshots use the built-in defaults as a compatibility fallback.

## Submission Parsing

Only an original Discord message whose entire content matches decimal digits is a numeric submission. Leading zeroes are permitted and normalized, so `001` is the value `1`.

The following are ignored as ordinary conversation:

- Spelled-out values such as `one` or `thirty three`
- Negative signs, plus signs, decimals, fractions, or scientific notation
- Numbers mixed with words, punctuation, whitespace, emoji, or mentions
- Messages outside the configured game channel
- Direct messages
- Messages authored by bots or webhooks

Normalized values must fall between zero and JavaScript's maximum safe integer. Digit-only values outside that range are removed from the game channel and treated as invalid numeric submissions when an attempt is active.

## Round and Attempt Lifecycle

A round moves through these states:

```text
Draft -> Ready -> WaitingForStart -> Counting -> Completed
Counting -> Broken -> WaitingForStart
WaitingForStart | Counting -> Paused -> preserved prior state
WaitingForStart | Counting | Paused -> Cancelled
```

- **Draft:** Configuration may be edited and previewed.
- **Ready:** Compilation succeeded and the immutable configuration is ready for activation.
- **WaitingForStart:** The round is active but no attempt is counting. Only the original starting number begins an attempt.
- **Counting:** The engine expects the next compiled sequence entry.
- **Paused:** A reversible administrative state that preserves the prior `WaitingForStart` or `Counting` state, active attempt, expected value, provisional rewards, penalties, and bans. Resuming returns to the preserved state. Numeric-only messages received while paused are deleted without evaluation, canonical replacement, or score change.
- **Broken:** A transient recorded outcome that closes the failed attempt, announces the failure, and returns the round to `WaitingForStart`.
- **Completed:** A terminal successful outcome. The target was accepted, successful-attempt rewards were committed, and required completion and leaderboard-publication work was created. Discord publication determines operational settlement but does not delay the state transition.
- **Cancelled:** A terminal administrative outcome. Cancellation closes any active attempt, discards its provisional participation and bonus data, removes every penalty charge and worst-severity record belonging to the round, expires round bans, and creates required cancellation-announcement work. A cancelled round cannot be resumed.

While waiting for the starting number, other numeric-only messages are deleted and ignored. They cause no score change and receive no canonical replacement. The starting submission establishes the first contributor for consecutive-player checks.

Accepting the starting submission is one transaction that creates the attempt, records the accepted submission, establishes the first contributor, advances the compiled-sequence position, transitions the round to `Counting`, and creates the ordered canonical-message and original-deletion work. The starting submission is canonicalized in the same way as every later accepted submission.

An active attempt breaks when an eligible player submits:

- A value other than the next expected sequence entry
- A duplicate or skipped value, both of which are instances of an unexpected value
- A submission immediately after their own previous accepted submission, regardless of intervening non-numeric conversation
- A digit-only value outside the supported numeric range

The failure announcement never reveals the expected value, hidden sequence rules, or matching predicates.

## Discord Message Canonicalization

Eligible numeric submissions are processed through one serialized queue for the configured channel. Discord arrival order determines evaluation order.

For every accepted starting submission and every eligible numeric submission evaluated during `Counting`, including the submission that breaks the attempt:

1. Record the original message ID, author ID, original digit string, normalized safe value when available, and decision transactionally.
2. Create a bot-authored canonical message such as `@Player -> 42`. An out-of-range digit string is preserved verbatim in the canonical breaking submission because it has no supported normalized value.
3. Delete the player's original numeric message.
4. For a break, create a separate failure-and-reset announcement after the canonical message.

Ordinary players cannot edit bot-authored canonical messages. Discord administrators with message-management permissions can still delete them. Deleting a canonical message does not rewrite game history; it creates a private audit event.

The effective reset announcement is snapshotted at activation. The built-in default says the attempt was reset, states that failed-attempt participation and bonus points were discarded while penalties remain, and reminds players of the original starting number. It never exposes hidden rules or the expected next value.

Persistence uses an outbox-style record for canonical messages, deletions, bonus announcements, reset announcements, completion announcements, cancellation announcements, and leaderboard publication. Duplicate Discord events are ignored by original message ID. Incomplete work is retried after reconnect or restart without applying the submission twice.

Each channel outbox operation has a stable operation ID, a monotonically increasing sequence number, an optional predecessor, a fully snapshotted payload, retry state, and the resulting Discord message ID when applicable. A single dispatcher executes operations in sequence and does not start an operation until its predecessor has succeeded or an administrator has explicitly resolved the predecessor. For one submission, required delivery order is canonical message, original-message deletion, and then any bonus, reset, completion, cancellation, or leaderboard output caused by that decision.

Submission decisions, state transitions, score-ledger changes, audit events, and their required ordered outbox operations commit atomically in SQLite before Discord is called. No database transaction remains open during a Discord API request. SQLite state is therefore exactly-once by original message ID, while Discord effects use idempotent retry and reconciliation rather than claiming a distributed transaction.

Message-creation operations use a deterministic Discord nonce derived from the stable outbox operation ID and request nonce enforcement. After an ambiguous response, the dispatcher reconciles recent bot-authored channel history by nonce before retrying. It retries automatically only while Discord can still enforce nonce uniqueness. If delivery remains ambiguous outside that window, the operation enters an administrator-visible review state rather than risking a blind duplicate. Deleting an already absent message is treated as successful.

If required persistence fails, the game pauses numeric processing. If canonical delivery or deletion fails after persistence, the decision remains recorded and the pending Discord work is retried and surfaced in the administration interface.

## Hidden Bonuses

When an accepted value matches one or more bonus rules, the bot renders the effective bonus announcement with the submitting player and total provisional bonus, but never exposes why the value qualified.

Each matching rule contributes one point. Overlapping conditions therefore stack. Bonus awards from an attempt are provisional until that attempt reaches the target. When an attempt breaks, all of its provisional participation and bonus data is discarded, and the reset announcement makes that explicit.

## Participation Scoring

Only submissions from the successful attempt qualify for participation points.

For a completed round:

```text
average contribution = successful-attempt submissions / successful-attempt participants
player ratio = player successful-attempt submissions / average contribution
```

Awards are:

| Player ratio | Participation points |
| --- | ---: |
| At least 150% | 5 |
| At least 110% and below 150% | 4 |
| At least 75% and below 110% | 3 |
| Below 75%, with at least one successful-attempt submission | 2 |

All ratios are computed from exact integer counts before comparison. Every contributor to the successful attempt receives at least two participation points. There is no forced ranking, so ties and groups in the same band receive the same award.

The completed-round score change is the participation award plus all stacked bonus points from that successful attempt. These entries are appended to the current season's score ledger before the completion announcement and leaderboard are published.

## Penalties

Penalty severity uses completed steps in the current attempt immediately before the breaking submission:

```text
progress = accepted submissions in current attempt / total submissions required by compiled sequence
```

| Progress before break | Penalty severity |
| --- | ---: |
| Through 25% | -2 |
| More than 25% through 50% | -3 |
| More than 50% through 75% | -4 |
| More than 75% | -5 |

An active attempt always contains the accepted starting number, so its progress is greater than zero before any breaking submission. Numeric messages received while waiting for that starting number carry no penalty.

Each player is charged only their single worst severity for the round. If a player's recorded severity changes from `-2` to `-5`, a new ledger entry charges only the additional `-3`. Later breaks with severity `-5` or less severe create audit records but no score change. The cap resets at the start of each new round.

Penalty deltas are committed immediately and remain while a round is active or paused. Cancelling the entire round atomically deletes all of that round's penalty ledger entries and worst-severity records, returning every affected player's seasonal total to the value it would have had without the cancelled round. The cancellation audit records the number and total value of discarded penalty entries without retaining a score charge. A player's maximum loss from penalties is five points per non-cancelled round.

## Seasonal Leaderboard

Current totals are derived from score-ledger entries rather than being the only stored representation. Normal scoring is append-only; administrative round cancellation is the one explicit exception and removes only penalty entries owned by the cancelled round in the same transaction as the terminal state change.

The public `/leaderboard` slash command displays the current season's standings. Completing a round automatically posts the updated leaderboard in the game channel. Player identity is keyed by immutable Discord user ID; the interface may display the latest known server display name without using it as identity.

An administrator may reset the leaderboard only when no round is active and the preceding round is operationally settled. A completed or cancelled round remains unsettled while any required terminal announcement or leaderboard-publication operation is pending or under review. Activating another round and resetting the season are blocked until that terminal chain succeeds or an administrator explicitly abandons it with confirmation and an audit record. Terminal announcement and leaderboard payloads are snapshotted in the transaction that creates them and are never recalculated during retry.

Resetting archives the current season and opens a new season with zero totals. Historical seasons and their round breakdowns remain available in the administration interface.

## Manual Round Game Bans

Administrators may ban or unban a Discord member from the current round through the private web interface.

- A ban affects only numeric game submissions in the configured channel.
- Ordinary conversation remains untouched.
- Numeric-only messages from a banned player are deleted without evaluation or canonical replacement.
- A banned submission cannot advance or break the count and causes no score change.
- A failed deletion is still ignored by the engine and appears as a private operational warning.
- Applying or removing a ban does not change the current attempt.
- Pausing preserves round bans. All round bans expire when the round completes or is cancelled.

The bot requires `Manage Messages` in the game channel to enforce canonicalization and bans.

## Private Administration Interface

The browser interface provides:

- Login and logout
- Discord connection and permission status
- Current round and attempt status
- Reusable round-template management
- Editable global announcement defaults and per-template announcement overrides
- Structured sequence, skip-rule, and stackable bonus-rule editing
- Private compiled-sequence and scoring preview
- Round activation, pause, resume, and administrative cancellation
- Live round-scoped ban and unban controls
- Current leaderboard and archived season breakdowns
- Season reset with explicit confirmation
- Searchable private audit and operational-failure views

The server binds to a configured address and is intended for a private network. Loopback-only HTTP is permitted for development. Private-network deployment uses HTTPS through a local reverse proxy.

Authentication uses an administrator password hash and independent session secret supplied outside the repository. Sessions use HTTP-only same-site cookies, expiration, login throttling, and CSRF protection. Production session cookies are always `Secure`, use a narrowly scoped path, and honor HTTPS only through explicitly trusted reverse-proxy configuration. A non-`Secure` cookie is permitted only for loopback development. The bot token, password material, and session secret are never stored in SQLite or returned to browser code. Hidden rule data and sequence previews are never sent to Discord.

## Persistence Model

The relational model includes:

- `seasons` and season lifecycle timestamps
- `players` keyed by Discord user ID
- `round_templates` and structured rule definitions
- a singleton typed announcement-default record and nullable typed announcement overrides on `round_templates`
- `rounds` containing immutable compiled configuration and lifecycle state
- `compiled_entries` containing ordered values and matched bonus-rule identifiers
- `attempts` containing lifecycle and reset outcome
- `submissions` keyed by original Discord message ID
- `round_player_penalties` containing the worst severity per player
- `round_bans`
- `score_ledger` containing typed signed score deltas
- `discord_outbox` containing ordered, dependent, idempotent delivery and deletion work, snapshotted payloads, nonces, retry state, and resulting Discord message IDs
- a durable channel-reconciliation checkpoint containing the greatest Discord message ID fully examined in the configured game channel
- `audit_events`
- `admin_sessions`

State transitions, score-ledger mutations, audit events, and required outbox entries are created in the same SQLite transaction. Foreign keys and uniqueness constraints enforce ownership and Discord-event idempotency.

The schema migration for this revision rebuilds the round-template target constraint to allow `target = start`, adds typed global announcement defaults and nullable template overrides, and removes penalty ledger and worst-severity rows for rounds that were already cancelled under the earlier rule. The migration runs atomically, performs a foreign-key integrity check, and leaves completed and active round scoring untouched.

## Discord Permissions and Intents

The bot validates these capabilities before round activation:

- View the configured channel
- Read message history
- Send messages
- Manage messages
- Use application commands where the leaderboard is invoked
- Receive message content through the Discord Message Content privileged intent

Missing capabilities block activation and are shown in the administration interface. The bot requests no presence or guild-member-list privileged intent for this design.

## Error Handling and Recovery

- A lost Discord connection places numeric processing in `Reconciling` mode after connectivity returns. Reconciliation and live Gateway processing use the same serialized channel executor and never evaluate submissions concurrently.
- Reconciliation reads channel history after the durable channel checkpoint, establishes a high-water message ID, and processes messages through the normal parser and game engine in chronological Discord message-ID order.
- Normal reconciliation evaluation continues until it reaches the high-water mark, the round completes, or the first penalty-causing submission breaks the attempt. Accepted historical submissions receive the same canonical replacement and original deletion as live submissions. Cleanup and checkpoint advancement may continue after normal evaluation stops.
- When reconciliation encounters a penalty-causing submission, it commits the normal penalty and reset. Every later numeric message through the reconciliation high-water mark is recorded as invalidated and deleted without evaluation, canonical replacement, or score change. The reset announcement follows those ordered deletions.
- Messages arriving during reconciliation remain behind the reconciliation work in the serialized executor. Duplicate delivery through history and the Gateway is ignored by Discord message ID. The durable checkpoint advances only after each message's disposition and any required outbox work have committed.
- A database write failure pauses game processing and exposes an administrator-visible critical error.
- A Discord API failure remains in the outbox with bounded retry and visible failure state.
- Duplicate and replayed message events are idempotent by Discord message ID.
- Startup reconciliation reloads the active round, current attempt, previous accepted player, penalties, bans, and pending outbox work.
- The game does not infer a missing submission from channel history or advance state based on an unpersisted event.
- Administrators can inspect and retry failed outbound work but cannot manually edit accepted sequence history.

## Testing Strategy

### Unit tests

- Strict numeric parsing and normalization
- Every predicate and overlapping bonus match
- Sequence generation, reachability, boundaries, and safety caps
- Single-value sequence compilation and completion
- Announcement placeholder allowlists, inheritance, snapshotting, and rendered-length bounds
- Every state-machine transition
- Same-player, duplicate, skipped, unexpected, and out-of-range breaks
- Progress boundaries and worst-penalty delta behavior
- Relative contribution band boundaries and ties
- Round-ban behavior

### Integration tests

- SQLite transactions, constraints, migrations, and ledger totals
- Crash and restart recovery at each outbox stage
- Discord event duplication and serialized arrival ordering
- Disconnect reconciliation through successful completion and through a penalty-causing submission
- Invalidation of post-break numeric messages within the reconciliation window
- Canonical replacement for valid and breaking submissions
- Canonical replacement of the accepted starting submission
- Strict outbox dependency ordering, nonce reconciliation, ambiguous-delivery review, and restart at each operation boundary
- Deletion failures for originals and banned-player messages
- Successful completion, leaderboard publication, season archival, and reset guards
- Pause and resume with retained penalties; cancellation with removed round penalties, discarded provisional rewards, and round-ban expiry
- Migration of existing cancelled-round penalties and existing template inheritance
- Global announcement editing, per-template overrides, preview, CSRF protection, and immutable active-round wording
- Blocking round activation and season reset while terminal Discord work remains unsettled
- Authentication, session expiration, CSRF protection, throttling, and authorization

### Manual verification

A dedicated Discord test server and channel will verify permissions, Message Content intent, slash-command registration, canonical replacement ordering, bonus and reset announcements, round bans, reconnect recovery, and end-to-end administration over the private network before production use.

## Delivery Boundary

Implementation must not create or configure the Discord application, invite the bot to a server, expose the administration interface publicly, or store production secrets without explicit authorization. Repository implementation may provide documented setup steps and example environment-variable names without real credentials.
