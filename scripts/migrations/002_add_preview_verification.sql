-- Migration: Add project type and preview verification support
-- Date: 2026-01-04

-- Add project_type column to track what kind of preview service to use
ALTER TABLE projects ADD COLUMN IF NOT EXISTS project_type VARCHAR(50) DEFAULT 'unknown';

-- Common project types:
-- 'react-native-web' - Expo/React Native Web projects
-- 'vite' - Vite-based projects (React, Vue, Vanilla)
-- 'nextjs' - Next.js projects
-- 'create-react-app' - CRA projects
-- 'vue' - Vue CLI projects
-- 'static' - Static HTML/CSS/JS
-- 'unknown' - Auto-detect

-- Add preview verification tracking
ALTER TABLE projects ADD COLUMN IF NOT EXISTS preview_status VARCHAR(50) DEFAULT 'pending';
-- Status values: 'pending', 'building', 'healthy', 'error', 'unreachable'

ALTER TABLE projects ADD COLUMN IF NOT EXISTS preview_last_error TEXT;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS preview_last_checked_at TIMESTAMP;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS preview_error_count INTEGER DEFAULT 0;

-- Add auto-fix attempt tracking
ALTER TABLE projects ADD COLUMN IF NOT EXISTS auto_fix_attempts INTEGER DEFAULT 0;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS last_auto_fix_at TIMESTAMP;

-- Create preview_health_checks table for history
CREATE TABLE IF NOT EXISTS preview_health_checks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id VARCHAR(255) REFERENCES projects(id) ON DELETE CASCADE,
  check_type VARCHAR(50) NOT NULL,  -- 'http', 'build', 'startup'
  status VARCHAR(50) NOT NULL,       -- 'success', 'error', 'timeout'
  error_type VARCHAR(100),           -- 'vite_allowed_hosts', 'module_not_found', 'syntax_error', etc.
  error_message TEXT,
  response_code INTEGER,
  response_time_ms INTEGER,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Create indexes
CREATE INDEX IF NOT EXISTS idx_projects_project_type ON projects(project_type);
CREATE INDEX IF NOT EXISTS idx_projects_preview_status ON projects(preview_status);
CREATE INDEX IF NOT EXISTS idx_preview_health_checks_project_id ON preview_health_checks(project_id);
CREATE INDEX IF NOT EXISTS idx_preview_health_checks_created_at ON preview_health_checks(created_at);

-- Comments
COMMENT ON COLUMN projects.project_type IS 'Type of project for preview service selection: react-native-web, vite, nextjs, etc.';
COMMENT ON COLUMN projects.preview_status IS 'Current preview health status: pending, building, healthy, error, unreachable';
COMMENT ON COLUMN projects.preview_last_error IS 'Last error message from preview health check';
COMMENT ON COLUMN projects.auto_fix_attempts IS 'Number of times Claude has been asked to fix preview errors';
