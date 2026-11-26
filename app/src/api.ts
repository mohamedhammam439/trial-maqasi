import { File } from 'expo-file-system';

import type { MeasureResponse, Pt, Scale } from './types';

const xy = (p: Pt) => [p.x, p.y];

export async function measure(
  serverUrl: string,
  photoUri: string,
  scale: Scale,
  /** Polygons (image px) to leave out of the garment, e.g. the A4 sheet's corners. */
  exclude?: number[][][],
): Promise<MeasureResponse> {
  const form = new FormData();
  // Expo's fetch (the global fetch since SDK 52) can't send React Native's {uri, name, type} parts
  // ("Unsupported FormDataPart implementation"). An expo-file-system File is a Blob, so it can.
  const file = new File(photoUri);
  form.append('image', file, file.name || 'shot.jpg');
  form.append('garment', 'tshirt');
  if (scale.type === 'px_per_cm') {
    form.append('px_per_cm', String(scale.pxPerCm));
  } else if (scale.type === 'tape') {
    form.append('reference', JSON.stringify({ type: 'tape', p1: xy(scale.p1), p2: xy(scale.p2), cm: scale.cm }));
  } else {
    const ref: Record<string, unknown> = { type: scale.type };
    if (scale.type === 'rect') Object.assign(ref, { w_cm: scale.wCm, h_cm: scale.hCm });
    if (scale.corners) ref.corners = scale.corners.map(xy);
    form.append('reference', JSON.stringify(ref));
  }

  if (exclude?.length) form.append('exclude', JSON.stringify(exclude));

  const res = await fetch(`${serverUrl.replace(/\/$/, '')}/measure`, { method: 'POST', body: form });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(typeof body?.detail === 'string' ? body.detail : `السيرفر رد بخطأ ${res.status}`);
  }
  return body as MeasureResponse;
}

export type A4Check = {
  ok: boolean;
  found: boolean;
  aspect_err: number | null;
  px_per_cm: number | null;
  corners: [number, number][] | null;
  /** The first thing to fix, or "all good". */
  message: string;
  /** Each check on its own (older servers send only the sheet fields). */
  sheet?: { ok: boolean; message: string };
  light?: { ok: boolean; message: string };
  garment?: { ok: boolean; message: string };
};

/** Live check before the shot: light, the sheet (in view, right proportions) and the garment laid out flat.
 *  `ok` only when all three pass. */
/** kind: the plain white A4 or the printed ArUco sheet. */
export async function checkA4(serverUrl: string, photoUri: string, kind: 'a4' | 'aruco' = 'a4'): Promise<A4Check> {
  const form = new FormData();
  const file = new File(photoUri);
  form.append('image', file, file.name || 'check.jpg');
  form.append('kind', kind);
  const res = await fetch(`${serverUrl.replace(/\/$/, '')}/check_a4`, { method: 'POST', body: form });
  if (!res.ok) throw new Error(`السيرفر رد بخطأ ${res.status}`);
  return (await res.json()) as A4Check;
}

export async function ping(serverUrl: string): Promise<boolean> {
  try {
    const res = await fetch(`${serverUrl.replace(/\/$/, '')}/health`);
    return res.ok;
  } catch {
    return false;
  }
}
