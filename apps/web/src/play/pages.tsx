import { PillButton, PillLink } from "../ui/pill";
import { Section } from "../ui/section";
import { Page } from "../ui/shell";
import { Stats } from "../ui/stat";
import { EmptyState } from "../ui/empty";
import type { Category } from "./catalog";
import type { Game, RoundResult } from "./game";
import { roundSeconds, roundsPerGame } from "./game";
import type { Preview } from "./sources";

export function categoriesPage(categories: Category[], signedIn: boolean) {
  return Page({
    title: "Guess the song",
    account: <a href="/settings">Account</a>,
    children: (
      <>
        <div class="page-head">
          <h1>Guess the song</h1>
          <p class="meta">
            Ten rounds, {roundSeconds} seconds each. A right answer is worth up
            to 1,000 points, and the faster you answer the more it scores.
          </p>
        </div>
        <div class="play-grid">
          {categories.map((category) => (
            <section class="play-card" key={category.slug}>
              <h2>{category.name}</h2>
              {category.feed === "mine" && !signedIn ? (
                <p class="hint">
                  Your own top tracks. <a href="/">Sign in</a> to play.
                </p>
              ) : (
                <form method="post" action="/play">
                  <input type="hidden" name="category" value={category.slug} />
                  <div class="modes">
                    <button
                      class="pill small primary"
                      type="submit"
                      name="mode"
                      value="choices"
                    >
                      Choices
                    </button>
                    <button
                      class="pill small"
                      type="submit"
                      name="mode"
                      value="typed"
                    >
                      Type it
                    </button>
                  </div>
                </form>
              )}
            </section>
          ))}
        </div>
        <p class="meta">
          Songs and previews come from Deezer and Apple Music. Each reveal links
          to the track on the service it came from.
        </p>
      </>
    ),
  });
}

const clipScript = (remainingMs: number) => `
const clip = document.getElementById("clip");
const bar = document.getElementById("count-bar");
const left = document.getElementById("count-left");
const answerForm = document.getElementById("answer-form");
let deadline = performance.now() + ${Math.max(0, remainingMs)};
clip.addEventListener("timeupdate", () => {
  if (clip.currentTime >= ${roundSeconds}) clip.pause();
});
const tick = setInterval(() => {
  const ms = Math.max(0, deadline - performance.now());
  left.textContent = String(Math.ceil(ms / 1000));
  bar.style.transform = "scaleX(" + ms / ${roundSeconds * 1000} + ")";
  if (ms <= 0) {
    clearInterval(tick);
    answerForm.submit();
  }
}, 200);
`;

export function questionPage(
  game: Game,
  preview: Preview,
  choices: string[],
  now: number,
) {
  const remaining = roundSeconds * 1000 - (now - game.current!.servedAt);
  const action = `/play/${game.id}/answer`;
  return Page({
    title: `${game.categoryName} · Guess the song`,
    account: <a href="/settings">Account</a>,
    children: (
      <>
        <div class="page-head">
          <p class="meta">
            {game.categoryName} · Round {game.results.length + 1} of{" "}
            {roundsPerGame} · Score {game.total}
          </p>
          <h1>Which song is this?</h1>
        </div>
        <Section
          title="Listen"
          aside={
            <span>
              <span id="count-left">{Math.ceil(remaining / 1000)}</span> s left
            </span>
          }
        >
          <div class="clip">
            {/* The player starts the clip; browsers block autoplay. */}
            <audio id="clip" src={preview.url} controls preload="auto" />
            <div class="share">
              <span id="count-bar" style="transform: scaleX(1)" />
            </div>
          </div>
          {game.mode === "choices" ? (
            <form
              id="answer-form"
              class="choices"
              method="post"
              action={action}
            >
              {choices.map((title) => (
                <button
                  class="pill choice"
                  type="submit"
                  name="choice"
                  value={title}
                >
                  {title}
                </button>
              ))}
            </form>
          ) : (
            <form id="answer-form" class="guess" method="post" action={action}>
              <div class="field">
                <label for="typed-answer">Song title</label>
                <input
                  id="typed-answer"
                  name="answer"
                  type="text"
                  autocomplete="off"
                  autofocus
                />
              </div>
              <div>
                <PillButton variant="primary" type="submit">
                  Guess
                </PillButton>
              </div>
            </form>
          )}
        </Section>
        <script dangerouslySetInnerHTML={{ __html: clipScript(remaining) }} />
      </>
    ),
  });
}

const serviceNames = { deezer: "Deezer", apple: "Apple Music" };

function revealPage(game: Game, result: RoundResult) {
  const heading = result.correct
    ? "Correct"
    : result.timedOut
      ? "Time ran out"
      : "Not quite";
  const last = game.results.length >= roundsPerGame;
  return Page({
    title: `${heading} · ${game.categoryName}`,
    account: <a href="/settings">Account</a>,
    children: (
      <>
        <div class="page-head">
          <p class="meta">
            {game.categoryName} · Round {game.results.length} of {roundsPerGame}{" "}
            · Score {game.total}
          </p>
          <h1>{heading}</h1>
        </div>
        <Section title={result.title} aside={`+${result.score}`}>
          <div class="reveal">
            {result.cover && (
              <img src={result.cover} alt="" width="96" height="96" />
            )}
            <div class="track">
              <b>{result.title}</b>
              <small class="muted">{result.artist}</small>
              {result.link && (
                <a href={result.link}>
                  Listen on {serviceNames[result.service]}
                </a>
              )}
            </div>
          </div>
          {!result.correct && result.answer && (
            <p class="meta">Your answer: {result.answer}</p>
          )}
          <form method="post" action={`/play/${game.id}/next`}>
            <PillButton variant="primary" type="submit">
              {last ? "See results" : "Next round"}
            </PillButton>
          </form>
        </Section>
      </>
    ),
  });
}

function resultLine(result: RoundResult) {
  return result.correct ? `+${result.score}` : result.timedOut ? "time" : "0";
}

export function finalPage(game: Game) {
  const correct = game.results.filter((result) => result.correct).length;
  return Page({
    title: `Game over · ${game.categoryName}`,
    account: <a href="/settings">Account</a>,
    children: (
      <>
        <div class="page-head">
          <p class="meta">{game.categoryName}</p>
          <h1>Game over</h1>
        </div>
        <Stats
          items={[
            { label: "Score", value: game.total },
            { label: "Correct", value: correct },
            { label: "Rounds", value: game.results.length },
          ]}
        />
        <Section title="Rounds">
          <ul class="rows">
            {game.results.map((result) => (
              <li>
                <div class="track">
                  <b>{result.title}</b>
                  <small>
                    {result.artist}
                    {result.answer && !result.correct
                      ? ` · your answer: ${result.answer}`
                      : ""}
                  </small>
                </div>
                <span class="count">{resultLine(result)}</span>
              </li>
            ))}
          </ul>
        </Section>
        <p>
          <PillLink href="/play" variant="primary">
            Play again
          </PillLink>
        </p>
      </>
    ),
  });
}

export function gamePage(
  game: Game,
  view:
    | { kind: "question"; preview: Preview; choices: string[] }
    | { kind: "reveal" }
    | { kind: "done" }
    | { kind: "error" },
  now: number,
) {
  if (view.kind === "reveal")
    return revealPage(game, game.results[game.results.length - 1]);
  if (view.kind === "done") return finalPage(game);
  if (view.kind === "error")
    return Page({
      title: "Preview unavailable",
      account: <a href="/settings">Account</a>,
      children: (
        <EmptyState
          title="The preview could not be loaded"
          body="The music service did not answer. Try again in a moment."
          action={{ href: "/play", label: "Back to categories" }}
          heading="h1"
        />
      ),
    });
  return questionPage(game, view.preview, view.choices, now);
}

export function feedErrorPage(name: string) {
  return Page({
    title: "Category unavailable",
    account: <a href="/settings">Account</a>,
    children: (
      <EmptyState
        title={`${name} is not available right now`}
        body="The music feed did not answer. Pick another category or try again in a moment."
        action={{ href: "/play", label: "Back to categories" }}
        heading="h1"
      />
    ),
  });
}
