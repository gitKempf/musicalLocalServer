-- Initialize Local PostgreSQL Database for Musical.run Local Server

-- Create databases
CREATE DATABASE IF NOT EXISTS musical_local;
CREATE DATABASE IF NOT EXISTS gitea_local;

-- Create Gitea user and database
CREATE USER gitea WITH PASSWORD 'gitea_pass';
GRANT ALL PRIVILEGES ON DATABASE gitea_local TO gitea;

-- Connect to musical_local database
\c musical_local;

-- Projects table
CREATE TABLE IF NOT EXISTS projects (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(255) NOT NULL,
  description TEXT,
  template VARCHAR(50) DEFAULT 'react-native',
  status VARCHAR(50) DEFAULT 'active',
  gitea_repo VARCHAR(255),
  preview_url VARCHAR(500),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Sessions table (Claude Code sessions)
CREATE TABLE IF NOT EXISTS sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID REFERENCES projects(id) ON DELETE CASCADE,
  session_path TEXT NOT NULL,
  status VARCHAR(50) DEFAULT 'active',
  turn_count INTEGER DEFAULT 0,
  last_activity_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Messages table (encrypted chat history - for local reference only)
CREATE TABLE IF NOT EXISTS messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID REFERENCES sessions(id) ON DELETE CASCADE,
  role VARCHAR(20) NOT NULL,  -- 'user' or 'assistant'
  content TEXT NOT NULL,       -- Encrypted content
  metadata JSONB,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Preview deployments table
CREATE TABLE IF NOT EXISTS previews (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID REFERENCES projects(id) ON DELETE CASCADE,
  container_id VARCHAR(255),
  url TEXT,
  status VARCHAR(50) DEFAULT 'building',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Create indexes
CREATE INDEX idx_projects_status ON projects(status);
CREATE INDEX idx_sessions_project_id ON sessions(project_id);
CREATE INDEX idx_sessions_status ON sessions(status);
CREATE INDEX idx_messages_session_id ON messages(session_id);
CREATE INDEX idx_previews_project_id ON previews(project_id);

-- Grant permissions
GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO musical;
GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO musical;
