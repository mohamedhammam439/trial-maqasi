import type { MeasureResponse, Pt } from './types';

export async function measure(
  serverUrl: string,
  photoUri: string,
  calib: { p1: Pt; p2: Pt; cm: number },
): Promise<MeasureResponse> {
  const form = new FormData();
  // React Native's FormData accepts {uri, name, type} file descriptors.
  form.append('image', { uri: photoUri, name: 'shot.jpg', type: 'image/jpeg' } as unknown as Blob);
  form.append('garment', 'tshirt');
  form.append('calib', JSON.stringify({ p1: [calib.p1.x, calib.p1.y], p2: [calib.p2.x, calib.p2.y], cm: calib.cm }));

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
