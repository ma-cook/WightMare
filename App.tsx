import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Animated,
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
import { getDownloadURL, ref } from 'firebase/storage';
import { storage } from './services/firebase';
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
const PB_STORAGE_KEY = 'wightmare_personal_best';

// True when running on a touch-only device in a web browser
const isMobileWeb =
  Platform.OS === 'web' &&
  typeof window !== 'undefined' &&
  window.matchMedia?.('(pointer: coarse)').matches === true;

const RotatePrompt = React.memo(function RotatePrompt() {
  const rotateAnim = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    const anim = Animated.loop(
      Animated.sequence([
        Animated.delay(500),
        Animated.timing(rotateAnim, { toValue: 1, duration: 700, useNativeDriver: true }),
        Animated.delay(600),
        Animated.timing(rotateAnim, { toValue: 0, duration: 0, useNativeDriver: true }),
      ])
    );
    anim.start();
    return () => anim.stop();
  }, [rotateAnim]);

  const rotate = rotateAnim.interpolate({
    inputRange: [0, 1],
    outputRange: ['0deg', '-90deg'],
  });

  return (
    <View style={rotateStyles.overlay}>
      <Animated.View style={{ transform: [{ rotate }] }}>
        <Svg width={80} height={80} viewBox="0 0 24 24">
          <Path
            d="M17 2H7a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V4a2 2 0 0 0-2-2zm-5 18.5a.5.5 0 1 1 0-1 .5.5 0 0 1 0 1zM17 17H7V6h10v11z"
            fill="#111111"
          />
        </Svg>
      </Animated.View>
      <Text style={rotateStyles.text}>Rotate your phone to play</Text>
    </View>
  );
});

export default function App() {
  const [ready, setReady] = useState(Platform.OS === 'web');
  const [screen, setScreen] = useState<'menu' | 'nameEntry' | 'game'>('menu');
  const [playerName, setPlayerName] = useState('');
  const [nameInput, setNameInput] = useState('');
  const [topScores, setTopScores] = useState<LeaderboardEntry[]>([]);
  const [personalBest, setPersonalBest] = useState<number | null>(null);
  const [dimensions, setDimensions] = useState(() => {
    const { width, height } = Dimensions.get('window');
    return {
      width: Math.max(width, height),
      height: Math.min(width, height),
    };
  });

  const [isPortrait, setIsPortrait] = useState(() => {
    if (Platform.OS !== 'web') return false;
    const { width, height } = Dimensions.get('window');
    return height > width;
  });

  // Load cached gamertag and personal best
  useEffect(() => {
    AsyncStorage.getItem(STORAGE_KEY).then((val) => {
      if (val) {
        setPlayerName(val);
        setNameInput(val);
      }
    });
    AsyncStorage.getItem(PB_STORAGE_KEY).then((val) => {
      if (val) setPersonalBest(parseFloat(val));
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
      if (Platform.OS === 'web') setIsPortrait(window.height > window.width);
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

  const handlePlay = useCallback(() => {
    if (playerName) {
      setScreen('game');
    } else {
      setScreen('nameEntry');
    }
  }, [playerName]);

  const handleStartGame = useCallback(() => {
    const trimmed = nameInput.trim().slice(0, 20);
    if (!trimmed) return;
    setPlayerName(trimmed);
    AsyncStorage.setItem(STORAGE_KEY, trimmed);
    setScreen('game');
  }, [nameInput]);

  const handleGameOver = useCallback((survivalTime?: number) => {
    if (survivalTime !== undefined && (personalBest === null || survivalTime > personalBest)) {
      setPersonalBest(survivalTime);
      AsyncStorage.setItem(PB_STORAGE_KEY, String(survivalTime));
    }
    setScreen('menu');
  }, [personalBest]);

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

  if (isMobileWeb && isPortrait)
    return <RotatePrompt />;

  if (screen === 'menu' || screen === 'nameEntry')
    return (
      <View style={styles.menu}>
        <StatusBar hidden />

        {/* 3-column landscape layout */}
        <View style={styles.menuColumns}>
          {/* Left column — Leaderboard */}
          <View style={styles.menuLeft}>
            {topScores.length > 0 && <Leaderboard entries={topScores} />}
          </View>

          {/* Center column — Main content */}
          <View style={styles.menuCenter}>
            <View style={styles.titleWrap}>
              <SquigglyTitle maxWidth={400} wobble={!introAnimDone} />
            </View>
            {screen === 'menu' ? (
              <>
                <AnimatedDotWrapper width={160} height={56} onPress={handlePlay}>
                  <SquigglyText text="Play" maxWidth={100} letterHeight={30} delay={0} animDuration={500} color="#ffffff" wobble={!introAnimDone} />
                </AnimatedDotWrapper>
                {playerName ? (
                  <Pressable onPress={() => setScreen('nameEntry')}>
                    <Text style={styles.changeNameText}>Change name</Text>
                  </Pressable>
                ) : null}
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
                {personalBest !== null ? (
                  <View style={styles.pbWrap}>
                    <Text style={styles.pbText}>
                      Personal Best: {Math.floor(personalBest / 60)}:{Math.floor(personalBest % 60).toString().padStart(2, '0')}
                    </Text>
                    {(() => {
                      const rank = topScores.findIndex(s => personalBest >= s.time) + 1;
                      return rank > 0 && rank <= 10 ? (
                        <Text style={styles.rankText}>Rank #{rank}</Text>
                      ) : null;
                    })()}
                  </View>
                ) : (
                  <Text style={styles.pbTextEmpty}>No runs yet</Text>
                )}
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
                  autoFocus={!playerName}
                  onSubmitEditing={handleStartGame}
                />
                <AnimatedDotWrapper width={56} height={56} onPress={handleStartGame}>
                  <Svg width={24} height={24} viewBox="0 0 24 24">
                    <Path d="M10 6l6 6-6 6" stroke="#fff" strokeWidth={3} fill="none" strokeLinecap="round" strokeLinejoin="round" />
                  </Svg>
                </AnimatedDotWrapper>
              </View>
            )}
          </View>

          {/* Right column — APK download (web only) */}
          <View style={styles.menuRight}>
            {Platform.OS === 'web' && (
              <ApkDownload />
            )}
          </View>
        </View>

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
        personalBest={personalBest}
        onReturnToMenu={handleGameOver}
      />
    </View>
  );
}

function ApkDownload() {
  const handleDownload = useCallback(async () => {
    try {
      const url = await getDownloadURL(ref(storage, 'downloads/Wightmare.apk'));
      const a = document.createElement('a');
      a.href = url;
      a.download = 'Wightmare.apk';
      a.click();
    } catch (e) {
      console.error('APK download failed', e);
    }
  }, []);

  return (
    <View style={apkStyles.container}>
      <Text style={apkStyles.title}>Wightmare APK</Text>
      <Pressable style={apkStyles.button} onPress={handleDownload}>
        <Text style={apkStyles.buttonText}>Download</Text>
      </Pressable>
    </View>
  );
}

const rotateStyles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: '#faecdb',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 28,
  },
  text: {
    fontSize: 18,
    color: '#111111',
    fontFamily: Platform.OS === 'web' ? 'Georgia, "Times New Roman", serif' : 'serif',
    textAlign: 'center',
  },
});

const apkStyles = StyleSheet.create({
  container: {
    alignItems: 'center',
    gap: 10,
  },
  title: {
    fontSize: 16,
    fontFamily: 'serif',
    fontWeight: '700',
    color: '#111111',
  },
  button: {
    backgroundColor: '#111111',
    paddingHorizontal: 24,
    paddingVertical: 12,
    borderRadius: 24,
  },
  buttonText: {
    color: '#ffffff',
    fontSize: 15,
    fontWeight: '700',
    fontFamily: 'serif',
  },
});

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
    backgroundColor: '#faecdb',
  },
  menuColumns: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
  },
  menuLeft: {
    width: '25%',
    alignItems: 'center',
    justifyContent: 'center',
    paddingLeft: 20,
  },
  menuCenter: {
    width: '50%',
    alignItems: 'center',
    justifyContent: 'center',
  },
  menuRight: {
    width: '25%',
  },
  titleWrap: {
    marginBottom: 16,
  },
  taglineWrap: {
    marginTop: 16,
  },
  changeNameText: {
    fontSize: 12,
    color: '#888888',
    fontFamily: 'serif',
    fontStyle: 'italic',
    marginTop: 6,
  },
  pbWrap: {
    alignItems: 'center',
    marginTop: 10,
  },
  pbText: {
    fontSize: 18,
    color: '#8B0000',
    fontFamily: 'serif',
    fontStyle: 'italic',
    fontWeight: '700',
  },
  pbTextEmpty: {
    fontSize: 14,
    color: '#888888',
    fontFamily: 'serif',
    fontStyle: 'italic',
    marginTop: 10,
  },
  rankText: {
    fontSize: 13,
    color: '#8B0000',
    fontFamily: 'serif',
    fontStyle: 'italic',
    marginTop: 2,
  },
  nameRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  nameInput: {
    backgroundColor: 'rgba(255,255,255,0.8)',
    color: '#111111',
    fontSize: 20,
    fontWeight: '700',
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderWidth: 2,
    borderColor: '#111111',
    borderRadius: 24,
    width: 240,
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
