import { Hono } from "hono";
import { csrf } from "hono/csrf";
import { notFoundPage } from "../app";
import { sessionUser } from "../auth";
import type { Env } from "../types";
import { catalog, getCategory, listCategories } from "./catalog";
import {
  advance,
  answerRound,
  buildGame,
  getGame,
  putGame,
  serveRound,
  type Mode,
} from "./game";
import { categoriesPage, feedErrorPage, gamePage } from "./pages";

export const playApp = new Hono<{ Bindings: Env }>();

playApp.use("*", csrf());

playApp.get("/", async (context) => {
  const user = await sessionUser(context);
  const categories = await listCategories(context.env.DB);
  return context.html(categoriesPage(categories, user !== null));
});

playApp.post("/", async (context) => {
  const body = await context.req.parseBody();
  const slug = typeof body.category === "string" ? body.category : "";
  const mode: Mode | null =
    body.mode === "choices" || body.mode === "typed" ? body.mode : null;
  if (slug === "" || mode === null)
    return context.text("Pick a category and a mode.", 400);
  const category = await getCategory(context.env.DB, slug);
  if (category === null) return context.html(notFoundPage(), 404);
  const user = await sessionUser(context);
  if (category.feed === "mine" && user === null)
    return context.redirect("/", 303);
  if (!context.env.CACHE)
    return context.html(feedErrorPage(category.name), 503);
  let tracks;
  try {
    tracks = await catalog(context.env, category, user?.id ?? null);
  } catch (error) {
    console.error("play catalog failed", error);
    return context.html(feedErrorPage(category.name), 502);
  }
  if (tracks.length < 4) return context.html(feedErrorPage(category.name), 502);
  const game = await buildGame(context.env, category, mode, tracks);
  return context.redirect(`/play/${game.id}`, 303);
});

playApp.get("/:id", async (context) => {
  const game = await getGame(context.env, context.req.param("id"));
  if (game === null) return context.html(notFoundPage(), 404);
  const now = Date.now();
  if (game.phase !== "question")
    return context.html(gamePage(game, { kind: game.phase }, now));
  const { preview } = await serveRound(context.env, game, now);
  if (game.phase !== "question")
    return context.html(gamePage(game, { kind: game.phase }, now));
  if (preview === null)
    return context.html(gamePage(game, { kind: "error" }, now));
  return context.html(
    gamePage(
      game,
      { kind: "question", preview, choices: game.current!.choices },
      now,
    ),
  );
});

playApp.post("/:id/answer", async (context) => {
  const game = await getGame(context.env, context.req.param("id"));
  if (game === null) return context.html(notFoundPage(), 404);
  const body = await context.req.parseBody();
  await answerRound(
    context.env,
    game,
    {
      choice: typeof body.choice === "string" ? body.choice : undefined,
      typed: typeof body.answer === "string" ? body.answer : undefined,
    },
    Date.now(),
  );
  return context.redirect(`/play/${game.id}`, 303);
});

playApp.post("/:id/next", async (context) => {
  const game = await getGame(context.env, context.req.param("id"));
  if (game === null) return context.html(notFoundPage(), 404);
  if (advance(game)) await putGame(context.env, game);
  return context.redirect(`/play/${game.id}`, 303);
});
