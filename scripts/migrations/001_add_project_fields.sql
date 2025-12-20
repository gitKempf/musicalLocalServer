-- Migration: Add fields for real project management
-- Date: 2025-10-19

-- Add new columns to projects table
ALTER TABLE projects ADD COLUMN IF NOT EXISTS user_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS initial_prompt TEXT;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS gitea_repo_url TEXT;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS gitea_repo_id INTEGER;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS container_id VARCHAR(255);
ALTER TABLE projects ADD COLUMN IF NOT EXISTS ssh_port INTEGER;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS tunnel_url TEXT;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS subdomain VARCHAR(255);
ALTER TABLE projects ADD COLUMN IF NOT EXISTS sandbox_id VARCHAR(255);
ALTER TABLE projects ADD COLUMN IF NOT EXISTS error_message TEXT;

-- Modify id column to be VARCHAR instead of UUID for compatibility
ALTER TABLE projects ALTER COLUMN id TYPE VARCHAR(255);

-- Add new columns to sessions table
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS container_id VARCHAR(255);
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS ssh_port INTEGER;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS pid INTEGER;

-- Modify session id to VARCHAR
ALTER TABLE sessions ALTER COLUMN id TYPE VARCHAR(255);

-- Create preview_builds table
CREATE TABLE IF NOT EXISTS preview_builds (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id VARCHAR(255) REFERENCES projects(id) ON DELETE CASCADE,
  commit_sha VARCHAR(40),
  status VARCHAR(50) DEFAULT 'pending',
  build_log TEXT,
  preview_url TEXT,
  metro_port INTEGER,
  container_id VARCHAR(255),
  started_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  completed_at TIMESTAMP
);

-- Add indexes for better query performance
CREATE INDEX IF NOT EXISTS idx_projects_user_id ON projects(user_id);
CREATE INDEX IF NOT EXISTS idx_projects_container_id ON projects(container_id);
CREATE INDEX IF NOT EXISTS idx_sessions_container_id ON sessions(container_id);
CREATE INDEX IF NOT EXISTS idx_preview_builds_project_id ON preview_builds(project_id);
CREATE INDEX IF NOT EXISTS idx_preview_builds_status ON preview_builds(status);

-- Comments
COMMENT ON COLUMN projects.user_id IS 'User ID from auth service';
COMMENT ON COLUMN projects.initial_prompt IS 'The initial prompt used to create the project';
COMMENT ON COLUMN projects.container_id IS 'Docker container ID for this project';
COMMENT ON COLUMN projects.ssh_port IS 'SSH port for connecting to project container';
COMMENT ON COLUMN projects.tunnel_url IS 'Tunnel URL for accessing the project';
COMMENT ON COLUMN sessions.container_id IS 'Docker container ID where session is running';
COMMENT ON COLUMN sessions.ssh_port IS 'SSH port for terminal connection';
COMMENT ON COLUMN sessions.pid IS 'Process ID of Claude CLI';
