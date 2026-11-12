const punctuation = new Map([
  ["‘", "'"],
  ["’", "'"],
  ["“", '"'],
  ["”", '"'],
  ["–", "-"],
  ["—", "-"],
  ["‑", "-"],
]);

const qualifierPatterns = [
  /\s+[-([]?\s*remastered(?:\s+\d{4})?\s*[)\]]?$/iu,
  /\s+[-([]?\s*remaster(?:\s+\d{4})?\s*[)\]]?$/iu,
  /\s+[-([]?\s*deluxe edition(?:\s+\d{4})?\s*[)\]]?$/iu,
  /\s+[-([]?\s*explicit(?:\s+\d{4})?\s*[)\]]?$/iu,
  /\s+[-([]?\s*official video(?:\s+\d{4})?\s*[)\]]?$/iu,
  /\s+[-([]?\s*official audio(?:\s+\d{4})?\s*[)\]]?$/iu,
  /\s+[-([]?\s*lyric video(?:\s+\d{4})?\s*[)\]]?$/iu,
  /\s+[-([]?\s*visualizer(?:\s+\d{4})?\s*[)\]]?$/iu,
  /\s+[-([]\s*mono(?:\s+\d{4})?\s*[)\]]?$/iu,
  /\s+[-([]\s*stereo(?:\s+\d{4})?\s*[)\]]?$/iu,
];

const featurePattern =
  /\s*[-([]?\s*(?:feat\.?|ft\.?|featuring)\s+[^)\]]+[)\]]?$/iu;

function replacePunctuation(value: string) {
  return [...value]
    .map((character) => punctuation.get(character) ?? character)
    .join("");
}

function removeQualifiers(value: string) {
  let result = value;
  for (const pattern of qualifierPatterns) result = result.replace(pattern, "");
  result = result.replace(featurePattern, "");
  return result;
}

export function normalizeText(value: string, removeTopic = false) {
  let result = replacePunctuation(value.normalize("NFKC").toLocaleLowerCase());
  result = result.normalize("NFD").replace(/\p{M}/gu, "");
  result = removeQualifiers(result);
  if (removeTopic) result = result.replace(/\s+-\s+topic$/iu, "");
  const compact = [...result]
    .filter((character) => /[\p{L}\p{N}]/u.test(character))
    .join("");
  return compact || value.trim().toLocaleLowerCase();
}

export function trackKey(artist: string, title: string, removeTopic = false) {
  return `${normalizeText(artist, removeTopic)}\u001f${normalizeText(title)}`;
}
