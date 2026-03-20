import React, { useCallback, useEffect, useState } from 'react';
import {
  AppState,
  Dimensions,
  Image,
  Platform,
  Pressable,
  StatusBar as RNStatusBar,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { StatusBar } from 'expo-status-bar';
import * as ScreenOrientation from 'expo-screen-orientation';
import * as NavigationBar from 'expo-navigation-bar';
import GameCanvas from './components/GameCanvas';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const splashImage = require('./assests/image (5).png');

export default function App() {
  const [ready, setReady] = useState(Platform.OS === 'web');
  const [screen, setScreen] = useState<'menu' | 'game'>('menu');
  const [dimensions, setDimensions] = useState(() => {
    const { width, height } = Dimensions.get('window');
    return {
      width: Math.max(width, height),
      height: Math.min(width, height),
    };
  });

  // Lock to landscape on native
  useEffect(() => {
    if (Platform.OS !== 'web') {
      ScreenOrientation.lockAsync(ScreenOrientation.OrientationLock.LANDSCAPE).then(
        () => setReady(true),
      );
    }
  }, []);

  // Listen for dimension changes
  useEffect(() => {
    const subscription = Dimensions.addEventListener('change', ({ window }) => {
      setDimensions({
        width: Math.max(window.width, window.height),
        height: Math.min(window.width, window.height),
      });
    });
    return () => subscription.remove();
  }, []);

  // Enter sticky immersive mode on Android — hide both bars and require
  // a deliberate swipe to reveal them transiently (BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE).
  // Also re-engage every time the app returns to the foreground, because Android
  // resets immersive mode whenever the system UI briefly appears.
  useEffect(() => {
    if (Platform.OS !== 'android') return;

    const engage = async () => {
      RNStatusBar.setHidden(true, 'none');
      await NavigationBar.setVisibilityAsync('hidden');
      await NavigationBar.setBehaviorAsync('overlay-swipe');
    };

    engage();

    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') engage();
    });

    return () => sub.remove();
  }, []);

  const handlePlay = useCallback(() => setScreen('game'), []);

  if (!ready)
    return (
      <View style={styles.splash}>
        <StatusBar hidden />
        <Image
          source={splashImage}
          style={styles.splashImage}
          resizeMode="contain"
        />
      </View>
    );

  if (screen === 'menu')
    return (
      <View style={styles.menu}>
        <StatusBar hidden />
        <Image
          source={splashImage}
          style={styles.menuImage}
          resizeMode="contain"
        />
        <Pressable style={styles.playButton} onPress={handlePlay}>
          <Text style={styles.playText}>Play</Text>
        </Pressable>
      </View>
    );

  return (
    <View style={styles.container}>
      <StatusBar hidden />
      <GameCanvas width={dimensions.width} height={dimensions.height} />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#ffffff',
  },
  splash: {
    flex: 1,
    backgroundColor: '#ffffff',
    alignItems: 'center',
    justifyContent: 'center',
  },
  splashImage: {
    width: '50%',
    height: '50%',
  },
  menu: {
    flex: 1,
    backgroundColor: '#ffffff',
    alignItems: 'center',
    justifyContent: 'center',
  },
  menuImage: {
    width: '40%',
    height: '40%',
    marginBottom: 32,
  },
  playButton: {
    backgroundColor: '#111111',
    paddingHorizontal: 48,
    paddingVertical: 16,
    borderRadius: 8,
  },
  playText: {
    color: '#ffffff',
    fontSize: 24,
    fontWeight: '700',
  },
});
