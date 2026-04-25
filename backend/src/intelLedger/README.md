# InteLedger: Interaction Archive + Retrospective Intelligence System

## Overview

**InteLedger** is a structured interaction archive with AI-powered retrospective synthesis. It ingests notes, files, and interactions, extracts structured signals, and enables time-series analysis—perfect for SEs tracking account history, engagement patterns, and emerging strategies.

**Core concept:** Store everything, extract meaning, enable re-discovery.

### Use Cases
- **SE Account Intelligence:** Archive calls, emails, notes → surface pain points, timeline pressure, stakeholder shifts
- **Retrospective Analysis:** "What changed between Q1 and Q2?" → query by signal type + temporal windows
- **Gap Detection:** System flags missing stakeholder context, unaddressed risks, unowned opportunities
- **Synthesis & Opinion:** Weekly AI analysis of emerging patterns + recommended next actions

---

## Architecture

### Data Layer
- **PostgreSQL** for structured storage (signals, interactions, synthesis)
- **Vector index** (future: Pinecone/Weaviate) for semantic search
- **Job queue** for async processing

### Processing Layer
- **Extraction Service:** Uses Mirabilis models (MCQ) to extract 6 signal types from raw text
- **Synthesis Service:** Periodic (weekly) jobs that analyze accumulated signals, detect patterns
- **Scheduler:** Cron-based job runner (runs weekly deltas Monday 9 AM)

### API Layer
- RESTful endpoints for ingestion, retrieval, synthesis
- Batch operations for bulk extraction
- Multipart file upload support

### Frontend
- React component for session management, interaction browsing, signal visualization

---

## Data Model

### Sessions
Container for a series of interactions (e.g., "Account ABC Q1-Q2 History", "Project X Stakeholder Interviews").

```sql
CREATE TABLE intelledger_sessions (
  id UUID PRIMARY KEY,
  user_id VARCHAR(255),
  title VARCHAR(512),
  description TEXT,
  created_at TIMESTAMP,
  archived BOOLEAN
);
```

### Interactions
Raw ingested content: text snippets, files, email exports, etc.

```sql
CREATE TABLE intelledger_interactions (
  id UUID PRIMARY KEY,
  session_id UUID,
  type VARCHAR(50), -- 'text', 'file', 'email_snippet'
  raw_content TEXT,
  source_name VARCHAR(255),
  ingested_at TIMESTAMP,
  extracted BOOLEAN
);
```

### Signals
Structured extracts: pain points, commitments, risks, timelines, stakeholders, opportunities.

```sql
CREATE TABLE intelledger_signals (
  id UUID PRIMARY KEY,
  session_id UUID,
  interaction_id UUID,
  signal_type VARCHAR(50), -- One of 6 types
  value TEXT, -- Actionable summary
  quote TEXT, -- Exact extract
  confidence DECIMAL(3,2), -- 0.0-1.0
  extracted_at TIMESTAMP
);
```

### Synthesis
AI-generated analysis, opinions, gap detection.

```sql
CREATE TABLE intelledger_synthesis (
  id UUID PRIMARY KEY,
  session_id UUID,
  synthesis_type VARCHAR(50), -- 'pattern', 'gap', 'opinion', 'weekly_delta'
  content TEXT,
  model_used VARCHAR(100),
  citations JSON,
  generated_at TIMESTAMP
);
```

---

## Signal Types

Six structured signal categories extracted from interactions:

1. **pain_point** — Problems, frustrations, unmet needs
   - Example: "We're struggling with API latency in peak hours"

2. **commitment** — Explicit/implicit promises, deadlines, next steps
   - Example: "We'll evaluate by end of Q2"

3. **risk** — Threats, concerns, potential blockers
   - Example: "Migration could disrupt production"

4. **timeline** — Date references, urgency indicators, temporal constraints
   - Example: "Board decision required by June"

5. **stakeholder** — Decision makers, influencers, key contacts
   - Example: "VP Eng (Jane Smith) is skeptical"

6. **opportunity** — Expansion potential, cross-sell indicators, growth signals
   - Example: "They're planning a 3x headcount increase next year"

Each signal includes:
- **value**: Concise, actionable summary
- **quote**: Exact text from source (for citation)
- **confidence**: 0.0-1.0 (higher = model more certain)

---

## API Endpoints

### Session Management

**Create session**
```
POST /api/intelledger/sessions
Body: { userId, title, description }
Response: { session: {...} }
```

**List sessions**
```
GET /api/intelledger/sessions?userId=user123
Response: { sessions: [...] }
```

**Get session**
```
GET /api/intelledger/sessions/:sessionId
Response: { session: {...} }
```

### Ingestion

**Ingest text**
```
POST /api/intelledger/sessions/:sessionId/ingest/text
Body: { content, sourceName }
Response: { interaction, signals: [...] }
```
Auto-extracts signals immediately.

**Ingest file**
```
POST /api/intelledger/sessions/:sessionId/ingest/file
Multipart: file + sessionId
Response: { interaction, signals: [...] }
```
Supports .txt, .md, .pdf (text), .csv.

### Retrieval

**Get interactions**
```
GET /api/intelledger/sessions/:sessionId/interactions
Response: { interactions: [...] }
```

**Get signals**
```
GET /api/intelledger/sessions/:sessionId/signals?type=pain_point
Response: { signals: [...] }
```
Optional `type` filter (pain_point, commitment, risk, timeline, stakeholder, opportunity).

### Synthesis

**Generate synthesis**
```
POST /api/intelledger/sessions/:sessionId/synthesize
Body: { query, synthesisType }
Response: { synthesis: {...} }
```

**Get synthesis history**
```
GET /api/intelledger/sessions/:sessionId/synthesis?type=pattern
Response: { syntheses: [...] }
```

### Batch Operations

**Extract pending**
```
POST /api/intelledger/sessions/:sessionId/extract-pending
Response: { processed, results }
```
Re-extracts all interactions not yet processed.

---

## Extraction Prompt (v1)

```
You are an expert analyst extracting structured insights from customer interactions.

Extract the following signal types from the provided interaction:
- pain_points: Problems, frustrations, or unmet needs mentioned
- commitments: Explicit or implicit promises, deadlines, or next steps
- risks: Threats, concerns, or potential blockers
- timeline: Date references, urgency indicators, or temporal constraints
- stakeholders: Decision makers, influencers, or key contacts mentioned
- opportunities: Expansion potential, cross-sell indicators, or growth signals

For EACH signal extracted:
1. Provide the signal value (concise summary)
2. Extract exact quote from source
3. Rate confidence (0.0-1.0)

Respond with valid JSON only:
{
  "signals": [
    {
      "type": "pain_point|commitment|risk|timeline|stakeholder|opportunity",
      "value": "clear, actionable statement",
      "quote": "exact text from source",
      "confidence": 0.85
    }
  ],
  "summary": "one-line observation about interaction tone/intent"
}
```

---

## Weekly Intelligence Job

Runs automatically every Monday 9 AM.

**Process:**
1. Query all signals extracted in past 7 days
2. Group by type + signal confidence
3. Detect escalations (new risks, urgent timelines)
4. Generate strategy summary via MCQ-Pro-12B
5. Store synthesis with citations

**Output:** Weekly delta synthesis with:
- Emerging patterns
- Escalations/priority shifts
- Recommended next actions

---

## Integration into Mirabilis

### Backend (`backend/src/server.js`)

```javascript
const IntelLedgerStorage = require('./storage/intelLedger');
const { ExtractionService } = require('./intelLedger/extraction');
const IntelLedgerScheduler = require('./intelLedger/scheduler');
const createIntelLedgerRoutes = require('./routes/intelLedger');

// Initialize
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
```

### Frontend (`frontend/src/components/`)

```jsx
import IntelLedgerSession from '@/components/IntelLedgerSession';

export default function AccountPage() {
  return <IntelLedgerSession sessionId="xyz" userId="user123" />;
}
```

### Environment Variables

```
DB_USER=postgres
DB_PASSWORD=your_password
DB_HOST=localhost
DB_PORT=5432
DB_NAME=mirabilis_intelledger
```

### Database Setup

```bash
createdb mirabilis_intelledger
psql mirabilis_intelledger < backend/src/intelLedger/schema.sql
```

---

## File Structure

```
backend/
├── src/
│   ├── intelLedger/
│   │   ├── schema.sql               # Database schema
│   │   ├── extraction.js            # Signal extraction (uses MCQ models)
│   │   ├── scheduler.js             # Weekly jobs + cron
│   │   └── INTEGRATION.md           # Integration guide
│   ├── storage/
│   │   └── intelLedger.js           # PostgreSQL persistence layer
│   └── routes/
│       └── intelLedger.js           # Express API endpoints
└── ...

frontend/
├── src/
│   └── components/
│       └── IntelLedgerSession.jsx   # Session UI component
└── ...
```

---

## Dependencies

**Backend:**
- `pg` (PostgreSQL driver)
- `node-cron` (Job scheduler)
- `multer` (File upload)
- `uuid` (ID generation)

**Frontend:**
- React 18+
- React hooks (useState, useEffect)

**Optional (future):**
- `pinecone-client` (Vector embeddings)
- `weaviate-client` (Alternative vector store)
- `pdf-parse` (PDF ingestion)
- `mailparser` (Email parsing)

---

## Usage Example

### Create a session
```bash
curl -X POST http://localhost:3001/api/intelledger/sessions \
  -H "Content-Type: application/json" \
  -d '{"userId":"user123", "title":"Account ABC Q2 Review", "description":"Quarterly engagement notes"}'
```

### Ingest text
```bash
curl -X POST http://localhost:3001/api/intelledger/sessions/:sessionId/ingest/text \
  -H "Content-Type: application/json" \
  -d '{"content":"Jane mentioned they need 3x throughput by Q3. Timeline is tight.", "sourceName":"call_2026-04-25"}'
```

### Query signals by type
```bash
curl http://localhost:3001/api/intelledger/sessions/:sessionId/signals?type=timeline
```

### Generate synthesis
```bash
curl -X POST http://localhost:3001/api/intelledger/sessions/:sessionId/synthesize \
  -H "Content-Type: application/json" \
  -d '{"query":"overall account momentum", "synthesisType":"pattern"}'
```

---

## Design Constraints (v1)

- **No deduplication** between signals (same insight extracted twice = two signals)
- **No conflict resolution** (contradictory signals coexist)
- **Linear extraction** (no multi-step reasoning)
- **Single-session scope** (cross-session synthesis in v2)
- **Weekly cadence** (not real-time synthesis)
- **Stateless extraction** (no memory of prior extractions)

These are v1 scope boundaries; v2 can expand to multi-session analysis, dedup, and entity linking.

---

## Future Enhancements

- **Identity Graph:** Link signals across sessions → unified account view
- **Evidence Model:** Track signal provenance, add explicit supporting data
- **Semantic Dedup:** Detect duplicate signals, merge confidence
- **Temporal Queries:** "Show all timeline pressure from Jan-Mar"
- **Cross-Session Synthesis:** "Compare this account to cohort patterns"
- **Writeback:** Generate next-action tasks in external systems
- **Live Capture:** Real-time Teams/Slack message ingestion
- **CRM Integration:** Automatically populate Salesforce/HubSpot fields

---

## Support

For questions, check [INTEGRATION.md](./INTEGRATION.md) or review [extraction.js](./extraction.js) for prompt customization.
