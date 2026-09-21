export type ParticipationAward = 2 | 3 | 4 | 5;
export type PenaltySeverity = -2 | -3 | -4 | -5;
export type PenaltyTotal = 0 | PenaltySeverity;
export type PenaltyDelta = 0 | -1 | -2 | -3 | -4 | -5;

export function participationAwards(
  counts: ReadonlyMap<string, number>,
): ReadonlyMap<string, ParticipationAward> {
  if (counts.size === 0) {
    return new Map();
  }

  let total = 0n;
  for (const count of counts.values()) {
    if (!Number.isSafeInteger(count) || count <= 0) {
      throw new RangeError("contribution count must be a positive safe integer");
    }
    total += BigInt(count);
  }

  const participantCount = BigInt(counts.size);
  const awards = new Map<string, ParticipationAward>();
  for (const [playerId, count] of counts) {
    const relativeContribution = BigInt(count) * participantCount;
    let award: ParticipationAward;
    if (relativeContribution * 2n >= total * 3n) {
      award = 5;
    } else if (relativeContribution * 10n >= total * 11n) {
      award = 4;
    } else if (relativeContribution * 4n >= total * 3n) {
      award = 3;
    } else {
      award = 2;
    }
    awards.set(playerId, award);
  }
  return awards;
}

export function penaltySeverity(accepted: number, required: number): PenaltySeverity {
  if (
    !Number.isSafeInteger(required) ||
    required <= 0 ||
    !Number.isSafeInteger(accepted) ||
    accepted <= 0 ||
    accepted > required
  ) {
    throw new RangeError("accepted progress must be between one and the required count");
  }

  const completed = BigInt(accepted);
  const total = BigInt(required);
  if (completed * 4n <= total) {
    return -2;
  }
  if (completed * 2n <= total) {
    return -3;
  }
  if (completed * 4n <= total * 3n) {
    return -4;
  }
  return -5;
}

export function additionalPenalty(
  previous: PenaltyTotal,
  next: PenaltySeverity,
): PenaltyDelta {
  return (next < previous ? next - previous : 0) as PenaltyDelta;
}
