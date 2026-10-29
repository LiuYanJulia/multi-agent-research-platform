import React, { useState, useEffect } from 'react';
import { BrowserRouter as Router, Routes, Route, useNavigate } from 'react-router-dom';
import './App.css';
import UserIdEntry from './components/UserIdEntry';
import WelcomePractice from './components/WelcomePractice';
import WelcomeActual from './components/WelcomeActual';
import ResearchPagePractice from './pages/ResearchPagePractice';
import ResearchPageActual from './pages/ResearchPageActual';
import GuidanceLayoutDemo from './pages/GuidanceLayoutDemo';

// Resume-on-refresh (2026-09): all of the state below used to live only in React state, which
// resets to blank on any page refresh/crash while a participant is mid-task (userId/groupId
// become '', sessionId becomes '', sessionStartTime becomes 0). That silently corrupted the
// session (wrong elapsed time for the 20/25-min timers, empty sessionId sent to the chat/logging
// APIs, etc.) and also explains why the test-mode debug button disappears on refresh, since it
// gates on userId. We persist the essential fields to localStorage on every change and restore
// them on mount when the URL is already past the entry screen, so a refresh continues the same
// session instead of silently resetting it. A fresh visit to "/" is never auto-resumed, so a new
// participant on a shared machine can't accidentally land inside a previous participant's session.
const SESSION_STORAGE_KEY = 'paper2_app_state_v1';

interface PersistedAppState {
  userId: string;
  groupId: string;
  practiceSessionId: string;
  practiceSessionStartTime: number;
  actualSessionId: string;
  actualSessionStartTime: number;
  savedAt: number;
}

// Saved state older than this is treated as stale (e.g. a leftover from a previous, unrelated
// visit days ago) and ignored rather than resumed.
const MAX_RESUME_AGE_MS = 12 * 60 * 60 * 1000; // 12 hours

function loadPersistedState(): PersistedAppState | null {
  try {
    const raw = localStorage.getItem(SESSION_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as PersistedAppState;
    if (!parsed.savedAt || Date.now() - parsed.savedAt > MAX_RESUME_AGE_MS) return null;
    return parsed;
  } catch {
    return null;
  }
}

function savePersistedState(state: Omit<PersistedAppState, 'savedAt'>) {
  try {
    const toSave: PersistedAppState = { ...state, savedAt: Date.now() };
    localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(toSave));
  } catch {
    // localStorage can throw (private browsing, quota, etc.) - resume is a nice-to-have,
    // never let it break the actual task flow.
  }
}

function AppContent() {
  const navigate = useNavigate();
  const [userId, setUserId] = useState<string>('');
  const [groupId, setGroupId] = useState<string>('');
  const [practiceSessionId, setPracticeSessionId] = useState<string>('');
  const [actualSessionId, setActualSessionId] = useState<string>('');
  const [practiceSessionStartTime, setPracticeSessionStartTime] = useState<number>(0);
  const [actualSessionStartTime, setActualSessionStartTime] = useState<number>(0);
  const [restoring, setRestoring] = useState<boolean>(window.location.pathname !== '/');

  // On mount: if we're already past the entry screen (i.e. this is a refresh, not a fresh visit),
  // restore whatever session state we have saved. A fresh visit to "/" always starts clean.
  useEffect(() => {
    if (window.location.pathname === '/') {
      setRestoring(false);
      return;
    }
    const saved = loadPersistedState();
    if (saved) {
      setUserId(saved.userId);
      setGroupId(saved.groupId);
      setPracticeSessionId(saved.practiceSessionId);
      setPracticeSessionStartTime(saved.practiceSessionStartTime);
      setActualSessionId(saved.actualSessionId);
      setActualSessionStartTime(saved.actualSessionStartTime);
    } else {
      // Nothing to resume (localStorage cleared, different browser, etc.) - there is no valid
      // session to render on this route, so send the participant back to the entry screen rather
      // than showing a broken page.
      navigate('/', { replace: true });
    }
    setRestoring(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Handle user ID submission
  const handleUserIdSubmit = async (submittedUserId: string, submittedGroupId: string) => {
    setUserId(submittedUserId);
    setGroupId(submittedGroupId);

    // Generate practice session ID
    const practiceId = `practice_${submittedUserId}_${Date.now()}`;
    const practiceStart = Date.now();
    setPracticeSessionId(practiceId);
    setPracticeSessionStartTime(practiceStart);

    savePersistedState({
      userId: submittedUserId,
      groupId: submittedGroupId,
      practiceSessionId: practiceId,
      practiceSessionStartTime: practiceStart,
      actualSessionId: '',
      actualSessionStartTime: 0,
    });

    try {
      // Practice uses the participant's assigned condition too, so the full multi-agent
      // pipeline can be tested before the Actual task begins.
      const response = await fetch('/api/session/create', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          sessionId: practiceId,
          participantId: submittedUserId,
          groupId: submittedGroupId,
          sessionStartTimestamp: practiceStart,
        }),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => null);
        throw new Error(body?.message || `Practice session creation failed (${response.status})`);
      }
    } catch (error) {
      console.error('Error creating practice session:', error);
      window.alert('Unable to start the practice session. Please try again after checking the server connection.');
      return;
    }

    // Navigate to practice welcome page
    navigate('/welcome-practice');
  };

  // Groups 2/3 have a single two-minute practice countdown. Its clock begins only
  // when the participant leaves the welcome page; groups 4/5 keep their existing
  // two-phase (90 seconds per phase) behavior.
  const handleStartPractice = async () => {
    const normalizedGroupId = groupId.trim().toLowerCase();
    const startsOnPracticePage = ['2', '3', 'hightf_hightm', 'hightf_lowtm'].includes(normalizedGroupId);

    if (startsOnPracticePage) {
      const practiceTaskStart = Date.now();
      try {
        const response = await fetch(`/api/session/${practiceSessionId}/start-practice`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sessionStartTimestamp: practiceTaskStart }),
        });
        if (!response.ok) {
          const body = await response.json().catch(() => null);
          throw new Error(body?.message || `Practice start failed (${response.status})`);
        }
      } catch (error) {
        console.error('Error starting practice timer:', error);
        window.alert('Unable to start the practice task. Please try again after checking the server connection.');
        return;
      }

      setPracticeSessionStartTime(practiceTaskStart);
      savePersistedState({
        userId,
        groupId,
        practiceSessionId,
        practiceSessionStartTime: practiceTaskStart,
        actualSessionId,
        actualSessionStartTime,
      });
    }
    navigate('/practice');
  };

  // Handle practice complete
  const handlePracticeComplete = () => {
    navigate('/welcome-actual');
  };

  // Handle start actual task
  const handleStartActual = async () => {
    // Generate actual session ID
    const actualId = `${userId}_${Date.now()}`;
    const startTime = Date.now();

    try {
      // The Actual task must not start until its condition state exists in the database.
      // Otherwise logging/transcription can create an unassigned placeholder session and the
      // manipulation pipeline correctly has no condition state to run against.
      const response = await fetch('/api/session/create', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          sessionId: actualId,
          participantId: userId,
          groupId: groupId,
          sessionStartTimestamp: startTime,
        }),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => null);
        throw new Error(body?.message || `Session creation failed (${response.status})`);
      }
    } catch (error) {
      console.error('Error creating session:', error);
      window.alert('Unable to start the study session. Please try again after checking the server connection.');
      return;
    }

    setActualSessionId(actualId);
    setActualSessionStartTime(startTime);
    savePersistedState({
      userId,
      groupId,
      practiceSessionId,
      practiceSessionStartTime,
      actualSessionId: actualId,
      actualSessionStartTime: startTime,
    });
    navigate('/research');
  };

  // Still restoring saved state on mount (refresh case) - render nothing for an instant rather
  // than flashing a page with blank sessionId/userId before the restore effect above runs.
  if (restoring) {
    return null;
  }

  return (
    <Routes>
      <Route path="/" element={<UserIdEntry onSubmit={handleUserIdSubmit} />} />
      <Route path="/welcome-practice" element={<WelcomePractice onStart={handleStartPractice} groupId={groupId} />} />
      <Route
        path="/practice"
        element={
          <ResearchPagePractice
            sessionId={practiceSessionId}
            sessionStartTime={practiceSessionStartTime}
            userId={userId}
            groupId={groupId}
            onComplete={handlePracticeComplete}
          />
        }
      />
      <Route path="/welcome-actual" element={<WelcomeActual onStart={handleStartActual} groupId={groupId} />} />
      <Route
        path="/research"
        element={
          <ResearchPageActual
            sessionId={actualSessionId}
            sessionStartTime={actualSessionStartTime}
            userId={userId}
          />
        }
      />
    </Routes>
  );
}

function App() {
  return (
    <Router>
      <Routes>
        {/* A self-contained visual prototype. It deliberately bypasses session restoration and APIs. */}
        <Route path="/guidance-layout-demo" element={<GuidanceLayoutDemo />} />
        <Route path="*" element={<AppContent />} />
      </Routes>
    </Router>
  );
}

export default App;
