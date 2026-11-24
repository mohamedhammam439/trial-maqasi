import type { MeasureResponse, Pt, Scale } from './types';

const xy = (p: Pt) => [p.x, p.y];

export async function measure(
  serverUrl: string,
  photoUri: string,
  scale: Scale,
): Promise<MeasureResponse> {
  const form = new FormData();
  // React Native's FormData accepts {uri, name, type} file descriptors.
  form.append('image', { uri: photoUri, name: 'shot.jpg', type: 'image/jpeg' } as unknown as Blob);
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

  const res = await fetch(`${serverUrl.replace(/\/$/, '')}/measure`, { method: 'POST', body: form });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(typeof body?.detail === 'string' ? body.detail : `السيرفر رد بخطأ ${res.status}`);
  }
  return body as MeasureResponse;
}

export async function ping(serverUrl: string): Promise<boolean> {
  try {
    const res = await fetch(`${serverUrl.replace(/\/$/, '')}/health`);
    return res.ok;
  } catch {
    return false;
  }
}
