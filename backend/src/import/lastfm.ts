import { normArtist } from "./normalize.js";
import { matchDetailed } from "./spotify.js";
import type { NavIndex, NavTrack, PlayMatcher } from "./spotify.js";

function canonicalArtist(value: string): string {
  return normArtist(value).replace(/^the\s+/, "");
}

function canonicalAlbum(value: string): string {
  return normArtist(value).replace(/^(the|a|an)\s+/, "");
}

const romanValues: Record<string, string> = {
  i: "1",
  ii: "2",
  iii: "3",
  iv: "4",
  v: "5",
  vi: "6",
  vii: "7",
  viii: "8",
  ix: "9",
  x: "10",
  xi: "11",
  xii: "12",
};

const partWordValues: Record<string, string> = {
  one: "1",
  two: "2",
  three: "3",
  four: "4",
  five: "5",
  six: "6",
  seven: "7",
  eight: "8",
  nine: "9",
  ten: "10",
  eleven: "11",
  twelve: "12",
};

function canonicalTitle(value: string): string {
  const tokens = normArtist(value)
    .split(/\s+/)
    .filter(Boolean)
    .map((token) => {
      if (token === "pt" || token === "pts" || token === "parts") return "part";
      return romanValues[token] ?? token;
    });

  for (let i = 1; i < tokens.length; i++) {
    if (tokens[i - 1] === "part" && partWordValues[tokens[i]]) {
      tokens[i] = partWordValues[tokens[i]];
    }
  }

  return tokens.join(" ");
}

function compactTitle(value: string): string {
  return canonicalTitle(value).replace(/\s+/g, "");
}

function relaxedPartTitle(value: string): string {
  return canonicalTitle(value)
    .replace(/\bpart\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function isBoundarySuffix(a: string, b: string): boolean {
  if (!a || !b || a === b) return false;
  const shorter = a.length <= b.length ? a : b;
  const longer = a.length <= b.length ? b : a;
  if (shorter.length < 6 || shorter.split(" ").length < 2) return false;
  return longer.endsWith(` ${shorter}`);
}

// Optimal string alignment distance. This handles the common Last.fm typo case
// where two neighboring characters are transposed while keeping the fallback
// conservative enough for album-scoped matching.
function damerauLevenshtein(a: string, b: string): number {
  const rows = a.length + 1;
  const cols = b.length + 1;
  const d = Array.from({ length: rows }, () => Array<number>(cols).fill(0));

  for (let i = 0; i < rows; i++) d[i][0] = i;
  for (let j = 0; j < cols; j++) d[0][j] = j;

  for (let i = 1; i < rows; i++) {
    for (let j = 1; j < cols; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(
        d[i - 1][j] + 1,
        d[i][j - 1] + 1,
        d[i - 1][j - 1] + cost,
      );

      if (
        i > 1 &&
        j > 1 &&
        a[i - 1] === b[j - 2] &&
        a[i - 2] === b[j - 1]
      ) {
        d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
      }
    }
  }

  return d[a.length][b.length];
}

function maxTypoDistance(length: number): number {
  if (length < 5) return 0;
  if (length <= 6) return 1;
  if (length <= 20) return 2;
  return 3;
}

export function buildLastFmMatcher(tracks: NavTrack[]): PlayMatcher {
  const byArtist = new Map<string, NavTrack[]>();

  for (const track of tracks) {
    const key = canonicalArtist(track.artist);
    const bucket = byArtist.get(key) ?? [];
    bucket.push(track);
    byArtist.set(key, bucket);
  }

  return (
    index: NavIndex,
    artist: string,
    title: string,
    album: string | null,
  ) => {
    // Preserve every match the existing importer already makes. The Last.fm
    // fallback only gets a chance when normal artist/title matching failed.
    const primary = matchDetailed(index, artist, title);
    if (primary) return primary;

    const artistCandidates = byArtist.get(canonicalArtist(artist));
    if (!artistCandidates?.length) return null;

    let candidates = artistCandidates;
    let albumScoped = false;

    if (album?.trim()) {
      const wantedAlbum = canonicalAlbum(album);
      const sameAlbum = artistCandidates.filter(
        (track) => track.album && canonicalAlbum(track.album) === wantedAlbum,
      );
      if (sameAlbum.length) {
        candidates = sameAlbum;
        albumScoped = true;
      }
    }

    const wantedTitle = canonicalTitle(title);
    const exactLoose = candidates.filter(
      (track) => canonicalTitle(track.title) === wantedTitle,
    );

    // Only accept a loose exact match when it is unambiguous.
    if (exactLoose.length === 1) {
      return { track: exactLoose[0], tier: "fuzzy" };
    }
    if (exactLoose.length > 1) return null;

    if (albumScoped) {
      const wantedRelaxed = relaxedPartTitle(title);
      const relaxedMatches = candidates.filter(
        (track) => relaxedPartTitle(track.title) === wantedRelaxed,
      );
      if (relaxedMatches.length === 1) {
        return { track: relaxedMatches[0], tier: "fuzzy" };
      }
      if (relaxedMatches.length > 1) return null;

      const suiteMatches = candidates.filter((track) =>
        isBoundarySuffix(wantedTitle, canonicalTitle(track.title)),
      );
      if (suiteMatches.length === 1) {
        return { track: suiteMatches[0], tier: "fuzzy" };
      }
      if (suiteMatches.length > 1) return null;
    }

    const wantedCompact = compactTitle(title);
    if (!wantedCompact) return null;

    const ranked = candidates
      .map((track) => ({
        track,
        distance: damerauLevenshtein(wantedCompact, compactTitle(track.title)),
      }))
      .sort((a, b) => a.distance - b.distance);

    const best = ranked[0];
    if (!best) return null;

    const comparedLength = Math.max(
      wantedCompact.length,
      compactTitle(best.track.title).length,
    );
    let allowed = maxTypoDistance(comparedLength);

    // Without album confirmation, allow at most a single-character typo.
    if (!albumScoped) allowed = Math.min(allowed, 1);

    if (best.distance > allowed) return null;

    const runnerUp = ranked[1];
    if (runnerUp && runnerUp.distance <= best.distance + 1) return null;

    return { track: best.track, tier: "fuzzy" };
  };
}
