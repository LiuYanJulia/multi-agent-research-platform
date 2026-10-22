import express from 'express';
import path from 'path';
import fs from 'fs';
import { isPracticeSession } from '../utils/sessionUtils';
import { buildSessionTimeline } from '../services/eventTimelineBuilder';
import { inspectSessionMetadata, sessionMetadataDiagnostic } from '../services/sessionMetadataDiagnostics';

const router = express.Router();

// Valid event types for the database ENUM
const VALID_EVENT_TYPES = ['mouse', 'keyboard', 'ui', 'api', 'session', 'selection', 'ai_guidance'];

// Helper function to normalize and validate event type
function normalizeEventType(eventType: string | undefined): string {
  if (!eventType) return 'ui';

  // Convert to lowercase to handle camelCase/PascalCase
  const normalized = eventType.toLowerCase();

  // Return if valid, otherwise default to 'ui'
  return VALID_EVENT_TYPES.includes(normalized) ? normalized : 'ui';
}

// POST /api/logging/batch - Log multiple interactions at once
router.post('/batch', async (req, res) => {
  try {
    const { sessionId, logs } = req.body;
    const db = (req as any).db;

    if (!sessionId || !Array.isArray(logs)) {
      return res.status(400).json({ error: 'Session ID and logs array are required' });
    }

    // Check if this is a practice session
    const isPractice = isPracticeSession(sessionId);

    // Ensure session exists in database (auto-create if not) - required for foreign key
    if (db && !isPractice) {
      try {
        const [existingSessions] = await db.execute(
          'SELECT id FROM sessions WHERE id = ?',
          [sessionId]
        );

        if ((existingSessions as any[]).length === 0) {
          console.log(`[Logging] Session ${sessionId} not found, creating it...`);
          sessionMetadataDiagnostic({
            stage: 'auto_create_before',
            source: 'interaction_log_batch',
            sessionId,
            metadata: await inspectSessionMetadata(db, sessionId),
          });
          const [autoCreateResult] = await db.execute(
            'INSERT INTO sessions (id, participant_id, status) VALUES (?, ?, ?)',
            [sessionId, 'auto-created', 'active']
          );
          sessionMetadataDiagnostic({
            stage: 'auto_create_after',
            source: 'interaction_log_batch',
            sessionId,
            result: autoCreateResult,
            metadata: await inspectSessionMetadata(db, sessionId),
          });
        }
      } catch (sessionError) {
        console.error('[Logging] Error checking/creating session:', sessionError);
        // Continue anyway - will fail on foreign key if there's a real issue
      }
    }

    // Allow logging for both practice and actual sessions
    // Prepare bulk insert with normalized event types
    const values = logs.map((log: any) => {
      return [
        sessionId,
        normalizeEventType(log.eventType),
        log.action || 'unknown',
        log.target?.element || null,
        log.target?.section || null,
        log.target?.coordinates ? JSON.stringify(log.target.coordinates) : null,
        log.target?.text || null,
        log.metadata ? JSON.stringify(log.metadata) : null,
        log.timestamp || 0, // Store relative timestamp as BIGINT (milliseconds since session start)
      ];
    });

    if (values.length > 0) {
      const placeholders = values.map(() => '(?, ?, ?, ?, ?, ?, ?, ?, ?)').join(', ');
      const flatValues = values.flat();

      try {
        await db.execute(
          `INSERT INTO interaction_logs
           (session_id, event_type, action, target_element, target_section, coordinates, text_content, metadata, timestamp)
           VALUES ${placeholders}`,
          flatValues
        );
      } catch (dbError: any) {
        console.error('Database insert error:', dbError.message);
        console.error('Sample log entry:', logs[0]);
        throw dbError;
      }

      if (db) {
        try {
          await buildSessionTimeline(db, sessionId);
        } catch (timelineError) {
          console.error('Failed to refresh session event timeline:', timelineError);
        }
      }
    }

    res.json({
      success: true,
      count: values.length,
      timestamp: new Date().toISOString(),
    });

  } catch (error) {
    console.error('Batch logging error:', error);
    res.status(500).json({
      error: 'Failed to save logs',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

// POST /api/logging/single - Log a single interaction
router.post('/single', async (req, res) => {
  try {
    const { sessionId, eventType, action, target, metadata } = req.body;
    const db = (req as any).db;

    if (!sessionId || !eventType || !action) {
      return res.status(400).json({ error: 'Session ID, event type, and action are required' });
    }

    // Check if this is a practice session
    const isPractice = isPracticeSession(sessionId);

    // Ensure session exists in database (auto-create if not) - required for foreign key
    if (db && !isPractice) {
      try {
        const [existingSessions] = await db.execute(
          'SELECT id FROM sessions WHERE id = ?',
          [sessionId]
        );

        if ((existingSessions as any[]).length === 0) {
          console.log(`[Logging] Session ${sessionId} not found, creating it...`);
          sessionMetadataDiagnostic({
            stage: 'auto_create_before',
            source: 'interaction_log_single',
            sessionId,
            metadata: await inspectSessionMetadata(db, sessionId),
          });
          const [autoCreateResult] = await db.execute(
            'INSERT INTO sessions (id, participant_id, status) VALUES (?, ?, ?)',
            [sessionId, 'auto-created', 'active']
          );
          sessionMetadataDiagnostic({
            stage: 'auto_create_after',
            source: 'interaction_log_single',
            sessionId,
            result: autoCreateResult,
            metadata: await inspectSessionMetadata(db, sessionId),
          });
        }
      } catch (sessionError) {
        console.error('[Logging] Error checking/creating session:', sessionError);
      }
    }

    // Allow logging for both practice and actual sessions
    await db.execute(
      `INSERT INTO interaction_logs
       (session_id, event_type, action, target_element, target_section, coordinates, text_content, metadata)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        sessionId,
        normalizeEventType(eventType),
        action,
        target?.element || null,
        target?.section || null,
        target?.coordinates ? JSON.stringify(target.coordinates) : null,
        target?.text || null,
        metadata ? JSON.stringify(metadata) : null,
      ]
    );

    res.json({
      success: true,
      timestamp: new Date().toISOString(),
    });

  } catch (error) {
    console.error('Single logging error:', error);
    res.status(500).json({
      error: 'Failed to save log',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

// GET /api/logging/:sessionId - Get interaction logs for a session
router.get('/:sessionId', async (req, res) => {
  try {
    const { sessionId } = req.params;
    const { eventType, action, limit = 1000, offset = 0 } = req.query;
    const db = (req as any).db;

    let query = 'SELECT * FROM interaction_logs WHERE session_id = ?';
    const params: any[] = [sessionId];

    if (eventType) {
      query += ' AND event_type = ?';
      params.push(eventType);
    }

    if (action) {
      query += ' AND action = ?';
      params.push(action);
    }

    query += ' ORDER BY timestamp ASC LIMIT ? OFFSET ?';
    params.push(parseInt(limit as string), parseInt(offset as string));

    const [rows] = await db.execute(query, params);

    // Parse JSON fields
    const logs = (rows as any[]).map(row => ({
      ...row,
      coordinates: row.coordinates ? JSON.parse(row.coordinates) : null,
      metadata: row.metadata ? JSON.parse(row.metadata) : null,
    }));

    res.json({
      logs,
      count: logs.length,
      sessionId,
    });

  } catch (error) {
    console.error('Get logs error:', error);
    res.status(500).json({
      error: 'Failed to retrieve logs',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

// GET /api/logging/:sessionId/stats - Get logging statistics for a session
router.get('/:sessionId/stats', async (req, res) => {
  try {
    const { sessionId } = req.params;
    const db = (req as any).db;

    // Get counts by event type
    const [eventTypeStats] = await db.execute(
      'SELECT event_type, COUNT(*) as count FROM interaction_logs WHERE session_id = ? GROUP BY event_type',
      [sessionId]
    );

    // Get counts by action
    const [actionStats] = await db.execute(
      'SELECT action, COUNT(*) as count FROM interaction_logs WHERE session_id = ? GROUP BY action ORDER BY count DESC LIMIT 10',
      [sessionId]
    );

    // Get session duration and total interactions
    const [sessionStats] = await db.execute(
      `SELECT
         MIN(timestamp) as first_interaction,
         MAX(timestamp) as last_interaction,
         COUNT(*) as total_interactions
       FROM interaction_logs WHERE session_id = ?`,
      [sessionId]
    );

    res.json({
      sessionId,
      eventTypes: eventTypeStats,
      topActions: actionStats,
      sessionStats: (sessionStats as any[])[0],
    });

  } catch (error) {
    console.error('Get stats error:', error);
    res.status(500).json({
      error: 'Failed to retrieve statistics',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

// GET /api/logging/export-csv - Export interaction logs as CSV and save to uploads folder
router.get('/export-csv', async (req, res) => {
  try {
    const { sessionId } = req.query;
    const db = (req as any).db;

    if (!sessionId) {
      return res.status(400).json({ error: 'Session ID is required' });
    }

    // Get all logs for this session
    const [rows] = await db.execute(
      'SELECT * FROM interaction_logs WHERE session_id = ? ORDER BY timestamp ASC',
      [sessionId]
    );

    const logs = rows as any[];

    // Create CSV header
    const headers = [
      'id',
      'session_id',
      'event_type',
      'action',
      'target_element',
      'target_section',
      'coordinates',
      'text_content',
      'metadata',
      'timestamp'
    ];

    // Create CSV rows
    const csvRows = [
      headers.join(','), // Header row
      ...logs.map(log => {
        return [
          log.id,
          log.session_id,
          log.event_type,
          log.action,
          escapeCsvField(log.target_element),
          log.target_section,
          escapeCsvField(log.coordinates),
          escapeCsvField(log.text_content),
          escapeCsvField(log.metadata),
          log.timestamp
        ].join(',');
      })
    ];

    const csvContent = csvRows.join('\n');

    // Save to uploads/interaction_logs directory
    const logsDir = path.join(__dirname, '../../uploads/interaction_logs');
    if (!fs.existsSync(logsDir)) {
      fs.mkdirSync(logsDir, { recursive: true });
    }

    const filename = `interaction_logs_${sessionId}.csv`;
    const filePath = path.join(logsDir, filename);
    const fileUrl = `/uploads/interaction_logs/${filename}`;

    // Write CSV to file
    fs.writeFileSync(filePath, csvContent);
    console.log(`Interaction logs saved to file: ${filePath}`);

    // Set headers for file download
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(csvContent);

  } catch (error) {
    console.error('Export CSV error:', error);
    res.status(500).json({
      error: 'Failed to export logs',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

// Helper function to escape CSV fields
function escapeCsvField(value: any): string {
  if (value === null || value === undefined) {
    return '';
  }

  // If value is an object (JSON), stringify it first
  let stringValue: string;
  if (typeof value === 'object') {
    stringValue = JSON.stringify(value);
  } else {
    stringValue = String(value);
  }

  // If the field contains comma, newline, or double quote, wrap it in quotes
  if (stringValue.includes(',') || stringValue.includes('\n') || stringValue.includes('"')) {
    // Escape double quotes by doubling them
    return `"${stringValue.replace(/"/g, '""')}"`;
  }

  return stringValue;
}

export default router;
