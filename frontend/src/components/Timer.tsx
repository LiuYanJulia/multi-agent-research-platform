import React, { useState, useEffect, useRef } from 'react';

interface TimerProps {
  mode: 'countdown' | 'countup';
  initialSeconds?: number; // For countdown mode, starting seconds (e.g., 120 for 2 minutes)
  visible?: boolean; // Whether to display the timer visually
  onExpire?: () => void; // Callback when countdown reaches 0
  onTick?: (elapsedSeconds: number) => void; // Callback on each second (for countup mode)
  paused?: boolean; // Temporarily freeze the timer without resetting its displayed value
}

const Timer: React.FC<TimerProps> = ({
  mode,
  initialSeconds = 120,
  visible = true,
  onExpire,
  onTick,
  paused = false
}) => {
  // Resume-on-refresh (2026-09): both modes now honor initialSeconds as their starting value -
  // callers computing real elapsed-time-since-session-start (for countup) or remaining time (for
  // countdown) can pass it in, so a page refresh mid-task doesn't silently reset the clock to 0.
  const [seconds, setSeconds] = useState(initialSeconds);
  const [expired, setExpired] = useState(false);
  const intervalRef = useRef<NodeJS.Timeout | null>(null);

  // Handle timer tick - just update the state, no callbacks here
  useEffect(() => {
    if (paused) return;

    intervalRef.current = setInterval(() => {
      setSeconds(prev => {
        if (mode === 'countdown') {
          const newValue = prev - 1;
          if (newValue <= 0) {
            if (intervalRef.current) {
              clearInterval(intervalRef.current);
            }
            setExpired(true);
            return 0;
          }
          return newValue;
        } else {
          return prev + 1;
        }
      });
    }, 1000);

    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
      }
    };
  }, [mode, paused]);

  // Handle onExpire callback separately (outside of render)
  useEffect(() => {
    if (expired && onExpire) {
      onExpire();
    }
  }, [expired, onExpire]);

  // Handle onTick callback separately (outside of render)
  useEffect(() => {
    if (mode === 'countup' && seconds > 0 && onTick) {
      onTick(seconds);
    }
  }, [seconds, mode, onTick]);

  // Format seconds to MM:SS
  const formatTime = (totalSeconds: number): string => {
    const mins = Math.floor(totalSeconds / 60);
    const secs = totalSeconds % 60;
    return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  };

  if (!visible) {
    return null; // Hidden timer for tracking purposes only
  }

  return (
    <div style={{
      position: 'fixed',
      top: '1rem',
      right: '1rem',
      backgroundColor: mode === 'countdown' ? '#fef3c7' : '#dbeafe',
      padding: '0.75rem 1.25rem',
      borderRadius: '0.5rem',
      boxShadow: '0 4px 6px -1px rgba(0, 0, 0, 0.1), 0 2px 4px -1px rgba(0, 0, 0, 0.06)',
      zIndex: 1000,
      display: 'flex',
      alignItems: 'center',
      gap: '0.5rem'
    }}>
      <svg
        width="20"
        height="20"
        viewBox="0 0 24 24"
        fill="none"
        stroke={mode === 'countdown' ? '#f59e0b' : '#3b82f6'}
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <circle cx="12" cy="12" r="10"/>
        <polyline points="12 6 12 12 16 14"/>
      </svg>
      <span style={{
        fontSize: '1.125rem',
        fontWeight: '600',
        color: mode === 'countdown' ? '#92400e' : '#1e40af'
      }}>
        {mode === 'countdown' ? 'Time Left: ' : 'Time: '}
        {formatTime(seconds)}
      </span>
    </div>
  );
};

export default Timer;
