"use client";

import { useCallback, useEffect, useRef, useState } from 'react';

export type DictationState = 'idle' | 'requesting' | 'recording' | 'processing';

type DictationOptions = {
  /** Called with base64 (no data: prefix) webm/opus audio after a recording stops. */
  onComplete: (audioBase64: string) => void;
  onError: (message: string) => void;
};

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Failed to read recorded audio.'));
    reader.onload = () => {
      const result = String(reader.result ?? '');
      const comma = result.indexOf(',');
      resolve(comma === -1 ? result : result.slice(comma + 1));
    };
    reader.readAsDataURL(blob);
  });
}

/**
 * Microphone dictation via MediaRecorder (webm/opus). Used by the composer
 * mic button and Voice Mode. Cleans up tracks and URLs on unmount.
 */
export function useDictation({ onComplete, onError }: DictationOptions) {
  const [state, setState] = useState<DictationState>('idle');
  const [elapsedSec, setElapsedSec] = useState(0);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const onCompleteRef = useRef(onComplete);
  const onErrorRef = useRef(onError);

  useEffect(() => {
    onCompleteRef.current = onComplete;
    onErrorRef.current = onError;
  }, [onComplete, onError]);

  const cleanup = useCallback(() => {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    recorderRef.current = null;
    chunksRef.current = [];
    setElapsedSec(0);
  }, []);

  useEffect(() => cleanup, [cleanup]);

  const start = useCallback(async () => {
    if (recorderRef.current) return;
    try {
      setState('requesting');
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      const mime = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'].find(
        (m) => typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(m)
      );
      const recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
      chunksRef.current = [];
      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };
      recorder.onstop = async () => {
        const blob = new Blob(chunksRef.current, { type: recorder.mimeType || 'audio/webm' });
        cleanup();
        if (blob.size < 1200) {
          setState('idle');
          onErrorRef.current('That recording was too short — hold the mic and speak, then release.');
          return;
        }
        setState('processing');
        try {
          const base64 = await blobToBase64(blob);
          onCompleteRef.current(base64);
        } catch (e) {
          setState('idle');
          onErrorRef.current((e as Error).message);
        }
      };
      recorder.start(250);
      recorderRef.current = recorder;
      setElapsedSec(0);
      timerRef.current = setInterval(() => setElapsedSec((s) => s + 1), 1000);
      setState('recording');
    } catch {
      cleanup();
      setState('idle');
      onErrorRef.current(
        'Microphone unavailable. Grant this page permission to use your microphone and try again.'
      );
    }
  }, [cleanup]);

  const stop = useCallback(() => {
    if (recorderRef.current && recorderRef.current.state !== 'inactive') {
      recorderRef.current.stop();
    } else {
      cleanup();
      setState('idle');
    }
  }, [cleanup]);

  const cancel = useCallback(() => {
    // Discard the recording entirely.
    if (recorderRef.current) {
      recorderRef.current.onstop = null;
      if (recorderRef.current.state !== 'inactive') recorderRef.current.stop();
    }
    cleanup();
    setState('idle');
  }, [cleanup]);

  const reset = useCallback(() => {
    cleanup();
    setState('idle');
  }, [cleanup]);

  return { state, elapsedSec, start, stop, cancel, reset, isRecording: state === 'recording' };
}
