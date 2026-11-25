import { useCallback, useEffect, useState } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

import { ping } from '../api';
import { clearRecords, exportRecords, loadRecords, saveServerUrl } from '../storage';
import { C, MEASUREMENT_LABELS } from '../theme';
import type { TestRecord } from '../types';

type Props = { serverUrl: string; setServerUrl: (v: string) => void; onStart: () => void; onArCompare: () => void };

const METHOD_LABELS: Record<string, string> = {
  tape: 'المقياس: متر',
  calibration: 'المقياس: متر',
  a4: 'المقياس: ورقة A4',
  card: 'المقياس: كارت',
  rect: 'المقياس: مرجع تاني',
  ar: 'المقياس: AR',
};

/** Mean absolute error per measurement across saved tests that have a tape value. */
function summary(records: TestRecord[]) {
  const acc: Record<string, { sum: number; n: number; within1: number }> = {};
  for (const r of records) {
    for (const [k, t] of Object.entries(r.truth)) {
      if (t == null || r.measured[k] == null) continue;
      const e = Math.abs(r.measured[k] - t);
      acc[k] ??= { sum: 0, n: 0, within1: 0 };
      acc[k].sum += e;
      acc[k].n += 1;
      if (e <= 1) acc[k].within1 += 1;
    }
  }
  return acc;
}

export function HomeScreen({ serverUrl, setServerUrl, onStart, onArCompare }: Props) {
  const [records, setRecords] = useState<TestRecord[]>([]);
  const [status, setStatus] = useState<'unknown' | 'ok' | 'down'>('unknown');

  const refresh = useCallback(async () => setRecords(await loadRecords()), []);
  useEffect(() => {
    refresh();
  }, [refresh]);

  const check = async () => {
    await saveServerUrl(serverUrl);
    setStatus((await ping(serverUrl)) ? 'ok' : 'down');
  };

  // One error table per scale reference, so tape / A4 / card can be compared on the same shirts.
  const byMethod = new Map<string, TestRecord[]>();
  for (const r of records) {
    const m = r.scaleMethod === 'calibration' ? 'tape' : r.scaleMethod;
    byMethod.set(m, [...(byMethod.get(m) ?? []), r]);
  }
  const groups = [...byMethod.entries()]
    .map(([m, rs]) => ({ method: m, n: rs.length, stats: summary(rs) }))
    .filter((g) => Object.keys(g.stats).length > 0);

  return (
    <ScrollView style={s.root} contentContainerStyle={{ padding: 16, paddingTop: 64, gap: 16 }}>
      <Text style={s.h1}>مقاسي — اختبار القياس</Text>
      <Text style={s.sub}>صوّر تيشرت مفرود، وقارن قياس مقاسي بالمتر. النتايج بتتحفظ على الموبايل وتقدر تصدّرها.</Text>

      <View style={s.card}>
        <Text style={s.label}>عنوان السيرفر</Text>
        <TextInput
          value={serverUrl}
          onChangeText={setServerUrl}
          autoCapitalize="none"
          autoCorrect={false}
          placeholder="http://192.168.1.10:8000"
          placeholderTextColor={C.muted}
          style={s.input}
        />
        <Pressable onPress={check} style={s.secondary}>
          <Text style={s.secondaryText}>
            {status === 'ok' ? '✓ السيرفر شغال' : status === 'down' ? 'مش واصلين للسيرفر — جرّب تاني' : 'اختبر الاتصال'}
          </Text>
        </Pressable>
      </View>

      <Pressable onPress={onStart} style={s.btn}>
        <Text style={s.btnText}>صوّر تيشرت</Text>
      </Pressable>
      <Pressable onPress={onArCompare} style={s.secondary}>
        <Text style={s.secondaryText}>القياس بالـ AR + A4</Text>
      </Pressable>

      <View style={s.card}>
        <Text style={s.h2}>النتايج لحد دلوقتي ({records.length} تجربة)</Text>
        {groups.length === 0 ? (
          <Text style={s.sub}>لسه مفيش تجارب فيها قياس بالمتر.</Text>
        ) : (
          groups.map((g) => (
            <View key={g.method} style={{ gap: 2 }}>
              <Text style={s.groupHead}>{METHOD_LABELS[g.method] ?? g.method} ({g.n})</Text>
              {Object.entries(g.stats).map(([k, v]) => (
                <View key={k} style={s.statRow}>
                  <Text style={s.statVal}>
                    ±{(v.sum / v.n).toFixed(1)} سم · {Math.round((100 * v.within1) / v.n)}% في حدود 1 سم
                  </Text>
                  <Text style={s.label}>{MEASUREMENT_LABELS[k] ?? k}</Text>
                </View>
              ))}
            </View>
          ))
        )}
        <View style={{ flexDirection: 'row-reverse', gap: 8, marginTop: 8 }}>
          <Pressable onPress={exportRecords} style={[s.secondary, { flex: 1 }]}>
            <Text style={s.secondaryText}>صدّر النتايج (JSON)</Text>
          </Pressable>
          <Pressable
            onPress={() =>
              Alert.alert('امسح كل النتايج؟', 'مش هتقدر ترجعها.', [
                { text: 'إلغاء', style: 'cancel' },
                { text: 'امسح', style: 'destructive', onPress: async () => { await clearRecords(); refresh(); } },
              ])
            }
            style={[s.secondary, { flex: 1 }]}
          >
            <Text style={[s.secondaryText, { color: C.bad }]}>امسح النتايج</Text>
          </Pressable>
        </View>
      </View>
    </ScrollView>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: C.bg },
  h1: { fontSize: 26, fontWeight: '700', color: C.text, textAlign: 'right' },
  h2: { fontSize: 17, fontWeight: '600', color: C.text, textAlign: 'right' },
  sub: { fontSize: 14, lineHeight: 22, color: C.text2, textAlign: 'right' },
  card: { backgroundColor: C.surface, borderRadius: 24, padding: 16, gap: 10, borderWidth: 1, borderColor: '#F0F2F2' },
  label: { fontSize: 14, fontWeight: '500', color: C.text, textAlign: 'right' },
  input: { height: 50, borderRadius: 14, borderWidth: 1.5, borderColor: C.borderStrong, paddingHorizontal: 12, fontSize: 15, color: C.text, textAlign: 'left' },
  btn: { height: 56, borderRadius: 16, backgroundColor: C.petrol, alignItems: 'center', justifyContent: 'center' },
  btnText: { color: '#FFFFFF', fontSize: 17, fontWeight: '600' },
  secondary: { height: 46, borderRadius: 14, borderWidth: 1.5, borderColor: C.borderStrong, alignItems: 'center', justifyContent: 'center', backgroundColor: C.surface },
  secondaryText: { fontSize: 14, fontWeight: '600', color: C.text },
  statRow: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 6, borderTopWidth: 1, borderTopColor: C.border },
  statVal: { fontSize: 14, color: C.text2 },
  groupHead: { fontSize: 14, fontWeight: '600', color: C.goldText, textAlign: 'right', marginTop: 6 },
});
