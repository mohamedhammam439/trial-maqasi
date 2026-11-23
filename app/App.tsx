import { StatusBar } from 'expo-status-bar';
import { useEffect, useState } from 'react';
import { View } from 'react-native';

import { CalibrateScreen } from './src/screens/CalibrateScreen';
import { CaptureScreen } from './src/screens/CaptureScreen';
import { HomeScreen } from './src/screens/HomeScreen';
import { ResultScreen } from './src/screens/ResultScreen';
import { loadServerUrl } from './src/storage';
import { C } from './src/theme';
import type { MeasureResponse, Shot } from './src/types';

type Route =
  | { name: 'home' }
  | { name: 'capture' }
  | { name: 'calibrate'; shot: Shot }
  | { name: 'result'; shot: Shot; result: MeasureResponse; calibrationCm: number };

export default function App() {
  const [route, setRoute] = useState<Route>({ name: 'home' });
  const [serverUrl, setServerUrl] = useState('');

  useEffect(() => {
    loadServerUrl().then((u) => u && setServerUrl(u));
  }, []);

  return (
    <View style={{ flex: 1, backgroundColor: C.bg }}>
      <StatusBar style="dark" />
      {route.name === 'home' && (
        <HomeScreen serverUrl={serverUrl} setServerUrl={setServerUrl} onStart={() => setRoute({ name: 'capture' })} />
      )}
      {route.name === 'capture' && (
        <CaptureScreen onBack={() => setRoute({ name: 'home' })} onShot={(shot) => setRoute({ name: 'calibrate', shot })} />
      )}
      {route.name === 'calibrate' && (
        <CalibrateScreen
          shot={route.shot}
          serverUrl={serverUrl}
          onBack={() => setRoute({ name: 'capture' })}
          onResult={(result, calibrationCm) => setRoute({ name: 'result', shot: route.shot, result, calibrationCm })}
        />
      )}
      {route.name === 'result' && (
        <ResultScreen shot={route.shot} result={route.result} calibrationCm={route.calibrationCm} onDone={() => setRoute({ name: 'home' })} />
      )}
    </View>
  );
}
