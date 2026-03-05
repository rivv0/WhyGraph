import { getLLMProvider } from '../intelligence/llm-provider.js';
import {
  DECISION_SYSTEM_PROMPT,
  buildDecisionExtractionPrompt
} from '../intelligence/decision-prompt.js';

export class DecisionExtractor {
  constructor(eventStore) {
    this.eventStore = eventStore;
    
  }

  
  get llm() {
    if (!this._llm) this._llm = getLLMProvider();
    return this._llm;
  }

  /**
   * Extract decisions from normalized events
   */
  async extractDecisions(repository, minConfidence = 0.4) {
    console.log(`🤖 Phase 3: Extracting decisions for ${repository}`);
    if (this.llm.isAvailable) {
      console.log(`   Mode: LLM-powered (${this.llm.provider} / ${this.llm.model})`);
    } else {
      console.log(`   Mode: Rule-based fallback`);
    }

    await this.createDecisionsTable();

    const candidates = await this.getCandidateEvents(repository, minConfidence);
    console.log(`Processing ${candidates.length} decision candidates...`);

    let extracted = 0;
    let skipped = 0;

    for (const candidate of candidates) {
      try {
        const decision = await this.extractDecisionFromEvent(candidate);
        if (decision) {
          await this.storeDecision(decision);
          extracted++;
        } else {
          skipped++;
        }
      } catch (error) {
        console.error(`Error processing event ${candidate.id}:`, error.message);
        skipped++;
      }
    }

    console.log(`✅ Extracted ${extracted} decisions, skipped ${skipped}`);
    return { extracted, skipped };
  }

  /**
   * Create decisions table for structured decision storage
   */
  async createDecisionsTable() {
    this.eventStore.db.exec(`
      CREATE TABLE IF NOT EXISTS decisions (
        id TEXT PRIMARY KEY,
        source_event_id TEXT NOT NULL,
        repository TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        
        -- Decision content
        decision_statement TEXT NOT NULL,
        rationale TEXT,
        alternatives_considered TEXT,
        tradeoffs TEXT,
        
        -- Decision metadata
        decision_type TEXT, -- 'technical', 'architectural', 'process', 'tool_choice'
        scope TEXT, -- 'local', 'component', 'system', 'organization'
        reversibility TEXT, -- 'reversible', 'costly', 'irreversible'
        
        -- Decision makers
        primary_decision_maker TEXT,
        involved_parties JSON, -- Array of people involved
        
        -- Confidence and quality
        extraction_confidence REAL NOT NULL,
        decision_confidence TEXT, -- 'high', 'medium', 'low' (from the decision maker)
        
        -- Context
        problem_statement TEXT,
        success_criteria TEXT,
        implementation_notes TEXT,
        
        -- Relationships
        related_pr_number INTEGER,
        related_issue_number INTEGER,
        related_commit_sha TEXT,
        supersedes_decision_id TEXT,
        
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        
        FOREIGN KEY (source_event_id) REFERENCES normalized_events(id)
      );

      CREATE INDEX IF NOT EXISTS idx_decisions_repository ON decisions(repository);
      CREATE INDEX IF NOT EXISTS idx_decisions_timestamp ON decisions(timestamp);
      CREATE INDEX IF NOT EXISTS idx_decisions_type ON decisions(decision_type);
      CREATE INDEX IF NOT EXISTS idx_decisions_confidence ON decisions(extraction_confidence);
      CREATE INDEX IF NOT EXISTS idx_decisions_pr ON decisions(related_pr_number);
    `);
  }

  /**
   * Get candidate events for decision extraction
   */
  async getCandidateEvents(repository, minConfidence) {
    const stmt = this.eventStore.db.prepare(`
      SELECT * FROM normalized_events 
      WHERE repository = ? 
        AND confidence_score >= ?
      ORDER BY confidence_score DESC, timestamp DESC
    `);

    const rows = stmt.all(repository, minConfidence);

    return rows.map(row => ({
      ...row,
      decision_indicators: JSON.parse(row.decision_indicators || '[]')
    }));
  }

  /**
   * Route to LLM or rule-based extraction
   */
  async extractDecisionFromEvent(event) {
    if (this.llm.isAvailable) {
      return this.extractDecisionWithLLM(event);
    }
    return this.extractDecisionRuleBased(event);
  }

  /**
   * LLM-based decision extraction — the primary path.
   */
  async extractDecisionWithLLM(event) {
    const userPrompt = buildDecisionExtractionPrompt(event);

    let parsed;
    try {
      parsed = await this.llm.completeJSON(DECISION_SYSTEM_PROMPT, userPrompt, {
        maxTokens: 512,
        temperature: 0.1
      });
    } catch (err) {
      console.warn(`⚠️  LLM parse failed for event ${event.id}, falling back to rule-based. Error: ${err.message}`);
      return this.extractDecisionRuleBased(event);
    }

    if (!parsed || !parsed.is_decision) {
      return null;
    }

    return {
      id: `decision_llm_${event.id}`,
      source_event_id: event.id,
      repository: event.repository,
      timestamp: event.timestamp,
      primary_decision_maker: event.author_login,
      related_pr_number: event.pull_request_number,
      related_issue_number: event.issue_number,
      related_commit_sha: event.commit_sha,

      decision_statement: parsed.decision_statement || '(no statement)',
      rationale: parsed.rationale || null,
      alternatives_considered: parsed.alternatives_considered || null,
      tradeoffs: parsed.tradeoffs || null,
      problem_statement: parsed.problem_statement || null,
      success_criteria: parsed.success_criteria || null,
      implementation_notes: parsed.implementation_notes || null,

      decision_type: parsed.decision_type || 'technical',
      scope: parsed.scope || 'component',
      reversibility: parsed.reversibility || 'reversible',
      decision_confidence: parsed.decision_confidence || 'medium',
      extraction_confidence: Math.min(
        Math.max(parsed.extraction_confidence ?? event.confidence_score, 0),
        1.0
      )
    };
  }

  /**
   * Rule-based decision extraction (fallback when no LLM available)
   */
  extractDecisionRuleBased(event) {
    const content = event.content || '';
    const title = event.title || '';
    const fullText = `${title} ${content}`.toLowerCase();

    const strongIndicators = event.decision_indicators.filter(i =>
      ['explicit_decision', 'approval_decision', 'implementation_decision'].includes(i.type)
    );

    if (strongIndicators.length === 0 && event.confidence_score < 0.6) {
      return null;
    }

    let decision = {
      id: `decision_${event.id}`,
      source_event_id: event.id,
      repository: event.repository,
      timestamp: event.timestamp,
      primary_decision_maker: event.author_login,
      related_pr_number: event.pull_request_number,
      related_issue_number: event.issue_number,
      related_commit_sha: event.commit_sha,
      extraction_confidence: Math.min(event.confidence_score + 0.1, 1.0)
    };

    if (event.event_type === 'pr_review' && content.includes('approved')) {
      decision.decision_statement = `Approved implementation approach in PR #${event.pull_request_number}`;
      decision.decision_type = 'approval';
      decision.scope = 'component';
      decision.reversibility = 'reversible';
      decision.rationale = this.extractRationale(content);

    } else if (event.event_type === 'pull_request') {
      decision.decision_statement = `Implement: ${title}`;
      decision.decision_type = 'technical';
      decision.scope = this.inferScope(content);
      decision.reversibility = this.inferReversibility(content);
      decision.problem_statement = this.extractProblemStatement(content);
      decision.rationale = this.extractRationale(content);

    } else if (event.event_type === 'pr_comment') {
      if (this.containsDecisionLanguage(content)) {
        decision.decision_statement = this.extractDecisionStatement(content);
        decision.decision_type = 'technical';
        decision.scope = 'component';
        decision.reversibility = 'reversible';
        decision.rationale = this.extractRationale(content);
      } else {
        return null;
      }

    } else if (event.event_type === 'commit') {
      decision.decision_statement = `Implement: ${title}`;
      decision.decision_type = 'implementation';
      decision.scope = 'local';
      decision.reversibility = 'reversible';
      decision.implementation_notes = content;

    } else {
      return null;
    }

    decision.decision_confidence = this.inferDecisionConfidence(content);
    return decision;
  }

  // ── Rule-based helpers ─────────────────────────────────────────────

  containsDecisionLanguage(content) {
    const decisionPhrases = [
      'let\'s go with', 'i think we should', 'we should use',
      'i prefer', 'better approach', 'i suggest',
      'let\'s implement', 'we need to', 'i recommend'
    ];
    const lowerContent = content.toLowerCase();
    return decisionPhrases.some(phrase => lowerContent.includes(phrase));
  }

  extractDecisionStatement(content) {
    const sentences = content.split(/[.!?]+/);
    for (const sentence of sentences) {
      const lower = sentence.toLowerCase().trim();
      if (this.containsDecisionLanguage(lower)) {
        return sentence.trim();
      }
    }
    return content.substring(0, 100) + '...';
  }

  extractRationale(content) {
    const rationalePatterns = [
      /because ([^.!?]+)/i,
      /since ([^.!?]+)/i,
      /due to ([^.!?]+)/i,
      /this (?:will|should) ([^.!?]+)/i
    ];
    for (const pattern of rationalePatterns) {
      const match = content.match(pattern);
      if (match) return match[1].trim();
    }
    return null;
  }

  extractProblemStatement(content) {
    const problemPatterns = [
      /(?:issue|problem|challenge) (?:is|was) ([^.!?]+)/i,
      /we (?:need|want) to ([^.!?]+)/i,
      /(?:currently|right now) ([^.!?]+)/i
    ];
    for (const pattern of problemPatterns) {
      const match = content.match(pattern);
      if (match) return match[1].trim();
    }
    return null;
  }

  inferScope(content) {
    const lowerContent = content.toLowerCase();
    if (lowerContent.includes('architecture') || lowerContent.includes('system')) return 'system';
    if (lowerContent.includes('component') || lowerContent.includes('module')) return 'component';
    return 'local';
  }

  inferReversibility(content) {
    const lowerContent = content.toLowerCase();
    if (lowerContent.includes('migration') || lowerContent.includes('breaking')) return 'costly';
    if (lowerContent.includes('database') || lowerContent.includes('schema')) return 'irreversible';
    return 'reversible';
  }

  inferDecisionConfidence(content) {
    const lowerContent = content.toLowerCase();
    if (lowerContent.includes('definitely') || lowerContent.includes('certain')) return 'high';
    if (lowerContent.includes('probably') || lowerContent.includes('likely')) return 'medium';
    return 'low';
  }

  // ── Storage & queries ──────────────────────────────────────────────

  async storeDecision(decision) {
    const stmt = this.eventStore.db.prepare(`
      INSERT OR REPLACE INTO decisions (
        id, source_event_id, repository, timestamp,
        decision_statement, rationale, alternatives_considered, tradeoffs,
        decision_type, scope, reversibility,
        primary_decision_maker, involved_parties,
        extraction_confidence, decision_confidence,
        problem_statement, success_criteria, implementation_notes,
        related_pr_number, related_issue_number, related_commit_sha,
        supersedes_decision_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      decision.id,
      decision.source_event_id,
      decision.repository,
      decision.timestamp,
      decision.decision_statement,
      decision.rationale,
      decision.alternatives_considered,
      decision.tradeoffs,
      decision.decision_type,
      decision.scope,
      decision.reversibility,
      decision.primary_decision_maker,
      JSON.stringify(decision.involved_parties || []),
      decision.extraction_confidence,
      decision.decision_confidence,
      decision.problem_statement,
      decision.success_criteria,
      decision.implementation_notes,
      decision.related_pr_number,
      decision.related_issue_number,
      decision.related_commit_sha,
      decision.supersedes_decision_id
    );
  }

  async getDecisions(repository, filters = {}) {
    let query = 'SELECT * FROM decisions WHERE repository = ?';
    const params = [repository];

    if (filters.decision_type) {
      query += ' AND decision_type = ?';
      params.push(filters.decision_type);
    }
    if (filters.min_confidence) {
      query += ' AND extraction_confidence >= ?';
      params.push(filters.min_confidence);
    }
    if (filters.after) {
      query += ' AND timestamp > ?';
      params.push(filters.after);
    }

    query += ' ORDER BY timestamp DESC';

    if (filters.limit) {
      query += ' LIMIT ?';
      params.push(filters.limit);
    }

    const stmt = this.eventStore.db.prepare(query);
    const rows = stmt.all(...params);

    return rows.map(row => ({
      ...row,
      involved_parties: JSON.parse(row.involved_parties || '[]')
    }));
  }

  async getExtractionStats(repository) {
    const totalDecisions = this.eventStore.db.prepare(`
      SELECT COUNT(*) as count FROM decisions WHERE repository = ?
    `).get(repository);

    const byType = this.eventStore.db.prepare(`
      SELECT decision_type, COUNT(*) as count
      FROM decisions 
      WHERE repository = ?
      GROUP BY decision_type
      ORDER BY count DESC
    `).all(repository);

    const byConfidence = this.eventStore.db.prepare(`
      SELECT 
        CASE 
          WHEN extraction_confidence >= 0.8 THEN 'high'
          WHEN extraction_confidence >= 0.6 THEN 'medium'
          ELSE 'low'
        END as confidence_level,
        COUNT(*) as count
      FROM decisions 
      WHERE repository = ?
      GROUP BY confidence_level
      ORDER BY count DESC
    `).all(repository);

    const avgConfidence = this.eventStore.db.prepare(`
      SELECT AVG(extraction_confidence) as avg_confidence
      FROM decisions 
      WHERE repository = ?
    `).get(repository);

    return {
      total: totalDecisions.count,
      byType,
      byConfidence,
      avgConfidence: avgConfidence.avg_confidence || 0
    };
  }
}