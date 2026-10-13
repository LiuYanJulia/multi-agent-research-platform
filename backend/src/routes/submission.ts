import express from 'express';
import mysql from 'mysql2/promise';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { isPracticeSession } from '../utils/sessionUtils';
import { inspectSessionMetadata, sessionMetadataDiagnostic } from '../services/sessionMetadataDiagnostics';
import { finalizeSessionTimeline } from '../services/manipulationPipeline';
import { exportEvaluationAudit } from '../services/evaluationAuditExport';

const router = express.Router();

const TREATMENT_GROUP_IDS = new Set(['2', '3', '4', '5', 'hightf_hightm', 'hightf_lowtm', 'lowtf_hightm', 'lowtf_lowtm']);

function isTreatmentGroup(groupId: unknown): boolean {
  return TREATMENT_GROUP_IDS.has(String(groupId ?? '').trim().toLowerCase());
}

function safeFilenamePart(value: unknown): string {
  const normalized = String(value ?? 'unknown').trim().replace(/[^a-zA-Z0-9_-]/g, '_');
  return normalized.slice(0, 80) || 'unknown';
}

// Configure multer for audio file uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const uploadDir = path.join(__dirname, '../../uploads/audio');
    // Create directory if it doesn't exist
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    // Generate temporary filename first, will rename after getting sessionId from body
    const timestamp = Date.now();
    const ext = path.extname(file.originalname);
    cb(null, `temp_${timestamp}${ext}`);
  }
});

const upload = multer({ storage });

// Upload audio file
router.post('/upload-audio', upload.single('audio'), async (req, res) => {
  try {
    const sessionId = req.body.sessionId || 'unknown';

    // Check if this is a practice session
    const isPractice = isPracticeSession(sessionId);

    // If practice session, delete the uploaded file and return success
    if (isPractice) {
      if (req.file) {
        fs.unlinkSync(req.file.path);
        console.log(`Practice session: Audio file deleted (not saved)`);
      }
      return res.json({
        success: true,
        fileUrl: null,
        filename: null
      });
    }

    if (!req.file) {
      return res.status(400).json({ error: 'No audio file uploaded' });
    }

    const ext = path.extname(req.file.originalname);
    const newFilename = `audio_${sessionId}${ext}`;

    // Rename the file from temp name to proper name with sessionId
    const oldPath = req.file.path;
    const newPath = path.join(path.dirname(oldPath), newFilename);

    fs.renameSync(oldPath, newPath);

    const fileUrl = `/uploads/audio/${newFilename}`;
    console.log(`Audio file uploaded and renamed: ${fileUrl}`);

    res.json({
      success: true,
      fileUrl,
      filename: newFilename
    });
  } catch (error) {
    console.error('Error uploading audio:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to upload audio file'
    });
  }
});

// Submit final work
router.post('/submit', async (req, res) => {
  const db: mysql.Connection = (req as any).db;

  console.log('=== SUBMISSION REQUEST RECEIVED ===');
  console.log('Database connection:', db ? 'Available' : 'NOT AVAILABLE');

  try {
    const {
      sessionId,
      finalWriting,
      wordCount,
      charCount,
      audioFileUrl,
      transcriptWithTimestamps,
      chatHistoryWithTimestamps,
      sessionStartTimestamp,
      recordingStartTimestamp,
      submittedAt
    } = req.body;

    console.log('Session ID:', sessionId);
    console.log('Word count:', wordCount);
    console.log('Submitted at:', submittedAt);

    // Check if this is a practice session
    const isPractice = isPracticeSession(sessionId);

    // Ensure session exists in database (auto-create if not)
    if (db && !isPractice) {
      try {
        const [existingSessions] = await db.execute(
          'SELECT id FROM sessions WHERE id = ?',
          [sessionId]
        );

        if ((existingSessions as any[]).length === 0) {
          console.log(`Session ${sessionId} not found in database, creating it...`);
          sessionMetadataDiagnostic({
            stage: 'auto_create_before',
            source: 'submission',
            sessionId,
            metadata: await inspectSessionMetadata(db, sessionId),
          });
          const [autoCreateResult] = await db.execute(
            'INSERT INTO sessions (id, participant_id, status) VALUES (?, ?, ?)',
            [sessionId, 'auto-created', 'active']
          );
          sessionMetadataDiagnostic({
            stage: 'auto_create_after',
            source: 'submission',
            sessionId,
            result: autoCreateResult,
            metadata: await inspectSessionMetadata(db, sessionId),
          });
          console.log(`Session ${sessionId} created in database`);
        }
      } catch (sessionError) {
        console.error('Error checking/creating session:', sessionError);
        // Continue anyway - the foreign key will fail if there's a real issue
      }
    }

    // If practice session, return success without saving anything
    if (isPractice) {
      console.log(`Practice session: Submission not saved (session: ${sessionId})`);
      return res.json({
        success: true,
        message: 'Practice session submission (not saved)',
        data: {
          sessionId,
          wordCount,
          charCount,
          submittedAt
        }
      });
    }

    // Convert ISO timestamp to MySQL datetime format
    const mysqlTimestamp = new Date(submittedAt).toISOString().slice(0, 19).replace('T', ' ');

    // Use the durable participant ID from the session rather than trusting a
    // client-provided filename value. The submission endpoint is only reached
    // after the session has been created for an actual (non-practice) run.
    const [submissionSessionRows] = await db.execute(
      'SELECT participant_id FROM sessions WHERE id = ?',
      [sessionId]
    );
    const participantId = (submissionSessionRows as any[])[0]?.participant_id ?? 'unknown';

    // Save transcript to a separate JSON file
    const transcriptDir = path.join(__dirname, '../../uploads/transcripts');
    if (!fs.existsSync(transcriptDir)) {
      fs.mkdirSync(transcriptDir, { recursive: true });
    }

    const transcriptFilename = `transcript_${sessionId}.json`;
    const transcriptPath = path.join(transcriptDir, transcriptFilename);
    const transcriptFileUrl = `/uploads/transcripts/${transcriptFilename}`;

    // Write transcript to file
    fs.writeFileSync(transcriptPath, JSON.stringify(transcriptWithTimestamps || [], null, 2));
    console.log(`Transcript saved to file: ${transcriptPath}`);

    // Save chat history to a separate JSON file
    const chatHistoryDir = path.join(__dirname, '../../uploads/chat_history');
    if (!fs.existsSync(chatHistoryDir)) {
      fs.mkdirSync(chatHistoryDir, { recursive: true });
    }

    const chatHistoryFilename = `chat_history_${sessionId}.json`;
    const chatHistoryPath = path.join(chatHistoryDir, chatHistoryFilename);
    const chatHistoryFileUrl = `/uploads/chat_history/${chatHistoryFilename}`;

    // Write chat history to file
    fs.writeFileSync(chatHistoryPath, JSON.stringify(chatHistoryWithTimestamps || [], null, 2));
    console.log(`Chat history saved to file: ${chatHistoryPath}`);

    // Export the participant's final proposal as an independently reviewable
    // plain-text artifact. Include the durable participant ID and submission
    // timestamp in both the filename and the file header.
    const proposalDir = path.join(__dirname, '../../uploads/proposals');
    if (!fs.existsSync(proposalDir)) {
      fs.mkdirSync(proposalDir, { recursive: true });
    }
    const submittedAtForFilename = new Date(submittedAt).toISOString().replace(/[-:.]/g, '').replace('T', '_').replace('Z', 'Z');
    const proposalFilename = `proposal_${safeFilenamePart(participantId)}_${submittedAtForFilename}.txt`;
    const proposalPath = path.join(proposalDir, proposalFilename);
    const proposalFileUrl = `/uploads/proposals/${proposalFilename}`;
    const proposalText = [
      `User ID: ${participantId}`,
      `Session ID: ${sessionId}`,
      `Submitted at: ${submittedAt}`,
      '',
      '--- Proposal ---',
      '',
      String(finalWriting ?? ''),
      '',
    ].join('\n');
    fs.writeFileSync(proposalPath, proposalText, 'utf8');
    console.log(`Proposal saved to file: ${proposalPath}`);

    // Generate and save interaction logs CSV
    let interactionLogsFileUrl = null;
    if (db) {
      try {
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

        // Helper function to escape CSV fields
        const escapeCsvField = (value: any): string => {
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
            return `"${stringValue.replace(/"/g, '""')}"`;
          }
          return stringValue;
        };

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

        const logsFilename = `interaction_logs_${sessionId}.csv`;
        const logsPath = path.join(logsDir, logsFilename);
        interactionLogsFileUrl = `/uploads/interaction_logs/${logsFilename}`;

        // Write CSV to file
        fs.writeFileSync(logsPath, csvContent);
        console.log(`Interaction logs saved to file: ${logsPath}`);
      } catch (logError) {
        console.error('Error saving interaction logs:', logError);
        // Don't fail the submission if interaction logs fail
      }
    }

    if (!db) {
      console.log('Demo mode: Submission received but not saved to database');
      console.log('Chat history with timestamps:', chatHistoryWithTimestamps);
      return res.json({
        success: true,
        message: 'Submission received (demo mode)',
        data: {
          sessionId,
          wordCount,
          charCount,
          submittedAt,
          transcriptFileUrl,
          chatHistoryFileUrl
        }
      });
    }

    // Finish any remaining timeline partition before exporting the audit, so a final
    // assistant response is represented in both evaluation_agent_audit and its files.
    try {
      await finalizeSessionTimeline(db as unknown as mysql.Pool, sessionId);
    } catch (timelineError) {
      console.error('Final event-timeline evaluation failed:', timelineError);
    }

    // Groups 2–5 receive a standalone audit export. The JSON and Markdown are generated
    // directly from evaluation_agent_audit rather than reconstructed from generic logs.
    let evaluationAuditJsonFileUrl: string | null = null;
    let evaluationAuditMarkdownFileUrl: string | null = null;
    try {
      const [sessionRows] = await db.execute('SELECT group_id FROM sessions WHERE id = ?', [sessionId]);
      const groupId = (sessionRows as any[])[0]?.group_id;
      if (isTreatmentGroup(groupId)) {
        const auditExport = await exportEvaluationAudit(db as unknown as mysql.Pool, sessionId);
        evaluationAuditJsonFileUrl = auditExport.jsonFileUrl;
        evaluationAuditMarkdownFileUrl = auditExport.markdownFileUrl;
        console.log(`Evaluation audit exported (${auditExport.count} runs): ${evaluationAuditJsonFileUrl}`);
      }
    } catch (auditError) {
      // Preserve the completed submission even if an audit file cannot be written.
      console.error('Error exporting evaluation audit:', auditError);
    }

    // Check if submission already exists for this session
    const [existingSubmissions] = await db.execute(
      'SELECT id FROM submissions WHERE session_id = ?',
      [sessionId]
    );

    if ((existingSubmissions as any[]).length > 0) {
      // Update existing submission
      await db.execute(
        `UPDATE submissions
         SET final_writing = ?, transcript_file_url = ?, chat_history_file_url = ?, interaction_logs_file_url = ?, proposal_file_url = ?, evaluation_audit_json_file_url = ?, evaluation_audit_markdown_file_url = ?, audio_file_url = ?, word_count = ?, char_count = ?, session_start_timestamp = ?, recording_start_timestamp = ?, submitted_at = ?
         WHERE session_id = ?`,
        [finalWriting, transcriptFileUrl, chatHistoryFileUrl, interactionLogsFileUrl, proposalFileUrl, evaluationAuditJsonFileUrl, evaluationAuditMarkdownFileUrl, audioFileUrl, wordCount, charCount, sessionStartTimestamp, recordingStartTimestamp, mysqlTimestamp, sessionId]
      );
    } else {
      // Generate unique ID for submission
      const submissionId = `sub_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

      // Insert new submission
      await db.execute(
        `INSERT INTO submissions (id, session_id, final_writing, transcript_file_url, chat_history_file_url, interaction_logs_file_url, proposal_file_url, evaluation_audit_json_file_url, evaluation_audit_markdown_file_url, audio_file_url, word_count, char_count, session_start_timestamp, recording_start_timestamp, submitted_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [submissionId, sessionId, finalWriting, transcriptFileUrl, chatHistoryFileUrl, interactionLogsFileUrl, proposalFileUrl, evaluationAuditJsonFileUrl, evaluationAuditMarkdownFileUrl, audioFileUrl, wordCount, charCount, sessionStartTimestamp, recordingStartTimestamp, mysqlTimestamp]
      );
    }

    // Update session status to completed
    await db.execute(
      `UPDATE sessions SET status = 'completed' WHERE id = ?`,
      [sessionId]
    );

    console.log(`Submission saved for session: ${sessionId}`);

    res.json({
      success: true,
      message: 'Submission saved successfully',
      data: {
        sessionId,
        wordCount,
        charCount,
        submittedAt,
        transcriptFileUrl,
        chatHistoryFileUrl,
        interactionLogsFileUrl,
        proposalFileUrl,
        evaluationAuditJsonFileUrl,
        evaluationAuditMarkdownFileUrl,
      }
    });
  } catch (error) {
    console.error('Error saving submission:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to save submission',
      message: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

// Get submission by session ID
router.get('/:sessionId', async (req, res) => {
  const db: mysql.Connection = (req as any).db;
  const { sessionId } = req.params;

  try {
    if (!db) {
      return res.status(503).json({ error: 'Database not available (demo mode)' });
    }

    const [submissions] = await db.execute(
      'SELECT * FROM submissions WHERE session_id = ?',
      [sessionId]
    );

    if ((submissions as any[]).length === 0) {
      return res.status(404).json({ error: 'Submission not found' });
    }

    res.json({ submission: (submissions as any[])[0] });
  } catch (error) {
    console.error('Error fetching submission:', error);
    res.status(500).json({ error: 'Failed to fetch submission' });
  }
});

export default router;
