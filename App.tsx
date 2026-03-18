import React, { useEffect, useState } from 'react';
import { Dimensions, Platform, StyleSheet, View } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import * as ScreenOrientation from 'expo-screen-orientation';
import GameCanvas from './components/GameCanvas';

export default function App() {
  const [ready, setReady] = useState(Platform.OS === 'web');
  const [dimensions, setDimensions] = useState(() => {
    const { width, height } = Dimensions.get('window');
    // Ensure we use landscape dimensions
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

  // Listen for dimension changes (handles web resize & native orientation events)
  useEffect(() => {
    const subscription = Dimensions.addEventListener('change', ({ window }) => {
      setDimensions({
        width: Math.max(window.width, window.height),
        height: Math.min(window.width, window.height),
      });
    });
    return () => subscription.remove();
  }, []);

  if (!ready) return null;

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
});
