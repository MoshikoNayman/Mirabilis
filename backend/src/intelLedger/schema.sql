-- InteLedger v1 Schema
-- Interaction archive + retrospective synthesis

CREATE TABLE IF NOT EXISTS intelledger_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id VARCHAR(255) NOT NULL,
  title VARCHAR(512) NOT NULL,
  description TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  archived BOOLEAN DEFAULT FALSE,
  INDEX idx_user_id (user_id),
  INDEX idx_created_at (created_at)
);

CREATE TABLE IF NOT EXISTS intelledger_interactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID NOT NULL REFERENCES intelledger_sessions(id) ON DELETE CASCADE,
  type VARCHAR(50) NOT NULL, -- 'text', 'file', 'note', 'email_snippet'
  raw_content TEXT NOT NULL,
  source_name VARCHAR(255), -- filename or email subject
  ingested_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  extracted BOOLEAN DEFAULT FALSE,
  extraction_version VARCHAR(20),
  INDEX idx_session_id (session_id),
  INDEX idx_type (type),
  INDEX idx_extracted (extracted)
);

CREATE TABLE IF NOT EXISTS intelledger_signals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  interaction_id UUID NOT NULL REFERENCES intelledger_interactions(id) ON DELETE CASCADE,
  session_id UUID NOT NULL REFERENCES intelledger_sessions(id) ON DELETE CASCADE,
  signal_type VARCHAR(50) NOT NULL, -- 'pain_point', 'commitment', 'risk', 'timeline', 'stakeholder', 'opportunity'
  value TEXT NOT NULL,
  quote TEXT, -- exact extract from source
  confidence DECIMAL(3,2), -- 0.0-1.0
  source_id VARCHAR(255), -- reference back to interaction/file
  extracted_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_session_id (session_id),
  INDEX idx_signal_type (signal_type),
  INDEX idx_confidence (confidence)
);

CREATE TABLE IF NOT EXISTS intelledger_synthesis (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID NOT NULL REFERENCES intelledger_sessions(id) ON DELETE CASCADE,
  synthesis_type VARCHAR(50) NOT NULL, -- 'pattern', 'gap', 'strategy', 'opinion', 'delta'
  content TEXT NOT NULL,
  model_used VARCHAR(100),
  tokens_used INT,
  citations JSON, -- array of {signal_id, quote, source}
  generated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_session_id (session_id),
  INDEX idx_synthesis_type (synthesis_type)
);

CREATE TABLE IF NOT EXISTS intelledger_vector_index (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID NOT NULL REFERENCES intelledger_sessions(id) ON DELETE CASCADE,
  interaction_id UUID REFERENCES intelledger_interactions(id) ON DELETE CASCADE,
  signal_id UUID REFERENCES intelledger_signals(id) ON DELETE CASCADE,
  text_chunk TEXT NOT NULL,
  embedding VECTOR(1536), -- OpenAI/compatible embedding
  embedding_model VARCHAR(100),
  indexed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_session_id (session_id)
);

CREATE TABLE IF NOT EXISTS intelledger_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID NOT NULL REFERENCES intelledger_sessions(id) ON DELETE CASCADE,
  job_type VARCHAR(50) NOT NULL, -- 'weekly_delta', 'full_synthesis', 'gap_detection'
  status VARCHAR(20) DEFAULT 'pending', -- 'pending', 'running', 'completed', 'failed'
  started_at TIMESTAMP,
  completed_at TIMESTAMP,
  error_message TEXT,
  result JSON,
  INDEX idx_session_id (session_id),
  INDEX idx_status (status)
);
