// Level conversions shared by the app and the tests.
// Convention: dBFS (decibels relative to digital full scale, sample range -1..+1).
// RMS of a full-scale sine is -3.01 dBFS; a full-scale square wave reads 0 dBFS.
// This is a plain RMS level, NOT a loudness measurement (no K-weighting, no gating).

export const FLOOR_DB = -120;

export function meanSquareToDb(meanSquare) {
  if (!(meanSquare > 1e-12)) return FLOOR_DB;
  return Math.max(FLOOR_DB, 10 * Math.log10(meanSquare));
}

export function amplitudeToDb(amplitude) {
  if (!(amplitude > 1e-6)) return FLOOR_DB;
  return Math.max(FLOOR_DB, 20 * Math.log10(amplitude));
}

// Loudest channel of one level report (silence means ALL channels are below the threshold).
export function loudestChannel(rmsDb) {
  if (!Array.isArray(rmsDb) || rmsDb.length === 0) return null;
  let max = -Infinity;
  for (const v of rmsDb) if (typeof v === 'number' && v > max) max = v;
  return max === -Infinity ? null : max;
}
