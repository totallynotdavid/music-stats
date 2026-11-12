import { app, scheduled } from "./app";
import type { Env } from "./types";

const scheduledHandler: NonNullable<ExportedHandler<Env>["scheduled"]> =
  scheduled;

export default {
  fetch: app.fetch,
  scheduled: scheduledHandler,
} satisfies ExportedHandler<Env>;
