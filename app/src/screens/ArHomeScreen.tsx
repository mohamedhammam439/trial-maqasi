import { useCallback, useEffect, useState } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { arSummary, clearArRecords, exportArRecords, loadArRecords, type ArTestRecord } from '../arStorage';
import { C, MEASUREMENT_LABELS } from '../theme';

type Props = { onStart: () => void; onBack: () => void };

const fmt = (v?: { sum: number; n: number; within1: number }) =>
  v ? `±${(v.sum / v.n).toFixed(1)} · ${Math.round((100 * v.within1) / v.n)}%` : '—';

/** Separate flow for the AR scale: its own tests, its own log, and AR error against tape-measured values. */
export function ArHomeScreen({ onStart, onBack }: Props) {
  const [records, setRecords] = useState<ArTestRecord[]>([]);
  const refresh = useCallback(async () => setRecords(await loadArRecords()), []);
  useEffect(() => {
    refresh();
  }, [refresh]);

  const st = arSummary(records);
  const keys = Object.keys(st.ar);

  return (
    <ScrollView style={s.root} contentContainerStyle={{ padding: 16, paddingTop: 56, gap: 16 }}>
      <View style={s.header}>
        <Pressable onPress={onBack} style={s.back} accessibilityLabel="رجوع">
          <Text style={{ fontSize: 18, color: C.text }}>›</Text>
        </Pressable>
        <Text style={s.h1}>القياس بالـ AR</Text>
        <View style={{ width: 44 }} />
      </View>
      <Text style={s.sub}>
        هنا المقياس بييجي من الـ AR بس: الموبايل بيحدد الأرضية وبُعده عنها، ومش محتاج متر في الصورة. بعد القياس اكتب قياساتك بالمتر عشان
        نشوف الفرق.
      </Text>

      <Pressable onPress={onStart} style={s.btn}>
        <Text style={s.btnText}>صوّر بالـ AR</Text>
      </Pressable>

      <View style={s.card}>
        <Text style={s.h2}>النتايج ({records.length} تجربة)</Text>
        {keys.length === 0 ? (
          <Text style={s.sub}>لسه مفيش تجارب فيها قياس بالمتر.</Text>
        ) : (
          <>
            <View style={s.statRow}>
              <Text style={[s.colHead, { flex: 1 }]}>متوسط الفرق عن المتر · ≤ 1 سم</Text>
              <Text style={[s.colHead, { flex: 1, textAlign: 'right' }]}>القياس</Text>
            </View>
            {keys.map((k) => (
              <View key={k} style={s.statRow}>
                <Text style={[s.statVal, { flex: 1 }]}>{fmt(st.ar[k])}</Text>
                <Text style={[s.label, { flex: 1 }]}>{MEASUREMENT_LABELS[k] ?? k}</Text>
              </View>
            ))}
          </>
        )}
        <View style={{ flexDirection: 'row-reverse', gap: 8, marginTop: 8 }}>
          <Pressable onPress={exportArRecords} style={[s.secondary, { flex: 1 }]}>
            <Text style={s.secondaryText}>صدّر النتايج (JSON)</Text>
          </Pressable>
          <Pressable
            onPress={() =>
              Alert.alert('امسح نتايج الـ AR؟', 'مش هتقدر ترجعها.', [
                { text: 'إلغاء', style: 'cancel' },
                { text: 'امسح', style: 'destructive', onPress: async () => { await clearArRecords(); refresh(); } },
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
  header: { flexDirection: 'row-reverse', alignItems: 'center', justifyContent: 'space-between' },
  back: { width: 44, height: 44, borderRadius: 22, backgroundColor: C.surface, borderWidth: 1, borderColor: C.border, alignItems: 'center', justifyContent: 'center' },
  h1: { fontSize: 22, fontWeight: '700', color: C.text },
  h2: { fontSize: 17, fontWeight: '600', color: C.text, textAlign: 'right' },
  sub: { fontSize: 14, lineHeight: 22, color: C.text2, textAlign: 'right' },
  card: { backgroundColor: C.surface, borderRadius: 24, padding: 16, gap: 10, borderWidth: 1, borderColor: '#F0F2F2' },
  label: { fontSize: 14, fontWeight: '500', color: C.text, textAlign: 'right' },
  colHead: { fontSize: 13, color: C.muted, textAlign: 'center' },
  btn: { height: 56, borderRadius: 16, backgroundColor: C.petrol, alignItems: 'center', justifyContent: 'center' },
  btnText: { color: '#FFFFFF', fontSize: 17, fontWeight: '600' },
  secondary: { height: 46, borderRadius: 14, borderWidth: 1.5, borderColor: C.borderStrong, alignItems: 'center', justifyContent: 'center', backgroundColor: C.surface },
  secondaryText: { fontSize: 14, fontWeight: '600', color: C.text },
  statRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 6, borderTopWidth: 1, borderTopColor: C.border },
  statVal: { fontSize: 13, color: C.text2, textAlign: 'center' },
});
