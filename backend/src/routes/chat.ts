import express from 'express';
import OpenAI from 'openai';
import { v4 as uuidv4 } from 'uuid';
import { isPracticeSession, isTestSession } from '../utils/sessionUtils';
import { AgentStageEvent, runTurnPipeline, runIncrementalPipeline, logMainResponseTurn, OnStage } from '../services/manipulationPipeline';

const router = express.Router();

// Trigger a cursor-based analysis for speech/idle thresholds without requiring a chat Send.
router.post('/analyze', async (req, res) => {
  const { sessionId, trigger } = req.body;
  const db = (req as any).db;
  if (!sessionId) return res.status(400).json({ error: 'Session ID is required' });
  if (!db) return res.json({ ran: false, stages: [] });

  const stages: AgentStageEvent[] = [];
  try {
    const result = await runIncrementalPipeline(db, sessionId, (stage) => stages.push(stage), typeof trigger === 'string' ? trigger : undefined);
    return res.json({
      ran: result.ran,
      trigger,
      stages,
      intervention: result.instruction?.intervened && result.guidanceText
        ? { id: uuidv4(), text: result.guidanceText }
        : null,
    });
  } catch (error) {
    console.error('Automatic manipulation analysis failed:', error);
    return res.status(500).json({ error: 'Automatic analysis failed' });
  }
});

// Lazy initialize OpenAI client to ensure .env is loaded
function getOpenAI() {
  return new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
  });
}

// POST /api/chat/send - Send message to LLM and get response (placeholder)
router.post('/send', async (req, res) => {
  try {
    const { sessionId, message, conversationHistory = [] } = req.body;
    const db = (req as any).db;

    if (!sessionId || !message) {
      return res.status(400).json({ error: 'Session ID and message are required' });
    }

    // Ensure session exists
    if (db) {
      await db.execute(
        'INSERT IGNORE INTO sessions (id, participant_id, status) VALUES (?, ?, ?)',
        [sessionId, 'current_user', 'active']
      );
    }

    // Paper 2: run Move-Type Evaluation Agent + Manipulation Controller for this turn.
    // No-op (returns { ran: false }) for sessions without a manipulation_state row, so
    // legacy/practice sessions are completely unaffected. Must run BEFORE fetching
    // history below, so a guidance message it inserts is included in this turn's context.
    let pipelineResult: Awaited<ReturnType<typeof runTurnPipeline>> = { ran: false };
    if (db) {
      try {
        pipelineResult = await runTurnPipeline(db, sessionId, message);
      } catch (pipelineError) {
        console.error('Manipulation pipeline error (continuing without it):', pipelineError);
      }
    }

    if (db && pipelineResult.ran && pipelineResult.instruction?.intervened && pipelineResult.guidanceText) {
      return res.json({
        intervention: { id: uuidv4(), text: pipelineResult.guidanceText },
        model: null,
        timestamp: new Date().toISOString(),
      });
    }

    // Get conversation history from database (user message already saved by frontend)
    let messages = [];
    if (db) {
      const [rows] = await db.execute(
        'SELECT role, content FROM messages WHERE session_id = ? ORDER BY timestamp ASC',
        [sessionId]
      );
      messages = (rows as any[]).map(row => ({
        role: row.role,
        content: row.content
      }));
    }

    // Use provided conversation history as fallback
    if (messages.length === 0 && conversationHistory.length > 0) {
      messages = conversationHistory;
    }

    // Call OpenAI API with conversation context
    const openai = getOpenAI();
    const modelName = process.env.OPENAI_MODEL || 'gpt-4o';
    const mainStart = new Date();
    const completion = await openai.chat.completions.create({
      model: modelName,
      messages: [
        { role: 'system', content: 'You are a helpful assistant. Provide clear, helpful responses to user questions.' },
        ...messages
      ],
      max_tokens: 1000,
      temperature: 0.7,
    });
    const mainEnd = new Date();

    const assistantMessage = completion.choices[0]?.message?.content || 'Sorry, I could not generate a response.';

    // Save assistant message to database
    if (db) {
      await db.execute(
        'INSERT INTO messages (session_id, role, content, model_slug) VALUES (?, ?, ?, ?)',
        [sessionId, 'assistant', assistantMessage, modelName]
      );
    }

    // Paper 2: log Main Response Agent execution + deterministic AI-Response move
    if (db && pipelineResult.ran && pipelineResult.turnIndex !== undefined) {
      try {
        await logMainResponseTurn(db, sessionId, pipelineResult.turnIndex, {
          input: { messages },
          output: assistantMessage,
          modelUsed: modelName,
          startedAt: mainStart,
          completedAt: mainEnd,
          status: 'success',
        });
      } catch (logError) {
        console.error('Failed to log main_response_agent execution:', logError);
      }
    }

    res.json({
      message: assistantMessage,
      model: modelName,
      guidance: null,
      timestamp: new Date().toISOString(),
    });

  } catch (error) {
    console.error('Chat error:', error);
    res.status(500).json({
      error: 'Failed to get LLM response',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

// POST /api/chat/stream - Streaming chat endpoint
router.post('/stream', async (req, res) => {
  let fullMessage = '';
  let streamStarted = false;
  const { sessionId, message, conversationHistory = [], skipPipeline = false } = req.body;
  const db = (req as any).db;
  const modelName = process.env.OPENAI_MODEL || 'gpt-4o';

  // Check if this is a practice session (declare at function scope)
  const isPractice = isPracticeSession(sessionId);

  // Paper 2: pipeline result + main-agent timing, declared at function scope so both
  // the success path and the error/interruption paths below can log against it.
  let pipelineResult: Awaited<ReturnType<typeof runTurnPipeline>> = { ran: false };
  let mainStart = new Date();

  try {
    if (!sessionId || !message) {
      return res.status(400).json({ error: 'Session ID and message are required' });
    }

    // Ensure session exists (allow for both practice and actual sessions)
    if (db && !skipPipeline) {
      await db.execute(
        'INSERT IGNORE INTO sessions (id, participant_id, status) VALUES (?, ?, ?)',
        [sessionId, 'current_user', 'active']
      );
    }

    // Set headers for SSE (Server-Sent Events). Moved up (before the pipeline call below) so a
    // test-mode session (see isTestSession) can stream agentStage debug events live, as the
    // pipeline is still running, rather than only being able to send them after it completes.
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no'); // Disable nginx buffering
    res.setHeader('Transfer-Encoding', 'chunked'); // Enable chunked transfer encoding
    res.flushHeaders(); // Send headers immediately

    // Disable any compression middleware
    (res as any).socket?.setNoDelay(true);
    (res as any).socket?.setTimeout(0);

    // Paper 2 (2026-09) test mode: stream agent execution stages to the frontend debug panel
    // (see PAPER2_MANIPULATION_PLAN.md section 11) as they happen. Gated server-side on
    // isTestSession so a real participant's session never pays for these extra SSE writes.
    const isTestMode = isTestSession(sessionId);
    const onStage: OnStage | undefined = isTestMode
      ? (stage) => {
          try {
            res.write(`data: ${JSON.stringify({ agentStage: stage, done: false })}\n\n`);
          } catch (writeError) {
            console.error('Failed to write agentStage debug event:', writeError);
          }
        }
      : undefined;

    // Paper 2: run Move-Type Evaluation Agent + Manipulation Controller for this turn.
    // No-op (returns { ran: false }) for sessions without a manipulation_state row.
    if (db && !skipPipeline) {
      try {
        pipelineResult = await runTurnPipeline(db, sessionId, message, onStage);
      } catch (pipelineError) {
        console.error('Manipulation pipeline error (continuing without it):', pipelineError);
      }
    }

    // A qualifying Controller instruction is shown as a persistent client-side prompt.
    // The participant explicitly chooses Insert; only that action saves the guidance and
    // begins the Main Response Agent turn.
    if (db && pipelineResult.ran && pipelineResult.instruction?.intervened && pipelineResult.guidanceText) {
      res.write(`data: ${JSON.stringify({
        intervention: {
          id: uuidv4(),
          text: pipelineResult.guidanceText,
        },
        done: false,
      })}\n\n`);
      res.write(`data: ${JSON.stringify({ content: '', done: true })}\n\n`);
      return res.end();
    }

    // Guidance selected through the client is already persisted before this request begins.
    let messages = [];
    if (db) {
      const [rows] = await db.execute(
        'SELECT role, content FROM messages WHERE session_id = ? ORDER BY timestamp ASC',
        [sessionId]
      );
      messages = (rows as any[]).map(row => ({
        role: row.role,
        content: row.content
      }));
    }

    // Use provided conversation history as fallback
    if (messages.length === 0 && conversationHistory.length > 0) {
      messages = conversationHistory;
    }

    // Call OpenAI API with streaming enabled
    onStage?.({ agent: 'main_response_agent', status: 'started', timestamp: Date.now() });
    const openai = getOpenAI();
    mainStart = new Date();
    const stream = await openai.chat.completions.create({
      model: modelName,
      messages: [
        { role: 'system', content: 'You are a helpful assistant. Provide clear, helpful responses to user questions.' },
        ...messages
      ],
      max_tokens: 1000,
      temperature: 0.7,
      stream: true,
    });

    streamStarted = true;

    // Stream the response chunks with enhanced error handling
    try {
      for await (const chunk of stream) {
        const content = chunk.choices[0]?.delta?.content || '';
        if (content) {
          fullMessage += content;
          // Send chunk as SSE
          const sseMessage = `data: ${JSON.stringify({ content, done: false })}\n\n`;
          res.write(sseMessage);

          // FORCE immediate flush to client using multiple methods
          // Method 1: Try standard flush if available
          if (typeof (res as any).flush === 'function') {
            (res as any).flush();
          }
          // Method 2: Directly flush the underlying socket
          if ((res as any).socket && typeof (res as any).socket.write === 'function') {
            // Socket is already written to by res.write, just ensure no delay
            (res as any).socket.uncork?.();
          }
        }
      }

      // Send completion signal - streaming completed successfully
      res.write(`data: ${JSON.stringify({ content: '', done: true })}\n\n`);
      onStage?.({
        agent: 'main_response_agent',
        status: 'completed',
        detail: `responded (${fullMessage.length} chars)`,
        timestamp: Date.now(),
      });

      // Save complete assistant message to database (allow for both practice and actual sessions)
      if (db && fullMessage.trim()) {
        await db.execute(
          'INSERT INTO messages (session_id, role, content, model_slug) VALUES (?, ?, ?, ?)',
          [sessionId, 'assistant', fullMessage, modelName]
        );
      }

      // Paper 2: log Main Response Agent execution + deterministic AI-Response move
      if (db && pipelineResult.ran && pipelineResult.turnIndex !== undefined && fullMessage.trim()) {
        try {
          await logMainResponseTurn(db, sessionId, pipelineResult.turnIndex, {
            input: { messages },
            output: fullMessage,
            modelUsed: modelName,
            startedAt: mainStart,
            completedAt: new Date(),
            status: 'success',
          });
        } catch (logError) {
          console.error('Failed to log main_response_agent execution:', logError);
        }
      }

      res.end();

    } catch (streamError: any) {
      // Handle connection termination during streaming
      console.error('Stream connection error:', {
        error: streamError.message,
        code: streamError.code,
        cause: streamError.cause?.message,
        partialMessageLength: fullMessage.length,
        sessionId: sessionId
      });

      // Save partial response if we have any content (allow for both practice and actual sessions)
      if (db && fullMessage.trim()) {
        console.log(`Saving partial response (${fullMessage.length} chars) for session ${sessionId}`);
        try {
          await db.execute(
            'INSERT INTO messages (session_id, role, content, model_slug) VALUES (?, ?, ?, ?)',
            [sessionId, 'assistant', fullMessage + '\n\n[Note: Response was interrupted]', modelName]
          );
        } catch (dbError) {
          console.error('Failed to save partial response:', dbError);
        }
      }

      // Paper 2: best-effort log of the interrupted Main Response Agent step
      if (db && pipelineResult.ran && pipelineResult.turnIndex !== undefined) {
        try {
          await logMainResponseTurn(db, sessionId, pipelineResult.turnIndex, {
            input: { messages },
            output: fullMessage,
            modelUsed: modelName,
            startedAt: mainStart,
            completedAt: new Date(),
            status: 'error',
            errorMessage: streamError?.message ?? 'Stream connection error',
          });
        } catch (logError) {
          console.error('Failed to log main_response_agent execution:', logError);
        }
      }

      // Try to notify frontend about the interruption with partial content
      try {
        res.write(`data: ${JSON.stringify({
          error: 'Connection interrupted',
          partialContent: fullMessage,
          done: true,
          interrupted: true
        })}\n\n`);
      } catch (writeError) {
        console.error('Failed to write error message to response:', writeError);
      }

      // Try to end the response gracefully
      try {
        res.end();
      } catch (endError) {
        console.error('Failed to end response:', endError);
      }
    }

  } catch (error: any) {
    console.error('Chat streaming error:', {
      error: error.message,
      code: error.code,
      streamStarted,
      partialMessageLength: fullMessage.length,
      sessionId: sessionId
    });

    // Save partial response if streaming had started and we have content (allow for both practice and actual sessions)
    if (streamStarted && db && fullMessage.trim()) {
      console.log(`Saving partial response after outer error (${fullMessage.length} chars) for session ${sessionId}`);
      try {
        await db.execute(
          'INSERT INTO messages (session_id, role, content, model_slug) VALUES (?, ?, ?, ?)',
          [sessionId, 'assistant', fullMessage + '\n\n[Note: Response encountered an error]', modelName]
        );
      } catch (dbError) {
        console.error('Failed to save partial response:', dbError);
      }
    }

    // Paper 2: best-effort log of the failed Main Response Agent step
    if (db && pipelineResult.ran && pipelineResult.turnIndex !== undefined) {
      try {
        await logMainResponseTurn(db, sessionId, pipelineResult.turnIndex, {
          input: { message },
          output: fullMessage,
          modelUsed: modelName,
          startedAt: mainStart,
          completedAt: new Date(),
          status: 'error',
          errorMessage: error?.message ?? 'Chat streaming error',
        });
      } catch (logError) {
        console.error('Failed to log main_response_agent execution:', logError);
      }
    }

    // Try to send error message to frontend
    try {
      res.write(`data: ${JSON.stringify({
        error: 'Failed to get LLM response',
        partialContent: fullMessage,
        done: true,
        interrupted: true
      })}\n\n`);
      res.end();
    } catch (writeError) {
      console.error('Failed to write final error message:', writeError);
    }
  }
});

// POST /api/chat - Main chat endpoint (alias for /send)
router.post('/', async (req, res) => {
  try {
    const { sessionId, message, conversationHistory = [] } = req.body;
    const db = (req as any).db;

    if (!sessionId || !message) {
      return res.status(400).json({ error: 'Session ID and message are required' });
    }

    // Ensure session exists
    if (db) {
      await db.execute(
        'INSERT IGNORE INTO sessions (id, participant_id, status) VALUES (?, ?, ?)',
        [sessionId, 'current_user', 'active']
      );
    }

    // Get conversation history from database (user message already saved by frontend)
    let messages = [];
    if (db) {
      const [rows] = await db.execute(
        'SELECT role, content FROM messages WHERE session_id = ? ORDER BY timestamp ASC',
        [sessionId]
      );
      messages = (rows as any[]).map(row => ({
        role: row.role,
        content: row.content
      }));
    }

    // Use provided conversation history as fallback
    if (messages.length === 0 && conversationHistory.length > 0) {
      messages = conversationHistory;
    }

    // Call OpenAI API with conversation context
    const openai = getOpenAI();
    const modelName = process.env.OPENAI_MODEL || 'gpt-4o';
    const completion = await openai.chat.completions.create({
      model: modelName,
      messages: [
        { role: 'system', content: 'You are a helpful assistant. Provide clear, helpful responses to user questions.' },
        ...messages
      ],
      max_tokens: 1000,
      temperature: 0.7,
    });

    const assistantMessage = completion.choices[0]?.message?.content || 'Sorry, I could not generate a response.';

    // Save assistant message to database
    if (db) {
      await db.execute(
        'INSERT INTO messages (session_id, role, content, model_slug) VALUES (?, ?, ?, ?)',
        [sessionId, 'assistant', assistantMessage, modelName]
      );
    }

    res.json({
      message: assistantMessage,
      model: modelName,
      timestamp: new Date().toISOString(),
    });

  } catch (error) {
    console.error('Chat error:', error);
    res.status(500).json({
      error: 'Failed to get LLM response',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

// POST /api/chat/save-message - Save individual message to database
router.post('/save-message', async (req, res) => {
  try {
    const { sessionId, role, content, model, isGuidance = false } = req.body;
    const db = (req as any).db;

    if (!sessionId || !role || !content) {
      return res.status(400).json({ error: 'Session ID, role, and content are required' });
    }

    // Check if this is a practice session
    const isPractice = isPracticeSession(sessionId);

    // Ensure session exists (allow for both practice and actual sessions)
    if (db) {
      await db.execute(
        'INSERT IGNORE INTO sessions (id, participant_id, status) VALUES (?, ?, ?)',
        [sessionId, 'current_user', 'active']
      );
    }

    // Save message (allow for both practice and actual sessions)
    if (db) {
      await db.execute(
        'INSERT INTO messages (session_id, role, content, model_slug, is_guidance) VALUES (?, ?, ?, ?, ?)',
        [sessionId, role, content, model || null, isGuidance]
      );

      // An Insert is an explicit acceptance of the currently displayed guidance.
      // For all treatment groups (never control), reset the prior streak and
      // persist a two-content-move grace period across later evaluator calls.
      if (isGuidance === true && role === 'user') {
        await db.execute(
          `UPDATE manipulation_state
           SET streak_orientation = NULL,
               streak_count = 0,
               streak_suppression_remaining = 2,
               updated_at = NOW()
           WHERE session_id = ? AND is_control = FALSE`,
          [sessionId]
        );
      }
    }

    res.json({
      success: true,
      timestamp: new Date().toISOString(),
    });

  } catch (error) {
    console.error('Save message error:', error);
    res.status(500).json({
      error: 'Failed to save message',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

// GET /api/chat/history - Get conversation history (without sessionId param)
router.get('/history', async (req, res) => {
  try {
    const sessionId = req.query.sessionId || 'current';
    const db = (req as any).db;

    if (!db) {
      return res.json({ messages: [], sessionId });
    }

    const [rows] = await db.execute(
      'SELECT id, role, content, model_slug, is_guidance, timestamp FROM messages WHERE session_id = ? ORDER BY timestamp ASC',
      [sessionId]
    );

    const messages = (rows as any[]).map(row => ({
      messageId: row.id,
      role: row.role,
      content: row.content,
      modelSlug: row.model_slug,
      isGuidance: !!row.is_guidance,
      timestamp: row.timestamp,
    }));

    res.json({
      messages,
      sessionId,
      timestamp: new Date().toISOString(),
    });

  } catch (error) {
    console.error('Get history error:', error);
    res.status(500).json({
      error: 'Failed to retrieve conversation history',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

// POST /api/chat/generate-from-transcript - Generate chat from transcript
router.post('/generate-from-transcript', async (req, res) => {
  try {
    const { transcript, sessionId = 'current' } = req.body;

    if (!transcript) {
      return res.status(400).json({ error: 'Transcript is required' });
    }

    const openai = getOpenAI();
    const modelName = process.env.OPENAI_MODEL || 'gpt-4o';
    const completion = await openai.chat.completions.create({
      model: modelName,
      messages: [
        {
          role: 'system',
          content: 'You are a helpful assistant. Based on the user\'s voice transcript, generate thoughtful questions or prompts that could help them explore their ideas further.'
        },
        {
          role: 'user',
          content: `Based on this transcript, please suggest some questions or prompts to help explore these ideas further:\n\n"${transcript}"`
        }
      ],
      max_tokens: 500,
      temperature: 0.7,
    });

    const suggestions = completion.choices[0]?.message?.content || 'Could not generate suggestions.';

    res.json({
      suggestions,
      sessionId,
      timestamp: new Date().toISOString(),
    });

  } catch (error) {
    console.error('Generate from transcript error:', error);
    res.status(500).json({
      error: 'Failed to generate suggestions from transcript',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

// POST /api/chat/generate-prompt - Generate prompt based on transcript (placeholder)
router.post('/generate-prompt', async (req, res) => {
  try {
    const { sessionId, transcript } = req.body;

    if (!sessionId || !transcript) {
      return res.status(400).json({ error: 'Session ID and transcript are required' });
    }

    // Simulate prompt generation
    const suggestions = `Based on your transcript, here are some suggested prompts to explore:

1. How can you develop the main themes you mentioned further?
2. What are the potential challenges or obstacles you might face?
3. What additional research or information would help strengthen your ideas?
4. How do these concepts connect to existing knowledge in this field?
5. What would be the next concrete steps to implement these ideas?

This is a simulated response. In the real implementation, this would use OpenAI to generate personalized prompts based on your specific transcript content.`;

    res.json({
      suggestions,
      timestamp: new Date().toISOString(),
    });

  } catch (error) {
    console.error('Generate prompt error:', error);
    res.status(500).json({
      error: 'Failed to generate prompts',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

// GET /api/chat/history/:sessionId - Get conversation history
router.get('/history/:sessionId', async (req, res) => {
  try {
    const { sessionId } = req.params;
    const db = (req as any).db;

    const [rows] = await db.execute(
      'SELECT id as message_id, role, content, model_slug, timestamp FROM messages WHERE session_id = ? ORDER BY timestamp ASC',
      [sessionId]
    );

    res.json({
      messages: rows,
      count: (rows as any[]).length,
    });

  } catch (error) {
    console.error('Get chat history error:', error);
    res.status(500).json({
      error: 'Failed to retrieve chat history',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

// POST /api/chat/feedback - Save feedback on LLM response
router.post('/feedback', async (req, res) => {
  try {
    const { sessionId, messageId, feedback, rating } = req.body;
    const db = (req as any).db;

    if (!sessionId || !feedback) {
      return res.status(400).json({ error: 'Session ID and feedback are required' });
    }

    // Log feedback as interaction
    await db.execute(
      'INSERT INTO interaction_logs (session_id, event_type, action, metadata) VALUES (?, ?, ?, ?)',
      [
        sessionId,
        'ui',
        'feedback',
        JSON.stringify({ messageId, feedback, rating, timestamp: new Date().toISOString() })
      ]
    );

    res.json({
      success: true,
      timestamp: new Date().toISOString(),
    });

  } catch (error) {
    console.error('Feedback error:', error);
    res.status(500).json({
      error: 'Failed to save feedback',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

// GET /api/chat/model-info - Get current model configuration
router.get('/model-info', async (req, res) => {
  try {
    res.json({
      model: process.env.OPENAI_MODEL || 'gpt-4o',
      provider: 'openai',
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error('Model info error:', error);
    res.status(500).json({
      error: 'Failed to get model info',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

export default router;
