import React, { useEffect, useState } from 'react';
import { Dimensions, StyleSheet, Text, View } from 'react-native';
import Svg, { Defs, LinearGradient, Stop, Rect, Path } from 'react-native-svg';
import Leaderboard from './Leaderboard';
import { SquigglyText, AnimatedDotWrapper } from './SquigglyTitle';
import { fetchTopScores, submitScore, type LeaderboardEntry } from '../services/leaderboard';

interface Props {
  survivalTime: number;
  playerName: string;
  isNewBest: boolean;
  onPlayAgain: () => void;
  onReturnToMenu: () => void;
  totalConnected: number;
  longestCombo: number;
  closestEdgeCall: number;
  averageConnectionTime: number;
}

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

// Stagger delay stages (ms)
const STAGE_TITLE = 0;
const STAGE_TIME = 200;
const STAGE_STATS = 400;
const STAGE_BUTTONS = 600;
const STAGE_LEADERBOARD = 800;

export default function GameOverScreen({ survivalTime, playerName, isNewBest, onPlayAgain, onReturnToMenu, totalConnected, longestCombo, closestEdgeCall, averageConnectionTime }: Props) {
  const [topScores, setTopScores] = useState<LeaderboardEntry[]>([]);
  const [submitted, setSubmitted] = useState(false);

  // Staggered entrance visibility
  const [showTitle, setShowTitle] = useState(false);
  const [showTime, setShowTime] = useState(false);
  const [showStats, setShowStats] = useState(false);
  const [showButtons, setShowButtons] = useState(false);
  const [showLeaderboard, setShowLeaderboard] = useState(false);

  useEffect(() => {
    const timers = [
      setTimeout(() => setShowTitle(true), STAGE_TITLE),
      setTimeout(() => setShowTime(true), STAGE_TIME),
      setTimeout(() => setShowStats(true), STAGE_STATS),
      setTimeout(() => setShowButtons(true), STAGE_BUTTONS),
      setTimeout(() => setShowLeaderboard(true), STAGE_LEADERBOARD),
    ];
    return () => timers.forEach(clearTimeout);
  }, []);

  useEffect(() => {
    if (!submitted && playerName) {
      setSubmitted(true);
      submitScore(playerName, survivalTime)
        .then(() => fetchTopScores(10))
        .then(setTopScores)
        .catch(() => {});
    }
  }, [submitted, playerName, survivalTime]);

  const { width: screenW, height: screenH } = Dimensions.get('window');
  const w = Math.max(screenW, screenH);
  const h = Math.min(screenW, screenH);

  return (
    <View style={styles.overlay}>
      {/* Gradient background */}
      <Svg width={w} height={h} style={StyleSheet.absoluteFill} pointerEvents="none">
        <Defs>
          <LinearGradient id="go-bg" x1="0" y1="0" x2="1" y2="0">
            <Stop offset="0" stopColor="#EDE5DA" />
            <Stop offset="1" stopColor="#FFFFFF" />
          </LinearGradient>
        </Defs>
        <Rect x="0" y="0" width={w} height={h} fill="url(#go-bg)" opacity={0.92} />
      </Svg>

      {/* 3-column layout */}
      <View style={styles.columns}>
        {/* Left column — Stats */}
        <View style={[styles.colLeft, { opacity: showStats ? 1 : 0 }]}>
          <View style={styles.statsGrid}>
            <View style={styles.statCard}>
              <Text style={styles.statLabel}>Connections</Text>
              <Text style={styles.statValue}>{totalConnected}</Text>
            </View>
            <View style={styles.statCard}>
              <Text style={styles.statLabel}>Best Combo</Text>
              <Text style={styles.statValue}>x{longestCombo}</Text>
            </View>
            <View style={styles.statCard}>
              <Text style={styles.statLabel}>Closest Call</Text>
              <Text style={styles.statValue}>{closestEdgeCall}px</Text>
            </View>
            <View style={styles.statCard}>
              <Text style={styles.statLabel}>Avg Connect</Text>
              <Text style={styles.statValue}>{averageConnectionTime.toFixed(1)}s</Text>
            </View>
          </View>
        </View>

        {/* Center column — title, time, buttons */}
        <View style={styles.colCenter}>
          {/* Title */}
          <View style={[styles.stageWrap, { opacity: showTitle ? 1 : 0, transform: [{ scale: showTitle ? 1 : 0.5 }] }]}>
            <SquigglyText text="Game Over" maxWidth={300} letterHeight={44} animDuration={0} strokeWidth={4} color="#8B0000" />
          </View>

          {/* Survival time */}
          <View style={[styles.stageWrap, { opacity: showTime ? 1 : 0, transform: [{ translateY: showTime ? 0 : 16 }] }]}>
            <Text style={styles.subtitle}>You survived</Text>
            <Text style={styles.time}>{formatTime(survivalTime)}</Text>
            {isNewBest && (
              <Text style={styles.newBest}>NEW BEST!</Text>
            )}
          </View>

          {/* Buttons */}
          <View style={[styles.buttonRow, { opacity: showButtons ? 1 : 0, transform: [{ translateY: showButtons ? 0 : 12 }] }]}>
            <AnimatedDotWrapper width={64} height={50} onPress={onPlayAgain}>
              <Svg width={26} height={26} viewBox="0 0 24 24">
                <Path
                  d="M12 5V2L8 6l4 4V7a7 7 0 1 1-7 7H3a9 9 0 1 0 9-9z"
                  fill="#fff"
                />
              </Svg>
            </AnimatedDotWrapper>
            <AnimatedDotWrapper width={110} height={50} onPress={onReturnToMenu}>
              <SquigglyText text="Menu" maxWidth={72} letterHeight={24} delay={0} animDuration={0} strokeWidth={2.5} color="#ffffff" wobble={false} />
            </AnimatedDotWrapper>
          </View>
        </View>

        {/* Right column — Leaderboard */}
        <View style={[styles.colRight, { opacity: showLeaderboard ? 1 : 0, transform: [{ translateX: showLeaderboard ? 0 : 40 }] }]}>
          {topScores.length > 0 && <Leaderboard entries={topScores} />}
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  overlay: {
    ...StyleSheet.absoluteFillObject,
  },
  columns: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
  },
  colLeft: {
    width: '25%',
    alignItems: 'center',
    justifyContent: 'center',
    paddingLeft: 20,
  },
  colCenter: {
    width: '50%',
    alignItems: 'center',
    justifyContent: 'center',
  },
  colRight: {
    width: '25%',
    alignItems: 'center',
    justifyContent: 'center',
    paddingRight: 20,
  },
  stageWrap: {
    alignItems: 'center',
  },
  subtitle: {
    fontSize: 13,
    color: '#8B0000',
    fontFamily: 'serif',
    fontStyle: 'italic',
    fontWeight: '700',
    marginTop: 2,
  },
  time: {
    fontSize: 56,
    fontWeight: '700',
    color: '#8B0000',
    fontFamily: 'serif',
    marginBottom: 2,
  },
  newBest: {
    fontSize: 14,
    fontWeight: '900',
    color: '#8B0000',
    fontFamily: 'serif',
    fontStyle: 'italic',
    letterSpacing: 2,
    marginBottom: 4,
  },
  statsGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'center',
    gap: 12,
    maxWidth: 260,
  },
  statCard: {
    alignItems: 'center',
    width: 110,
  },
  statLabel: {
    fontSize: 11,
    color: '#888888',
    fontFamily: 'serif',
    fontStyle: 'italic',
    marginBottom: 2,
  },
  statValue: {
    fontSize: 20,
    fontWeight: '700',
    color: '#8B0000',
    fontFamily: 'serif',
  },
  buttonRow: {
    flexDirection: 'row',
    gap: 16,
    alignItems: 'center',
  },
});
