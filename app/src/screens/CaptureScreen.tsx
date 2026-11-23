import { Accelerometer } from 'expo-sensors';
import { useEffect, useState } from 'react';
import { ActivityIndicator, Image, Pressable, StyleSheet, Text, View } from 'react-native';
import Svg, { Path } from 'react-native-svg';
import {
  Camera,
  CommonResolutions,
  useCameraDevice,
  useCameraPermission,
  usePhotoOutput,
} from 'react-native-vision-camera';

import { C } from '../theme';
import type { Shot } from '../types';

/** Max phone tilt (degrees from flat) allowed to take the photo. From the synthetic tests:
 *  3° keeps core measurements within ~1 cm; 8° already drifts ~1.5 cm. */
export const MAX_TILT_DEG = 3;

function useTiltDeg() {
  const [tilt, setTilt] = useState(90);
  useEffect(() => {
    Accelerometer.setUpdateInterval(100);
    const sub = Accelerometer.addListener(({ x, y, z }) => {
      const g = Math.sqrt(x * x + y * y + z * z) || 1;
      // 0° = phone lying flat (camera pointing straight at the floor)
      setTilt((Math.acos(Math.min(1, Math.abs(z) / g)) * 180) / Math.PI);
    });
    return () => sub.remove();
  }, []);
  return tilt;
}

export function CaptureScreen({ onShot, onBack }: { onShot: (s: Shot) => void; onBack: () => void }) {
  const { hasPermission, requestPermission, canRequestPermission } = useCameraPermission();
  const device = useCameraDevice('back');
  const photoOutput = usePhotoOutput({ targetResolution: CommonResolutions.UHD_4_3, qualityPrioritization: 'quality' });
  const tilt = useTiltDeg();
  const [busy, setBusy] = useState(false);
  const level = tilt <= MAX_TILT_DEG;

  useEffect(() => {
    if (!hasPermission && canRequestPermission) requestPermission();
  }, [hasPermission, canRequestPermission, requestPermission]);

  const take = async () => {
    if (!level || busy) return;
    setBusy(true);
    try {
      const file = await photoOutput.capturePhotoToFile({ enableShutterSound: false }, {});
      const uri = file.filePath.startsWith('file://') ? file.filePath : `file://${file.filePath}`;
      // Use the displayed (EXIF-oriented) size; calibration taps are in these pixels.
      Image.getSize(
        uri,
        (width, height) => onShot({ uri, width, height, tiltDeg: Math.round(tilt * 10) / 10, takenAt: new Date().toISOString() }),
        () => onShot({ uri, width: file.width, height: file.height, tiltDeg: tilt, takenAt: new Date().toISOString() }),
      );
    } finally {
      setBusy(false);
    }
  };

  if (!hasPermission) {
    return (
      <View style={[s.root, s.center]}>
        <Text style={s.title}>محتاجين إذن الكاميرا</Text>
        <Text style={s.sub}>افتح الإعدادات واسمح لمقاسي يستخدم الكاميرا.</Text>
      </View>
    );
  }
  if (!device) {
    return (
      <View style={[s.root, s.center]}>
        <ActivityIndicator color={C.petrol} />
      </View>
    );
  }

  return (
    <View style={s.root}>
      <View style={s.header}>
        <Pressable onPress={onBack} style={s.back} accessibilityLabel="رجوع">
          <Text style={{ fontSize: 18, color: C.text }}>›</Text>
        </Pressable>
        <Text style={s.title}>تيشرت — صوّر من فوق</Text>
        <View style={{ width: 44 }} />
      </View>

      <View style={s.viewport}>
        <Camera style={StyleSheet.absoluteFill} device={device} outputs={[photoOutput]} isActive resizeMode="contain" />
        <Svg style={StyleSheet.absoluteFill} viewBox="0 0 100 100" preserveAspectRatio="xMidYMid meet" pointerEvents="none">
          <Path
            d="M31 20 L42 15 Q50 24 58 15 L69 20 L88 34 L79 48 L70 43 V84 Q70 87 67 87 H33 Q30 87 30 84 V43 L21 48 L12 34 Z"
            fill="none"
            stroke="#FFFFFF"
            strokeWidth={0.6}
            strokeDasharray="2 1.5"
          />
        </Svg>
        <View style={[s.pill, { backgroundColor: level ? 'rgba(30,122,82,0.92)' : 'rgba(20,18,16,0.75)' }]}>
          <Text style={s.pillText}>
            {level ? 'الموبايل موازي — صوّر' : `ميّل الموبايل لحد ما يبقى موازي للأرض (${tilt.toFixed(1)}°)`}
          </Text>
        </View>
      </View>

      <View style={s.checks}>
        <Text style={[s.check, level ? s.ok : s.no]}>{level ? '✓' : '!'} الميل ≤ {MAX_TILT_DEG}°</Text>
        <Text style={[s.check, s.ok]}>✓ القطعة على أرضية سادة</Text>
        <Text style={[s.check, s.ok]}>✓ الأكمام مفرودة</Text>
      </View>

      <View style={s.footer}>
        <Pressable
          onPress={take}
          disabled={!level || busy}
          accessibilityLabel="التقاط الصورة"
          style={[s.shutter, { borderColor: level ? C.petrol : 'rgba(29,53,54,0.3)' }]}
        >
          <View style={[s.shutterInner, { backgroundColor: level ? C.petrol : 'rgba(29,53,54,0.15)' }]} />
        </Pressable>
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: C.bg },
  center: { alignItems: 'center', justifyContent: 'center', padding: 24, gap: 8 },
  header: { flexDirection: 'row-reverse', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingTop: 56, paddingBottom: 8 },
  back: { width: 44, height: 44, borderRadius: 22, backgroundColor: C.surface, borderWidth: 1, borderColor: C.border, alignItems: 'center', justifyContent: 'center' },
  title: { fontSize: 17, fontWeight: '600', color: C.text, textAlign: 'center' },
  sub: { fontSize: 14, color: C.text2, textAlign: 'center' },
  viewport: { flex: 1, marginHorizontal: 16, borderRadius: 24, overflow: 'hidden', backgroundColor: '#E7EAEA' },
  pill: { position: 'absolute', top: 16, alignSelf: 'center', paddingHorizontal: 14, paddingVertical: 8, borderRadius: 999 },
  pillText: { color: '#FFFFFF', fontSize: 14, fontWeight: '600' },
  checks: { flexDirection: 'row-reverse', flexWrap: 'wrap', gap: 8, paddingHorizontal: 16, paddingTop: 12 },
  check: { fontSize: 13, fontWeight: '600', paddingHorizontal: 10, paddingVertical: 6, borderRadius: 8, overflow: 'hidden' },
  ok: { color: C.good, backgroundColor: C.goodBg },
  no: { color: C.warn, backgroundColor: C.warnBg },
  footer: { alignItems: 'center', paddingVertical: 24 },
  shutter: { width: 76, height: 76, borderRadius: 38, borderWidth: 4, alignItems: 'center', justifyContent: 'center' },
  shutterInner: { width: 60, height: 60, borderRadius: 30 },
});
