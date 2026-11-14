const timeoutMs = 8000;

export class FeedError extends Error {
  constructor(
    message: string,
    readonly url: string,
  ) {
    super(message);
  }
}

export async function fetchJson(url: string): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(url, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: { "user-agent": "music-stats-web" },
    });
  } catch (error) {
    throw new FeedError(String(error), url);
  }
  if (!response.ok)
    throw new FeedError(`feed answered ${response.status}`, url);
  return response.json();
}
