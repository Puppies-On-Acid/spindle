import { readFileSync, writeFileSync } from "node:fs";
import Database from "better-sqlite3";
import { buildIndex, classify } from "./import/spotify.js";
import type { NavTrack } from "./import/spotify.js";
import { buildLastFmMatcher } from "./import/lastfm.js";
import { openStatsDb } from "./db/stats-db.js";
import { EventStore } from "./events/store.js";

function parseCsvLine(line: string): string[] {
  const result: string[] = [];
  let current = "";
  let quoted = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"') {
      if (quoted && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        quoted = !quoted;
      }
    } else if (char === "," && !quoted) {
      result.push(current);
      current = "";
    } else {
      current += char;
    }
  }

  result.push(current);
  return result;
}

function loadLastFm(file: string) {
  const lines = readFileSync(file, "utf8")
    .split("\n")
    .map((l) => l.replace(/\r$/, ""))
    .filter(Boolean);

  const headers = parseCsvLine(lines[0]);

  return lines.slice(1).map((line) => {
    const values = parseCsvLine(line);

    const row = Object.fromEntries(
      headers.map((h, i) => [h, values[i] ?? ""])
    );

    return {
      ts: new Date(Number(row.uts) * 1000).toISOString(),
      ms_played: 240000,
      track: row.track || null,
      artist: row.artist || null,
      album: row.album || null,
      uri: null,
    };
  });
}

function parseArgs(argv: string[]) {
  return {
    csv: argv[2],
    commit: argv.includes("--commit"),
    missingFile: argv.find((a) => a.startsWith("--missing-file="))?.slice(15) ?? null,
    user: process.env.DEFAULT_USER ?? "",
    navidrome: process.env.NAVIDROME_DB_PATH ?? "",
    stats: process.env.STATS_DB_PATH ?? "",
    excludeBaselineWhenImported:
      process.env.EXCLUDE_BASELINE_WHEN_IMPORTED === "true",
  };
}

function startMonitor(label: string) {
  const started = Date.now();

  return setInterval(() => {
    const seconds = Math.floor((Date.now() - started) / 1000);
    console.log(`${label} running... ${seconds}s`);
  }, 10000);
}

async function main() {
  const cfg = parseArgs(process.argv);

  if (!cfg.csv) {
    console.error(
      "Usage: import-lastfm <file.csv> [--commit] [--missing-file=<path.csv>]"
    );
    process.exit(1);
  }

  if (!cfg.user) {
    console.error("Error: DEFAULT_USER env var required.");
    process.exit(1);
  }

  if (!cfg.navidrome) {
    console.error("Error: NAVIDROME_DB_PATH env var required.");
    process.exit(1);
  }

  if (cfg.commit && !cfg.stats) {
    console.error("Error: STATS_DB_PATH env var required for --commit.");
    process.exit(1);
  }

  console.log("Loading Last.fm CSV...");

  const plays = loadLastFm(cfg.csv);

  console.log(`Loaded ${plays.length} Last.fm plays`);

  console.log("Opening Navidrome database...");

  const navDb = new Database(cfg.navidrome, {
    readonly: true,
    fileMustExist: true,
  });

  const tracks = navDb
    .prepare(
      "SELECT id, title, artist, album, duration FROM media_file"
    )
    .all() as NavTrack[];

  navDb.close();

  console.log(`Loaded ${tracks.length} Navidrome tracks`);

  console.log("Building track index...");

  const indexStart = Date.now();

  const index = buildIndex(tracks);

  console.log(
    `Index built in ${((Date.now() - indexStart) / 1000).toFixed(1)}s`
  );

  console.log("Matching Last.fm plays...");

  const monitor = startMonitor("Matching");

  const matcher = buildLastFmMatcher(tracks);

  const report = classify(
    plays,
    index,
    30000,
    matcher,
  );
  clearInterval(monitor);

  console.log("");
  console.log("Import summary:");
  console.log(`  Counted: ${report.counted}`);
  console.log(`  Matched: ${report.matched}`);
  console.log(`  Exact: ${report.matchedExact}`);
  console.log(`  Title only: ${report.matchedByTitle}`);
  console.log(`  Missing: ${report.unmatched}`);

  if (cfg.stats) {
    try {
      const statsDb = new Database(cfg.stats, {
        readonly: true,
        fileMustExist: true,
      });

      const importedByTrack = new Map<string, number>();
      for (const event of report.events) {
        importedByTrack.set(
          event.nd_track_id,
          (importedByTrack.get(event.nd_track_id) ?? 0) + 1,
        );
      }

      const baselineRows = statsDb
        .prepare(
          "SELECT nd_track_id, COUNT(*) AS plays FROM play_events WHERE source='baseline' AND user=? GROUP BY nd_track_id",
        )
        .all(cfg.user) as { nd_track_id: string; plays: number }[];

      statsDb.close();

      let overlapTracks = 0;
      let baselinePlaysOnOverlap = 0;
      let importedPlaysOnOverlap = 0;
      let baselineHigherTracks = 0;
      let baselineHigherBy = 0;

      for (const row of baselineRows) {
        const imported = importedByTrack.get(row.nd_track_id);
        if (imported === undefined) continue;

        overlapTracks++;
        baselinePlaysOnOverlap += row.plays;
        importedPlaysOnOverlap += imported;

        if (row.plays > imported) {
          baselineHigherTracks++;
          baselineHigherBy += row.plays - imported;
        }
      }

      console.log("");
      console.log("Baseline overlap preview:");
      console.log(`  Matched unique tracks: ${importedByTrack.size}`);
      console.log(`  Tracks also having Navidrome baseline: ${overlapTracks}`);
      console.log(`  Baseline plays on overlapping tracks: ${baselinePlaysOnOverlap}`);
      console.log(`  Last.fm plays on overlapping tracks: ${importedPlaysOnOverlap}`);
      console.log(
        `  Overlap tracks where baseline > Last.fm: ${baselineHigherTracks}` +
          ` (baseline exceeds Last.fm by ${baselineHigherBy} plays total)`,
      );
      console.log(
        cfg.excludeBaselineWhenImported
          ? "  EXCLUDE_BASELINE_WHEN_IMPORTED=true: those baseline plays will be hidden from counted stats after import."
          : "  EXCLUDE_BASELINE_WHEN_IMPORTED=false: baseline and imported plays will both be counted after import.",
      );
    } catch (err) {
      console.warn(
        `Could not inspect existing baseline overlap: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  if (cfg.missingFile) {
    const escape = (s: string) => `"${s.replace(/"/g, '""')}"`;

    const missingRows = plays.filter(
      (p) =>
        p.artist &&
        p.track &&
        !matcher(index, p.artist, p.track, p.album)
    );

    const csv = [
      "date,artist,title,album",
      ...missingRows.map((p) =>
        [
          escape(p.ts),
          escape(p.artist!),
          escape(p.track!),
          escape(p.album ?? ""),
        ].join(",")
      ),
    ].join("\n");

    writeFileSync(cfg.missingFile, csv + "\n", "utf8");

    console.log(
      `Wrote ${missingRows.length} missing plays to ${cfg.missingFile}`
    );
  }

  if (!cfg.commit) {
    console.log("");
    console.log(
      "DRY RUN - rerun with --commit to import"
    );
    return;
  }

  console.log("Writing events...");

  const statsDb = openStatsDb(cfg.stats, {
    excludeBaselineWhenImported: cfg.excludeBaselineWhenImported,
  });

  const store = new EventStore(statsDb);

  const inserted = store.insertImport(
    report.events,
    cfg.user
  );

  console.log(
    `Inserted ${inserted}, skipped ${report.events.length - inserted} duplicates`
  );

  statsDb.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
