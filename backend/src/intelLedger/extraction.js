// backend/src/intelLedger/extraction.js
// Signal extraction from raw interactions

const EXTRACTION_PROMPT_V1 = `
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
`;

class ExtractionService {
  constructor(mirabilis) {
    // mirabilis = Express app with model service injected
    this.mirabilis = mirabilis;
  }

  async extractSignals(interaction, model = 'mcq-pro-12b:latest') {
    try {
      const prompt = `${EXTRACTION_PROMPT_V1}\n\nINTERACTION:\n${interaction}`;

      // Call Mirabilis' existing model inference pipeline
      const response = await this.mirabilis.modelService.generate({
        model,
        prompt,
        stream: false,
        temperature: 0.3 // Low temp for consistency
      });

      // Parse response
      const jsonMatch = response.match(/\{[\s\S]*\}/);
      if (!jsonMatch) throw new Error('No JSON in response');

      const parsed = JSON.parse(jsonMatch[0]);
      return parsed.signals || [];
    } catch (err) {
      console.error('Extraction failed:', err);
      return [];
    }
  }

  async batchExtract(interactions, storage) {
    // Extract signals from multiple interactions
    const results = [];

    for (const interaction of interactions) {
      if (interaction.extracted) continue;

      const signals = await this.extractSignals(interaction.raw_content);
      const stored = await storage.storeSignals(
        interaction.session_id,
        interaction.id,
        signals
      );

      // Mark interaction as extracted
      await storage.pool.query(
        `UPDATE intelledger_interactions SET extracted = TRUE, extraction_version = 'v1' WHERE id = $1`,
        [interaction.id]
      );

      results.push({ interaction: interaction.id, signals: stored });
    }

    return results;
  }
}

module.exports = { ExtractionService, EXTRACTION_PROMPT_V1 };
