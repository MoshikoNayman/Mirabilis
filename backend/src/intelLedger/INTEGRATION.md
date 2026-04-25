// InteLedger Integration Guide for backend/src/server.js

/*
INTEGRATION STEPS:

1. Install dependencies:
   npm install pg node-cron multer

2. Add to server.js initialization:
*/

// At top with other imports
const IntelLedgerStorage = require('./storage/intelLedger');
const { ExtractionService } = require('./intelLedger/extraction');
const IntelLedgerScheduler = require('./intelLedger/scheduler');
const createIntelLedgerRoutes = require('./routes/intelLedger');

// In app initialization, after modelService setup:
const dbConfig = {
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres',
  host: process.env.DB_HOST || 'localhost',
  port: process.env.DB_PORT || 5432,
  database: process.env.DB_NAME || 'mirabilis_intelledger'
};

const intelLedgerStorage = new IntelLedgerStorage(dbConfig);
const extractionService = new ExtractionService({ modelService });
const intelLedgerScheduler = new IntelLedgerScheduler(
  intelLedgerStorage,
  extractionService,
  modelService
);

// Mount routes
app.use('/api/intelledger', createIntelLedgerRoutes(intelLedgerStorage, extractionService));

// Start scheduler
intelLedgerScheduler.start();

// Health check
app.get('/health/intelledger', async (req, res) => {
  try {
    const result = await intelLedgerStorage.pool.query('SELECT NOW()');
    res.json({ status: 'ok', timestamp: result.rows[0].now });
  } catch (err) {
    res.status(500).json({ status: 'error', error: err.message });
  }
});

// Graceful shutdown
process.on('SIGTERM', async () => {
  await intelLedgerStorage.close();
  process.exit(0);
});

/*
ENVIRONMENT VARIABLES (.env):
DB_USER=postgres
DB_PASSWORD=your_password
DB_HOST=localhost
DB_PORT=5432
DB_NAME=mirabilis_intelledger

DATABASE SETUP:
1. Create database: createdb mirabilis_intelledger
2. Run schema: psql mirabilis_intelledger < backend/src/intelLedger/schema.sql

API ENDPOINTS:

POST /api/intelledger/sessions
  Body: { userId, title, description }
  Returns: { session: {...} }

GET /api/intelledger/sessions?userId=user123
  Returns: { sessions: [...] }

GET /api/intelledger/sessions/:sessionId
  Returns: { session: {...} }

POST /api/intelledger/sessions/:sessionId/ingest/text
  Body: { content, sourceName }
  Auto-extracts signals, returns: { interaction, signals }

POST /api/intelledger/sessions/:sessionId/ingest/file
  Multipart: file + sessionId
  Auto-extracts signals from file, returns: { interaction, signals }

GET /api/intelledger/sessions/:sessionId/interactions
  Returns: { interactions: [...] }

GET /api/intelledger/sessions/:sessionId/signals?type=pain_point
  Returns: { signals: [...] }

POST /api/intelledger/sessions/:sessionId/synthesize
  Body: { query, synthesisType }
  Returns: { synthesis: {...} }

GET /api/intelledger/sessions/:sessionId/synthesis?type=pattern
  Returns: { syntheses: [...] }

POST /api/intelledger/sessions/:sessionId/extract-pending
  Batch-extracts all unprocessed interactions
  Returns: { processed, results }

*/
