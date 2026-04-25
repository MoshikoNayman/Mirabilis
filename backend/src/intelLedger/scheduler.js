// backend/src/intelLedger/scheduler.js
// Periodic InteLedger jobs (weekly synthesis, delta detection)

const cron = require('node-cron');

class IntelLedgerScheduler {
  constructor(storage, extractionService, modelService) {
    this.storage = storage;
    this.extractionService = extractionService;
    this.modelService = modelService;
  }

  start() {
    // Run weekly job every Monday at 9 AM
    cron.schedule('0 9 * * 1', async () => {
      console.log('[InteLedger] Running weekly synthesis job');
      await this.runWeeklyDelta();
    });

    console.log('[InteLedger] Scheduler started');
  }

  async runWeeklyDelta() {
    try {
      // Get all active sessions
      const sessions = await this.storage.pool.query(
        `SELECT DISTINCT session_id FROM intelledger_signals WHERE extracted_at > NOW() - INTERVAL '7 days'`
      );

      for (const row of sessions.rows) {
        const jobId = await this.createJob(row.session_id, 'weekly_delta');
        await this.synthesizeSessionDelta(row.session_id, jobId);
      }
    } catch (err) {
      console.error('[InteLedger] Weekly job failed:', err);
    }
  }

  async synthesizeSessionDelta(sessionId, jobId) {
    try {
      // Get signals from past 7 days
      const newSignals = await this.storage.pool.query(`
        SELECT * FROM intelledger_signals
        WHERE session_id = $1 AND extracted_at > NOW() - INTERVAL '7 days'
        ORDER BY extracted_at DESC
      `, [sessionId]);

      // Categorize by type
      const byType = {};
      newSignals.rows.forEach(sig => {
        byType[sig.signal_type] = (byType[sig.signal_type] || 0) + 1;
      });

      // Generate delta summary
      const prompt = `
Analyze these interaction signals from the past week and provide:
1. Key emerging patterns
2. Escalations or changes in priority
3. Recommended next actions

Signal summary:
${JSON.stringify(byType, null, 2)}

Total signals: ${newSignals.rows.length}

Provide a concise strategic summary (2-3 paragraphs) focused on actionable insights.
      `;

      const synthesis = await this.modelService.generate({
        model: 'mcq-pro-12b:latest',
        prompt,
        stream: false,
        temperature: 0.5
      });

      // Store synthesis
      await this.storage.storeSynthesis(
        sessionId,
        'weekly_delta',
        synthesis,
        'mcq-pro-12b:latest',
        0,
        newSignals.rows.map(s => ({ signal_id: s.id, type: s.signal_type }))
      );

      // Mark job complete
      await this.storage.updateJobStatus(jobId, 'completed', {
        signalsProcessed: newSignals.rows.length,
        summary: byType
      });

      console.log(`[InteLedger] Completed weekly delta for session ${sessionId}`);
    } catch (err) {
      console.error(`[InteLedger] Delta synthesis failed for ${sessionId}:`, err);
      await this.storage.updateJobStatus(jobId, 'failed', null, err.message);
    }
  }

  async createJob(sessionId, jobType) {
    const result = await this.storage.createJob(sessionId, jobType);
    return result.id;
  }
}

module.exports = IntelLedgerScheduler;
