import React from 'react';
import { Platform, StyleSheet, Text, View } from 'react-native';
import Svg, { Path } from 'react-native-svg';
import type { LeaderboardEntry } from '../services/leaderboard';

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

/** Mobile / phone icon */
function MobileIcon() {
  return (
    <Svg width={16} height={16} viewBox="0 0 24 24" fill="none">
      <Path
        d="M7 2h10a2 2 0 0 1 2 2v16a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2zm5 18h.01"
        stroke="#000000"
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </Svg>
  );
}

/** Desktop / monitor icon */
function DesktopIcon() {
  return (
    <Svg width={16} height={16} viewBox="0 0 24 24" fill="none">
      <Path
        d="M2 4a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V4zm6 18h8m-4-4v4"
        stroke="#000000"
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </Svg>
  );
}

interface Props {
  entries: LeaderboardEntry[];
}

export default function Leaderboard({ entries }: Props) {
  const isWeb = Platform.OS === 'web';

  return (
    <View style={styles.container} pointerEvents="none">
      <View style={styles.titleRow}>
        {isWeb ? <DesktopIcon /> : <MobileIcon />}
        <Text style={styles.title}>Leaderboard</Text>
      </View>
      <View style={styles.column}>
        {entries.slice(0, 9).map((e, i) => (
          <Text key={i} style={styles.entry}>
            {i + 1}. {e.name}  {formatTime(e.time)}
          </Text>
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    alignItems: 'flex-start',
    backgroundColor: 'rgba(240, 240, 240, 0.72)',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  titleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginBottom: 6,
  },
  title: {
    fontFamily: Platform.OS === 'web' ? 'Georgia, "Times New Roman", serif' : 'serif',
    fontStyle: 'normal',
    fontWeight: '700',
    fontSize: 14,
    color: '#000000',
    letterSpacing: 1,
  },
  column: {
    alignItems: 'flex-start',
    gap: 2,
  },
  entry: {
    fontFamily: Platform.OS === 'web' ? 'Georgia, "Times New Roman", serif' : 'serif',
    fontStyle: 'normal',
    fontWeight: '700',
    fontSize: 12,
    color: '#000000',
    letterSpacing: 1,
  },
});
