export type Period = "week" | "month" | "all";

export interface Env {
  DB: D1Database;
  CACHE?: KVNamespace;
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
  SPOTIFY_CLIENT_ID?: string;
  SPOTIFY_CLIENT_SECRET?: string;
  SPOTIFY_ENCRYPTION_KEY?: string;
}

export interface SourceRow {
  id: number;
  user_id: number;
  kind: string;
  account: string | null;
  secret?: ArrayBuffer | Uint8Array | null;
  cursor: number | null;
  backfill_before: number | null;
  gap_before: number | null;
  gap_floor: number | null;
  next_pull_at: number | null;
  idle_pulls: number;
  status?: string;
  error?: string | null;
  play_count?: number;
}

export interface TrackInput {
  kind: string;
  sourceKey: string;
  artist: string;
  title: string;
  mbid?: string;
  isrc?: string;
}

export interface PeriodStats {
  schema: 1;
  user: { name: string };
  period: Period;
  from: number | null;
  to: number;
  plays: number;
  unique_tracks: number;
  unique_artists: number;
  top_tracks: Array<{ title: string; artist: string; plays: number }>;
  top_artists: Array<{ artist: string; plays: number }>;
  daily: Array<{ day: string; plays: number }>;
  updated_at: number;
}
