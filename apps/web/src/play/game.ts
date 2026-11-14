import { base64url } from "../auth";
import { normalizeText } from "../normalize";
import type { Env } from "../types";
import type { Category } from "./catalog";
import {
  applePreview,
  appleSearchPreview,
  deezerIsrcPreview,
  deezerPreview,
  deezerSearchPreview,
  type Candidate,
  type Service,
} from "./sources";

export const roundSeconds = 15;
export const roundsPerGame = 10;
const gameTtlSeconds = 3600;
const extraCandidates = 6;
const maxChoices = 4;

export type Mode = "choices" | "typed";
export type Phase = "question" | "reveal" | "done";

export interface RoundResult {
  title: string;
  artist: string;
  cover: string | null;
  link: string | null;
  service: Service;
  answer: string | null;
  correct: boolean;
  timedOut: boolean;
  score: number;
}

export interface Game {
  id: string;
  mode: Mode;
  categorySlug: string;
  categoryName: string;
  candidates: Candidate[];
  pool: string[];
  next: number;
  served: number;
  phase: Phase;
  current: {
    index: number;
    servedAt: number;
    reveal: { service: Service; link: string | null; cover: string | null };
    // The distractor set is sampled once: re-sampling on each load would let
    // a reload narrow the answer to the title present in both lists.
    choices: string[];
  } | null;
  results: RoundResult[];
  total: number;
}

const gameKey = (id: string) => `play:game:${id}`;

export async function getGame(env: Env, id: string) {
  return (
    (await env.CACHE?.get<Game>(gameKey(id), "json").catch(() => null)) ?? null
  );
}

export async function putGame(env: Env, game: Game) {
  await env.CACHE?.put(gameKey(game.id), JSON.stringify(game), {
    expirationTtl: gameTtlSeconds,
  });
}

function shuffled<T>(items: T[]): T[] {
  const order = crypto.getRandomValues(new Uint32Array(items.length));
  return items
    .map((item, i) => ({ item, sort: order[i] }))
    .sort((a, b) => a.sort - b.sort)
    .map(({ item }) => item);
}

export async function buildGame(
  env: Env,
  category: Category,
  mode: Mode,
  candidates: Candidate[],
): Promise<Game> {
  const picked = shuffled(candidates).slice(0, roundsPerGame + extraCandidates);
  const game: Game = {
    id: base64url(crypto.getRandomValues(new Uint8Array(16))),
    mode,
    categorySlug: category.slug,
    categoryName: category.name,
    candidates: picked,
    pool: [...new Set(candidates.map((track) => track.title))],
    next: 0,
    served: 0,
    phase: "question",
    current: null,
    results: [],
    total: 0,
  };
  await putGame(env, game);
  return game;
}

async function candidatePreview(candidate: Candidate) {
  if (candidate.deezerId !== undefined)
    return deezerPreview(candidate.deezerId);
  if (candidate.appleId !== undefined)
    return applePreview(candidate.appleId, candidate.appleCountry ?? "us");
  if (candidate.isrc) {
    const byIsrc = await deezerIsrcPreview(
      candidate.isrc,
      candidate.artist,
    ).catch(() => null);
    if (byIsrc) return byIsrc;
  }
  const bySearch = await deezerSearchPreview(
    candidate.artist,
    candidate.title,
  ).catch(() => null);
  return bySearch ?? appleSearchPreview(candidate.artist, candidate.title);
}

// Skips candidates with no resolvable preview; the round is served only once
// a preview URL exists, so the timer never runs against a dead clip.
export async function serveRound(env: Env, game: Game, now: number) {
  if (game.current !== null) {
    // A refresh re-resolves the preview; the round's clock keeps its first
    // servedAt, so a reload cannot buy time.
    const preview = await candidatePreview(
      game.candidates[game.current.index],
    ).catch(() => null);
    return { game, preview };
  }
  while (game.next < game.candidates.length) {
    const index = game.next;
    game.next += 1;
    const candidate = game.candidates[index];
    const preview = await candidatePreview(candidate).catch(() => null);
    if (preview === null) continue;
    // The signed preview URL goes only to the page it was resolved for; the
    // stored round keeps the reveal data, never the URL itself.
    game.current = {
      index,
      servedAt: now,
      reveal: {
        service: preview.service,
        link: preview.link ?? candidate.link,
        cover: preview.cover ?? candidate.cover,
      },
      choices: game.mode === "choices" ? choicesFor(game, candidate.title) : [],
    };
    game.served += 1;
    await putGame(env, game);
    return { game, preview };
  }
  game.phase = "done";
  await putGame(env, game);
  return { game, preview: null };
}

export function scoreFor(elapsedMs: number) {
  if (elapsedMs >= roundSeconds * 1000) return 0;
  return Math.round(1000 - (900 * elapsedMs) / (roundSeconds * 1000));
}

function levenshtein(a: string, b: string) {
  const row = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i += 1) {
    let diagonal = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const above = row[j];
      row[j] = Math.min(
        row[j] + 1,
        row[j - 1] + 1,
        diagonal + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
      diagonal = above;
    }
  }
  return row[b.length];
}

// Bracketed clauses and a feat. credit are part of a title on a service but
// not of the name a player remembers.
export function answerKey(text: string) {
  const stripped = text
    .replace(/[[(][^\])]*[\])]/g, " ")
    .replace(/\s(?:feat\.?|ft\.?|featuring)\s.*$/i, "");
  return normalizeText(stripped);
}

export function matchTyped(input: string, title: string) {
  const given = answerKey(input);
  const wanted = answerKey(title);
  if (given === "" || wanted === "") return false;
  if (given === wanted) return true;
  const limit = wanted.length >= 10 ? 2 : 1;
  return levenshtein(given, wanted) <= limit;
}

export function choicesFor(game: Game, answer: string) {
  const answerNorm = answerKey(answer);
  const others = game.pool.filter(
    (title) => title !== answer && answerKey(title) !== answerNorm,
  );
  return shuffled([answer, ...shuffled(others).slice(0, maxChoices - 1)]);
}

export interface Answered {
  game: Game;
  result: RoundResult;
}

export async function answerRound(
  env: Env,
  game: Game,
  answer: { choice?: string; typed?: string },
  now: number,
): Promise<Answered | null> {
  if (game.phase !== "question" || game.current === null) return null;
  const candidate = game.candidates[game.current.index];
  const elapsed = now - game.current.servedAt;
  const timedOut = elapsed >= roundSeconds * 1000;
  let given: string | null;
  let correct: boolean;
  if (game.mode === "choices") {
    given = answer.choice ?? null;
    correct = !timedOut && given === candidate.title;
  } else {
    given = answer.typed?.trim() ? answer.typed!.trim() : null;
    correct = !timedOut && given !== null && matchTyped(given, candidate.title);
  }
  const score = correct ? scoreFor(elapsed) : 0;
  const result: RoundResult = {
    title: candidate.title,
    artist: candidate.artist,
    cover: game.current.reveal.cover,
    link: game.current.reveal.link,
    service: game.current.reveal.service,
    answer: given,
    correct,
    timedOut,
    score,
  };
  game.results.push(result);
  game.total += score;
  game.current = null;
  game.phase = "reveal";
  await putGame(env, game);
  return { game, result };
}

// The game ends when the round count is reached or the candidates ran out;
// both can only be decided after a reveal is acknowledged.
export function advance(game: Game) {
  if (game.phase !== "reveal") return false;
  game.phase =
    game.served >= roundsPerGame || game.next >= game.candidates.length
      ? "done"
      : "question";
  return true;
}
