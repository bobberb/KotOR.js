/**
 * Viseme catalog and timeline helpers for the LIP editor.
 *
 * A KotOR/TSL .lip file is a duration plus (time, shape) keys, where shape is
 * one of the 16 Odyssey mouth shapes in {@link LIPShape}. Each key holds its
 * shape until the next key (or the end of the clip). These helpers are pure so
 * the editor's snapping, merging and span layout can be tested without React.
 *
 * @file lipVisemes.ts
 * @license {@link https://www.gnu.org/licenses/gpl-3.0.txt|GPLv3}
 */

import { LIPShape } from "@/enums/resource/LIPShape";
import { LIPShapeLabels } from "@/apps/forge/data/LIPShapeLabels";

export interface LipViseme {
  shape: LIPShape;
  /** LIPShape enum name, e.g. "MBP". */
  token: string;
  /** Human-readable description, e.g. "m, p, b". */
  label: string;
}

export const LIP_SHAPE_COUNT = 16;

/** Indexed by shape id (0-15). */
export const LIP_VISEMES: readonly LipViseme[] = Array.from({ length: LIP_SHAPE_COUNT }, (_, shape) => ({
  shape: shape as LIPShape,
  token: LIPShape[shape],
  label: (LIPShapeLabels[shape] || "").trim(),
}));

/** Grid step for "grid" snapping: 10 ms. */
export const LIP_SNAP_GRID_SEC = 0.01;

export function clampLipShape(shape: number): number {
  const value = Math.round(Number(shape));
  if (!Number.isFinite(value)) return 0;
  return Math.min(LIP_SHAPE_COUNT - 1, Math.max(0, value));
}

export interface LipKey {
  uuid?: string;
  time: number;
  shape: number;
}

export interface LipVisemeSpan {
  uuid: string;
  shape: number;
  start: number;
  end: number;
}

/**
 * The interval each key's shape is held for: from its time to the next key's
 * time, the last one to the clip duration. Keys may arrive unsorted.
 */
export function visemeSpansFromKeys(keys: ReadonlyArray<LipKey & { uuid: string }>, duration: number): LipVisemeSpan[] {
  const sorted = [...keys].sort((a, b) => a.time - b.time);
  return sorted.map((key, i) => {
    const next = sorted[i + 1];
    const end = next ? next.time : Math.max(key.time, duration);
    return { uuid: key.uuid, shape: key.shape, start: key.time, end };
  });
}

export type LipSnapMode = "off" | "grid" | "phoneme";

export interface LipSnapOptions {
  mode: LipSnapMode;
  duration: number;
  /** Grid step in seconds; defaults to {@link LIP_SNAP_GRID_SEC}. */
  grid?: number;
  /** Phoneme start times for "phoneme" mode. */
  phonemeStarts?: ReadonlyArray<number>;
}

/** Snap a time per the mode, always clamped to [0, duration]. */
export function snapLipTime(time: number, options: LipSnapOptions): number {
  const duration = Math.max(0, options.duration || 0);
  const clamp = (t: number) => Math.min(duration, Math.max(0, t));
  let t = clamp(Number.isFinite(time) ? time : 0);

  if (options.mode === "grid") {
    const grid = options.grid && options.grid > 0 ? options.grid : LIP_SNAP_GRID_SEC;
    // Rounded through the step count, then to 6 places, to keep 0.1 + 0.2 noise out of saved keys.
    t = Number((Math.round(t / grid) * grid).toFixed(6));
  } else if (options.mode === "phoneme" && options.phonemeStarts?.length) {
    let best = options.phonemeStarts[0];
    for (const start of options.phonemeStarts) {
      if (Math.abs(start - t) < Math.abs(best - t)) best = start;
    }
    t = best;
  }
  return clamp(t);
}

/**
 * Add generated keys to existing ones without overwriting: an incoming key
 * within `tolerance` seconds of a key already kept is dropped. Sorted by time.
 */
export function mergeLipKeyframes<E extends LipKey, I extends LipKey>(
  existing: ReadonlyArray<E>,
  incoming: ReadonlyArray<I>,
  tolerance = LIP_SNAP_GRID_SEC,
): Array<E | I> {
  const merged: Array<E | I> = [...existing];
  for (const key of incoming) {
    if (merged.some((kept) => Math.abs(kept.time - key.time) <= tolerance)) continue;
    merged.push(key);
  }
  return merged.sort((a, b) => a.time - b.time);
}

/** Clock text as m:ss.ss. */
export function formatLipClock(seconds: number): string {
  // Whole hundredths first, so 59.999 rolls over to 1:00.00 instead of 0:60.00.
  const hundredths = Math.round((Number.isFinite(seconds) && seconds > 0 ? seconds : 0) * 100);
  const m = Math.floor(hundredths / 6000);
  const s = (hundredths % 6000) / 100;
  return `${m}:${s < 10 ? "0" : ""}${s.toFixed(2)}`;
}
