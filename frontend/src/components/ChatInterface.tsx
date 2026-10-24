import React, { useState, useRef, useEffect, useCallback, memo } from 'react';
import ReactMarkdown from 'react-markdown';
import { AgentStageEvent } from './DebugPanel';

interface Message {
  id: string;
  role: 'user' | 'assistant' | 'ai_guidance';
  content: string;
  timestamp: Date;
  modelSlug?: string;
  isFeedback?: boolean; // Mark feedback messages
  feedbackType?: 'good' | 'bad'; // Track feedback state for each message
  isLoading?: boolean; // Track loading state for assistant messages
  referencedMessageId?: string; // ID of the message this is referring to
  referencedMessageContent?: string; // Preview content of referenced message
  isGuidance?: boolean; // compatibility with historical Insert records
  guidanceDirection?: string;
  guidancePreviousIdeas?: string[];
  guidanceDisplayAt?: Date;
}

interface ChatInterfaceProps {
  sessionId: string;
  sessionStartTime: number;
  logger: {
    logEvent: (event: any) => void;
    sendBatch: () => Promise<void>;
  };
  // Paper 2 (2026-09) test mode: forwards agentStage SSE events up to the page-level debug panel.
  // undefined for the regular participant flow - has no effect there.
  onAgentStage?: (stage: AgentStageEvent) => void;
  transcriptChunks?: string[];
  speechActivityAt?: number;
  // Low-TF Phase 2 disables participant-initiated prompts but keeps automatic AI guidance active.
  promptingEnabled?: boolean;
}

interface DirectGuidancePayload {
  messageId: number;
  directionGuidance: string;
  previousIdeas: string[];
  response: string;
  displayAt: string;
  guidanceResponseInput?: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>;
}

// This must stay at module scope.  Defining a memoized component inside
// ChatInterface creates a new component type on every parent render, which
// unmounts the response DOM and breaks an in-progress text selection.
const MemoizedMarkdown = memo(({ content }: { content: string }) => {
  const lines = content.split('\n');
  const blocks: React.ReactNode[] = [];
  let plain: string[] = [];
  const flushPlain = () => {
    if (plain.length) blocks.push(<ReactMarkdown key={`markdown-${blocks.length}`}>{plain.join('\n')}</ReactMarkdown>);
    plain = [];
  };
  const cells = (line: string) => line.trim().replace(/^\||\|$/g, '').split('|').map((cell) => cell.trim());
  for (let index = 0; index < lines.length;) {
    const isTable = index + 1 < lines.length && lines[index].includes('|') && /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(lines[index + 1]);
    if (!isTable) { plain.push(lines[index]); index += 1; continue; }
    flushPlain();
    const header = cells(lines[index]);
    index += 2;
    const body: string[][] = [];
    while (index < lines.length && lines[index].includes('|') && lines[index].trim()) { body.push(cells(lines[index])); index += 1; }
    blocks.push(<div key={`table-${blocks.length}`} style={{ overflowX: 'auto', margin: '0.75rem 0' }}><table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.875rem' }}><thead><tr>{header.map((cell, cellIndex) => <th key={cellIndex} style={{ textAlign: 'left', padding: '0.45rem', borderBottom: '1px solid #86efac' }}>{cell}</th>)}</tr></thead><tbody>{body.map((row, rowIndex) => <tr key={rowIndex}>{header.map((_, cellIndex) => <td key={cellIndex} style={{ verticalAlign: 'top', padding: '0.45rem', borderBottom: '1px solid #d1fae5' }}>{row[cellIndex] ?? ''}</td>)}</tr>)}</tbody></table></div>);
  }
  flushPlain();
  return <>{blocks}</>;
});
MemoizedMarkdown.displayName = 'MemoizedMarkdown';

// The Debug Panel is the primary transcript viewer. Keep the browser console
// focused on the evaluator's audit trail instead of printing every speech chunk.
function logEvaluationAgentStage(stage: AgentStageEvent): void {
  if (stage.agent !== 'evaluation_agent') return;

  if (stage.status === 'started') {
    console.groupCollapsed('[Evaluation Agent] initiated');
    console.log('Trigger:', stage.detail || 'chat turn');
    console.groupEnd();
    return;
  }

  if (stage.status === 'completed') {
    const moveCount = stage.evaluationMoves?.length ?? 0;
    console.groupCollapsed(`[Evaluation Agent] completed — ${moveCount} move${moveCount === 1 ? '' : 's'}`);
    console.log('Input (session timeline; system prompt excluded):', stage.evaluationInput ?? []);
    console.log('Output (this partition only):', stage.evaluationMoves ?? []);
    console.log('Raw model response / parser detail:', stage.evaluationRaw ?? null);
    if (stage.detail) console.log('Summary:', stage.detail);
    console.groupEnd();
    return;
  }

  if (stage.status === 'error') {
    console.error('[Evaluation Agent] failed:', stage.detail || 'Unknown error');
  }
}

const ChatInterface: React.FC<ChatInterfaceProps> = ({ sessionId, sessionStartTime, logger, onAgentStage, transcriptChunks = [], speechActivityAt = 0, promptingEnabled = true }) => {
  const [prompt, setPrompt] = useState('');
  const [composerHeight, setComposerHeight] = useState(40);
  const [messages, setMessages] = useState<Message[]>([]);
  const [currentModel, setCurrentModel] = useState('gpt-5.6-terra'); // Default fallback
  const [expandedMessageId, setExpandedMessageId] = useState<string | null>(null); // Track which message's expanded section is open
  const [pendingGuidance, setPendingGuidance] = useState<DirectGuidancePayload | null>(null);
  const [guidanceCountdown, setGuidanceCountdown] = useState<number | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const messagesContainerRef = useRef<HTMLDivElement>(null);
  const analyzedTranscriptCountRef = useRef(0);
  const availableTranscriptCountRef = useRef(0);
  const lastAutomaticAnalysisTranscriptCountRef = useRef(0);
  const wordsSinceAnalysisRef = useRef(0);
  const continuousSpeechStartedAtRef = useRef<number | null>(null);
  const analysisInFlightRef = useRef(false);
  const idleAnalysisTimerRef = useRef<number | null>(null);
  const continuousAnalysisTimerRef = useRef<number | null>(null);

  const scrollToBlockStart = (id: string) => {
    requestAnimationFrame(() => {
      const container = messagesContainerRef.current;
      const block = document.getElementById(`chat-block-${id}`);
      if (!container || !block) return;
      container.scrollTo({ top: Math.max(0, block.offsetTop - container.offsetTop), behavior: 'smooth' });
    });
  };

  const beginComposerResize = (event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const startY = event.clientY;
    const startHeight = textareaRef.current?.getBoundingClientRect().height ?? composerHeight;
    const maxHeight = Math.max(72, Math.floor((window.innerHeight - 250) / 3));
    const onPointerMove = (moveEvent: PointerEvent) => {
      // The handle sits above the composer: pulling it upward expands the input
      // while the composer bottom remains anchored at the bottom of the chat pane.
      const nextHeight = Math.max(40, Math.min(maxHeight, startHeight + startY - moveEvent.clientY));
      setComposerHeight(nextHeight);
    };
    const onPointerUp = () => {
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
    };
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp, { once: true });
  };

  const copyToClipboard = (text: string, messageId: string, messageRole: Message['role'], messageIndex: number) => {
    navigator.clipboard.writeText(text);
    // Log copy action
    logger.logEvent({
      eventType: 'ui',
      action: 'message_action',
      target: {
        element: 'copy-turn-action-button',
        section: 'response',
      },
      metadata: {
        messageId: messageIndex, // Use sequential index instead of timestamp ID
        messageRole,
        actionType: 'copy',
        copiedText: text, // Full text without limit
        textLength: text.length,
      },
    });
    // TODO: Show toast notification
  };


  const handleFeedback = async (messageId: string, isGood: boolean, messageIndex: number) => {
    try {
      console.log('=== handleFeedback called ===');
      console.log('messageId:', messageId);
      console.log('isGood:', isGood);
      console.log('Current messages:', messages.map(m => ({ id: m.id, role: m.role, feedbackType: m.feedbackType })));

      // Log feedback action
      logger.logEvent({
        eventType: 'ui',
        action: 'message_action',
        target: {
          element: isGood ? 'good-response-turn-action-button' : 'bad-response-turn-action-button',
          section: 'response',
        },
        metadata: {
          messageId: messageIndex, // Use sequential index
          actionType: 'feedback',
          feedbackValue: isGood ? 'good' : 'bad',
        },
      });

      // Find the message being rated
      const message = messages.find(msg => msg.id === messageId);
      if (!message) {
        console.log('ERROR: Message not found!');
        return;
      }

      console.log('Found message to update:', { id: message.id, currentFeedbackType: message.feedbackType });

      // Update the message with feedback type
      setMessages(prev => {
        const updated = prev.map(msg => {
          if (msg.id === messageId) {
            const newFeedbackType: 'good' | 'bad' = isGood ? 'good' : 'bad';
            console.log(`Updating message ${msg.id} feedbackType to:`, newFeedbackType);
            return { ...msg, feedbackType: newFeedbackType } as Message;
          }
          console.log(`Not updating message ${msg.id} (current feedbackType: ${msg.feedbackType})`);
          return msg;
        });
        console.log('After update:', updated.map(m => ({ id: m.id, feedbackType: m.feedbackType })));
        return updated;
      });

      // Create feedback message as a user message for backend
      const feedbackContent = isGood
        ? "The previous answer is good. You do not reply anything here."
        : "The previous answer is bad. You do not reply anything here.";

      // Save feedback message to database without displaying in frontend
      await fetch('/api/chat/save-message', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          sessionId: sessionId,
          role: 'user',
          content: feedbackContent,
          model: null,
          isFeedback: true
        }),
      });

      console.log(`Feedback sent for message ${messageId}: ${isGood ? 'positive' : 'negative'}`);

    } catch (error) {
      console.error('Error sending feedback:', error);
    }
  };

  const saveChatMessage = async (message: Message) => {
    try {
      await fetch('/api/chat/save-message', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          sessionId: sessionId,
          role: message.role,
          content: message.content,
          model: message.modelSlug || null,
          isGuidance: !!message.isGuidance,
        }),
      });
    } catch (error) {
      console.error('Error saving chat message:', error);
    }
  };

  const loadChatHistory = async () => {
    try {
      const response = await fetch(`/api/chat/history?sessionId=${sessionId}`);
      if (response.ok) {
        const data = await response.json();
        const loadedMessages: Message[] = data.messages.map((msg: any) => ({
          id: msg.messageId || msg.id,
          role: msg.role,
          content: msg.content,
          timestamp: new Date(msg.timestamp),
          modelSlug: msg.modelSlug,
          isGuidance: !!msg.isGuidance,
          guidanceDirection: msg.guidanceDirection,
          guidancePreviousIdeas: msg.guidancePreviousIdeas,
          guidanceDisplayAt: msg.guidanceDisplayAt ? new Date(msg.guidanceDisplayAt) : undefined,
        }));

        const deferredGuidance = loadedMessages.find((message) => message.role === 'ai_guidance' && message.guidanceDisplayAt && message.guidanceDisplayAt.getTime() > Date.now());
        if (deferredGuidance?.guidanceDisplayAt) {
          setPendingGuidance({
            messageId: Number(String(deferredGuidance.id).replace('guidance-', '')),
            directionGuidance: deferredGuidance.guidanceDirection ?? '', previousIdeas: deferredGuidance.guidancePreviousIdeas ?? [],
            response: deferredGuidance.content, displayAt: deferredGuidance.guidanceDisplayAt.toISOString(),
          });
        }
        // Sort messages by timestamp to ensure proper conversation order.
        const visibleMessages = deferredGuidance ? loadedMessages.filter((message) => message !== deferredGuidance) : loadedMessages;
        visibleMessages.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());

        setMessages(visibleMessages);
        console.log(`Loaded ${loadedMessages.length} messages from chat history for session ${sessionId}`);
      }
    } catch (error) {
      console.error('Error loading chat history:', error);
    }
  };

  const loadModelInfo = async () => {
    try {
      const response = await fetch('/api/chat/model-info');
      if (response.ok) {
        const data = await response.json();
        setCurrentModel(data.model);
        console.log(`Using model: ${data.model}`);
      }
    } catch (error) {
      console.error('Error loading model info:', error);
    }
  };

  // Load chat history and model info on component mount or sessionId change
  useEffect(() => {
    if (sessionId) {
      loadChatHistory();
      loadModelInfo();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  useEffect(() => {
    if (!pendingGuidance) return;
    const displayAt = new Date(pendingGuidance.displayAt).getTime();
    const updateCountdown = () => setGuidanceCountdown(Math.max(0, Math.ceil((displayAt - Date.now()) / 1000)));
    updateCountdown();
    const interval = window.setInterval(updateCountdown, 250);
    const timer = window.setTimeout(() => {
      logger.logEvent({ eventType: 'ai_guidance', action: 'ai_guidance_notification_completed', target: { element: 'ai-guidance-banner', section: 'prompting' }, metadata: { messageId: pendingGuidance.messageId } });
      const card: Message = {
        id: `guidance-${pendingGuidance.messageId}`,
        role: 'ai_guidance', content: pendingGuidance.response, timestamp: new Date(displayAt),
        guidanceDirection: pendingGuidance.directionGuidance,
        guidancePreviousIdeas: pendingGuidance.previousIdeas,
        guidanceDisplayAt: new Date(displayAt),
      };
      setMessages((existing) => existing.some((message) => message.id === card.id) ? existing : [...existing, card]);
      logger.logEvent({ eventType: 'ai_guidance', action: 'ai_guidance_displayed', target: { element: 'ai-guidance-card', section: 'response', text: `${pendingGuidance.directionGuidance}\n\nYour earlier ideas: ${pendingGuidance.previousIdeas.join(', ')}\n\n${pendingGuidance.response}` }, metadata: { messageId: pendingGuidance.messageId, displayDelayMs: 5000, directionGuidance: pendingGuidance.directionGuidance, previousIdeas: pendingGuidance.previousIdeas, responseLength: pendingGuidance.response.length } });
      void logger.sendBatch();
      setPendingGuidance(null);
      setGuidanceCountdown(null);
      scrollToBlockStart(card.id);
    }, Math.max(0, displayAt - Date.now()));
    return () => { window.clearInterval(interval); window.clearTimeout(timer); };
  }, [logger, pendingGuidance]);

  const handleSend = async (contextMessageId?: string, customPrompt?: string, hideUserPrompt?: boolean, isGuidanceMessage = false) => {
    if (!promptingEnabled && !isGuidanceMessage) return;
    const messageContent = customPrompt || prompt;
    if (messageContent.trim()) {
      // Find referenced message if contextMessageId is provided
      let referencedMessage = null;
      let referencedMessageIndex: number | undefined;
      let mergedPrompt = messageContent;

      if (contextMessageId) {
        const messageIdx = messages.findIndex(msg => msg.id === contextMessageId);
        if (messageIdx !== -1) {
          referencedMessage = messages[messageIdx];
          referencedMessageIndex = messageIdx + 1; // Convert to 1-based sequential index
          // Merge prompt with referenced message content
          mergedPrompt = `${messageContent} based on this information: ${referencedMessage.content}`;
        }
      }

      if (!isGuidanceMessage) {
        // The partition closes as soon as the user message is persisted. Flush this
        // interaction now so the evaluator sees the send behavior in the same turn.
        logger.logEvent({
          eventType: 'ui',
          action: 'composer_interaction',
          target: {
            element: 'send-button',
            section: 'prompting',
          },
          metadata: {
            promptLength: messageContent.length,
            isCustomPrompt: !!customPrompt,
            hasContext: !!contextMessageId,
            contextMessageId: referencedMessageIndex, // Use sequential index instead of timestamp ID
          },
        });
        await logger.sendBatch();
      }

      // Add user message (only if not hidden)
      const userMessage: Message = {
        id: Date.now().toString(),
        role: 'user',
        content: messageContent, // Display original prompt (not merged)
        timestamp: new Date(),
        referencedMessageId: contextMessageId,
        referencedMessageContent: referencedMessage?.content.substring(0, 200), // Store first 200 chars for preview
        isGuidance: isGuidanceMessage,
      };

      if (!hideUserPrompt) {
        setMessages(prev => [...prev, userMessage]);
        // Save user message to database
        await saveChatMessage(userMessage);
      }

      const currentPrompt = mergedPrompt; // Use merged prompt for API call
      if (!customPrompt) {
        setPrompt('');
      }

      // Add loading message immediately
      const loadingMessageId = (Date.now() + 1).toString();
      const loadingMessage: Message = {
        id: loadingMessageId,
        role: 'assistant',
        content: '',
        timestamp: new Date(),
        isLoading: true
      };
      setMessages(prev => [...prev, loadingMessage]);

      // Auto-scroll to bottom of messages container only (not the entire page)
      setTimeout(() => scrollToBlockStart(loadingMessageId), 100);

      try {
        // Call the streaming chat API
        const response = await fetch('/api/chat/stream', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            sessionId: sessionId,
            message: userMessage.content,
            contextMessageId: contextMessageId,
            skipPipeline: isGuidanceMessage,
            conversationHistory: messages.map(msg => ({
              role: msg.role,
              content: msg.content
            }))
          }),
        });

        if (!response.ok) {
          throw new Error(`HTTP error! status: ${response.status}`);
        }

        // Handle streaming response
        const reader = response.body?.getReader();
        const decoder = new TextDecoder();

        console.log('[Frontend] Starting to receive stream...');
        if (reader) {
          while (true) {
            const { done, value } = await reader.read();
            if (done) {
              console.log('[Frontend] Stream reading complete');
              break;
            }

            // Decode the chunk
            const chunk = decoder.decode(value, { stream: true });
            const lines = chunk.split('\n');

            for (const line of lines) {
              if (line.startsWith('data: ')) {
                const jsonStr = line.slice(6);
                try {
                  const data = JSON.parse(jsonStr);

                  if (data.agentStage) {
                    // Paper 2 test mode: forward to the debug panel, if one is listening.
                    logEvaluationAgentStage(data.agentStage as AgentStageEvent);
                    onAgentStage?.(data.agentStage);
                  } else if (data.error) {
                    // Handle error with optional partial content
                    if (data.interrupted && data.partialContent) {
                      console.warn('[Frontend] Stream was interrupted, displaying partial content:', data.partialContent.length, 'chars');
                      // Update message with partial content and add error note
                      setMessages(prev => prev.map(msg =>
                        msg.id === loadingMessageId
                          ? {
                              ...msg,
                              content: data.partialContent,
                              isLoading: false
                            }
                          : msg
                      ));
                      // Note: Backend already saved the partial response with error note
                    } else {
                      // No partial content, throw error to trigger fallback
                      throw new Error(data.error);
                    }
                  } else if (data.done) {
                    console.log('[Frontend] Received done signal');
                    // Streaming complete, mark message as not loading
                    setMessages(prev => prev.map(msg =>
                      msg.id === loadingMessageId
                        ? { ...msg, isLoading: false }
                        : msg
                    ));
                  } else if (data.content) {
                    // Append content chunk using functional update
                    console.log('[Frontend] Received chunk:', data.content);

                    // IMMEDIATE update - use functional update to avoid closure issues
                    setMessages(prev => {
                      const updated = prev.map(msg =>
                        msg.id === loadingMessageId
                          ? { ...msg, content: (msg.content || '') + data.content, isLoading: true }
                          : msg
                      );
                      console.log('[Frontend] Updated messages, current content length:', updated.find(m => m.id === loadingMessageId)?.content.length);
                      return updated;
                    });

                    // Auto-scroll to bottom (skip if user has text selected)
                    requestAnimationFrame(() => scrollToBlockStart(loadingMessageId));
                  }
                } catch (parseError) {
                  console.error('Error parsing SSE data:', parseError);
                }
              }
            }
          }
        }

        // After streaming completes, the assistant message is already saved by the backend
        // No need to save again here to avoid duplicates

      } catch (error) {
        console.error('Error calling chat API:', error);

        // Fallback response for demo purposes
        const assistantMessage: Message = {
          id: loadingMessageId,
          role: 'assistant',
          content: `I'm having trouble connecting to the server right now. This is a mock response to: "${currentPrompt}". Please try again later.`,
          timestamp: new Date(),
          modelSlug: currentModel,
          isLoading: false
        };

        // Replace loading message with fallback response
        setMessages(prev => prev.map(msg =>
          msg.id === loadingMessageId ? assistantMessage : msg
        ));

        // Save fallback assistant message to database
        await saveChatMessage(assistantMessage);
      }
    }
  };

  const requestAutomaticAnalysis = useCallback(async (trigger: 'silence' | 'word_threshold' | 'continuous_speech') => {
    if (analysisInFlightRef.current) return;
    const availableTranscriptCount = availableTranscriptCountRef.current;
    if (availableTranscriptCount <= lastAutomaticAnalysisTranscriptCountRef.current) return;
    // Mark this completed-transcript set as attempted before the request. A server error
    // cannot then create a two-second retry loop while the participant remains silent.
    lastAutomaticAnalysisTranscriptCountRef.current = availableTranscriptCount;
    analysisInFlightRef.current = true;
    onAgentStage?.({
      agent: 'evaluation_agent',
      status: 'started',
      detail: `automatic trigger: ${trigger}`,
      timestamp: Date.now(),
    });
    logEvaluationAgentStage({
      agent: 'evaluation_agent',
      status: 'started',
      detail: `automatic trigger: ${trigger}`,
      timestamp: Date.now(),
    });
    try {
      await logger.sendBatch();
      const response = await fetch('/api/chat/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId, trigger }),
      });
      if (!response.ok) {
        const errorBody = await response.json().catch(() => ({}));
        throw new Error(errorBody.error || `Automatic analysis failed (${response.status})`);
      }
      const data = await response.json();
      (data.stages ?? [])
        .filter((stage: AgentStageEvent) => !(stage.agent === 'evaluation_agent' && stage.status === 'started'))
        .forEach((stage: AgentStageEvent) => {
          logEvaluationAgentStage(stage);
          onAgentStage?.(stage);
        });
      if (data.ran) {
        wordsSinceAnalysisRef.current = 0;
        continuousSpeechStartedAtRef.current = null;
        if (continuousAnalysisTimerRef.current !== null) {
          window.clearTimeout(continuousAnalysisTimerRef.current);
          continuousAnalysisTimerRef.current = null;
        }
      }
      if (data.guidance) {
        const guidance = data.guidance as DirectGuidancePayload;
        logger.logEvent({
          eventType: 'ai_guidance', action: 'ai_guidance_notification_shown',
          target: { element: 'ai-guidance-banner', section: 'prompting' },
          metadata: { messageId: guidance.messageId, displayAt: guidance.displayAt, displayDelayMs: 5000 },
        });
        void logger.sendBatch();
        setPendingGuidance(guidance);
      }
    } catch (error) {
      console.error('Automatic manipulation analysis failed:', error);
      const errorStage: AgentStageEvent = {
        agent: 'evaluation_agent',
        status: 'error',
        detail: error instanceof Error ? error.message : 'automatic analysis failed',
        timestamp: Date.now(),
      };
      logEvaluationAgentStage(errorStage);
      onAgentStage?.(errorStage);
    } finally {
      analysisInFlightRef.current = false;
    }
  }, [logger, onAgentStage, sessionId]);

  useEffect(() => {
    if (transcriptChunks.length <= analyzedTranscriptCountRef.current) return;
    const newChunks = transcriptChunks.slice(analyzedTranscriptCountRef.current);
    analyzedTranscriptCountRef.current = transcriptChunks.length;
    availableTranscriptCountRef.current = transcriptChunks.length;
    wordsSinceAnalysisRef.current += newChunks.join(' ').trim().split(/\s+/).filter(Boolean).length;
    if (continuousSpeechStartedAtRef.current === null) {
      continuousSpeechStartedAtRef.current = Date.now();
      continuousAnalysisTimerRef.current = window.setTimeout(() => requestAutomaticAnalysis('continuous_speech'), 45_000);
    }
    if (wordsSinceAnalysisRef.current >= 60) requestAutomaticAnalysis('word_threshold');
  }, [requestAutomaticAnalysis, transcriptChunks]);

  useEffect(() => {
    if (!speechActivityAt) return;
    if (availableTranscriptCountRef.current <= lastAutomaticAnalysisTranscriptCountRef.current) return;
    if (idleAnalysisTimerRef.current !== null) window.clearTimeout(idleAnalysisTimerRef.current);
    const remainingSilenceMs = Math.max(0, speechActivityAt + 2_000 - Date.now());
    idleAnalysisTimerRef.current = window.setTimeout(() => requestAutomaticAnalysis('silence'), remainingSilenceMs);
    return () => {
      if (idleAnalysisTimerRef.current !== null) window.clearTimeout(idleAnalysisTimerRef.current);
    };
  }, [requestAutomaticAnalysis, speechActivityAt, transcriptChunks.length]);

  useEffect(() => () => {
    if (continuousAnalysisTimerRef.current !== null) window.clearTimeout(continuousAnalysisTimerRef.current);
  }, []);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (!promptingEnabled) return;
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleContextualPrompt = async (messageId: string, promptText: string, messageIndex: number) => {
    // Log contextual prompt action
    logger.logEvent({
      eventType: 'ui',
      action: 'message_action',
      target: {
        element: 'contextual-prompt-input',
        section: 'response',
      },
      metadata: {
        messageId: messageIndex, // Use sequential index
        actionType: 'contextual_prompt',
        promptText: promptText.substring(0, 100), // Log first 100 chars
        promptLength: promptText.length,
      },
    });

    // Send the contextual prompt
    await handleSend(messageId, promptText, false);
    // Close the expanded section
    setExpandedMessageId(null);
  };

  // Expanded section component
  const ExpandedSection: React.FC<{ messageId: string; messageIndex: number }> = ({ messageId, messageIndex }) => {
    const [contextInput, setContextInput] = useState('');

    const handleContextInputKeyDown = (e: React.KeyboardEvent) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        if (contextInput.trim()) {
          handleContextualPrompt(messageId, contextInput, messageIndex);
          setContextInput('');
        }
      }
    };

    return (
      <div style={{
        backgroundColor: 'var(--token-bg-primary, #ffffff)',
        borderRadius: '16px',
        boxShadow: '0 4px 24px rgba(0, 0, 0, 0.15)',
        padding: '12px',
        marginTop: '8px',
        maxWidth: '320px'
      }}>
        {/* Ask to change response input */}
        <div style={{ position: 'relative', marginBottom: '8px' }}>
          <input
            type="text"
            value={contextInput}
            onChange={(e) => setContextInput(e.target.value)}
            onKeyDown={handleContextInputKeyDown}
            placeholder="Ask to change response"
            data-message-id={messageId}
            data-message-index={messageIndex}
            style={{
              width: '100%',
              minWidth: '210px',
              padding: '8px 36px 8px 10px',
              fontSize: '0.875rem',
              border: '1px solid transparent',
              borderRadius: '10px',
              backgroundColor: 'var(--token-bg-primary, #ffffff)',
              color: 'var(--token-text-primary, #2d333a)',
              outline: 'none'
            }}
            className="text-token-text-primary bg-token-bg-primary"
          />
          <button
            onClick={() => {
              if (contextInput.trim()) {
                handleContextualPrompt(messageId, contextInput, messageIndex);
                setContextInput('');
              }
            }}
            disabled={!contextInput.trim()}
            style={{
              position: 'absolute',
              right: '10px',
              top: '50%',
              transform: 'translateY(-50%)',
              width: '20px',
              height: '20px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              border: 'none',
              backgroundColor: 'transparent',
              cursor: contextInput.trim() ? 'pointer' : 'not-allowed',
              opacity: contextInput.trim() ? 1 : 0.5
            }}
            aria-label="Submit"
          >
            <svg width="20" height="20" viewBox="0 0 20 20" fill="currentColor" xmlns="http://www.w3.org/2000/svg">
              <path d="M8.99992 16V6.41407L5.70696 9.70704C5.31643 10.0976 4.68342 10.0976 4.29289 9.70704C3.90237 9.31652 3.90237 8.6835 4.29289 8.29298L9.29289 3.29298L9.36907 3.22462C9.76184 2.90427 10.3408 2.92686 10.707 3.29298L15.707 8.29298L15.7753 8.36915C16.0957 8.76192 16.0731 9.34092 15.707 9.70704C15.3408 10.0732 14.7618 10.0958 14.3691 9.7754L14.2929 9.70704L10.9999 6.41407V16C10.9999 16.5523 10.5522 17 9.99992 17C9.44764 17 8.99992 16.5523 8.99992 16Z"/>
            </svg>
          </button>
        </div>

        {/* Separator */}
        <div style={{ height: '1px', backgroundColor: 'var(--token-border-default, #d1d5db)', margin: '4px 16px' }}></div>

        {/* Try again button */}
        <button
          onClick={() => handleContextualPrompt(messageId, 'Generate another version for this response.', messageIndex)}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '12px',
            width: '100%',
            padding: '8px 12px',
            border: 'none',
            backgroundColor: 'transparent',
            cursor: 'pointer',
            borderRadius: '8px',
            fontSize: '0.875rem'
          }}
          className="text-token-text-primary"
          onMouseEnter={(e) => {
            e.currentTarget.style.backgroundColor = 'var(--token-bg-secondary, #f8f9fa)';
          }}
          onMouseLeave={(e) => e.currentTarget.style.backgroundColor = 'transparent'}
        >
          <div style={{ width: '20px', height: '20px', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <svg width="20" height="20" viewBox="0 0 20 20" fill="currentColor" xmlns="http://www.w3.org/2000/svg">
              <path d="M3.502 16.6663V13.3333C3.502 12.9661 3.79977 12.6683 4.16704 12.6683H7.50004L7.63383 12.682C7.93691 12.7439 8.16508 13.0119 8.16508 13.3333C8.16508 13.6547 7.93691 13.9227 7.63383 13.9847L7.50004 13.9984H5.47465C6.58682 15.2249 8.21842 16.0013 10 16.0013C13.06 16.0012 15.5859 13.711 15.9551 10.7513L15.9854 10.6195C16.0845 10.3266 16.3785 10.1334 16.6973 10.1732C17.0617 10.2186 17.3198 10.551 17.2745 10.9154L17.2247 11.2523C16.6301 14.7051 13.6224 17.3313 10 17.3314C8.01103 17.3314 6.17188 16.5383 4.83208 15.2474V16.6663C4.83208 17.0335 4.53411 17.3311 4.16704 17.3314C3.79977 17.3314 3.502 17.0336 3.502 16.6663ZM4.04497 9.24935C3.99936 9.61353 3.66701 9.87178 3.30278 9.8265C2.93833 9.78105 2.67921 9.44876 2.72465 9.08431L4.04497 9.24935ZM10 2.66829C11.9939 2.66833 13.8372 3.46551 15.1778 4.76204V3.33333C15.1778 2.96616 15.4757 2.66844 15.8428 2.66829C16.2101 2.66829 16.5079 2.96606 16.5079 3.33333V6.66634C16.5079 7.03361 16.2101 7.33138 15.8428 7.33138H12.5098C12.1425 7.33138 11.8448 7.03361 11.8448 6.66634C11.8449 6.29922 12.1426 6.0013 12.5098 6.0013H14.5254C13.4133 4.77488 11.7816 3.99841 10 3.99837C6.93998 3.99837 4.41406 6.28947 4.04497 9.24935L3.38481 9.16634L2.72465 9.08431C3.17574 5.46702 6.26076 2.66829 10 2.66829Z"/>
            </svg>
          </div>
          <span>Try again</span>
        </button>

        {/* Add details button */}
        <button
          onClick={() => handleContextualPrompt(messageId, 'Add more details to this response', messageIndex)}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '12px',
            width: '100%',
            padding: '8px 12px',
            border: 'none',
            backgroundColor: 'transparent',
            cursor: 'pointer',
            borderRadius: '8px',
            fontSize: '0.875rem'
          }}
          className="text-token-text-primary"
          onMouseEnter={(e) => {
            e.currentTarget.style.backgroundColor = 'var(--token-bg-secondary, #f8f9fa)';
          }}
          onMouseLeave={(e) => e.currentTarget.style.backgroundColor = 'transparent'}
        >
          <div style={{ width: '20px', height: '20px', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <svg width="20" height="20" viewBox="0 0 20 20" fill="currentColor" xmlns="http://www.w3.org/2000/svg" data-rtl-flip="">
              <path d="M14.3013 12.6816C14.6039 12.7438 14.8314 13.012 14.8316 13.333C14.8316 13.654 14.604 13.922 14.3013 13.9843L14.1666 13.998H10.8336C10.4663 13.998 10.1685 13.7002 10.1685 13.333C10.1687 12.9659 10.4664 12.6679 10.8336 12.6679H14.1666L14.3013 12.6816Z"/>
              <path d="M17.5006 9.33589L17.6343 9.34956C17.9372 9.41179 18.1657 9.67969 18.1656 10.0009C18.1654 10.3221 17.9363 10.5903 17.6334 10.6523L17.4996 10.666L10.8326 10.664C10.4655 10.6637 10.1684 10.3651 10.1685 9.998C10.1688 9.63092 10.4664 9.33383 10.8336 9.33394L17.5006 9.33589Z"/>
              <path d="M17.6343 6.01558C17.9371 6.07778 18.1656 6.34576 18.1656 6.66695C18.1655 6.98805 17.9371 7.25617 17.6343 7.31831L17.5006 7.33199H10.8336C10.4664 7.33199 10.1687 7.0341 10.1685 6.66695C10.1685 6.29968 10.4663 6.00191 10.8336 6.00191H17.5006L17.6343 6.01558Z"/>
              <path d="M5.47029 3.69625C5.24315 3.46926 4.89238 3.44115 4.63435 3.61129L4.52986 3.69625L2.44587 5.78023C2.18668 6.03992 2.18649 6.4611 2.44587 6.72066C2.70554 6.98019 3.12762 6.98019 3.38728 6.72066L4.38533 5.72066C4.37869 5.75711 4.37461 5.79461 4.37458 5.83297V14.166C4.37458 14.2042 4.37875 14.2419 4.38533 14.2783L3.38728 13.2793L3.28279 13.1943C3.02467 13.0238 2.67314 13.052 2.44587 13.2793C2.21861 13.5065 2.19043 13.858 2.36091 14.1162L2.44587 14.2207L4.52986 16.3037L4.63435 16.3886C4.89245 16.5589 5.24311 16.5309 5.47029 16.3037L7.5533 14.2207C7.81297 13.961 7.81299 13.5389 7.5533 13.2793C7.32609 13.0524 6.97534 13.0241 6.71736 13.1943L6.61287 13.2793L5.61287 14.2783C5.61948 14.2418 5.62458 14.2043 5.62458 14.166V5.83297C5.62456 5.79451 5.61954 5.7572 5.61287 5.72066L6.61287 6.72066L6.71736 6.80563C6.97536 6.97591 7.32608 6.94761 7.5533 6.72066C7.78046 6.49349 7.80852 6.14283 7.63826 5.88473L7.5533 5.78023L5.47029 3.69625Z"/>
            </svg>
          </div>
          <span>Add details</span>
        </button>

        {/* More concise button */}
        <button
          onClick={() => handleContextualPrompt(messageId, 'Give me a more concise response', messageIndex)}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '12px',
            width: '100%',
            padding: '8px 12px',
            border: 'none',
            backgroundColor: 'transparent',
            cursor: 'pointer',
            borderRadius: '8px',
            fontSize: '0.875rem'
          }}
          className="text-token-text-primary"
          onMouseEnter={(e) => {
            e.currentTarget.style.backgroundColor = 'var(--token-bg-secondary, #f8f9fa)';
          }}
          onMouseLeave={(e) => e.currentTarget.style.backgroundColor = 'transparent'}
        >
          <div style={{ width: '20px', height: '20px', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 20 20" fill="none" data-rtl-flip="">
              <path d="M10.2002 7.91699L16.8669 7.91889" stroke="currentColor" strokeWidth="1.33" strokeLinecap="round"/>
              <path d="M10.2002 12.083H13.5335" stroke="currentColor" strokeWidth="1.33" strokeLinecap="round"/>
              <path d="M5.2002 3.33301V7.49967" stroke="currentColor" strokeWidth="1.33" strokeLinecap="round" strokeLinejoin="round"/>
              <path d="M5.2002 12.5V16.6667" stroke="currentColor" strokeWidth="1.33" strokeLinecap="round" strokeLinejoin="round"/>
              <path d="M3.11719 13.7503L5.20052 11.667L7.28385 13.7503" stroke="currentColor" strokeWidth="1.33" strokeLinecap="round" strokeLinejoin="round"/>
              <path d="M7.28385 6.25L5.20052 8.33333L3.11719 6.25" stroke="currentColor" strokeWidth="1.33" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
          </div>
          <span>More concise</span>
        </button>

        {/* Separator */}
        <div style={{ height: '1px', backgroundColor: 'var(--token-border-default, #d1d5db)', margin: '4px 16px' }}></div>

        {/* Think longer button */}
        <button
          onClick={() => handleContextualPrompt(messageId, 'Regenerate this response with longer thinking process', messageIndex)}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '12px',
            width: '100%',
            padding: '8px 12px',
            border: 'none',
            backgroundColor: 'transparent',
            cursor: 'pointer',
            borderRadius: '8px',
            fontSize: '0.875rem'
          }}
          className="text-token-text-primary"
          onMouseEnter={(e) => {
            e.currentTarget.style.backgroundColor = 'var(--token-bg-secondary, #f8f9fa)';
          }}
          onMouseLeave={(e) => e.currentTarget.style.backgroundColor = 'transparent'}
        >
          <div style={{ width: '20px', height: '20px', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <svg width="20" height="20" viewBox="0 0 20 20" fill="currentColor" xmlns="http://www.w3.org/2000/svg">
              <path d="M10 2.125C14.3492 2.125 17.875 5.65076 17.875 10C17.875 14.3492 14.3492 17.875 10 17.875C5.65076 17.875 2.125 14.3492 2.125 10C2.125 5.65076 5.65076 2.125 10 2.125ZM7.88672 10.625C7.94334 12.3161 8.22547 13.8134 8.63965 14.9053C8.87263 15.5194 9.1351 15.9733 9.39453 16.2627C9.65437 16.5524 9.86039 16.625 10 16.625C10.1396 16.625 10.3456 16.5524 10.6055 16.2627C10.8649 15.9733 11.1274 15.5194 11.3604 14.9053C11.7745 13.8134 12.0567 12.3161 12.1133 10.625H7.88672ZM3.40527 10.625C3.65313 13.2734 5.45957 15.4667 7.89844 16.2822C7.7409 15.997 7.5977 15.6834 7.4707 15.3486C6.99415 14.0923 6.69362 12.439 6.63672 10.625H3.40527ZM13.3633 10.625C13.3064 12.439 13.0059 14.0923 12.5293 15.3486C12.4022 15.6836 12.2582 15.9969 12.1006 16.2822C14.5399 15.467 16.3468 13.2737 16.5947 10.625H13.3633ZM12.1006 3.7168C12.2584 4.00235 12.4021 4.31613 12.5293 4.65137C13.0059 5.90775 13.3064 7.56102 13.3633 9.375H16.5947C16.3468 6.72615 14.54 4.53199 12.1006 3.7168ZM10 3.375C9.86039 3.375 9.65437 3.44756 9.39453 3.7373C9.1351 4.02672 8.87263 4.48057 8.63965 5.09473C8.22547 6.18664 7.94334 7.68388 7.88672 9.375H12.1133C12.0567 7.68388 11.7745 6.18664 11.3604 5.09473C11.1274 4.48057 10.8649 4.02672 10.6055 3.7373C10.3456 3.44756 10.1396 3.375 10 3.375ZM7.89844 3.7168C5.45942 4.53222 3.65314 6.72647 3.40527 9.375H6.63672C6.69362 7.56102 6.99415 5.90775 7.4707 4.65137C7.59781 4.31629 7.74073 4.00224 7.89844 3.7168Z"/>
            </svg>
          </div>
          <span>Think longer</span>
        </button>
      </div>
    );
  };

  // Keep this as a render helper rather than a component declared during every
  // parent render.  A new component identity would remount every message and
  // reset the browser's drag-selection anchor to the beginning of the thread.
  const renderMessageBubble = (message: Message, turnIndex: number, messageIndex: number, messagePromptingEnabled: boolean) => (
    <article
      key={message.id}
      id={`chat-block-${message.id}`}
      className="text-token-text-primary group"
      data-turn-id={message.id}
      data-message-index={messageIndex}
      data-testid={`conversation-turn-${turnIndex}`}
      data-turn={message.role}
      style={{ width: '100%', outline: 'none' }}
    >
      <div style={{ fontSize: '1rem', margin: 'auto', paddingBottom: '1.5rem' }}>
        <div style={{
          maxWidth: '100%',
          margin: '0 auto',
          flex: '1',
          position: 'relative',
          display: 'flex',
          width: '100%',
          minWidth: '0',
          flexDirection: 'column'
        }} className="group/turn-messages">

          {/* Message Content */}
          <div style={{ display: 'flex', maxWidth: '100%', flexDirection: 'column', flexGrow: '1' }}>
            <div
              data-message-author-role={message.role}
              data-message-id={message.id}
              data-ai-response-content={message.role === 'assistant' ? 'true' : undefined}
              style={{
                minHeight: '2rem',
                position: 'relative',
                display: 'flex',
                width: '100%',
                flexDirection: 'column',
                gap: '0.5rem',
                textAlign: 'start',
                wordBreak: 'break-word',
                whiteSpace: 'normal'
              }}
            >
              {message.role === 'ai_guidance' ? (
                <div style={{ display: 'flex', width: '100%', justifyContent: 'flex-start' }}>
                  <div style={{
                    display: 'flex',
                    flexDirection: 'column',
                    width: '100%',
                    maxWidth: '92%',
                    backgroundColor: '#ecfdf5',
                    border: '1px solid #a7f3d0',
                    borderRadius: '12px',
                    padding: '0.75rem 1rem'
                  }}>
                    <div style={{ whiteSpace: 'pre-wrap', color: '#065f46', fontSize: '0.9375rem', lineHeight: '1.5' }}>
                      {message.guidanceDirection}
                    </div>
                    <div style={{ marginTop: '0.9rem', fontSize: '0.78rem', color: '#38856b' }}>
                      [Your earlier ideas: {(message.guidancePreviousIdeas ?? []).join(', ')}]
                    </div>
                    <div className="markdown prose" style={{ color: '#064e3b', fontSize: '0.9375rem', lineHeight: '1.5', marginTop: '0.9rem', overflowX: 'auto' }}>
                      <MemoizedMarkdown content={message.content} />
                    </div>
                  </div>
                </div>
              ) : message.role === 'user' ? (
                /* User Message */
                <div style={{ display: 'flex', width: '100%', flexDirection: 'column', gap: '0.25rem', alignItems: 'flex-end' }}>
                  {/* Reference preview - Show if this message references another */}
                  {message.referencedMessageContent && (
                    <div style={{
                      display: 'flex',
                      alignItems: 'start',
                      justifyContent: 'flex-end',
                      gap: '6px',
                      margin: '0 8px 4px 0',
                      fontSize: '0.875rem',
                      color: 'var(--token-text-tertiary, #9ca3af)'
                    }}
                    className="text-token-text-tertiary">
                      <svg width="20" height="20" viewBox="0 0 20 20" fill="currentColor" xmlns="http://www.w3.org/2000/svg" data-rtl-flip="" style={{ flexShrink: 0, marginTop: '2px' }}>
                        <path d="M12.5293 6.5293C12.7566 6.30203 13.1081 6.27383 13.3662 6.44434L13.4707 6.5293L17.4707 10.5293C17.7304 10.789 17.7304 11.211 17.4707 11.4707L13.4707 15.4707C13.211 15.7304 12.789 15.7304 12.5293 15.4707C12.2696 15.211 12.2696 14.789 12.5293 14.5293L15.3936 11.665H6C3.97588 11.665 2.33496 10.0241 2.33496 8V4.5C2.33496 4.13273 2.63273 3.83496 3 3.83496C3.36727 3.83496 3.66504 4.13273 3.66504 4.5V8C3.66504 9.28958 4.71042 10.335 6 10.335H15.3936L12.5293 7.4707L12.4443 7.36621C12.2738 7.10808 12.302 6.75657 12.5293 6.5293Z"/>
                      </svg>
                      <p style={{
                        display: '-webkit-box',
                        WebkitLineClamp: 3,
                        WebkitBoxOrient: 'vertical',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        lineHeight: '1.5',
                        maxWidth: '70%',
                        textAlign: 'right'
                      }}>
                        {message.referencedMessageContent}
                      </p>
                    </div>
                  )}
                  <div className="user-message-bubble-color" style={{
                    position: 'relative',
                    borderRadius: '18px',
                    padding: '0.375rem 1rem',
                    maxWidth: '70%'
                  }}>
                    <div style={{ whiteSpace: 'pre-wrap' }}>{message.content}</div>
                  </div>
                </div>
              ) : (
                /* Assistant Message */
                <div style={{ display: 'flex', width: '100%', flexDirection: 'column', gap: '0.25rem' }}>
                  {/* Show content if available, otherwise show loading indicator */}
                  {message.content ? (
                    <div
                      className="markdown prose"
                      style={{
                        width: '100%',
                        wordBreak: 'break-word',
                        userSelect: 'text',
                        WebkitUserSelect: 'text',
                        MozUserSelect: 'text',
                        msUserSelect: 'text'
                      }}
                    >
                      {/* During streaming, retain one text node so incremental chunks do not
                          replace the DOM subtree underneath a user's text selection. */}
                      {message.isLoading ? (
                        <div style={{ whiteSpace: 'pre-wrap' }}>{message.content}</div>
                      ) : (
                        <MemoizedMarkdown content={message.content} />
                      )}
                      {/* Show cursor indicator while streaming */}
                      {message.isLoading && (
                        <span style={{
                          display: 'inline-block',
                          width: '0.5rem',
                          height: '1rem',
                          backgroundColor: '#9ca3af',
                          marginLeft: '0.25rem',
                          animation: 'blink 1s infinite'
                        }}></span>
                      )}
                    </div>
                  ) : (
                    /* Loading indicator when no content yet */
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', padding: '0.5rem 0' }}>
                      <div style={{
                        width: '0.5rem',
                        height: '0.5rem',
                        borderRadius: '50%',
                        backgroundColor: '#9ca3af',
                        animation: 'pulse 1.5s ease-in-out infinite'
                      }}></div>
                      <div style={{
                        width: '0.5rem',
                        height: '0.5rem',
                        borderRadius: '50%',
                        backgroundColor: '#9ca3af',
                        animation: 'pulse 1.5s ease-in-out 0.2s infinite'
                      }}></div>
                      <div style={{
                        width: '0.5rem',
                        height: '0.5rem',
                        borderRadius: '50%',
                        backgroundColor: '#9ca3af',
                        animation: 'pulse 1.5s ease-in-out 0.4s infinite'
                      }}></div>
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>

          {/* Action Buttons (only for assistant messages and not loading) */}
          {message.role === 'assistant' && !message.isLoading && (
            <div style={{ display: 'flex', minHeight: '46px', justifyContent: 'flex-start' }}>
              <div style={{
                display: 'flex',
                flexWrap: 'wrap',
                alignItems: 'center',
                gap: '0.5rem',
                padding: '0.25rem',
                userSelect: 'none',
                WebkitUserSelect: 'none',
                MozUserSelect: 'none',
                msUserSelect: 'none'
              }}>
                {/* Copy Button */}
                <button
                  onClick={() => copyToClipboard(message.content, message.id, message.role, messageIndex)}
                  className="text-token-text-secondary"
                  style={{
                    borderRadius: '0.5rem',
                    padding: '0.25rem',
                    border: 'none',
                    backgroundColor: 'transparent',
                    cursor: 'pointer',
                    position: 'relative'
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.backgroundColor = 'var(--token-bg-secondary, #f8f9fa)';
                  }}
                  onMouseLeave={(e) => e.currentTarget.style.backgroundColor = 'transparent'}
                  aria-label="Copy"
                  title="Copy"
                  data-testid="copy-turn-action-button"
                >
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <rect width="14" height="14" x="8" y="8" rx="2" ry="2"/>
                    <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>
                  </svg>
                </button>

                {/* Good Response Button - Hide if bad feedback given */}
                {message.feedbackType !== 'bad' && (
                  <button
                    onClick={() => handleFeedback(message.id, true, messageIndex)}
                    className={`text-token-text-secondary ${message.feedbackType === 'good' ? 'bg-token-bg-tertiary' : ''}`}
                    style={{
                      borderRadius: '0.5rem',
                      padding: '0.25rem',
                      border: 'none',
                      backgroundColor: message.feedbackType === 'good' ? 'var(--token-bg-tertiary, #e5e7eb)' : 'transparent',
                      cursor: message.feedbackType === 'good' ? 'default' : 'pointer'
                    }}
                    onMouseEnter={(e) => {
                      if (message.feedbackType !== 'good') {
                        e.currentTarget.style.backgroundColor = 'var(--token-bg-secondary, #f8f9fa)';
                      }
                    }}
                    onMouseLeave={(e) => {
                      if (message.feedbackType !== 'good') {
                        e.currentTarget.style.backgroundColor = 'transparent';
                      }
                    }}
                    aria-label="Good response"
                    title="Good response"
                    aria-pressed={message.feedbackType === 'good'}
                    data-state={message.feedbackType ? 'closed' : undefined}
                    data-testid="good-response-turn-action-button"
                    disabled={message.feedbackType === 'good'}
                  >
                    {message.feedbackType === 'good' ? (
                      // Filled/solid icon when clicked
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                        <path d="M10.4933 2.24145C10.6705 1.93631 11.0263 1.77698 11.3766 1.84591C12.9688 2.15921 13.9371 3.75763 13.4595 5.28453L12.7524 7.66797H14.0805C16.2694 7.66797 17.8591 9.71567 17.2831 11.7933L16.1515 15.7534C15.7576 17.1743 14.4458 18.16 12.9488 18.16L7.97157 18.16C7.0564 18.1583 6.31505 17.4278 6.31505 16.527V7.66797H6.93102C7.22884 7.66797 7.50382 7.38853 7.65157 7.13413L10.4933 2.24145Z"/>
                        <path d="M4.98959 7.66797C3.61457 7.66797 2.66748 8.80749 2.66748 10.1603V15.7534C2.66748 17.1062 3.61457 18.16 4.98959 18.16H5.4337C5.15125 17.6796 4.98959 17.1219 4.98959 16.527V7.66797Z"/>
                      </svg>
                    ) : (
                      // Outline icon when not clicked
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M7 10v12"/>
                        <path d="M15 5.88 14 10h5.83a2 2 0 0 1 1.92 2.56l-2.33 8A2 2 0 0 1 17.5 22H4a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2h2.76a2 2 0 0 0 1.79-1.11L12 2h3.5a2 2 0 0 1 2 2.5"/>
                      </svg>
                    )}
                  </button>
                )}

                {/* Bad Response Button - Hide if good feedback given */}
                {message.feedbackType !== 'good' && (
                  <button
                    onClick={() => handleFeedback(message.id, false, messageIndex)}
                    className={`text-token-text-secondary ${message.feedbackType === 'bad' ? 'bg-token-bg-tertiary' : ''}`}
                    style={{
                      borderRadius: '0.5rem',
                      padding: '0.25rem',
                      border: 'none',
                      backgroundColor: message.feedbackType === 'bad' ? 'var(--token-bg-tertiary, #e5e7eb)' : 'transparent',
                      cursor: message.feedbackType === 'bad' ? 'default' : 'pointer'
                    }}
                    onMouseEnter={(e) => {
                      if (message.feedbackType !== 'bad') {
                        e.currentTarget.style.backgroundColor = 'var(--token-bg-secondary, #f8f9fa)';
                      }
                    }}
                    onMouseLeave={(e) => {
                      if (message.feedbackType !== 'bad') {
                        e.currentTarget.style.backgroundColor = 'transparent';
                      }
                    }}
                    aria-label="Bad response"
                    title="Bad response"
                    aria-pressed={message.feedbackType === 'bad'}
                    data-state={message.feedbackType ? 'closed' : undefined}
                    data-testid="bad-response-turn-action-button"
                    disabled={message.feedbackType === 'bad'}
                  >
                    {message.feedbackType === 'bad' ? (
                      // Filled/solid icon when clicked
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                        <path d="M12.6687 5.83304C12.6687 5.22006 12.6649 4.91019 12.6394 4.70413L12.6062 4.52542C12.4471 3.93179 12.0022 3.45922 11.4255 3.26272L11.3083 3.22757C11.0963 3.17075 10.8175 3.16507 9.99974 3.16507H8.0554C7.04558 3.16507 6.62456 3.17475 6.32982 3.26175L6.2097 3.30374C5.95005 3.41089 5.71908 3.57635 5.53392 3.78616L5.45677 3.87796C5.30475 4.0748 5.20336 4.33135 5.03392 4.91702L4.83763 5.6221L4.45677 7.01761C4.24829 7.78204 4.10326 8.31846 4.02318 8.73929C3.94374 9.15672 3.94298 9.39229 3.98119 9.56448L4.03587 9.75784C4.18618 10.1996 4.50043 10.5702 4.91771 10.7901L5.05052 10.8477C5.20009 10.9014 5.40751 10.9429 5.72533 10.9678C6.15231 11.0012 6.70771 11.002 7.49974 11.002C7.71076 11.002 7.90952 11.1018 8.0349 11.2715C8.14465 11.4201 8.18683 11.6067 8.15404 11.7862L8.13548 11.8623L7.34447 14.4326C7.01523 15.5033 7.71404 16.6081 8.81126 16.7813L11.5095 12.0606L11.5827 11.9405C11.8445 11.5461 12.2289 11.2561 12.6687 11.1094V5.83304Z"/>
                        <path d="M17.3318 8.33304C17.3318 8.97366 17.3364 9.43432 17.2615 9.82327L17.2234 9.98538C16.949 11.0094 16.1821 11.8233 15.1872 12.1621L14.9861 12.2237C14.5624 12.3372 14.0656 12.3321 13.3337 12.3321C13.0915 12.3321 12.8651 12.4453 12.7204 12.6348L12.6638 12.7198L9.74388 17.8301C9.61066 18.0631 9.35005 18.1935 9.08372 18.1602L8.70579 18.1123C6.75379 17.8682 5.49542 15.9213 6.07396 14.041L6.60033 12.3272C6.22861 12.3233 5.90377 12.3161 5.62083 12.294C5.18804 12.26 4.79914 12.1931 4.44701 12.0391L4.29857 11.9668C3.52688 11.5605 2.95919 10.8555 2.72533 10.0205L2.68333 9.85257C2.58769 9.42154 2.62379 8.97768 2.71654 8.49026C2.80865 8.00634 2.97082 7.41139 3.17357 6.668L3.55443 5.27249L3.74583 4.58011C3.9286 3.94171 4.10186 3.45682 4.40404 3.06546L4.53685 2.9053C4.85609 2.54372 5.25433 2.25896 5.70189 2.07425L5.93626 1.99222C6.49455 1.82612 7.15095 1.83499 8.0554 1.83499H12.6667C13.3558 1.83499 13.9128 1.83434 14.363 1.87112C14.8208 1.90854 15.2266 1.98789 15.6033 2.17972L15.821 2.30179C16.317 2.6059 16.7215 3.04226 16.987 3.56351L17.0535 3.70608C17.1977 4.04236 17.2629 4.40311 17.2956 4.80374C17.3324 5.25398 17.3318 5.81094 17.3318 6.50003V8.33304Z"/>
                      </svg>
                    ) : (
                      // Outline icon when not clicked
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M17 14v10"/>
                        <path d="M9 18.12 10 14H4.17a2 2 0 0 1-1.92-2.56l2.33-8A2 2 0 0 1 6.5 2H20a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-2.76a2 2 0 0 0-1.79 1.11L12 22h-3.5a2 2 0 0 1-2-2.5"/>
                      </svg>
                    )}
                  </button>
                )}

                {/* Regenerate Button - Now toggles expanded section */}
                {messagePromptingEnabled && <button
                  onClick={() => {
                    const isExpanding = expandedMessageId !== message.id;
                    logger.logEvent({
                      eventType: 'ui',
                      action: 'message_action',
                      target: {
                        element: 'regenerate-button',
                        section: 'response',
                      },
                      metadata: {
                        messageId: messageIndex,
                        actionType: 'toggle_regenerate_menu',
                        isExpanding,
                      },
                    });
                    setExpandedMessageId(isExpanding ? message.id : null);
                  }}
                  className="text-token-text-secondary"
                  style={{
                    borderRadius: '0.5rem',
                    padding: '0.25rem',
                    border: 'none',
                    backgroundColor: expandedMessageId === message.id ? 'var(--token-bg-tertiary, #e5e7eb)' : 'transparent',
                    cursor: 'pointer'
                  }}
                  onMouseEnter={(e) => {
                    if (expandedMessageId !== message.id) {
                      e.currentTarget.style.backgroundColor = 'var(--token-bg-secondary, #f8f9fa)';
                    }
                  }}
                  onMouseLeave={(e) => {
                    if (expandedMessageId !== message.id) {
                      e.currentTarget.style.backgroundColor = 'transparent';
                    }
                  }}
                  aria-label="Regenerate response"
                  title="Regenerate response"
                >
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/>
                    <path d="M21 3v5h-5"/>
                    <path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/>
                    <path d="M3 21v-5h5"/>
                  </svg>
                </button>}
              </div>
            </div>
          )}

          {/* Expanded Section - Show below action buttons */}
          {messagePromptingEnabled && expandedMessageId === message.id && (
            <ExpandedSection messageId={message.id} messageIndex={messageIndex} />
          )}
        </div>
      </div>
    </article>
  );

  return (
    <div style={{ height: '100%', minHeight: 0, display: 'flex', flexDirection: 'column', padding: '1rem', boxSizing: 'border-box', overflow: 'hidden' }}>
      {pendingGuidance && guidanceCountdown !== null && (
        <div
          role="status"
          style={{
            width: '100%',
            boxSizing: 'border-box',
            marginBottom: '0.75rem',
            padding: '0.625rem 0.875rem',
            borderRadius: '0.5rem',
            backgroundColor: '#ecfdf5',
            border: '1px solid #6ee7b7',
            color: '#065f46',
            fontSize: '0.8125rem',
            fontWeight: 600,
          }}
        >
          AI guidance will appear in {guidanceCountdown}s
        </div>
      )}
      <h2 style={{ fontSize: '1.125rem', fontWeight: '600', marginBottom: '1rem' }} className="text-token-text-primary">
        LLM Chat Interface
      </h2>

      {/* Chat Messages Area */}
      <div
        ref={messagesContainerRef}
        data-interaction-section="response"
        style={{
          flex: '1 1 0',
          minHeight: 0,
          overflowY: 'auto',
          overflowX: 'hidden',
          marginBottom: '1rem',
          overscrollBehavior: 'contain'
        }}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
          {messages.length === 0 ? (
            <div style={{ textAlign: 'center', padding: '2rem 0' }} className="text-token-text-secondary">
              <svg style={{
                margin: '0 auto 1rem',
                height: '3rem',
                width: '3rem',
                color: '#9ca3af'
              }} fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
              </svg>
              <p style={{ fontSize: '0.875rem' }}>Start a conversation with the AI assistant</p>
              <p style={{ fontSize: '0.75rem', color: '#9ca3af', marginTop: '0.25rem' }}>
                Ask any questions
              </p>
            </div>
          ) : (
            messages.map((message, index) => renderMessageBubble(message, index + 1, index + 1, promptingEnabled))
          )}
          {/* Scroll anchor */}
          <div ref={messagesEndRef} />
        </div>
      </div>

      {/* Composer Interface */}
      {promptingEnabled ? <form
        style={{ width: '100%', flexShrink: 0, marginTop: 'auto' }}
        data-type="unified-composer"
        onSubmit={(e) => { e.preventDefault(); handleSend(); }}
      >
        <div className="bg-token-bg-primary shadow-short"
             style={{
               cursor: 'text',
               padding: '0.625rem',
               borderRadius: '16px',
               display: 'flex',
               flexDirection: 'column'
             }}>
          <div
            role="separator"
            aria-orientation="horizontal"
            aria-label="Drag upward to enlarge the message input"
            onPointerDown={beginComposerResize}
            style={{
              height: '12px',
              margin: '-0.375rem 0 0.25rem',
              cursor: 'ns-resize',
              touchAction: 'none',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
            title="Drag upward to enlarge the message input"
          >
            <span style={{ width: '2.75rem', height: '3px', borderRadius: '999px', backgroundColor: '#cbd5e1' }} />
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr auto', alignItems: 'end' }}>
            {/* Primary (Text Input) */}
          <div style={{ display: 'flex', alignItems: 'stretch', padding: '0 0.75rem' }}>
            <textarea
              ref={textareaRef}
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Ask anything"
              className="text-token-text-primary"
              rows={1}
              style={{
                width: '100%',
                resize: 'none',
                outline: 'none',
                backgroundColor: 'transparent',
                border: 'none',
                minHeight: '1.5rem',
                height: `${composerHeight}px`,
                maxHeight: `${Math.max(72, Math.floor((window.innerHeight - 250) / 3))}px`,
                boxSizing: 'border-box',
                overflowY: 'auto'
              }}
            />
          </div>

          {/* Trailing (Send button) */}
          <div style={{ display: 'flex', alignItems: 'flex-end', gap: '0.5rem' }}>
            <button
              type="submit"
              disabled={!prompt.trim()}
              style={{
                display: 'flex',
                height: '2rem',
                width: '2rem',
                alignItems: 'center',
                justifyContent: 'center',
                borderRadius: '50%',
                border: 'none',
                cursor: prompt.trim() ? 'pointer' : 'not-allowed',
                backgroundColor: prompt.trim() ? 'black' : '#e5e7eb',
                color: prompt.trim() ? 'white' : '#9ca3af'
              }}
              onMouseEnter={(e) => {
                if (prompt.trim()) {
                  e.currentTarget.style.backgroundColor = '#1f2937';
                }
              }}
              onMouseLeave={(e) => {
                if (prompt.trim()) {
                  e.currentTarget.style.backgroundColor = 'black';
                }
              }}
            >
              <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" xmlns="http://www.w3.org/2000/svg">
                <path d="M.5 1.163A1 1 0 0 1 1.97.28l12.868 6.837a1 1 0 0 1 0 1.766L1.969 15.72A1 1 0 0 1 .5 14.836V10.33a1 1 0 0 1 .816-.983L8.5 8 1.316 6.653A1 1 0 0 1 .5 5.67V1.163Z"/>
              </svg>
            </button>
          </div>
          </div>
        </div>
      </form> : (
        <div style={{
          padding: '0.75rem 1rem',
          borderRadius: '0.75rem',
          backgroundColor: '#f3f4f6',
          color: '#4b5563',
          fontSize: '0.875rem',
          textAlign: 'center'
        }}>
          You are now in the writing phase. Direct prompts to the AI are unavailable, but AI guidance may still appear here.
        </div>
      )}
    </div>
  );
};

export default ChatInterface;
