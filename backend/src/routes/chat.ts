import express from 'express';
import OpenAI from 'openai';
import { ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import { isPracticeSession } from '../utils/sessionUtils';
import { AgentStageEvent, runIncrementalPipeline, logMainResponseTurn } from '../services/manipulationPipeline';

const router = express.Router();

const MAIN_RESPONSE_SYSTEM_PROMPT = `The user is acting as a product manager and is brainstorming new ideas, features, learning experiences, interaction formats, and user pipelines for a career-development website.

Help the user explore, develop, and refine ideas for a proposal for new ideas for a career-development website. Encourage creative but useful thinking, especially ideas that go beyond common services such as CV refinement and mock interviews. The user may explore individual features, user journeys, learning pipelines, formats of interaction, or combinations of these elements.`;

/** Practice responses intentionally use the participant's prompt and conversation only. */
function mainResponseSystemMessages(sessionId: string): ChatCompletionMessageParam[] {
  return isPracticeSession(sessionId)
    ? []
    : [{ role: 'system', content: MAIN_RESPONSE_SYSTEM_PROMPT }];
}

async function createDirectGuidancePayload(db: any, sessionId: string, result: any) {
  const guidance = result.instruction?.guidance;
  if (!guidance) return null;
  const modelName = process.env.OPENAI_MODEL || 'gpt-5.6-terra';
  const [rows] = await db.execute('SELECT role, content FROM messages WHERE session_id = ? ORDER BY timestamp ASC', [sessionId]);
  const context: ChatCompletionMessageParam[] = (rows as any[]).map((row): ChatCompletionMessageParam => ({
    role: row.role === 'user' ? 'user' : 'assistant',
    content: String(row.content ?? ''),
  }));
  const responseMessages: ChatCompletionMessageParam[] = [
    ...mainResponseSystemMessages(sessionId),
    ...context,
    { role: 'user', content: guidance.promptForResponse },
  ];
  const guidanceResponseInput = responseMessages.map((message) => ({
    role: message.role === 'system' || message.role === 'user' ? message.role : 'assistant' as const,
    content: typeof message.content === 'string' ? message.content : JSON.stringify(message.content),
  }));
  const startedAt = new Date();
  const completion = await getOpenAI().chat.completions.create({
    model: modelName,
    reasoning_effort: 'low',
    verbosity: 'low',
    messages: responseMessages,
    max_completion_tokens: 900,
  });
  const response = completion.choices[0]?.message?.content?.trim();
  if (!response) throw new Error('Direct guidance response was empty');
  const displayAt = new Date(Date.now() + 5_000);
  const [insert] = await db.execute(
    `INSERT INTO messages (session_id, role, content, model_slug, is_guidance, guidance_direction, guidance_previous_ideas, guidance_display_at)
     VALUES (?, 'ai_guidance', ?, ?, FALSE, ?, ?, ?)`,
    [sessionId, response, modelName, guidance.directionGuidance, JSON.stringify(guidance.previousIdeas), displayAt]
  );
  if (result.turnIndex !== undefined) {
    await logMainResponseTurn(db, sessionId, result.turnIndex, {
      input: { directGuidance: guidance, messages: guidanceResponseInput }, output: response, modelUsed: modelName,
      startedAt, completedAt: new Date(), status: 'success',
    });
  }
  return {
    messageId: Number((insert as any).insertId), directionGuidance: guidance.directionGuidance,
    previousIdeas: guidance.previousIdeas, response, displayAt: displayAt.toISOString(), guidanceResponseInput,
  };
}

// Trigger a cursor-based analysis for speech/idle thresholds without requiring a chat Send.
router.post('/analyze', async (req, res) => {
  const { sessionId, trigger } = req.body;
  const db = (req as any).db;
  if (!sessionId) return res.status(400).json({ error: 'Session ID is required' });
  if (!db) return res.json({ ran: false, stages: [] });

  const stages: AgentStageEvent[] = [];
  try {
    const result = await runIncrementalPipeline(db, sessionId, (stage) => stages.push(stage), typeof trigger === 'string' ? trigger : undefined);
    let guidance = result.instruction?.intervened ? await createDirectGuidancePayload(db, sessionId, result) : null;
    if (guidance) {
      // Reserve the notification slot at delivery time. The evaluator and guidance
      // generation still run; only the participant-facing notification is throttled.
      const [reservation] = await db.execute(
        `UPDATE manipulation_state
         SET last_guidance_notification_at = CURRENT_TIMESTAMP
         WHERE session_id = ?
           AND (last_guidance_notification_at IS NULL
                OR last_guidance_notification_at <= DATE_SUB(CURRENT_TIMESTAMP, INTERVAL 60 SECOND))`,
        [sessionId]
      );
      if (Number((reservation as any).affectedRows ?? 0) === 0) {
        await db.execute('DELETE FROM messages WHERE id = ? AND session_id = ?', [guidance.messageId, sessionId]);
        guidance = null;
      }
    }
    if (guidance) {
      stages.push({
        agent: 'main_response_agent', status: 'completed',
        detail: 'Generated the AI-response portion of the guidance card.',
        modelUsed: process.env.OPENAI_MODEL || 'gpt-5.6-terra',
        guidanceResponseInput: guidance.guidanceResponseInput,
        timestamp: Date.now(),
      });
    }
    return res.json({
      ran: result.ran,
      trigger,
      stages,
      guidance,
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


    // Get conversation history from database (user message already saved by frontend)
    let messages = [];
    if (db) {
      const [rows] = await db.execute(
        'SELECT role, content FROM messages WHERE session_id = ? ORDER BY timestamp ASC',
        [sessionId]
      );
      messages = (rows as any[]).map(row => ({
        role: row.role === 'user' ? 'user' : 'assistant',
        content: row.content
      }));
    }

    // Use provided conversation history as fallback
    if (messages.length === 0 && conversationHistory.length > 0) {
      messages = conversationHistory;
    }

    // Call OpenAI API with conversation context
    const openai = getOpenAI();
    const modelName = process.env.OPENAI_MODEL || 'gpt-5.6-terra';
    const completion = await openai.chat.completions.create({
      model: modelName,
      reasoning_effort: 'low',
      verbosity: 'low',
      messages: [
        ...mainResponseSystemMessages(sessionId),
        ...messages
      ],
      // This cap includes hidden reasoning tokens as well as the visible reply.
      max_completion_tokens: 1_500,
    });

    const assistantMessage = completion.choices[0]?.message?.content || 'Sorry, I could not generate a response.';

    // Save assistant message to database
    if (db) {
      await db.execute(
        'INSERT INTO messages (session_id, role, content, model_slug) VALUES (?, ?, ?, ?)',
        [sessionId, 'assistant', assistantMessage, modelName]
      );
    }

    // Paper 2: log Main Response Agent execution + deterministic AI-Response move
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
  const modelName = process.env.OPENAI_MODEL || 'gpt-5.6-terra';

  // Check if this is a practice session (declare at function scope)
  const isPractice = isPracticeSession(sessionId);


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

    // Set headers for SSE before calling the main model so the response begins immediately.
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no'); // Disable nginx buffering
    res.setHeader('Transfer-Encoding', 'chunked'); // Enable chunked transfer encoding
    res.flushHeaders(); // Send headers immediately

    // Disable any compression middleware
    (res as any).socket?.setNoDelay(true);
    (res as any).socket?.setTimeout(0);

    // Evaluation and direct guidance run only through /analyze's speech triggers.
    // A typed message begins streaming immediately and never waits for that pipeline.

    // Guidance selected through the client is already persisted before this request begins.
    let messages = [];
    if (db) {
      const [rows] = await db.execute(
        'SELECT role, content FROM messages WHERE session_id = ? ORDER BY timestamp ASC',
        [sessionId]
      );
      messages = (rows as any[]).map(row => ({
        role: row.role === 'user' ? 'user' : 'assistant',
        content: row.content
      }));
    }

    // Use provided conversation history as fallback
    if (messages.length === 0 && conversationHistory.length > 0) {
      messages = conversationHistory;
    }

    // Call OpenAI API with streaming enabled
    const openai = getOpenAI();
    res.write(`data: ${JSON.stringify({ agentStage: {
      agent: 'main_response_agent', status: 'started',
      detail: `Main response AI running with "${modelName}".`, modelUsed: modelName,
      timestamp: Date.now(),
    } })}\n\n`);
    const stream = await openai.chat.completions.create({
      model: modelName,
      reasoning_effort: 'low',
      verbosity: 'low',
      messages: [
        ...mainResponseSystemMessages(sessionId),
        ...messages
      ],
      // This cap includes hidden reasoning tokens as well as the visible reply.
      max_completion_tokens: 1_500,
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

      // Send the model identity before the completion signal so test-mode clients
      // can show exactly which model produced each normal chat response.
      res.write(`data: ${JSON.stringify({ agentStage: {
        agent: 'main_response_agent', status: 'completed',
        detail: `Main response AI completed with "${modelName}".`, modelUsed: modelName,
        timestamp: Date.now(),
      } })}\n\n`);

      // Send completion signal - streaming completed successfully
      res.write(`data: ${JSON.stringify({ content: '', done: true })}\n\n`);

      // Save complete assistant message to database (allow for both practice and actual sessions)
      if (db && fullMessage.trim()) {
        await db.execute(
          'INSERT INTO messages (session_id, role, content, model_slug) VALUES (?, ?, ?, ?)',
          [sessionId, 'assistant', fullMessage, modelName]
        );
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
        role: row.role === 'user' ? 'user' : 'assistant',
        content: row.content
      }));
    }

    // Use provided conversation history as fallback
    if (messages.length === 0 && conversationHistory.length > 0) {
      messages = conversationHistory;
    }

    // Call OpenAI API with conversation context
    const openai = getOpenAI();
    const modelName = process.env.OPENAI_MODEL || 'gpt-5.6-terra';
    const completion = await openai.chat.completions.create({
      model: modelName,
      reasoning_effort: 'low',
      verbosity: 'low',
      messages: [
        ...mainResponseSystemMessages(sessionId),
        ...messages
      ],
      // This cap includes hidden reasoning tokens as well as the visible reply.
      max_completion_tokens: 1_500,
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
      `SELECT id, role, content, model_slug, is_guidance, guidance_direction,
              guidance_previous_ideas, guidance_display_at, timestamp
       FROM messages WHERE session_id = ? ORDER BY timestamp ASC`,
      [sessionId]
    );

    const messages = (rows as any[]).map(row => ({
      messageId: row.id,
      role: row.role,
      content: row.content,
      modelSlug: row.model_slug,
      isGuidance: !!row.is_guidance,
      guidanceDirection: row.guidance_direction ?? undefined,
      guidancePreviousIdeas: row.guidance_previous_ideas
        ? (typeof row.guidance_previous_ideas === 'string' ? JSON.parse(row.guidance_previous_ideas) : row.guidance_previous_ideas)
        : undefined,
      guidanceDisplayAt: row.guidance_display_at ?? undefined,
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
    const modelName = process.env.OPENAI_MODEL || 'gpt-5.6-terra';
    const completion = await openai.chat.completions.create({
      model: modelName,
      reasoning_effort: 'low',
      verbosity: 'low',
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
      // This cap includes hidden reasoning tokens as well as the visible suggestions.
      max_completion_tokens: 700,
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
      model: process.env.OPENAI_MODEL || 'gpt-5.6-terra',
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
