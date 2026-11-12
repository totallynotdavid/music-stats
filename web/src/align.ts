export type PagePair = readonly [day: string, videoId: string];

export interface Alignment {
  newCount: number;
  ambiguous: number;
  gap: boolean;
  replay: boolean;
}

const separator: PagePair = ["", ""];

function samePair(a: PagePair, b: PagePair) {
  return a[0] === b[0] && a[1] === b[1];
}

function zValues(series: PagePair[]) {
  const z = Array.from({ length: series.length }, () => 0);
  let left = 0;
  let right = 0;
  for (let i = 1; i < series.length; i += 1) {
    if (i < right) z[i] = Math.min(right - i, z[i - left]);
    while (i + z[i] < series.length && samePair(series[i + z[i]], series[z[i]]))
      z[i] += 1;
    if (i + z[i] > right) {
      left = i;
      right = i + z[i];
    }
  }
  return z;
}

export function alignPage(
  previous: PagePair[] | null,
  next: PagePair[],
): Alignment {
  const nextLength = next.length;
  if (previous === null)
    return { newCount: nextLength, ambiguous: 0, gap: false, replay: false };
  const previousLength = previous.length;
  if (
    nextLength === previousLength &&
    next.every((pair, index) => samePair(pair, previous[index]))
  )
    return { newCount: 0, ambiguous: 0, gap: false, replay: true };

  const need = Math.min(2, previousLength, nextLength);
  const z = zValues([...previous, separator, ...next]);
  const runAt = (start: number) => z[previousLength + 1 + start];

  let firstCandidate = -1;
  let lastCandidate = -1;
  for (
    let start = Math.max(0, nextLength - previousLength);
    start + need <= nextLength;
    start += 1
  ) {
    if (runAt(start) >= nextLength - start) {
      if (firstCandidate < 0) firstCandidate = start;
      lastCandidate = start;
    }
  }
  if (firstCandidate >= 0)
    return {
      newCount: firstCandidate,
      ambiguous: lastCandidate - firstCandidate,
      gap: false,
      replay: false,
    };

  let bestRun = 0;
  let firstRun = -1;
  let lastRun = -1;
  for (let start = 0; start < nextLength; start += 1) {
    const run = runAt(start);
    if (run > bestRun) {
      bestRun = run;
      firstRun = start;
      lastRun = start;
    } else if (run === bestRun) {
      lastRun = start;
    }
  }
  if (bestRun >= need)
    return {
      newCount: firstRun,
      ambiguous: lastRun - firstRun,
      gap: false,
      replay: false,
    };

  return { newCount: nextLength, ambiguous: 0, gap: true, replay: false };
}
