"use client";

import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchSpeech } from '@/lib/api-client';

export type SpeechState = 'idle' | 'loading' | 'playing';

/**
 * Read-aloud playback for assistant messages (and Voice Mode replies).
 * Only one utterance plays at a time; calling speak() cancels the previous one.
 */
export function useSpeech() {
  const [state, setState] = useState<SpeechState>('idle');
  const [speakingId, setSpeakingId] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const urlRef = useRef<string | null>(null);

  const hardStop = useCallback(() => {
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.currentTime = 0;
    }
    audioRef.current = null;
    if (urlRef.current) {
      URL.revokeObjectURL(urlRef.current);
      urlRef.current = null;
    }
    setState('idle');
    setSpeakingId(null);
  }, []);

  useEffect(() => hardStop, [hardStop]);

  const speak = useCallback(
    async (id: string, text: string, opts?: { voice?: string; speed?: number }) => {
      if (state !== 'idle') hardStop();
      const clean = text.replace(/```[\s\S]*?```/g, ' (code block) ').replace(/[*_#>`|]/g, ' ').trim();
      if (!clean) return;
      setState('loading');
      setSpeakingId(id);
      try {
        const blob = await fetchSpeech(clean.slice(0, 6000), opts?.voice, opts?.speed);
        const url = URL.createObjectURL(blob);
        urlRef.current = url;
        const audio = new Audio(url);
        audioRef.current = audio;
        audio.onended = () => hardStop();
        audio.onerror = () => {
          hardStop();
          throw new Error('Audio playback failed.');
        };
        await audio.play();
        setState('playing');
      } catch (e) {
        hardStop();
        throw e;
      }
    },
    [state, hardStop]
  );

  const stop = hardStop;

  return { speak, stop, state, speakingId, isBusy: state !== 'idle' };
}
