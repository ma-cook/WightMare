import {
  addDoc,
  collection,
  getDocs,
  limit,
  orderBy,
  query,
} from 'firebase/firestore';
import { db } from './firebase';

export interface LeaderboardEntry {
  name: string;
  time: number; // survival time in seconds
  createdAt: number; // Date.now()
}

const COLLECTION = 'leaderboard';

/** Fetch top N entries sorted by longest survival time. */
export async function fetchTopScores(n = 10): Promise<LeaderboardEntry[]> {
  const q = query(
    collection(db, COLLECTION),
    orderBy('time', 'desc'),
    limit(n),
  );
  const snap = await getDocs(q);
  return snap.docs.map((d) => d.data() as LeaderboardEntry);
}

/** Submit a new score. */
export async function submitScore(name: string, time: number): Promise<void> {
  await addDoc(collection(db, COLLECTION), {
    name: name.trim().slice(0, 20),
    time,
    createdAt: Date.now(),
  } satisfies LeaderboardEntry);
}
