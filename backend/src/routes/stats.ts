import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Database } from "better-sqlite3";
import type { NavidromeReader } from "../db/navidrome-db.js";
import type { MemoCache } from "../cache.js";
import type { EventStore } from "../events/store.js";
import { resolveTimeframe, type Timeframe, type TimeframeQuery } from "../stats/timeframe.js";
import { buildPlayAggregate } from "../stats/aggregate.js";
import { topArtists, topAlbums, topTracks, topGenres, type Sort } from "../stats/tops.js";
import { computeTotals } from "../stats/totals.js";
import { computeHeatmap } from "../stats/heatmap.js";
import { computeTimeseries, type Bucketing } from "../stats/timeseries.js";
import { computeSessions } from "../stats/sessions.js";
import { recentPlays } from "../stats/recent.js";
import { computeFlow } from "../stats/flow.js";

const flowQuery = z.object({
  group: z.enum(["artist", "album", "genre"]).default("artist"),
  bucket: z.enum(["auto", "day", "week", "month"]).default("auto"),
  sort: z.enum(["plays", "time"]).default("plays"),
  limit: z.coerce.number().int().min(1).max(40).default(16),
  compact: z.enum(["true", "false"]).default("false").transform((v) => v === "true"),
  focus: z.string().max(300).optional(),
});

interface Opts {
  statsDb: Database;
  reader: NavidromeReader;
  store: EventStore;
  cache: MemoCache;
  now: () => number;
  sessionGapSeconds: number;
  defaultUser: string;
}

interface Q extends TimeframeQuery {
  sort?: Sort;
  limit?: string;
  user?: string;
  bucket?: Bucketing;
  tz?: string;
}

export function registerStats(app: FastifyInstance, o: Opts): void {
  const key = (parts: unknown[]) => JSON.stringify(parts);

  function tf(q: Q) { return resolveTimeframe(q, o.now()); }
  function user(q: Q) { return q.user ?? o.defaultUser; }
  function sort(q: Q): Sort { return q.sort === "time" ? "time" : "plays"; }
  function limit(q: Q) { return Math.min(Number(q.limit ?? 50), 200); }
  function tz(q: Q) { const n = Number(q.tz); return Number.isFinite(n) ? Math.max(-50400, Math.min(50400, Math.trunc(n))) : 0; }
  function agg(q: Q, t: Timeframe) {
    return o.cache.get(key(["agg", user(q), t]), () => buildPlayAggregate(o.statsDb, o.reader, t, user(q)));
  }

  app.get("/api/tops/artists", async (req) => {
    const q = req.query as Q;
    const t = tf(q);
    return o.cache.get(key(["artists", user(q), t, sort(q), limit(q)]), () => topArtists(agg(q, t), sort(q), limit(q)));
  });
  app.get("/api/tops/albums", async (req) => {
    const q = req.query as Q;
    const t = tf(q);
    return o.cache.get(key(["albums", user(q), t, sort(q), limit(q)]), () => topAlbums(agg(q, t), sort(q), limit(q)));
  });
  app.get("/api/tops/tracks", async (req) => {
    const q = req.query as Q;
    const t = tf(q);
    return o.cache.get(key(["tracks", user(q), t, sort(q), limit(q)]), () => topTracks(agg(q, t), sort(q), limit(q)));
  });
  app.get("/api/tops/genres", async (req) => {
    const q = req.query as Q;
    const t = tf(q);
    return o.cache.get(key(["genres", user(q), t, sort(q), limit(q)]), () => topGenres(agg(q, t), sort(q), limit(q)));
  });
  app.get("/api/totals", async (req) => {
    const q = req.query as Q;
    const t = tf(q);
    return o.cache.get(key(["totals", user(q), t]), () => computeTotals(o.statsDb, agg(q, t), t, user(q)));
  });
  app.get("/api/heatmap", async (req) => {
    const q = req.query as Q;
    const t = tf(q);
    return o.cache.get(key(["heatmap", q, t]), () => computeHeatmap(o.statsDb, t, user(q), tz(q)));
  });
  app.get("/api/timeseries", async (req) => {
    const q = req.query as Q;
    const t = tf(q);
    const bucket: Bucketing = q.bucket === "week" || q.bucket === "month" ? q.bucket : "day";
    return o.cache.get(key(["timeseries", q, t, bucket]), () => computeTimeseries(o.statsDb, o.reader, t, user(q), bucket, tz(q)));
  });
  app.get("/api/flow", async (req, reply) => {
    const q = req.query as Q;
    const flow = flowQuery.safeParse(q);
    if (!flow.success) return reply.code(400).send({ error: "Invalid flow parameters" });
    const t = tf(q);
    const opts = { ...flow.data, user: user(q), offset: tz(q) };
    return o.cache.get(key(["flow", t, opts]), () => computeFlow(o.statsDb, o.reader, t, opts));
  });
  app.get("/api/sessions", async (req) => {
    const q = req.query as Q;
    const t = tf(q);
    return o.cache.get(key(["sessions", q, t]), () => computeSessions(o.statsDb, o.reader, t, user(q), o.sessionGapSeconds, limit(q), q.sort === "time" ? "longest" : "recent"));
  });
  app.get("/api/recent", async (req) => {
    const q = req.query as Q;
    return o.cache.get(key(["recent", user(q), limit(q)]), () => recentPlays(o.statsDb, o.reader, user(q), limit(q)));
  });
  app.get("/api/search", async (req) => {
    const term = String((req.query as { q?: string }).q ?? "").trim();
    if (!term) return { artists: [], albums: [], tracks: [] };
    return o.cache.get(key(["search", term]), () => o.reader.search(term, 8));
  });
  app.get("/api/users", async () => {
    return { users: o.store.users(), default: o.defaultUser };
  });
}
