export const maxSourcesPerPull = 10;

export const idlePullDelay = (idlePulls: number) =>
  Math.min(6 * 60 * 60, 15 * 60 * 2 ** idlePulls);

export function nextPullDelay(inserted: number, idlePulls: number) {
  return inserted > 0 ? 15 * 60 : idlePullDelay(idlePulls);
}

export const nextUtcMidnight = (now: number) =>
  Math.floor(now / 86400) * 86400 + 86400;

export const dailyLimitPattern = /daily row (?:read|write) limit/i;
