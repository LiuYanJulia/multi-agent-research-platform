-- Fix timestamp column in interaction_logs table
-- This migration changes the timestamp column from TIMESTAMP/DATETIME to BIGINT
-- to store relative milliseconds since session start

USE research_platform;

-- First, check the current structure
DESCRIBE interaction_logs;

-- Drop the table and recreate it with the correct structure
-- This is safe if you don't have important data yet
DROP TABLE IF EXISTS interaction_logs;

-- Recreate the interaction_logs table with BIGINT timestamp
CREATE TABLE interaction_logs (
  id INT AUTO_INCREMENT PRIMARY KEY,
  session_id VARCHAR(36) NOT NULL,
  event_type ENUM('mouse', 'keyboard', 'ui', 'api', 'session', 'selection', 'ai_guidance') NOT NULL,
  action VARCHAR(100) NOT NULL,
  target_element VARCHAR(255),
  target_section ENUM('prompting', 'transcript', 'response', 'writing', 'regenerate-menu', 'guidance'),
  coordinates JSON,
  text_content TEXT,
  metadata JSON,
  timestamp BIGINT NOT NULL COMMENT 'Milliseconds relative to session start',
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE,
  INDEX idx_session_timestamp (session_id, timestamp),
  INDEX idx_event_type (event_type),
  INDEX idx_action (action)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Verify the change
DESCRIBE interaction_logs;

-- Show confirmation
SELECT 'Migration completed successfully. The timestamp column is now BIGINT.' AS Status;
