import React from 'react';
import { StyleSheet, Text, View } from 'react-native';

interface Props {
  survivalTime: number;
}

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  const ms = Math.floor((seconds % 1) * 10);
  return `${m}:${s.toString().padStart(2, '0')}.${ms}`;
}

function HUD({ survivalTime }: Props) {
  return (
    <View style={styles.container} pointerEvents="none">
      <Text style={styles.text}>{formatTime(survivalTime)}</Text>
    </View>
  );
}

export default React.memo(HUD, (prev, next) => {
  // Only re-render when the displayed string actually changes (tenths of a second)
  return formatTime(prev.survivalTime) === formatTime(next.survivalTime);
});

const styles = StyleSheet.create({
  container: {
    position: 'absolute',
    top: 12,
    right: 16,
    paddingHorizontal: 10,
    paddingVertical: 4,
    backgroundColor: 'rgba(0,0,0,0.08)',
    borderRadius: 6,
  },
  text: {
    fontFamily: 'monospace',
    fontSize: 18,
    color: '#111',
    fontWeight: '700',
  },
});
