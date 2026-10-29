-- Direct AI guidance delivery: structured card fields and bounded writing snapshots.
ALTER TABLE messages
  MODIFY COLUMN role ENUM('user', 'assistant', 'ai_guidance') NOT NULL,
  ADD COLUMN IF NOT EXISTS guidance_direction TEXT NULL,
  ADD COLUMN IF NOT EXISTS guidance_previous_ideas JSON NULL,
  ADD COLUMN IF NOT EXISTS guidance_display_summary TEXT NULL,
  ADD COLUMN IF NOT EXISTS guidance_display_at TIMESTAMP NULL;

ALTER TABLE interaction_logs
  MODIFY COLUMN event_type ENUM('mouse', 'keyboard', 'ui', 'api', 'session', 'selection', 'ai_guidance') NOT NULL;

CREATE TABLE IF NOT EXISTS writing_snapshots (
  id INT AUTO_INCREMENT PRIMARY KEY,
  session_id VARCHAR(36) NOT NULL,
  content TEXT NOT NULL,
  captured_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  received_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE,
  INDEX idx_writing_snapshots_session_time (session_id, captured_at)
);
