import React from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import Svg, { Path } from 'react-native-svg';

interface Props {
  survivalTime: number;
  onPlayAgain: () => void;
}

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

export default function GameOverScreen({ survivalTime, onPlayAgain }: Props) {
  return (
    <View style={styles.overlay}>
      <View style={styles.card}>
        <Text style={styles.title}>GAME OVER</Text>
        <Text style={styles.subtitle}>You survived</Text>
        <Text style={styles.time}>{formatTime(survivalTime)}</Text>
        <TouchableOpacity style={styles.button} onPress={onPlayAgain}>
          <Svg width={40} height={40} viewBox="0 0 24 24">
            {/* Circular arrow (restart) icon */}
            <Path
              d="M12 5V2L8 6l4 4V7a7 7 0 1 1-7 7H3a9 9 0 1 0 9-9z"
              fill="#8B0000"
            />
          </Svg>
        </TouchableOpacity>
      </View>
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
});
