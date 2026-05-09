import { useState, useRef, useCallback } from 'react';

export interface AudioQuality {
  level: number;       // 0–1 normalized RMS
  isClipping: boolean;
  warning: '' | 'low' | 'clipping' | 'noisy';
}

export function useAudioQuality() {
  const [quality, setQuality] = useState<AudioQuality>({ level: 0, isClipping: false, warning: '' });
  const contextRef = useRef<AudioContext | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const noiseFloorRef = useRef(0);
  const silenceCountRef = useRef(0);

  const startMonitoring = useCallback((stream: MediaStream) => {
    const ctx = new AudioContext();
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 512;
    analyser.smoothingTimeConstant = 0.8;
    ctx.createMediaStreamSource(stream).connect(analyser);
    contextRef.current = ctx;

    const data = new Float32Array(analyser.fftSize);

    timerRef.current = setInterval(() => {
      analyser.getFloatTimeDomainData(data);

      let sumSq = 0;
      let peak = 0;
      for (let i = 0; i < data.length; i++) {
        sumSq += data[i] * data[i];
        const abs = Math.abs(data[i]);
        if (abs > peak) peak = abs;
      }
      const rms = Math.sqrt(sumSq / data.length);
      const isClipping = peak > 0.95;

      // Track a rough noise floor from silence periods
      if (rms < 0.01) {
        silenceCountRef.current++;
        if (silenceCountRef.current > 5) {
          noiseFloorRef.current = 0.8 * noiseFloorRef.current + 0.2 * rms;
        }
      } else {
        silenceCountRef.current = 0;
      }

      let warning: AudioQuality['warning'] = '';
      if (rms > 0.005) {
        if (isClipping) warning = 'clipping';
        else if (rms < 0.025) warning = 'low';
        else if (noiseFloorRef.current > 0.008) warning = 'noisy';
      }

      setQuality({ level: Math.min(1, rms * 8), isClipping, warning });
    }, 100);
  }, []);

  const stopMonitoring = useCallback(() => {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
    contextRef.current?.close();
    contextRef.current = null;
    noiseFloorRef.current = 0;
    silenceCountRef.current = 0;
    setQuality({ level: 0, isClipping: false, warning: '' });
  }, []);

  return { quality, startMonitoring, stopMonitoring };
}
