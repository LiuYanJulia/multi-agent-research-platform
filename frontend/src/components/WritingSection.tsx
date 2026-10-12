import React, { useState, useEffect, useRef, useCallback } from 'react';
import { WebRTCTranscriptRef } from './WebRTCTranscript';

interface WritingSectionProps {
  sessionId?: string;
  transcriptRef?: React.RefObject<WebRTCTranscriptRef | null>;
  sessionStartTime?: number;
  logger: {
    logEvent: (event: any) => void;
    sendBatch: () => void;
  };
  onSubmissionComplete?: () => void;
  isPracticeMode?: boolean;
  elapsedTime?: number; // in seconds (for practice mode)
  elapsedTimeRef?: React.RefObject<number>; // ref for actual mode (avoids re-renders)
  minimumTimeMet?: boolean; // Reactive actual-mode signal so the submit button unlocks exactly at 10 minutes
  writingMinimumTimeMet?: boolean; // Low-TF Phase 2 requires four active writing minutes before submission
  taskDescription?: string; // e.g., "Toy" or "Adult Learning Platform"
  showForcedSubmission?: boolean; // Show forced submission popup at 25 minutes
  showSubmissionExtension?: boolean;
  onRequestExtraTime?: () => void;
  onTimerPauseChange?: (paused: boolean) => void;
  locked?: boolean; // Paper 2 Low-TF Phase 1 ("collect"): writing area is locked until the participant advances phase
  canAdvanceToWriting?: boolean;
  onAdvanceToWriting?: () => void;
  advancingToWriting?: boolean;
}

const WritingSection: React.FC<WritingSectionProps> = ({
  sessionId,
  transcriptRef,
  sessionStartTime,
  logger,
  onSubmissionComplete,
  isPracticeMode = false,
  elapsedTime = 0,
  elapsedTimeRef,
  minimumTimeMet = false,
  writingMinimumTimeMet = true,
  taskDescription,
  showForcedSubmission = false,
  showSubmissionExtension = false,
  onRequestExtraTime,
  onTimerPauseChange,
  locked = false,
  canAdvanceToWriting = false,
  onAdvanceToWriting,
  advancingToWriting = false
}) => {
  // Get elapsed time from either prop or ref
  const getElapsedTime = () => {
    return elapsedTimeRef?.current ?? elapsedTime;
  };
  const [content, setContent] = useState('');
  const [wordCount, setWordCount] = useState(0);
  const [charCount, setCharCount] = useState(0);
  const [isAutoSaving, setIsAutoSaving] = useState(false);
  const [lastSaved, setLastSaved] = useState<Date | null>(null);
  const [showSubmitConfirm, setShowSubmitConfirm] = useState(false);
  const [showTimeWarning, setShowTimeWarning] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Submission confirmations are part of the timed task flow. Let the parent freeze
  // its shared experiment timer while either local confirmation is visible.
  useEffect(() => {
    onTimerPauseChange?.(showSubmitConfirm || showTimeWarning);
  }, [onTimerPauseChange, showSubmitConfirm, showTimeWarning]);

  useEffect(() => () => onTimerPauseChange?.(false), [onTimerPauseChange]);

  // Update counts when content changes
  useEffect(() => {
    const words = content.trim() ? content.trim().split(/\s+/).length : 0;
    setWordCount(words);
    setCharCount(content.length);
    // Note: text_insert/text_delete is now tracked globally by useInteractionLogger
  }, [content]);

  const autoSave = useCallback(async () => {
    if (!sessionId) return; // Don't auto-save without a session ID

    setIsAutoSaving(true);
    try {
      const response = await fetch('/api/writing/save', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          sessionId: sessionId,
          content: content,
          wordCount: wordCount,
          charCount: charCount,
          timestamp: new Date().toISOString()
        }),
      });

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      setLastSaved(new Date());
    } catch (error) {
      console.error('Error auto-saving:', error);
    } finally {
      setIsAutoSaving(false);
    }
  }, [sessionId, content, wordCount, charCount]);

  // Auto-save functionality
  useEffect(() => {
    if (content.trim()) {
      const autoSaveTimer = setTimeout(() => {
        autoSave();
      }, 3000);

      return () => clearTimeout(autoSaveTimer);
    }
  }, [content, autoSave]);

  const handleSubmit = async () => {
    if (!content.trim()) {
      alert('Please write something before submitting.');
      return;
    }

    // Close confirmation modal and show uploading modal
    setShowSubmitConfirm(false);
    setIsUploading(true);

    // Log submission action
    logger.logEvent({
      eventType: 'ui',
      action: 'form_submit',
      target: {
        element: 'submit-final-work-button',
        section: 'writing',
      },
      metadata: {
        actionType: 'final_submission',
        wordCount,
        charCount,
      },
    });
    // The submission endpoint exports interaction_logs immediately. Persist this
    // final click first so the exported CSV contains the submission boundary.
    await logger.sendBatch();

    try {
      // Get audio data from transcript component
      const audioData = transcriptRef?.current?.getAudioData();

      // Upload audio file if available
      let audioFileUrl = null;
      if (audioData?.audioBlob) {
        const audioSizeMB = audioData.audioBlob.size / (1024 * 1024);
        console.log(`Audio file size: ${audioSizeMB.toFixed(2)} MB`);

        const formData = new FormData();
        formData.append('audio', audioData.audioBlob, 'recording.webm');
        formData.append('sessionId', sessionId || 'unknown');

        // Upload audio file
        const audioResponse = await fetch('/api/submissions/upload-audio', {
          method: 'POST',
          body: formData,
        });

        if (audioResponse.ok) {
          const audioResult = await audioResponse.json();
          audioFileUrl = audioResult.fileUrl;
          console.log('Audio file uploaded:', audioFileUrl);
        } else {
          console.error('Audio upload failed:', audioResponse.status);
        }
      }

      // Get chat history and calculate timestamps
      const chatResponse = await fetch(`/api/chat/history?sessionId=${sessionId}`);
      const chatData = chatResponse.ok ? await chatResponse.json() : { messages: [] };

      // Convert chat messages to format with timestamps (milliseconds since session start)
      const chatHistoryWithTimestamps = chatData.messages?.map((msg: any) => {
        const messageTime = new Date(msg.timestamp).getTime();
        const timestamp = sessionStartTime ? messageTime - sessionStartTime : 0;
        return {
          role: msg.role,
          content: msg.content,
          timestamp: timestamp
        };
      }) || [];

      // Submit everything to backend
      const response = await fetch('/api/submissions/submit', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          sessionId: sessionId || 'unknown',
          finalWriting: content,
          wordCount: wordCount,
          charCount: charCount,
          audioFileUrl: audioFileUrl,
          transcriptWithTimestamps: audioData?.transcriptWithTimestamps || [],
          chatHistoryWithTimestamps: chatHistoryWithTimestamps,
          sessionStartTimestamp: sessionStartTime || 0,
          recordingStartTimestamp: audioData?.recordingStartTime || 0,
          submittedAt: new Date().toISOString()
        }),
      });

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      const result = await response.json();
      console.log('Submission successful:', result.data);
      console.log('Interaction logs saved to:', result.data.interactionLogsFileUrl);

      // Trigger submission complete callback (this will show the confirmation page)
      if (onSubmissionComplete) {
        onSubmissionComplete();
      }
    } catch (error) {
      console.error('Error submitting:', error);
      setIsUploading(false);
      alert('Error submitting your work. Please try again.');
    }
  };

  const clearContent = () => {
    if (content.trim() && !window.confirm('Are you sure you want to clear all content? This cannot be undone.')) {
      return;
    }

    // Log clear action
    logger.logEvent({
      eventType: 'ui',
      action: 'button_click',
      target: {
        element: 'clear-button',
        section: 'writing',
      },
      metadata: {
        actionType: 'clear_content',
        clearedWordCount: wordCount,
        clearedCharCount: charCount,
      },
    });

    setContent('');
    setLastSaved(null);
  };

  const formatTimestamp = (date: Date) => {
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  };

  const hasMetMinimumTime = isPracticeMode || minimumTimeMet || getElapsedTime() >= 10 * 60;
  const canSubmit = Boolean(content.trim()) && hasMetMinimumTime && writingMinimumTimeMet;

  return (
    <>
      <div style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '0.75rem' }}>
          <div>
            <h2 style={{ fontSize: '1.125rem', fontWeight: '600', marginBottom: '0.25rem' }} className="text-token-text-primary">
              Writing & Submission
            </h2>
            {taskDescription && (
              <p style={{ fontSize: '0.875rem', color: '#6b7280', margin: 0 }}>
                Write design proposal for {taskDescription}
              </p>
            )}
          </div>
          <button
            onClick={clearContent}
            disabled={locked}
            style={{
              padding: '0.25rem 0.75rem',
              fontSize: '0.875rem',
              backgroundColor: '#f3f4f6',
              color: '#6b7280',
              border: 'none',
              borderRadius: '0.25rem',
              cursor: locked ? 'not-allowed' : 'pointer',
              opacity: locked ? 0.5 : 1,
              transition: 'background-color 0.2s'
            }}
            onMouseEnter={(e) => { if (!locked) e.currentTarget.style.backgroundColor = '#e5e7eb'; }}
            onMouseLeave={(e) => { if (!locked) e.currentTarget.style.backgroundColor = '#f3f4f6'; }}
          >
            Clear
          </button>
        </div>

        {/* Writing Area - You can change minHeight here (e.g., '400px', '500px') */}
        <div style={{ marginBottom: '0.75rem', overflow: 'hidden', position: 'relative' }}>
          {locked && (
            <div style={{
              position: 'absolute',
              inset: 0,
              zIndex: 10,
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              gap: '0.5rem',
              backgroundColor: 'rgba(249, 250, 251, 0.92)',
              border: '1px dashed #d1d5db',
              borderRadius: '0.5rem',
              textAlign: 'center',
              padding: '1rem'
            }}>
              <span style={{ fontSize: '1.5rem' }} role="img" aria-label="locked">🔒</span>
              <p style={{ fontSize: '0.875rem', fontWeight: 500, color: '#374151', margin: 0 }}>
                Writing opens up in the next phase
              </p>
              <p style={{ fontSize: '0.8125rem', color: '#6b7280', margin: 0, maxWidth: '26rem' }}>
                {onAdvanceToWriting
                  ? "Keep exploring ideas with the chatbot for now. The Next button is disabled now and will be enabled 5 minutes after the main task begins. When you finish the exploration with AI chatbot, click 'Next' to unlock this area."
                  : 'Keep exploring ideas with the chatbot for now. The writing area will unlock when the exploration phase ends.'}
              </p>
              {onAdvanceToWriting && (
                <button
                  type="button"
                  onClick={onAdvanceToWriting}
                  disabled={!canAdvanceToWriting || advancingToWriting}
                  style={{
                    marginTop: '0.5rem',
                    padding: '0.375rem 1rem',
                    fontSize: '0.875rem',
                    fontWeight: 500,
                    backgroundColor: canAdvanceToWriting && !advancingToWriting ? '#f59e0b' : '#e5e7eb',
                    color: canAdvanceToWriting && !advancingToWriting ? 'white' : '#9ca3af',
                    border: 'none',
                    borderRadius: '0.375rem',
                    cursor: canAdvanceToWriting && !advancingToWriting ? 'pointer' : 'not-allowed'
                  }}
                >
                  {advancingToWriting ? 'Moving on...' : 'Next: Move to writing →'}
                </button>
              )}
            </div>
          )}
          <textarea
            ref={textareaRef}
            data-testid="writing-textarea"
            value={content}
            onChange={(e) => setContent(e.target.value)}
            disabled={locked}
            placeholder="Combine your insights here. Write your final thoughts, conclusions, or answers..."
            style={{
              width: '100%',
              minHeight: '500px',
              padding: '1rem',
              border: '1px solid #e5e7eb',
              borderRadius: '0.5rem',
              resize: 'vertical',
              outline: 'none',
              fontSize: '0.875rem',
              lineHeight: '1.625',
              transition: 'border-color 0.2s, box-shadow 0.2s',
              boxSizing: 'border-box',
              wordWrap: 'break-word',
              overflowWrap: 'break-word',
              whiteSpace: 'pre-wrap'
            }}
            onFocus={(e) => {
              e.target.style.borderColor = '#3b82f6';
              e.target.style.boxShadow = '0 0 0 2px rgba(59, 130, 246, 0.5)';
              // Log focus event
              logger.logEvent({
                eventType: 'ui',
                action: 'input_focus',
                target: {
                  element: 'writing-textarea',
                  section: 'writing',
                },
                metadata: {
                  currentWordCount: wordCount,
                  currentCharCount: charCount,
                },
              });
            }}
            onBlur={(e) => {
              e.target.style.borderColor = '#e5e7eb';
              e.target.style.boxShadow = 'none';
              // Log blur event
              logger.logEvent({
                eventType: 'ui',
                action: 'input_blur',
                target: {
                  element: 'writing-textarea',
                  section: 'writing',
                },
                metadata: {
                  currentWordCount: wordCount,
                  currentCharCount: charCount,
                },
              });
            }}
          />
        </div>

        {/* Bottom Section - Status Bar and Submission (shown only once writing is unlocked) */}
        {!locked && <div>
          {/* Status Bar */}
          <div style={{ marginBottom: '0.75rem', fontSize: '0.75rem', display: 'flex', alignItems: 'center', gap: '1rem' }} className="text-token-text-secondary">
            <span>Words: {wordCount}</span>
            <span>Characters: {charCount}</span>
            {isAutoSaving && (
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.25rem' }}>
                <div style={{
                  width: '0.75rem',
                  height: '0.75rem',
                  border: '2px solid #d1d5db',
                  borderTop: '2px solid #4b5563',
                  borderRadius: '50%',
                  animation: 'spin 1s linear infinite'
                }}></div>
                <span>Saving...</span>
              </div>
            )}
            {lastSaved && !isAutoSaving && (
              <span style={{ color: '#22c55e' }}>
                Last saved: {formatTimestamp(lastSaved)}
              </span>
            )}
          </div>

          {/* Submission Section */}
          <div>
            <div style={{ fontSize: '0.875rem', marginBottom: '0.75rem' }} className="text-token-text-secondary">
              <p style={{ marginBottom: '0.5rem' }}>Ready to submit your work?</p>
              <ul style={{ fontSize: '0.75rem', marginLeft: '1rem', listStyle: 'disc' }}>
                <li>Your transcript and conversation history will be included</li>
                <li>This action cannot be undone</li>
                <li>Make sure you've completed your thoughts</li>
              </ul>
              {!isPracticeMode && !hasMetMinimumTime && (
                <p style={{ fontSize: '0.75rem', marginTop: '0.5rem', color: '#92400e' }}>
                  Submission becomes available 10 minutes after the main task begins.
                </p>
              )}
              {!isPracticeMode && hasMetMinimumTime && !writingMinimumTimeMet && (
                <p style={{ fontSize: '0.75rem', marginTop: '0.5rem', color: '#92400e' }}>
                  Submission becomes available after you have spent 4 minutes in the writing phase.
                </p>
              )}
            </div>

            <button
              onClick={() => {
                setShowSubmitConfirm(true);
              }}
              disabled={!canSubmit || isPracticeMode}
              style={{
                display: isPracticeMode ? 'none' : 'block',
                width: '100%',
                padding: '0.75rem 1rem',
                borderRadius: '0.5rem',
                fontWeight: '500',
                border: 'none',
                cursor: canSubmit ? 'pointer' : 'not-allowed',
                backgroundColor: canSubmit ? '#22c55e' : '#e5e7eb',
                color: canSubmit ? 'white' : '#9ca3af',
                transition: 'background-color 0.2s'
              }}
              onMouseEnter={(e) => {
                if (canSubmit) {
                  e.currentTarget.style.backgroundColor = '#16a34a';
                }
              }}
              onMouseLeave={(e) => {
                if (canSubmit) {
                  e.currentTarget.style.backgroundColor = '#22c55e';
                }
              }}
            >
              Submit Final Work
            </button>
          </div>
        </div>}
      </div>

      {/* Confirmation Modal */}
      {showSubmitConfirm && (
        <div style={{
          position: 'fixed',
          inset: 0,
          backgroundColor: 'rgba(0, 0, 0, 0.5)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          zIndex: 9999
        }}>
          <div style={{
            backgroundColor: 'white',
            borderRadius: '0.5rem',
            padding: '1.5rem',
            maxWidth: '28rem',
            width: '100%',
            margin: '0 1rem'
          }}>
            <h3 style={{ fontSize: '1.125rem', fontWeight: '600', marginBottom: '1rem' }}>Confirm Submission</h3>
            <p style={{ fontSize: '0.875rem', color: '#4b5563', marginBottom: '1.5rem' }}>
              Are you sure you want to submit your final work? This will save all your progress including:
            </p>
            <ul style={{ fontSize: '0.875rem', color: '#4b5563', marginBottom: '1.5rem', marginLeft: '1rem', listStyle: 'disc' }}>
              <li style={{ marginBottom: '0.25rem' }}>Your voice transcript</li>
              <li style={{ marginBottom: '0.25rem' }}>LLM conversation history</li>
              <li style={{ marginBottom: '0.25rem' }}>Final written content ({wordCount} words)</li>
              <li style={{ marginBottom: '0.25rem' }}>All interaction logs</li>
            </ul>
            <div style={{ display: 'flex', gap: '0.75rem' }}>
              <button
                onClick={() => setShowSubmitConfirm(false)}
                style={{
                  flex: 1,
                  padding: '0.5rem 1rem',
                  border: '1px solid #d1d5db',
                  borderRadius: '0.5rem',
                  color: '#374151',
                  backgroundColor: 'white',
                  cursor: 'pointer',
                  transition: 'background-color 0.2s'
                }}
                onMouseEnter={(e) => e.currentTarget.style.backgroundColor = '#f9fafb'}
                onMouseLeave={(e) => e.currentTarget.style.backgroundColor = 'white'}
              >
                Cancel
              </button>
              <button
                onClick={handleSubmit}
                style={{
                  flex: 1,
                  padding: '0.5rem 1rem',
                  backgroundColor: '#22c55e',
                  color: 'white',
                  border: 'none',
                  borderRadius: '0.5rem',
                  cursor: 'pointer',
                  transition: 'background-color 0.2s'
                }}
                onMouseEnter={(e) => e.currentTarget.style.backgroundColor = '#16a34a'}
                onMouseLeave={(e) => e.currentTarget.style.backgroundColor = '#22c55e'}
              >
                Submit
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Time Warning Modal (less than 10 minutes) */}
      {showTimeWarning && (
        <div style={{
          position: 'fixed',
          inset: 0,
          backgroundColor: 'rgba(0, 0, 0, 0.5)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          zIndex: 9999
        }}>
          <div style={{
            backgroundColor: 'white',
            borderRadius: '0.5rem',
            padding: '1.5rem',
            maxWidth: '28rem',
            width: '100%',
            margin: '0 1rem'
          }}>
            <h3 style={{ fontSize: '1.125rem', fontWeight: '600', marginBottom: '1rem', color: '#d97706' }}>
              Minimum Time Requirement
            </h3>
            <p style={{ fontSize: '0.875rem', color: '#4b5563', marginBottom: '1rem' }}>
              The minimum time requirement is 10 minutes. Please continue working on your design.
            </p>
            <p style={{ fontSize: '0.875rem', color: '#6b7280', marginBottom: '1.5rem' }}>
              You have spent <strong>{Math.floor(getElapsedTime() / 60)} minutes and {getElapsedTime() % 60} seconds</strong> so far.
            </p>
            <button
              onClick={() => setShowTimeWarning(false)}
              style={{
                width: '100%',
                padding: '0.75rem 1rem',
                backgroundColor: '#3b82f6',
                color: 'white',
                border: 'none',
                borderRadius: '0.5rem',
                cursor: 'pointer',
                fontWeight: '500',
                transition: 'background-color 0.2s'
              }}
              onMouseEnter={(e) => e.currentTarget.style.backgroundColor = '#2563eb'}
              onMouseLeave={(e) => e.currentTarget.style.backgroundColor = '#3b82f6'}
            >
              Continue Working
            </button>
          </div>
        </div>
      )}

      {/* Uploading Modal */}
      {isUploading && (
        <div style={{
          position: 'fixed',
          inset: 0,
          backgroundColor: 'rgba(0, 0, 0, 0.75)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          zIndex: 10000
        }}>
          <div style={{
            backgroundColor: 'white',
            borderRadius: '0.5rem',
            padding: '2rem',
            maxWidth: '32rem',
            width: '100%',
            margin: '0 1rem',
            textAlign: 'center'
          }}>
            {/* Spinner */}
            <div style={{
              width: '4rem',
              height: '4rem',
              border: '4px solid #e5e7eb',
              borderTop: '4px solid #3b82f6',
              borderRadius: '50%',
              margin: '0 auto 1.5rem',
              animation: 'spin 1s linear infinite'
            }}></div>

            <h3 style={{
              fontSize: '1.25rem',
              fontWeight: '600',
              marginBottom: '1rem',
              color: '#1f2937'
            }}>
              Uploading Your Data
            </h3>

            <p style={{
              fontSize: '0.875rem',
              color: '#4b5563',
              lineHeight: '1.6',
              marginBottom: '1rem'
            }}>
              Your submission is being uploaded. This process may take up to 2 minutes depending on your internet connection speed.
            </p>

            <div style={{
              backgroundColor: '#fef3c7',
              border: '1px solid #fbbf24',
              borderRadius: '0.375rem',
              padding: '1rem',
              marginTop: '1.5rem'
            }}>
              <p style={{
                fontSize: '0.875rem',
                color: '#92400e',
                fontWeight: '500',
                margin: 0
              }}>
                ⚠️ Please do not close this window, refresh the page, or navigate away until the upload is complete.
              </p>
            </div>
          </div>
        </div>
      )}

      {/* Forced Submission Modal (25 minutes - no cancel button) */}
      {showSubmissionExtension && (
        <div style={{
          position: 'fixed',
          inset: 0,
          backgroundColor: 'rgba(0, 0, 0, 0.5)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          zIndex: 9999
        }}>
          <div style={{
            backgroundColor: 'white',
            borderRadius: '0.5rem',
            padding: '1.5rem',
            maxWidth: '28rem',
            width: '100%',
            margin: '0 1rem'
          }}>
            <h3 style={{ fontSize: '1.125rem', fontWeight: '600', marginBottom: '1rem' }}>Ready to Submit?</h3>
            <p style={{ fontSize: '0.875rem', color: '#4b5563', lineHeight: 1.5, marginBottom: '1.5rem' }}>
              The scheduled task time has ended. You may submit your work now, or take two more minutes to finish your proposal.
            </p>
            <div style={{ display: 'flex', gap: '0.75rem' }}>
              <button
                onClick={handleSubmit}
                style={{ flex: 1, padding: '0.5rem 0.75rem', backgroundColor: '#22c55e', color: 'white', border: 'none', borderRadius: '0.375rem', cursor: 'pointer', fontWeight: 500 }}
              >
                Submit Final Work
              </button>
              <button
                onClick={onRequestExtraTime}
                style={{ flex: 1, padding: '0.5rem 0.75rem', backgroundColor: '#f59e0b', color: 'white', border: 'none', borderRadius: '0.375rem', cursor: 'pointer', fontWeight: 500 }}
              >
                Two More Minutes to Wrap Up
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Forced Submission Modal (time limit - no cancel button) */}
      {showForcedSubmission && (
        <div style={{
          position: 'fixed',
          inset: 0,
          backgroundColor: 'rgba(0, 0, 0, 0.5)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          zIndex: 9999
        }}>
          <div style={{
            backgroundColor: 'white',
            borderRadius: '0.5rem',
            padding: '1.5rem',
            maxWidth: '28rem',
            width: '100%',
            margin: '0 1rem'
          }}>
            <div style={{
              fontSize: '1.25rem',
              fontWeight: '700',
              marginBottom: '1rem',
              color: '#dc2626',
              textAlign: 'center'
            }}>
              ⏰ Time's up.
            </div>
            <h3 style={{ fontSize: '1.125rem', fontWeight: '600', marginBottom: '1rem' }}>Confirm Submission</h3>
            <p style={{ fontSize: '0.875rem', color: '#4b5563', marginBottom: '1.5rem' }}>
              The maximum time limit has been reached. Please submit your final work now. This will save all your progress including:
            </p>
            <ul style={{ fontSize: '0.875rem', color: '#4b5563', marginBottom: '1.5rem', marginLeft: '1rem', listStyle: 'disc' }}>
              <li style={{ marginBottom: '0.25rem' }}>Your voice transcript</li>
              <li style={{ marginBottom: '0.25rem' }}>LLM conversation history</li>
              <li style={{ marginBottom: '0.25rem' }}>Final written content ({wordCount} words)</li>
              <li style={{ marginBottom: '0.25rem' }}>All interaction logs</li>
            </ul>
            <button
              onClick={handleSubmit}
              style={{
                width: '100%',
                padding: '0.75rem 1rem',
                backgroundColor: '#22c55e',
                color: 'white',
                border: 'none',
                borderRadius: '0.5rem',
                cursor: 'pointer',
                fontWeight: '600',
                fontSize: '1rem',
                transition: 'background-color 0.2s'
              }}
              onMouseEnter={(e) => e.currentTarget.style.backgroundColor = '#16a34a'}
              onMouseLeave={(e) => e.currentTarget.style.backgroundColor = '#22c55e'}
            >
              Submit
            </button>
          </div>
        </div>
      )}
    </>
  );
};

export default WritingSection;
