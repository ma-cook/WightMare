import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import type { LeaderboardEntry } from '../services/leaderboard';

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

interface Props {
  entries: LeaderboardEntry[];
}

export default function Leaderboard({ entries }: Props) {
  const left = entries.slice(0, 5);
  const right = entries.slice(5, 10);

  return (
    <View style={styles.container} pointerEvents="none">
      {/* Top 1-5 on the left */}
      <View style={styles.column}>
        {left.map((e, i) => (
          <Text key={i} style={styles.entry}>
            {i + 1}. {e.name}  {formatTime(e.time)}
          </Text>
        ))}
      </View>
      {/* Top 6-10 on the right */}
      <View style={styles.column}>
        {right.map((e, i) => (
          <Text key={i} style={styles.entry}>
            {i + 6}. {e.name}  {formatTime(e.time)}
          </Text>
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    width: '100%',
    paddingHorizontal: 24,
  },
  column: {
    alignItems: 'flex-start',
    gap: 2,
  },
  entry: {
    fontFamily: 'serif',
    fontStyle: 'italic',
    fontWeight: '900',
    fontSize: 14,
    color: '#FF0000',
    letterSpacing: 1,
  },
});
