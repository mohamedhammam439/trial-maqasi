import * as FileSystem from 'expo-file-system/legacy';
import * as Sharing from 'expo-sharing';

/** One AR comparison: the same photo measured with the AR scale and with the tape scale,
 *  next to what the tape said for the garment itself. Kept in its own log, apart from the normal tests. */
export type ArTestRecord = {
  id: string;
  takenAt: string;
  tiltDeg: number;
  ar: { pxPerCm: number; distanceCm: number | null; spread: number; topBottomDiff: number; samples: number; debug?: unknown };
  /** Scale from tapping the tape on the same photo; null if the tape wasn't tapped. */
  tape: { pxPerCm: number; calibrationCm: number } | null;
  /** (AR scale - tape scale) / tape scale, in %. */
  scaleDiffPct: number | null;
  /** Scale from the A4 sheet in the same photo (auto-detected); null if not found. Older records lack it. */
  a4?: { pxPerCm: number; detected: boolean } | null;
  /** A4 scale moved to the garment with AR's perspective. */
  fused?: { pxPerCm: number; arCorrection: number; perspective: number } | null;
  measuredAr: Record<string, number>;
  measuredA4?: Record<string, number> | null;
  measuredFused?: Record<string, number> | null;
  measuredTape: Record<string, number> | null;
  truth: Record<string, number | null>;
  /** Which sheet set the scale (absent = plain A4). */
  sheet?: SheetKind;
  /** Multi-frame: how many frames went into the A4 median, and the largest per-measurement spread (cm). */
  frames?: { n: number; maxSpreadCm: number } | null;
  note: string;
};

const LOG = `${FileSystem.documentDirectory}maqasi-ar-tests.json`;
const SETTINGS = `${FileSystem.documentDirectory}maqasi-ar-settings.json`;

/** Which scale sheet lies on the garment: the plain white A4, or the printed ArUco sheet. */
export type SheetKind = 'a4' | 'aruco';

export async function loadSheetKind(): Promise<SheetKind> {
  try {
    const info = await FileSystem.getInfoAsync(SETTINGS);
    if (!info.exists) return 'a4';
    const v = JSON.parse(await FileSystem.readAsStringAsync(SETTINGS))?.sheet;
    return v === 'aruco' ? 'aruco' : 'a4';
  } catch {
    return 'a4';
  }
}

export const saveSheetKind = (sheet: SheetKind) => FileSystem.writeAsStringAsync(SETTINGS, JSON.stringify({ sheet }));
export async function loadArRecords(): Promise<ArTestRecord[]> {
  try {
    const info = await FileSystem.getInfoAsync(LOG);
    if (!info.exists) return [];
    return JSON.parse(await FileSystem.readAsStringAsync(LOG)) as ArTestRecord[];
  } catch {
    return [];
  }
}

export async function saveArRecord(r: ArTestRecord) {
  const all = await loadArRecords();
  all.unshift(r);
  await FileSystem.writeAsStringAsync(LOG, JSON.stringify(all, null, 2));
}

export async function clearArRecords() {
  await FileSystem.writeAsStringAsync(LOG, '[]');
}

export async function exportArRecords() {
  const info = await FileSystem.getInfoAsync(LOG);
  if (!info.exists) await FileSystem.writeAsStringAsync(LOG, '[]');
  await Sharing.shareAsync(LOG, { mimeType: 'application/json', dialogTitle: 'نتايج مقارنة الـ AR' });
}

type Acc = { sum: number; n: number; within1: number };
const add = (acc: Record<string, Acc>, k: string, e: number) => {
  acc[k] ??= { sum: 0, n: 0, within1: 0 };
  acc[k].sum += e;
  acc[k].n += 1;
  if (e <= 1) acc[k].within1 += 1;
};

/** Mean absolute error per measurement for each scale method, plus mean |AR vs tape scale| difference. */
export function arSummary(records: ArTestRecord[]) {
  const ar: Record<string, Acc> = {};
  const a4: Record<string, Acc> = {};
  const fused: Record<string, Acc> = {};
  const tape: Record<string, Acc> = {};
  let scaleSum = 0;
  let scaleN = 0;
  for (const r of records) {
    if (r.scaleDiffPct != null) {
      scaleSum += Math.abs(r.scaleDiffPct);
      scaleN += 1;
    }
    for (const [k, t] of Object.entries(r.truth)) {
      if (t == null) continue;
      if (r.measuredAr[k] != null) add(ar, k, Math.abs(r.measuredAr[k] - t));
      if (r.measuredA4?.[k] != null) add(a4, k, Math.abs(r.measuredA4[k] - t));
      if (r.measuredFused?.[k] != null) add(fused, k, Math.abs(r.measuredFused[k] - t));
      if (r.measuredTape?.[k] != null) add(tape, k, Math.abs(r.measuredTape[k] - t));
    }
  }
  return { ar, a4, fused, tape, meanScaleDiffPct: scaleN ? scaleSum / scaleN : null, scaleN };
}
