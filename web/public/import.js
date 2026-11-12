import { detectKind, spotifyPlays, takeoutPlays } from "./import-parse.js";

const batchSize = 100;
const files = document.getElementById("import-files");
const start = document.getElementById("import-start");
const status = document.getElementById("import-status");

function say(text) {
  if (status) status.textContent = text;
}

function cut(text) {
  return [...text].slice(0, 512).join("");
}

function resetText(retryAfter) {
  const reset = new Date(Date.now() + retryAfter * 1000);
  return `00:00 UTC (${reset.toISOString().slice(0, 16).replace("T", " ")} UTC)`;
}

async function postBatch(source, plays) {
  return fetch("/settings/import", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ source, plays }),
  });
}

async function runImport(fileList) {
  const plays = [];
  const skips = new Map();
  for (const file of fileList) {
    let records;
    try {
      records = JSON.parse(await file.text());
    } catch {
      say(`${file.name}: the file is not valid JSON.`);
      return;
    }
    if (!Array.isArray(records) || records.length === 0) {
      say(`${file.name}: the file does not hold a list of records.`);
      return;
    }
    const kind = detectKind(records);
    if (kind === null) {
      say(`${file.name}: not a Spotify or YouTube Music history file.`);
      return;
    }
    const result = (kind === "spotify" ? spotifyPlays : takeoutPlays)(records);
    for (const play of result.plays) {
      plays.push({
        source: kind,
        at: play.at,
        id: play.id,
        artist: cut(play.artist),
        title: cut(play.title),
      });
    }
    for (const [reason, count] of result.skips)
      skips.set(reason, (skips.get(reason) ?? 0) + count);
  }
  const bySource = new Map();
  for (const play of plays) {
    const list = bySource.get(play.source) ?? [];
    list.push(play);
    bySource.set(play.source, list);
  }
  const ordered = [...bySource.values()].flatMap((list) =>
    list.sort((a, b) => b.at - a.at),
  );
  const skippedText = [...skips]
    .map(([reason, count]) => `${count} skipped: ${reason}`)
    .join("; ");
  const counts = `${ordered.length} plays kept${skips.size > 0 ? `; ${skippedText}` : ""}.`;
  if (ordered.length === 0) {
    say(`${counts} Nothing to import.`);
    return;
  }
  const note = `music-stats:import:${JSON.stringify(
    fileList.map((file) => [file.name, file.size]).sort(),
  )}`;
  const posted = Number(localStorage.getItem(note) ?? 0) || 0;
  const pending = ordered.slice(posted);
  if (pending.length === 0) {
    say(`${counts} All of them were already posted.`);
    return;
  }
  say(
    `${counts} ${posted > 0 ? `${posted} already posted. ` : ""}Posting ${pending.length} plays…`,
  );
  for (let offset = posted; offset < ordered.length;) {
    const slice = ordered.slice(offset, offset + batchSize);
    const groups = new Map();
    for (const play of slice) {
      const list = groups.get(play.source) ?? [];
      list.push(play);
      groups.set(play.source, list);
    }
    for (const [source, group] of groups) {
      const response = await postBatch(
        source,
        group.map(({ source: _source, ...play }) => play),
      );
      if (response.status === 429) {
        const retryAfter = Number(response.headers.get("retry-after") ?? 0);
        localStorage.setItem(note, String(offset));
        say(
          `The daily limit is reached; it resets at ${resetText(retryAfter)}. ` +
            `${offset} of ${ordered.length} plays posted. ` +
            "Select the same files again after the reset to continue.",
        );
        return;
      }
      if (!response.ok) {
        localStorage.setItem(note, String(offset));
        say(
          `The import failed (status ${response.status}). ` +
            `${offset} of ${ordered.length} plays posted.`,
        );
        return;
      }
      offset += group.length;
      localStorage.setItem(note, String(offset));
      ensureRemoveRow(source);
      say(`${counts} Posted ${offset} of ${ordered.length}…`);
    }
  }
  say(`${counts} Done: ${ordered.length} plays posted.`);
}

async function runRemove(button) {
  const source = button.getAttribute("data-import-remove");
  for (;;) {
    const response = await fetch("/settings/import/remove", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ source }),
    });
    if (response.status === 429) {
      const retryAfter = Number(response.headers.get("retry-after") ?? 0);
      say(
        `The daily limit is reached; it resets at ${resetText(retryAfter)}. ` +
          "Try the removal again after the reset.",
      );
      return;
    }
    if (!response.ok) {
      say(`The removal failed (status ${response.status}).`);
      return;
    }
    const body = await response.json();
    say(`Removed ${body.removed} plays; ${body.remaining} left.`);
    if (body.remaining === 0) {
      button.closest("li")?.remove();
      say("The import is removed.");
      return;
    }
  }
}

const importNames = {
  spotify: "Spotify import",
  ytmusic: "YouTube Music import",
};

function ensureRemoveRow(source) {
  const list = document.getElementById("import-sources");
  if (!list || list.querySelector(`[data-import-remove="${source}"]`)) return;
  const li = document.createElement("li");
  const track = document.createElement("span");
  track.className = "track";
  const name = document.createElement("b");
  name.textContent = importNames[source] ?? `${source} import`;
  const when = document.createElement("small");
  when.textContent = "last batch just now";
  track.append(name, when);
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = "Remove";
  button.setAttribute("data-import-remove", source);
  li.append(track, button);
  list.append(li);
  wireRemove(button);
}

function wireRemove(button) {
  button.addEventListener("click", async () => {
    button.disabled = true;
    try {
      await runRemove(button);
    } finally {
      button.disabled = false;
    }
  });
}

start?.addEventListener("click", async () => {
  const fileList = [...(files?.files ?? [])];
  if (fileList.length === 0) {
    say("Choose one or more .json history files first.");
    return;
  }
  start.disabled = true;
  try {
    await runImport(fileList);
  } finally {
    start.disabled = false;
  }
});

for (const button of document.querySelectorAll("[data-import-remove]")) {
  wireRemove(button);
}
