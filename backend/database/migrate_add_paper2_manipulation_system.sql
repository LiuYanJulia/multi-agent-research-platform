-- Paper 2: Multi-Agent Manipulation System
-- Adds group_id/is_guidance columns and 5 new tables.
-- Note: the running server (backend/src/index.ts createTables()) applies these
-- automatically on startup (CREATE TABLE IF NOT EXISTS + defensive ALTER TABLE
-- for the two new columns), so running this file by hand is optional / for
-- reference on databases that are not booted via the app.

USE research_platform;

ALTER TABLE sessions
  ADD COLUMN IF NOT EXISTS group_id VARCHAR(50) NULL
  COMMENT 'Paper2 manipulation condition: HighTF_HighTM / HighTF_LowTM / LowTF_HighTM / LowTF_LowTM / control';

-- Compatibility fields used by the online event timeline and session lifecycle.
-- Existing sessions retain their original created_at as their start time.
ALTER TABLE sessions
  ADD COLUMN IF NOT EXISTS started_at TIMESTAMP NULL,
  ADD COLUMN IF NOT EXISTS ended_at TIMESTAMP NULL,
  ADD COLUMN IF NOT EXISTS metadata JSON NULL;

UPDATE sessions
SET started_at = created_at
WHERE started_at IS NULL;

-- New sessions still receive the creation time automatically after historical rows are backfilled.
ALTER TABLE sessions
  MODIFY COLUMN started_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP;

ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS is_guidance BOOLEAN DEFAULT FALSE
  COMMENT 'True if this is a Manipulation Controller guidance message (Paper2)';

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
);

CREATE TABLE IF NOT EXISTS manipulation_state (
  session_id VARCHAR(36) PRIMARY KEY,
  tf_level ENUM('high', 'low') NULL,
  tm_level ENUM('high', 'low') NULL,
  is_control BOOLEAN DEFAULT FALSE,
  phase ENUM('collect', 'synthesize', 'na') DEFAULT 'na',
  phase_advanced_at TIMESTAMP NULL,
  streak_orientation ENUM('D', 'C') NULL,
  streak_count INT DEFAULT 0,
  turn_count INT DEFAULT 0,
  last_evaluated_event_id INT NOT NULL DEFAULT 0,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
);

ALTER TABLE manipulation_state
  ADD COLUMN IF NOT EXISTS last_evaluated_event_id INT NOT NULL DEFAULT 0;

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
);

ALTER TABLE agent_execution_log
  MODIFY COLUMN agent_name ENUM('evaluation_agent', 'decision_agent', 'manipulation_controller', 'main_response_agent') NOT NULL;

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
);

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
);

SHOW TABLES;
