import React, { useEffect, useState } from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import Svg, { Path } from 'react-native-svg';
import Leaderboard from './Leaderboard';
import { fetchTopScores, submitScore, type LeaderboardEntry } from '../services/leaderboard';

interface Props {
  survivalTime: number;
  playerName: string;
  onPlayAgain: () => void;
  onReturnToMenu: () => void;
}

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

export default function GameOverScreen({ survivalTime, playerName, onPlayAgain, onReturnToMenu }: Props) {
  const [topScores, setTopScores] = useState<LeaderboardEntry[]>([]);
  const [submitted, setSubmitted] = useState(false);

  useEffect(() => {
    if (!submitted && playerName) {
      setSubmitted(true);
      submitScore(playerName, survivalTime)
        .then(() => fetchTopScores(10))
        .then(setTopScores)
        .catch(() => {});
    }
  }, [submitted, playerName, survivalTime]);

  return (
    <View style={styles.overlay}>
      <View style={styles.card}>
        <Text style={styles.title}>GAME OVER</Text>
        <Text style={styles.subtitle}>You survived</Text>
        <Text style={styles.time}>{formatTime(survivalTime)}</Text>
        <View style={styles.buttonRow}>
          <TouchableOpacity style={styles.button} onPress={onPlayAgain}>
            <Svg width={40} height={40} viewBox="0 0 24 24">
              <Path
                d="M12 5V2L8 6l4 4V7a7 7 0 1 1-7 7H3a9 9 0 1 0 9-9z"
                fill="#8B0000"
              />
            </Svg>
          </TouchableOpacity>
          <TouchableOpacity style={styles.menuButton} onPress={onReturnToMenu}>
            <Text style={styles.menuButtonText}>Menu</Text>
          </TouchableOpacity>
        </View>
      </View>
      {topScores.length > 0 && (
        <View style={styles.leaderboardWrap}>
          <Leaderboard entries={topScores} />
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  overlay: {
    ...StyleSheet.absoluteFillObject,
    justifyContent: 'center',
    alignItems: 'center',
  },
  card: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  title: {
    fontSize: 40,
    fontWeight: '900',
    color: '#8B0000',
    letterSpacing: 6,
    marginBottom: 8,
    fontFamily: 'serif',
    fontStyle: 'italic',
  },
  subtitle: {
    fontSize: 16,
    color: '#8B0000',
    marginBottom: 4,
    fontFamily: 'serif',
    fontStyle: 'italic',
    fontWeight: '700',
  },
  time: {
    fontSize: 56,
    fontWeight: '700',
    color: '#8B0000',
    fontFamily: 'serif',
    marginBottom: 28,
  },
  button: {
    backgroundColor: '#111',
    width: 64,
    height: 64,
    borderRadius: 32,
    alignItems: 'center',
    justifyContent: 'center',
  },
  buttonRow: {
    flexDirection: 'row',
    gap: 16,
    alignItems: 'center',
  },
  menuButton: {
    backgroundColor: '#111',
    paddingHorizontal: 20,
    paddingVertical: 14,
    borderRadius: 32,
    alignItems: 'center',
    justifyContent: 'center',
  },
  menuButtonText: {
    color: '#8B0000',
    fontSize: 16,
    fontWeight: '900',
    fontFamily: 'serif',
    fontStyle: 'italic',
  },
  leaderboardWrap: {
    marginTop: 20,
    width: '100%',
  },
});
