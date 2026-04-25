// backend/src/storage/intelLedger.js
// InteLedger persistence layer

const { Pool } = require('pg');
const { v4: uuidv4 } = require('uuid');

class IntelLedgerStorage {
  constructor(dbConfig) {
    this.pool = new Pool(dbConfig);
  }

  // Session CRUD
  async createSession(userId, title, description) {
    const query = `
      INSERT INTO intelledger_sessions (user_id, title, description)
      VALUES ($1, $2, $3)
      RETURNING *;
    `;
    const result = await this.pool.query(query, [userId, title, description]);
    return result.rows[0];
  }

  async getSession(sessionId) {
    const query = `SELECT * FROM intelledger_sessions WHERE id = $1;`;
    const result = await this.pool.query(query, [sessionId]);
    return result.rows[0];
  }

  async listSessions(userId) {
    const query = `
      SELECT * FROM intelledger_sessions
      WHERE user_id = $1 AND archived = FALSE
      ORDER BY updated_at DESC;
    `;
    const result = await this.pool.query(query, [userId]);
    return result.rows;
  }

  // Interaction ingestion
  async ingestInteraction(sessionId, type, rawContent, sourceName) {
    const query = `
      INSERT INTO intelledger_interactions (session_id, type, raw_content, source_name)
      VALUES ($1, $2, $3, $4)
      RETURNING *;
    `;
    const result = await this.pool.query(query, [sessionId, type, rawContent, sourceName]);
    return result.rows[0];
  }

  async getInteractions(sessionId) {
    const query = `
      SELECT * FROM intelledger_interactions
      WHERE session_id = $1
      ORDER BY ingested_at DESC;
    `;
    const result = await this.pool.query(query, [sessionId]);
    return result.rows;
  }

  // Signal storage
  async storeSignals(sessionId, interactionId, signals) {
    const queries = signals.map(sig => ({
      text: `
        INSERT INTO intelledger_signals
        (session_id, interaction_id, signal_type, value, quote, confidence, source_id, extraction_version)
        VALUES ($1, $2, $3, $4, $5, $6, $7, 'v1')
        RETURNING *;
      `,
      values: [
        sessionId,
        interactionId,
        sig.type,
        sig.value,
        sig.quote || null,
        sig.confidence || 0.9,
        sig.sourceId || interactionId
      ]
    }));

    const results = [];
    for (const q of queries) {
      const result = await this.pool.query(q.text, q.values);
      results.push(result.rows[0]);
    }
    return results;
  }

  async getSignalsBySession(sessionId, signalType = null) {
    let query = `SELECT * FROM intelledger_signals WHERE session_id = $1`;
    const params = [sessionId];

    if (signalType) {
      query += ` AND signal_type = $2`;
      params.push(signalType);
    }

    query += ` ORDER BY extracted_at DESC;`;
    const result = await this.pool.query(query, params);
    return result.rows;
  }

  // Synthesis storage
  async storeSynthesis(sessionId, synthesisType, content, modelUsed, tokensUsed, citations) {
    const query = `
      INSERT INTO intelledger_synthesis
      (session_id, synthesis_type, content, model_used, tokens_used, citations)
      VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING *;
    `;
    const result = await this.pool.query(query, [
      sessionId,
      synthesisType,
      content,
      modelUsed,
      tokensUsed,
      JSON.stringify(citations)
    ]);
    return result.rows[0];
  }

  async getSynthesisBySession(sessionId, synthesisType = null) {
    let query = `SELECT * FROM intelledger_synthesis WHERE session_id = $1`;
    const params = [sessionId];

    if (synthesisType) {
      query += ` AND synthesis_type = $2`;
      params.push(synthesisType);
    }

    query += ` ORDER BY generated_at DESC;`;
    const result = await this.pool.query(query, params);
    return result.rows;
  }

  // Vector index (for hybrid search)
  async indexChunk(sessionId, interactionId, signalId, textChunk, embedding, model) {
    const query = `
      INSERT INTO intelledger_vector_index
      (session_id, interaction_id, signal_id, text_chunk, embedding, embedding_model)
      VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING *;
    `;
    const result = await this.pool.query(query, [
      sessionId,
      interactionId,
      signalId,
      textChunk,
      embedding,
      model
    ]);
    return result.rows[0];
  }

  async vectorSearch(sessionId, embedding, limit = 10) {
    const query = `
      SELECT id, text_chunk, embedding <-> $2 AS distance
      FROM intelledger_vector_index
      WHERE session_id = $1
      ORDER BY distance ASC
      LIMIT $3;
    `;
    const result = await this.pool.query(query, [sessionId, JSON.stringify(embedding), limit]);
    return result.rows;
  }

  // Job tracking
  async createJob(sessionId, jobType) {
    const query = `
      INSERT INTO intelledger_jobs (session_id, job_type, status)
      VALUES ($1, $2, 'pending')
      RETURNING *;
    `;
    const result = await this.pool.query(query, [sessionId, jobType]);
    return result.rows[0];
  }

  async updateJobStatus(jobId, status, result = null, error = null) {
    const query = `
      UPDATE intelledger_jobs
      SET status = $2, completed_at = CURRENT_TIMESTAMP, result = $3, error_message = $4
      WHERE id = $1
      RETURNING *;
    `;
    const jobResult = await this.pool.query(query, [
      jobId,
      status,
      result ? JSON.stringify(result) : null,
      error
    ]);
    return jobResult.rows[0];
  }

  async getPendingJobs() {
    const query = `
      SELECT * FROM intelledger_jobs
      WHERE status = 'pending'
      ORDER BY created_at ASC;
    `;
    const result = await this.pool.query(query);
    return result.rows;
  }

  async close() {
    await this.pool.end();
  }
}

module.exports = IntelLedgerStorage;
