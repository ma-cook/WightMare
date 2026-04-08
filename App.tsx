import React, { useCallback, useEffect, useState } from 'react';
import {
  AppState,
  Dimensions,
  Linking,
  Platform,
  Pressable,
  StatusBar as RNStatusBar,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { StatusBar } from 'expo-status-bar';
import * as ScreenOrientation from 'expo-screen-orientation';
import * as NavigationBar from 'expo-navigation-bar';
import AsyncStorage from '@react-native-async-storage/async-storage';
import GameCanvas from './components/GameCanvas';
import Leaderboard from './components/Leaderboard';
import SquigglyTitle, { SquigglyText, AnimatedDotWrapper } from './components/SquigglyTitle';
import { fetchTopScores, type LeaderboardEntry } from './services/leaderboard';
import Svg, { Path } from 'react-native-svg';

const STORAGE_KEY = 'wightmare_gamertag';

export default function App() {
  const [ready, setReady] = useState(Platform.OS === 'web');
  const [screen, setScreen] = useState<'menu' | 'nameEntry' | 'game'>('menu');
  const [playerName, setPlayerName] = useState('');
  const [nameInput, setNameInput] = useState('');
  const [topScores, setTopScores] = useState<LeaderboardEntry[]>([]);
  const [dimensions, setDimensions] = useState(() => {
    const { width, height } = Dimensions.get('window');
    return {
      width: Math.max(width, height),
      height: Math.min(width, height),
    };
  });

  // Load cached gamertag
  useEffect(() => {
    AsyncStorage.getItem(STORAGE_KEY).then((val) => {
      if (val) {
        setPlayerName(val);
        setNameInput(val);
      }
    });
  }, []);

  // Fetch leaderboard on mount and when returning to menu
  useEffect(() => {
    if (screen === 'menu') {
      fetchTopScores(10).then(setTopScores).catch(() => {});
    }
  }, [screen]);

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

  const handlePlay = useCallback(() => setScreen('nameEntry'), []);

  const handleStartGame = useCallback(() => {
    const trimmed = nameInput.trim().slice(0, 20);
    if (!trimmed) return;
    setPlayerName(trimmed);
    AsyncStorage.setItem(STORAGE_KEY, trimmed);
    setScreen('game');
  }, [nameInput]);

  const handleGameOver = useCallback(() => {
    setScreen('menu');
  }, []);

  const [introAnimDone, setIntroAnimDone] = useState(false);

  useEffect(() => {
    if (screen !== 'menu') return;
    setIntroAnimDone(false);
    const t = setTimeout(() => setIntroAnimDone(true), 2200);
    return () => clearTimeout(t);
  }, [screen]);

  if (!ready)
    return (
      <View style={styles.splash}>
        <StatusBar hidden />
        <SquigglyTitle maxWidth={400} />
      </View>
    );

  if (screen === 'menu' || screen === 'nameEntry')
    return (
      <View style={styles.menu}>
        <StatusBar hidden />
        <View style={styles.titleWrap}>
          <SquigglyTitle maxWidth={400} wobble={!introAnimDone} />
        </View>
        {screen === 'menu' ? (
          <>
            <Pressable style={styles.playBar} onPress={handlePlay}>
              <SquigglyText text="Play" maxWidth={120} letterHeight={36} delay={0} animDuration={500} color="#ffffff" wobble={!introAnimDone} />
            </Pressable>
            <View style={styles.taglineWrap}>
              <SquigglyText
                text="Connect the lines - Survive!"
                maxWidth={380}
                letterHeight={44}
                animDuration={0}
                letterStagger={0}
                strokeWidth={1.5}
                color="#555555"
                wobble={false}
              />
            </View>
          </>
        ) : (
          <View style={styles.nameRow}>
            <TextInput
              style={styles.nameInput}
              value={nameInput}
              onChangeText={setNameInput}
              placeholder="Enter gamertag"
              placeholderTextColor="#aaaaaa"
              maxLength={20}
              autoFocus
              onSubmitEditing={handleStartGame}
            />
            <AnimatedDotWrapper width={56} height={56} onPress={handleStartGame}>
              <Svg width={24} height={24} viewBox="0 0 24 24">
                <Path d="M10 6l6 6-6 6" stroke="#111" strokeWidth={3} fill="none" strokeLinecap="round" strokeLinejoin="round" />
              </Svg>
            </AnimatedDotWrapper>
          </View>
        )}
        {topScores.length > 0 && (
          <View style={styles.leaderboardMenuWrap}>
            <Leaderboard entries={topScores} />
          </View>
        )}
        {Platform.OS === 'web' && (
          <Pressable
            style={styles.privacyButton}
            onPress={() => Linking.openURL('/privacy-policy.html')}
          >
            <Text style={styles.privacyButtonText}>Privacy Policy</Text>
          </Pressable>
        )}
      </View>
    );

  return (
    <View style={styles.container}>
      <StatusBar hidden />
      <GameCanvas
        width={dimensions.width}
        height={dimensions.height}
        playerName={playerName}
        onReturnToMenu={handleGameOver}
      />
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

  menu: {
    flex: 1,
    backgroundColor: '#ffffff',
    alignItems: 'center',
    justifyContent: 'center',
  },
  titleWrap: {
    marginBottom: 20,
    marginTop: -40,
  },
  taglineWrap: {
    marginTop: 20,
  },
  playBar: {
    width: '20%',
    backgroundColor: '#111111',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 12,
  },
  nameRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  nameInput: {
    backgroundColor: '#ffffff',
    color: '#111111',
    fontSize: 20,
    fontWeight: '700',
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderWidth: 2,
    borderColor: '#111111',
    borderRadius: 0,
    width: 240,
  },
  leaderboardMenuWrap: {
    position: 'absolute',
    left: 20,
    top: 0,
    bottom: 0,
    width: '25%',
    justifyContent: 'center',
    alignItems: 'center',
  },
  privacyButton: {
    position: 'absolute',
    bottom: 16,
    right: 16,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  privacyButtonText: {
    fontSize: 12,
    color: '#999999',
    textDecorationLine: 'underline',
  },
});
