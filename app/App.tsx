import { StatusBar } from 'expo-status-bar';
import { useEffect, useState } from 'react';
import { View } from 'react-native';

import { ArCaptureScreen, type ArShot } from './src/screens/ArCaptureScreen';
import { ArResultScreen } from './src/screens/ArResultScreen';
import { ArHomeScreen } from './src/screens/ArHomeScreen';
import { CalibrateScreen } from './src/screens/CalibrateScreen';
import { CaptureScreen } from './src/screens/CaptureScreen';
import { HomeScreen } from './src/screens/HomeScreen';
import { ResultScreen } from './src/screens/ResultScreen';
import { loadServerUrl } from './src/storage';
import { C } from './src/theme';
import type { MeasureResponse, ScaleInfo, Shot } from './src/types';

type Route =
  | { name: 'home' }
  | { name: 'capture' }
  | { name: 'calibrate'; shot: Shot }
  | { name: 'result'; shot: Shot; result: MeasureResponse; scale: ScaleInfo }
  // Separate AR flow: AR scale vs tape scale on the same photo, with its own log.
  | { name: 'arHome' }
  | { name: 'arCapture' }
  | { name: 'arResult'; shot: ArShot };

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
        <HomeScreen serverUrl={serverUrl} setServerUrl={setServerUrl} onStart={() => setRoute({ name: 'capture' })}
          onArCompare={() => setRoute({ name: 'arHome' })}
        />
      )}
      {route.name === 'capture' && (
        <CaptureScreen onBack={() => setRoute({ name: 'home' })} onShot={(shot) => setRoute({ name: 'calibrate', shot })} />
      )}
      {route.name === 'calibrate' && (
        <CalibrateScreen
          shot={route.shot}
          serverUrl={serverUrl}
          onBack={() => setRoute({ name: 'capture' })}
          onResult={(result, scale) => setRoute({ name: 'result', shot: route.shot, result, scale })}
        />
      )}
      {route.name === 'result' && (
        <ResultScreen shot={route.shot} result={route.result} scale={route.scale} onDone={() => setRoute({ name: 'home' })} />
      )}
      {route.name === 'arHome' && (
        <ArHomeScreen onBack={() => setRoute({ name: 'home' })} onStart={() => setRoute({ name: 'arCapture' })} />
      )}
      {route.name === 'arCapture' && (
        <ArCaptureScreen serverUrl={serverUrl} onBack={() => setRoute({ name: 'arHome' })} onShot={(shot) => setRoute({ name: 'arResult', shot })} />
      )}
      {route.name === 'arResult' && (
        <ArResultScreen
          shot={route.shot}
          serverUrl={serverUrl}
          onBack={() => setRoute({ name: 'arCapture' })}
          onDone={() => setRoute({ name: 'arHome' })}
        />
      )}
    </View>
  );
}
