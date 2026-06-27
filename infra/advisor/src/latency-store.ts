// Disk-backed persistence for the advisor's rolling latency windows.
//
// The ack/ttft LatencyWindows live in memory and are otherwise lost on
// restart, which leaves the public latency headline blank ("—") until jobs
// flow again. In production the advisor mounts a volume; this module writes
// the last samples there and reloads them on the next boot so the headline
// shows the last known figures instead of nothing — flagged `cached` until
// live traffic refills the window.
//
// Best-effort by design: a missing/unreadable/corrupt file just leaves the
// window empty (the readout falls back to its usual "no samples" state), and
// a failed write is logged but never crashes the advisor. Writes are atomic
// (temp file + rename) so a crash mid-write can't leave a truncated cache.

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import type { LatencyWindow } from "./latency-window.ts";

/** On-disk shape. Additive: unknown fields are ignored on read, so the
 *  format can grow without breaking older/newer advisors sharing a volume. */
interface PersistedLatency {
  /** Latency samples in ms, oldest-first. */
  samples: number[];
  /** When this snapshot was written (RFC3339, UTC). Informational. */
  updatedAt: string;
}

/** Seed `window` from the snapshot at `path`. Returns the number of samples
 *  actually resident afterwards (0 when the file is absent, empty, or
 *  unreadable). Never throws — a cold/corrupt cache simply yields an empty
 *  window. Logs the count and the snapshot's age so an operator can spot a
 *  headline being seeded from a long-dormant volume; we intentionally serve
 *  even an old snapshot (that's the point — don't blank the headline on
 *  restart), and the `cached` flag on `stats()` marks it to API consumers. */
export async function hydrateLatencyWindow(window: LatencyWindow, path: string): Promise<number> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    // No snapshot yet (first boot / fresh volume) — nothing to hydrate.
    return 0;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<PersistedLatency>;
    // Match `hydrate()`'s own validation exactly (finite AND non-negative) so
    // the resident count below can't be thrown off by samples it would drop.
    const samples = Array.isArray(parsed?.samples)
      ? parsed.samples.filter(
          (s): s is number => typeof s === "number" && Number.isFinite(s) && s >= 0,
        )
      : [];
    if (samples.length === 0) return 0;
    // Net samples resident after validation + capacity bounding — never an
    // overcount even if the snapshot exceeds the window's capacity.
    const before = window.snapshot().length;
    window.hydrate(samples);
    const hydrated = window.snapshot().length - before;
    if (hydrated > 0) {
      const age = snapshotAge(parsed.updatedAt);
      console.error(
        `[latency-store] hydrated ${hydrated} sample(s) from ${path}${age ? ` (snapshot ${age})` : ""}`,
      );
    }
    return hydrated;
  } catch {
    // Corrupt JSON — ignore and start cold rather than crash.
    return 0;
  }
}

/** Human-readable age of a persisted snapshot from its RFC3339 `updatedAt`,
 *  or null when missing/unparseable/future-dated. Coarse on purpose — it's a
 *  log breadcrumb for spotting stale hydrations, not a precise duration. */
function snapshotAge(updatedAt: unknown): string | null {
  if (typeof updatedAt !== "string") return null;
  const t = Date.parse(updatedAt);
  if (!Number.isFinite(t)) return null;
  const ms = Date.now() - t;
  if (ms < 0) return null;
  const s = Math.round(ms / 1000);
  if (s < 90) return `age ${s}s`;
  const m = Math.round(s / 60);
  if (m < 90) return `age ${m}m`;
  const h = Math.round(m / 60);
  if (h < 48) return `age ${h}h`;
  return `age ${Math.round(h / 24)}d`;
}

/** Atomically write `window`'s current samples to `path`. Creates the parent
 *  directory if needed. Resolves false (without throwing) on any I/O error so
 *  a periodic flush can't take the advisor down. */
export async function persistLatencyWindow(
  window: LatencyWindow,
  path: string,
  nowIso: string,
): Promise<boolean> {
  const body: PersistedLatency = { samples: window.snapshot(), updatedAt: nowIso };
  try {
    await mkdir(dirname(path), { recursive: true });
    const tmp = `${path}.tmp`;
    await writeFile(tmp, JSON.stringify(body), "utf8");
    await rename(tmp, path);
    return true;
  } catch (e) {
    console.error(`[latency-store] failed to persist ${path}:`, e);
    return false;
  }
}
