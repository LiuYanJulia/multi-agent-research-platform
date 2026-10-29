import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { createServer } from 'http';
import { Server as SocketIOServer } from 'socket.io';
import mysql from 'mysql2/promise';

// Import route handlers
import transcriptRoutes from './routes/transcript';
import chatRoutes from './routes/chat';
import loggingRoutes from './routes/logging';
import sessionRoutes from './routes/session';
import submissionRoutes from './routes/submission';
import writingRoutes from './routes/writing';

// Load environment variables
dotenv.config();

const app = express();
const server = createServer(app);
const io = new SocketIOServer(server, {
  cors: {
    origin: process.env.FRONTEND_URL || "http://localhost:3000",
    methods: ["GET", "POST"]
  }
});

const PORT = process.env.PORT || 5001;

// Middleware
app.use(cors({
  origin: process.env.FRONTEND_URL || "http://localhost:3000",
  credentials: true
}));
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Serve uploaded files (audio and chat history)
app.use('/uploads', express.static('uploads'));

// Database connection pool (handles reconnection automatically)
let db: mysql.Pool;

async function initDatabase() {
  try {
    // Use createPool instead of createConnection for better reliability
    // Pool automatically handles connection drops and reconnection
    db = mysql.createPool({
      host: process.env.DB_HOST || 'localhost',
      user: process.env.DB_USER || 'root',
      password: process.env.DB_PASSWORD || '',
      database: process.env.DB_NAME || 'research_platform',
      waitForConnections: true,
      connectionLimit: 10,
      queueLimit: 0,
      enableKeepAlive: true,
      keepAliveInitialDelay: 10000  // 10 seconds
    });

    // Test the connection
    const connection = await db.getConnection();
    console.log('Connected to MySQL database (using connection pool)');
    connection.release();

    // Create tables if they don't exist
    await createTables();
  } catch (error) {
    console.error('Database connection failed:', error);
    console.log('Running without database connection for demo purposes');
    db = null as any;
  }
}

async function columnExists(table: string, column: string): Promise<boolean> {
  const [rows] = await db.execute(
    `SELECT COUNT(*) as cnt FROM information_schema.COLUMNS WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?`,
    [table, column]
  );
  return (rows as any[])[0].cnt > 0;
}

async function ensureColumn(table: string, column: string, definition: string) {
  if (!(await columnExists(table, column))) {
    await db.execute(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    console.log(`Added column ${table}.${column}`);
  }
}

async function ensureDecisionAgentEnum() {
  const [rows] = await db.execute(
    `SELECT COLUMN_TYPE AS columnType FROM information_schema.COLUMNS
     WHERE table_schema = DATABASE() AND table_name = 'agent_execution_log' AND column_name = 'agent_name'`
  );
  const columnType = String((rows as any[])[0]?.columnType ?? '');
  if (columnType && !columnType.includes("'decision_agent'")) {
    await db.execute(`ALTER TABLE agent_execution_log MODIFY COLUMN agent_name ENUM('evaluation_agent', 'decision_agent', 'manipulation_controller', 'main_response_agent') NOT NULL`);
    console.log('Added decision_agent to agent_execution_log.agent_name enum');
  }
}

async function ensureGuidanceEnums() {
  const [messageRows] = await db.execute(`SELECT COLUMN_TYPE AS columnType FROM information_schema.COLUMNS WHERE table_schema = DATABASE() AND table_name = 'messages' AND column_name = 'role'`);
  if (!String((messageRows as any[])[0]?.columnType ?? '').includes("'ai_guidance'")) {
    await db.execute("ALTER TABLE messages MODIFY COLUMN role ENUM('user', 'assistant', 'ai_guidance') NOT NULL");
  }
  const [logRows] = await db.execute(`SELECT COLUMN_TYPE AS columnType FROM information_schema.COLUMNS WHERE table_schema = DATABASE() AND table_name = 'interaction_logs' AND column_name = 'event_type'`);
  if (!String((logRows as any[])[0]?.columnType ?? '').includes("'ai_guidance'")) {
    await db.execute("ALTER TABLE interaction_logs MODIFY COLUMN event_type ENUM('mouse', 'keyboard', 'ui', 'api', 'session', 'selection', 'ai_guidance') NOT NULL");
  }
}

// Paper 2 (2026-09): some live databases were created long before `participant_id` was the
// column name in this file's CREATE TABLE statement, and still have the legacy `user_id`
// column instead (CREATE TABLE IF NOT EXISTS is a no-op on an already-existing table, so
// that legacy schema never got updated automatically). Rename it in place if found, so the
// rest of the codebase can assume `participant_id` always exists.
async function renameColumnIfNeeded(table: string, oldColumn: string, newColumn: string, definition: string) {
  const hasOld = await columnExists(table, oldColumn);
  const hasNew = await columnExists(table, newColumn);
  if (hasOld && !hasNew) {
    await db.execute(`ALTER TABLE ${table} CHANGE COLUMN ${oldColumn} ${newColumn} ${definition}`);
    console.log(`Renamed column ${table}.${oldColumn} -> ${table}.${newColumn}`);
  }
}

async function createTables() {
  if (!db) return;

  try {
    // Sessions table
    await db.execute(`
      CREATE TABLE IF NOT EXISTS sessions (
        id VARCHAR(36) PRIMARY KEY,
        participant_id VARCHAR(255) NOT NULL,
        group_id VARCHAR(50) NULL COMMENT 'Paper2 manipulation condition: HighTF_HighTM / HighTF_LowTM / LowTF_HighTM / LowTF_LowTM / control',
        started_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        ended_at TIMESTAMP NULL,
        status ENUM('active', 'completed', 'abandoned') DEFAULT 'active',
        metadata JSON,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      )
    `);

    // Transcripts table
    await db.execute(`
      CREATE TABLE IF NOT EXISTS transcripts (
        id INT AUTO_INCREMENT PRIMARY KEY,
        session_id VARCHAR(36) NOT NULL,
        content TEXT NOT NULL,
        timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE,
        INDEX idx_session_timestamp (session_id, timestamp)
      )
    `);

    // Messages table (for LLM conversations)
    await db.execute(`
      CREATE TABLE IF NOT EXISTS messages (
        id INT AUTO_INCREMENT PRIMARY KEY,
        session_id VARCHAR(36) NOT NULL,
        role ENUM('user', 'assistant', 'ai_guidance') NOT NULL,
        content TEXT NOT NULL,
        model_slug VARCHAR(100),
        is_guidance BOOLEAN DEFAULT FALSE COMMENT 'True if this is a Manipulation Controller guidance message (Paper2)',
        timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE,
        INDEX idx_session_timestamp (session_id, timestamp)
      )
    `);

    // Interaction logs table
    await db.execute(`
      CREATE TABLE IF NOT EXISTS interaction_logs (
        id INT AUTO_INCREMENT PRIMARY KEY,
        session_id VARCHAR(36) NOT NULL,
        event_type ENUM('mouse', 'keyboard', 'ui', 'api', 'session', 'selection', 'ai_guidance') NOT NULL,
        action VARCHAR(100) NOT NULL,
        target_element VARCHAR(255),
        target_section ENUM('prompting', 'transcript', 'response', 'writing', 'regenerate-menu'),
        coordinates JSON,
        text_content TEXT,
        metadata JSON,
        timestamp BIGINT NOT NULL COMMENT 'Milliseconds relative to session start',
        FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE,
        INDEX idx_session_timestamp (session_id, timestamp),
        INDEX idx_event_type (event_type),
        INDEX idx_action (action)
      )
    `);

    // Final submissions table
    await db.execute(`
      CREATE TABLE IF NOT EXISTS submissions (
        id VARCHAR(50) PRIMARY KEY,
        session_id VARCHAR(36) NOT NULL UNIQUE,
        final_writing TEXT NOT NULL,
        transcript_file_url VARCHAR(255),
        chat_history_file_url VARCHAR(255),
        interaction_logs_file_url VARCHAR(255),
        proposal_file_url VARCHAR(255),
        evaluation_audit_json_file_url VARCHAR(255),
        evaluation_audit_markdown_file_url VARCHAR(255),
        audio_file_url VARCHAR(255),
        word_count INT DEFAULT 0,
        char_count INT DEFAULT 0,
        session_start_timestamp BIGINT,
        recording_start_timestamp BIGINT,
        submitted_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
      )
    `);

    // Writing drafts table (for auto-save)
    await db.execute(`
      CREATE TABLE IF NOT EXISTS writing_drafts (
        id INT AUTO_INCREMENT PRIMARY KEY,
        session_id VARCHAR(36) NOT NULL,
        content TEXT,
        word_count INT DEFAULT 0,
        char_count INT DEFAULT 0,
        last_saved_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE,
        INDEX idx_session (session_id)
      )
    `);

    await db.execute(`
      CREATE TABLE IF NOT EXISTS writing_snapshots (
        id INT AUTO_INCREMENT PRIMARY KEY,
        session_id VARCHAR(36) NOT NULL,
        content TEXT NOT NULL,
        captured_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        received_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE,
        INDEX idx_writing_snapshots_session_time (session_id, captured_at)
      )
    `);


    // ── Paper 2: Manipulation System tables ──────────────────────────────
    // move_ledger: per-move classification records from the Move-Type Evaluation Agent
    await db.execute(`
      CREATE TABLE IF NOT EXISTS move_ledger (
        id INT AUTO_INCREMENT PRIMARY KEY,
        session_id VARCHAR(36) NOT NULL,
        move_id INT NOT NULL,
        move_type TINYINT NOT NULL COMMENT '1=Generate,2=Ask,3=Evaluate,4=Adopt,5=AI Response,6=Reject',
        orientation ENUM('D', 'C') NOT NULL COMMENT 'Derived from move_type: 1/2/5=D, 3/4/6=C',
        description TEXT,
        event_id_start INT,
        event_id_end INT,
        turn_index INT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE,
        INDEX idx_session_turn (session_id, turn_index)
      )
    `);

    // manipulation_state: one mutable row per session tracking the Controller's state machine
    await db.execute(`
      CREATE TABLE IF NOT EXISTS manipulation_state (
        session_id VARCHAR(36) PRIMARY KEY,
        tf_level ENUM('high', 'low') NULL,
        tm_level ENUM('high', 'low') NULL,
        is_control BOOLEAN DEFAULT FALSE,
        phase ENUM('collect', 'synthesize', 'na') DEFAULT 'na',
        phase_advanced_at TIMESTAMP NULL,
        streak_orientation ENUM('D', 'C') NULL,
        streak_count INT DEFAULT 0,
        streak_suppression_remaining INT NOT NULL DEFAULT 0 COMMENT 'Content moves still excluded from Controller streak after guidance Insert',
        last_guidance_notification_at TIMESTAMP NULL,
        turn_count INT DEFAULT 0,
        last_evaluated_event_id INT NOT NULL DEFAULT 0,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
      )
    `);

    // agent_execution_log: multi-agent execution trace (evaluation agent / controller / main response agent), one row per agent step per turn
    await db.execute(`
      CREATE TABLE IF NOT EXISTS agent_execution_log (
        id INT AUTO_INCREMENT PRIMARY KEY,
        session_id VARCHAR(36) NOT NULL,
        turn_index INT,
        agent_name ENUM('evaluation_agent', 'decision_agent', 'manipulation_controller', 'main_response_agent') NOT NULL,
        step_order TINYINT,
        input_payload MEDIUMTEXT,
        output_payload MEDIUMTEXT,
        model_used VARCHAR(100),
        started_at DATETIME(3),
        completed_at DATETIME(3),
        duration_ms INT,
        status ENUM('success', 'error', 'timeout', 'fallback_used') DEFAULT 'success',
        error_message TEXT,
        retry_count INT DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE,
        INDEX idx_session_turn (session_id, turn_index),
        INDEX idx_agent_name (agent_name)
      )
    `);

    // evaluation_agent_audit: one self-contained, submission-exportable audit row per
    // Evaluation Agent run. Unlike agent_execution_log, this table also freezes the
    // corresponding Controller state transition and the move-ledger delta.
    await db.execute(`
      CREATE TABLE IF NOT EXISTS evaluation_agent_audit (
        id INT AUTO_INCREMENT PRIMARY KEY,
        session_id VARCHAR(36) NOT NULL,
        turn_index INT NOT NULL,
        trigger_type VARCHAR(50) NOT NULL,
        trigger_reason TEXT,
        evaluation_input_payload MEDIUMTEXT NOT NULL,
        evaluation_output_payload MEDIUMTEXT NOT NULL,
        evaluation_model_used VARCHAR(100),
        evaluation_started_at DATETIME(3) NOT NULL,
        evaluation_completed_at DATETIME(3) NOT NULL,
        evaluation_duration_ms INT NOT NULL,
        evaluation_status ENUM('success', 'error', 'timeout', 'fallback_used') DEFAULT 'success',
        evaluation_retry_count INT DEFAULT 0,
        evaluation_error_message TEXT,
        controller_input_payload MEDIUMTEXT,
        controller_output_payload MEDIUMTEXT,
        controller_model_used VARCHAR(100),
        controller_started_at DATETIME(3),
        controller_completed_at DATETIME(3),
        controller_duration_ms INT,
        controller_status ENUM('success', 'error', 'timeout', 'fallback_used', 'not_run') DEFAULT 'not_run',
        controller_error_message TEXT,
        controller_turn_count_before INT,
        controller_turn_count_after INT,
        move_ledger_count_before INT NOT NULL DEFAULT 0,
        move_ledger_count_after INT NOT NULL DEFAULT 0,
        move_ledger_delta MEDIUMTEXT,
        guidance_generation_payload MEDIUMTEXT,
        streak_orientation_before ENUM('D', 'C') NULL,
        streak_count_before INT,
        streak_suppression_remaining_before INT,
        streak_orientation_after ENUM('D', 'C') NULL,
        streak_count_after INT,
        streak_suppression_remaining_after INT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE,
        INDEX idx_evaluation_audit_session_turn (session_id, turn_index),
        INDEX idx_evaluation_audit_trigger (trigger_type)
      )
    `);

    // session_events: real-time unified event timeline, mirrors the offline *_timeline_cleaned.json shape
    await db.execute(`
      CREATE TABLE IF NOT EXISTS session_events (
        id INT AUTO_INCREMENT PRIMARY KEY,
        session_id VARCHAR(36) NOT NULL,
        event_id INT NOT NULL COMMENT 'Sequential within session, aligned with offline pipeline event_id',
        timestamp_start BIGINT NOT NULL,
        timestamp_end BIGINT NOT NULL,
        event_type ENUM('user_action', 'user_speech', 'user_message', 'ai_response') NOT NULL,
        action_description TEXT,
        speech TEXT,
        user_message TEXT,
        ai_response TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE,
        INDEX idx_session_event (session_id, event_id)
      )
    `);

    // timeline_source_cursors: independent raw-source watermarks for the online
    // preprocessing pipeline. They prevent interaction logs, speech segments,
    // and chat history from being re-ingested into session_events on every
    // Evaluation Agent trigger. This is intentionally separate from
    // manipulation_state.last_evaluated_event_id, which only records what the
    // Evaluation Agent has already consumed.
    await db.execute(`
      CREATE TABLE IF NOT EXISTS timeline_source_cursors (
        session_id VARCHAR(36) NOT NULL,
        source_name ENUM('interaction_logs', 'speech_segments', 'messages') NOT NULL,
        last_source_id BIGINT NOT NULL DEFAULT 0,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (session_id, source_name),
        FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
      )
    `);

    // speech_segments: raw realtime transcription segments, before smart-merge into session_events
    await db.execute(`
      CREATE TABLE IF NOT EXISTS speech_segments (
        id INT AUTO_INCREMENT PRIMARY KEY,
        session_id VARCHAR(36) NOT NULL,
        timestamp_start BIGINT NOT NULL,
        timestamp_end BIGINT NOT NULL,
        transcription TEXT,
        received_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE,
        INDEX idx_session_timestamp (session_id, timestamp_start)
      )
    `);

    // Defensive column backfill for pre-existing databases (createTables only runs CREATE TABLE IF NOT EXISTS,
    // so a database created before Paper2 changes needs these columns added explicitly).
    await renameColumnIfNeeded('sessions', 'user_id', 'participant_id', 'VARCHAR(255) NOT NULL');
    await ensureColumn('sessions', 'group_id', "VARCHAR(50) NULL");
    // Add without a default first so pre-existing rows can retain created_at rather than
    // receiving the migration timestamp. Set the default only after the backfill below.
    await ensureColumn('sessions', 'started_at', "TIMESTAMP NULL");
    await ensureColumn('sessions', 'ended_at', "TIMESTAMP NULL");
    await ensureColumn('sessions', 'metadata', "JSON NULL");
    // Preserve the original start time for sessions created before started_at existed.
    await db.execute('UPDATE sessions SET started_at = created_at WHERE started_at IS NULL');
    // Earlier development builds added started_at with CURRENT_TIMESTAMP, which assigned the
    // migration time to older rows. Sessions without client metadata can safely use created_at.
    await db.execute('UPDATE sessions SET started_at = created_at WHERE metadata IS NULL');
    await db.execute('ALTER TABLE sessions MODIFY COLUMN started_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP');
    await ensureColumn('messages', 'is_guidance', "BOOLEAN DEFAULT FALSE");
    await ensureColumn('messages', 'guidance_direction', "TEXT NULL");
    await ensureColumn('messages', 'guidance_previous_ideas', "JSON NULL");
    await ensureColumn('messages', 'guidance_display_summary', "TEXT NULL");
    await ensureColumn('messages', 'guidance_display_at', "TIMESTAMP NULL");
    await ensureColumn('submissions', 'evaluation_audit_json_file_url', "VARCHAR(255) NULL");
    await ensureColumn('submissions', 'evaluation_audit_markdown_file_url', "VARCHAR(255) NULL");
    await ensureColumn('submissions', 'proposal_file_url', "VARCHAR(255) NULL");
    await ensureColumn('manipulation_state', 'last_evaluated_event_id', "INT NOT NULL DEFAULT 0");
    await ensureColumn('manipulation_state', 'streak_suppression_remaining', "INT NOT NULL DEFAULT 0");
    await ensureColumn('manipulation_state', 'last_guidance_notification_at', "TIMESTAMP NULL");
    await ensureColumn('evaluation_agent_audit', 'guidance_generation_payload', "MEDIUMTEXT NULL");
    await ensureDecisionAgentEnum();
    await ensureGuidanceEnums();

    console.log('Database tables created successfully');
  } catch (error) {
    console.error('Error creating tables:', error);
    throw error;
  }
}

// Make database connection available to routes
app.use((req, res, next) => {
  (req as any).db = db;
  (req as any).io = io;
  next();
});

// Routes
app.use('/api/transcript', transcriptRoutes);
app.use('/api/chat', chatRoutes);
app.use('/api/logging', loggingRoutes);
app.use('/api/session', sessionRoutes);
app.use('/api/submissions', submissionRoutes);
app.use('/api/writing', writingRoutes);

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.json({ status: 'OK', timestamp: new Date().toISOString() });
});

// Socket.IO connection handling
io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);

  // Join session room for real-time updates
  socket.on('join-session', (sessionId: string) => {
    socket.join(sessionId);
    console.log(`Client ${socket.id} joined session: ${sessionId}`);
  });

  // Handle real-time transcript updates
  socket.on('transcript-update', (data) => {
    // Broadcast to all clients in the same session
    socket.to(data.sessionId).emit('transcript-updated', data);
  });

  // Handle realtime transcription events
  socket.on('realtime-transcript', (data) => {
    // Broadcast real-time transcription to session
    socket.to(data.sessionId).emit('realtime-transcript-update', data);
  });

  socket.on('disconnect', () => {
    console.log('Client disconnected:', socket.id);
  });
});

// Global error handler
app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
  console.error('Error:', err);
  res.status(500).json({
    error: 'Internal Server Error',
    message: process.env.NODE_ENV === 'development' ? err.message : 'Something went wrong'
  });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: 'Route not found' });
});

// Start server
async function startServer() {
  await initDatabase();

  server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    console.log(`Frontend URL: ${process.env.FRONTEND_URL || "http://localhost:3000"}`);
  });
}

startServer().catch(console.error);
