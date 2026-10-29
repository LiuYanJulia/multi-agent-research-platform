-- Migration: Add 'regenerate-menu' to target_section ENUM
-- Date: 2025-01-XX
-- Purpose: Support logging for regenerate menu button interactions

USE research_platform;

-- Keep target_section aligned with the application schema, including AI guidance cards.
ALTER TABLE interaction_logs
MODIFY COLUMN target_section ENUM('prompting', 'transcript', 'response', 'writing', 'regenerate-menu', 'guidance');

-- Verify the change
DESCRIBE interaction_logs;
