import * as FileSystem from 'expo-file-system/legacy';
import * as Sharing from 'expo-sharing';

import type { TestRecord } from './types';

const LOG = `${FileSystem.documentDirectory}maqasi-tests.json`;
const SETTINGS = `${FileSystem.documentDirectory}maqasi-settings.json`;

async function readJson<T>(uri: string, fallback: T): Promise<T> {
  try {
    const info = await FileSystem.getInfoAsync(uri);
    if (!info.exists) return fallback;
    return JSON.parse(await FileSystem.readAsStringAsync(uri)) as T;
  } catch {
    return fallback;
  }
}

export const loadRecords = () => readJson<TestRecord[]>(LOG, []);

export async function saveRecord(r: TestRecord) {
  const all = await loadRecords();
  all.unshift(r);
  await FileSystem.writeAsStringAsync(LOG, JSON.stringify(all, null, 2));
}

export async function clearRecords() {
  await FileSystem.writeAsStringAsync(LOG, '[]');
}

export async function exportRecords() {
  const info = await FileSystem.getInfoAsync(LOG);
  if (!info.exists) await FileSystem.writeAsStringAsync(LOG, '[]');
  await Sharing.shareAsync(LOG, { mimeType: 'application/json', dialogTitle: 'نتايج اختبار مقاسي' });
}

export const loadServerUrl = async () => (await readJson<{ serverUrl?: string }>(SETTINGS, {})).serverUrl ?? '';

export const saveServerUrl = (serverUrl: string) =>
  FileSystem.writeAsStringAsync(SETTINGS, JSON.stringify({ serverUrl }));
