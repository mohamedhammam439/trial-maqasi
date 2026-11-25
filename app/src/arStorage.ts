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
  measuredAr: Record<string, number>;
  measuredTape: Record<string, number> | null;
  truth: Record<string, number | null>;
  note: string;
};

const LOG = `${FileSystem.documentDirectory}maqasi-ar-tests.json`;

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
      if (r.measuredTape?.[k] != null) add(tape, k, Math.abs(r.measuredTape[k] - t));
    }
  }
  return { ar, tape, meanScaleDiffPct: scaleN ? scaleSum / scaleN : null, scaleN };
}
