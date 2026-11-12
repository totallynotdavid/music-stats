const punctuation = new Map([
  ["‘", "'"],
  ["’", "'"],
  ["“", '"'],
  ["”", '"'],
  ["–", "-"],
  ["—", "-"],
  ["‑", "-"],
]);

const punctuationPattern = new RegExp(
  `[${[...punctuation.keys()].join("")}]`,
  "gu",
);

const qualifierPattern =
  /(?:\s+[-([]?\s*(?:remastered|remaster|deluxe edition|explicit|official video|official audio|lyric video|visualizer)(?:\s+\d{4})?\s*[)\]]?|\s+[-([]\s*(?:mono|stereo)(?:\s+\d{4})?\s*[)\]]?)+$/iu;

const featurePattern =
  /\s*[-([]?\s*(?:feat\.?|ft\.?|featuring)\s+[^)\]]+[)\]]?$/iu;

const clauseGuard =
  /(?:remaster|deluxe|explicit|official|lyric|visualiz|mono|stereo|feat|ft)/iu;

const marksPattern = /\p{M}/gu;
const nonAlphaNumeric = /[^\p{L}\p{N}]+/gu;
const topicPattern = /\s+-\s+topic$/iu;

export function normalizeText(value: string, removeTopic = false) {
  let result = value
    .normalize("NFKC")
    .toLowerCase()
    .replace(punctuationPattern, (character) => punctuation.get(character)!);
  result = result.normalize("NFD").replace(marksPattern, "");
  if (clauseGuard.test(result))
    result = result.replace(qualifierPattern, "").replace(featurePattern, "");
  if (removeTopic) result = result.replace(topicPattern, "");
  return result.replace(nonAlphaNumeric, "") || value.trim().toLowerCase();
}

export function trackKey(artist: string, title: string, removeTopic = false) {
  return `${normalizeText(artist, removeTopic)}\u001f${normalizeText(title)}`;
}
