import { describe, expect, it } from "vitest";
import { alignPage, type PagePair } from "../src/align";

const page = (items: string): PagePair[] =>
  items
    .split(" ")
    .filter(Boolean)
    .map((item) => {
      const [day = "2026-11-11", videoId = item] = item.split(":");
      return [day, videoId];
    });

describe("page alignment", () => {
  it.each([
    {
      name: "first upload stores every play",
      previous: null,
      next: "c b a",
      newCount: 3,
      ambiguous: 0,
      gap: false,
      replay: false,
    },
    {
      name: "a new head and a lost tail stores one play",
      previous: "c b a",
      next: "x c b",
      newCount: 1,
      ambiguous: 0,
      gap: false,
      replay: false,
    },
    {
      name: "an identical page is a replay",
      previous: "x c b",
      next: "x c b",
      newCount: 0,
      ambiguous: 0,
      gap: false,
      replay: true,
    },
    {
      name: "a page that shares nothing is a gap",
      previous: "x c b",
      next: "q r s",
      newCount: 3,
      ambiguous: 0,
      gap: true,
      replay: false,
    },
    {
      name: "a gap recovers on the next overlap",
      previous: "q r s",
      next: "t q r",
      newCount: 1,
      ambiguous: 0,
      gap: false,
      replay: false,
    },
    {
      name: "one repeated pair at the head is exact",
      previous: "A A B",
      next: "A A A",
      newCount: 1,
      ambiguous: 0,
      gap: false,
      replay: false,
    },
    {
      name: "a repeated pair all down the page marks the spread",
      previous: "A A A",
      next: "A A A A",
      newCount: 1,
      ambiguous: 1,
      gap: false,
      replay: false,
    },
    {
      name: "a candidate shorter than the need is ruled out",
      previous: "A A",
      next: "A A A",
      newCount: 1,
      ambiguous: 0,
      gap: false,
      replay: false,
    },
    {
      name: "a page that keeps only the head stores no new play",
      previous: "c b a",
      next: "c b",
      newCount: 0,
      ambiguous: 0,
      gap: false,
      replay: false,
    },
    {
      name: "a page longer than the last one aligns at its tail",
      previous: "b c",
      next: "x a b c",
      newCount: 2,
      ambiguous: 0,
      gap: false,
      replay: false,
    },
    {
      name: "an edit breaks the run but the best run still positions",
      previous: "a b c d e",
      next: "x a b y c",
      newCount: 1,
      ambiguous: 0,
      gap: false,
      replay: false,
    },
    {
      name: "tied runs count as ambiguous",
      previous: "a b c d",
      next: "x a b y a b w",
      newCount: 1,
      ambiguous: 3,
      gap: false,
      replay: false,
    },
    {
      name: "a single shared pair aligns when the need is one",
      previous: "a",
      next: "x a",
      newCount: 1,
      ambiguous: 0,
      gap: false,
      replay: false,
    },
    {
      name: "a single pair pages apart is a gap",
      previous: "a b",
      next: "x y",
      newCount: 2,
      ambiguous: 0,
      gap: true,
      replay: false,
    },
    {
      name: "days are part of the pair",
      previous: "2026-11-10:a 2026-11-10:b",
      next: "2026-11-11:a 2026-11-10:a 2026-11-10:b",
      newCount: 1,
      ambiguous: 0,
      gap: false,
      replay: false,
    },
  ])("$name", ({ previous, next, newCount, ambiguous, gap, replay }) => {
    const alignment = alignPage(
      previous === null ? null : page(previous),
      page(next),
    );
    expect(alignment).toEqual({ newCount, ambiguous, gap, replay });
  });
});
