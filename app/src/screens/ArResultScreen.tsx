import { useEffect, useState } from 'react';
import { ActivityIndicator, Image, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import Svg, { Circle, Line as SvgLine } from 'react-native-svg';

import { measure } from '../api';
import { saveArRecord } from '../arStorage';
import { C, MEASUREMENT_LABELS } from '../theme';
import type { MeasureResponse } from '../types';
import type { ArShot } from './ArCaptureScreen';

type Props = { shot: ArShot; serverUrl: string; onBack: () => void; onDone: () => void };

const num = (v: string | undefined) => {
  const x = parseFloat((v ?? '').replace(',', '.'));
  return Number.isFinite(x) ? x : null;
};

function DiffText({ value, truth }: { value: number | undefined; truth: number | null }) {
  if (value == null) return <Text style={s.value}>—</Text>;
  const diff = truth == null ? null : value - truth;
  return (
    <View style={{ flex: 1, alignItems: 'center' }}>
      <Text style={s.value}>{value.toFixed(1)}</Text>
      {diff != null && (
        <Text style={[s.diff, { color: Math.abs(diff) <= 1 ? C.good : Math.abs(diff) <= 2 ? C.warn : C.bad }]}>
          {diff > 0 ? '+' : ''}{diff.toFixed(1)}
        </Text>
      )}
    </View>
  );
}

/** Measures the AR photo with the AR floor scale only, then the user types what the tape says for each
 *  measurement so the AR result can be compared with the tape. */
export function ArResultScreen({ shot, serverUrl, onBack, onDone }: Props) {
  const [boxW, setBoxW] = useState(0);
  const [arRes, setArRes] = useState<MeasureResponse | null>(null);
  const [truth, setTruth] = useState<Record<string, string>>({});
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const boxH = boxW ? (boxW * shot.height) / shot.width : 0;
  const k = boxW ? shot.width / boxW : 1; // display px -> image px

  useEffect(() => {
    measure(serverUrl, shot.uri, { type: 'px_per_cm', pxPerCm: shot.ar.pxPerCm })
      .then(setArRes)
      .catch((e) => setError(e instanceof Error ? e.message : 'حصل خطأ في الاتصال بالسيرفر.'))
      .finally(() => setBusy(false));
  }, [serverUrl, shot]);

  const keys = Object.keys(arRes?.measurements_cm ?? {});

  const save = async () => {
    if (!arRes) return;
    const parsed: Record<string, number | null> = {};
    for (const key of keys) parsed[key] = num(truth[key]);
    await saveArRecord({
      id: `${Date.now()}`,
      takenAt: shot.takenAt,
      tiltDeg: shot.tiltDeg,
      ar: {
        pxPerCm: shot.ar.pxPerCm,
        distanceCm: shot.ar.distanceCm,
        spread: shot.ar.spread,
        topBottomDiff: shot.ar.topBottomDiff,
        samples: shot.ar.samples,
      },
      tape: null,
      scaleDiffPct: null,
      measuredAr: arRes.measurements_cm,
      measuredTape: null,
      truth: parsed,
      note,
    });
    setSaved(true);
  };

  return (
    <ScrollView style={s.root} contentContainerStyle={{ padding: 16, paddingTop: 56, gap: 14 }}>
      <View style={s.header}>
        <Pressable onPress={onBack} style={s.back} accessibilityLabel="رجوع">
          <Text style={{ fontSize: 18, color: C.text }}>›</Text>
        </Pressable>
        <Text style={s.title}>القياس بالـ AR</Text>
        <View style={{ width: 44 }} />
      </View>

      <View style={s.card}>
        <Text style={s.label}>مقياس الـ AR: {shot.ar.pxPerCm.toFixed(2)} px/cm</Text>
        <Text style={s.sub}>
          بُعد الموبايل عن الأرض: {shot.ar.distanceCm != null ? `${shot.ar.distanceCm} سم` : 'مش معروف'} · الميل {shot.tiltDeg}° · ثبات القياس ±
          {(shot.ar.spread * 100).toFixed(1)}%
        </Text>
      </View>

      <View style={{ width: '100%' }} onLayout={(e) => setBoxW(e.nativeEvent.layout.width)}>
        {boxW > 0 && (
          <View style={{ width: boxW, height: boxH }}>
            <Image source={{ uri: shot.uri }} style={{ width: boxW, height: boxH, borderRadius: 16 }} />
            <Svg style={StyleSheet.absoluteFill} pointerEvents="none">
              {arRes?.lines.map((ln) => (
                <SvgLine
                  key={ln.name}
                  x1={ln.a.x / k} y1={ln.a.y / k} x2={ln.b.x / k} y2={ln.b.y / k}
                  stroke={ln.confidence === 'high' ? C.petrol : C.warn}
                  strokeWidth={3}
                  strokeDasharray={ln.confidence === 'high' ? undefined : '6 4'}
                />
              ))}
              {arRes?.lines.flatMap((ln) => [ln.a, ln.b].map((p, i) => (
                <Circle key={`${ln.name}${i}`} cx={p.x / k} cy={p.y / k} r={5} fill={C.gold} stroke="#FFFFFF" strokeWidth={1.5} />
              )))}
            </Svg>
          </View>
        )}
      </View>

      {error && <Text style={s.error}>{error}</Text>}
      {busy && <ActivityIndicator color={C.petrol} />}
      {arRes?.warnings.map((w) => <Text key={w} style={s.warn}>{w}</Text>)}

      {arRes && (
        <View style={s.card}>
          <View style={s.headRow}>
            <Text style={s.colHead}>بالـ AR</Text>
            <Text style={s.colHead}>بالمتر</Text>
            <Text style={[s.colHead, { flex: 1.3, textAlign: 'right' }]}>القياس</Text>
          </View>
          {keys.map((key) => {
            const t = num(truth[key]);
            return (
              <View key={key} style={s.row}>
                <DiffText value={arRes.measurements_cm[key]} truth={t} />
                <TextInput
                  value={truth[key] ?? ''}
                  onChangeText={(v) => setTruth((p) => ({ ...p, [key]: v }))}
                  keyboardType="decimal-pad"
                  placeholder="—"
                  placeholderTextColor={C.muted}
                  style={s.input}
                  accessibilityLabel={`قياس ${MEASUREMENT_LABELS[key] ?? key} بالمتر`}
                />
                <Text style={[s.label, { flex: 1.3 }]}>{MEASUREMENT_LABELS[key] ?? key}</Text>
              </View>
            );
          })}
        </View>
      )}

      <TextInput value={note} onChangeText={setNote} placeholder="ملاحظة (الأرضية، الإضاءة، الموبايل...)" placeholderTextColor={C.muted} style={s.note} multiline />

      {saved ? (
        <Pressable onPress={onDone} style={s.btn}><Text style={s.btnText}>اتحفظ — رجوع لصفحة الـ AR</Text></Pressable>
      ) : (
        <Pressable onPress={save} disabled={!arRes} style={[s.btn, !arRes && { opacity: 0.4 }]}><Text style={s.btnText}>احفظ النتيجة</Text></Pressable>
      )}
    </ScrollView>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: C.bg },
  header: { flexDirection: 'row-reverse', alignItems: 'center', justifyContent: 'space-between' },
  back: { width: 44, height: 44, borderRadius: 22, backgroundColor: C.surface, borderWidth: 1, borderColor: C.border, alignItems: 'center', justifyContent: 'center' },
  title: { fontSize: 18, fontWeight: '600', color: C.text },
  sub: { fontSize: 14, lineHeight: 22, color: C.text2, textAlign: 'right' },
  card: { backgroundColor: C.surface, borderRadius: 24, padding: 16, gap: 6, borderWidth: 1, borderColor: '#F0F2F2' },
  label: { fontSize: 15, color: C.text, textAlign: 'right' },
  warn: { color: C.warn, backgroundColor: C.warnBg, padding: 10, borderRadius: 12, textAlign: 'right' },
  error: { color: C.bad, backgroundColor: C.badBg, padding: 12, borderRadius: 12, textAlign: 'right' },
  headRow: { flexDirection: 'row', paddingBottom: 8 },
  colHead: { flex: 1, fontSize: 13, color: C.muted, textAlign: 'center' },
  row: { flexDirection: 'row', alignItems: 'center', paddingVertical: 10, borderTopWidth: 1, borderTopColor: C.border },
  value: { fontSize: 17, fontWeight: '600', color: C.text, textAlign: 'center' },
  diff: { fontSize: 12, fontWeight: '600' },
  input: { flex: 1, height: 44, marginHorizontal: 4, borderRadius: 12, borderWidth: 1.5, borderColor: C.borderStrong, textAlign: 'center', fontSize: 16, color: C.text, backgroundColor: C.surface },
  note: { minHeight: 60, borderRadius: 14, borderWidth: 1.5, borderColor: C.borderStrong, backgroundColor: C.surface, padding: 12, textAlign: 'right', color: C.text },
  btn: { height: 54, borderRadius: 16, backgroundColor: C.petrol, alignItems: 'center', justifyContent: 'center' },
  btnText: { color: '#FFFFFF', fontSize: 16, fontWeight: '600' },
});
