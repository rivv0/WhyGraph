/**
 * Why Engine - Core logic for answering "Why does this exist?"
 */
import { getLLMProvider } from '../intelligence/llm-provider.js';
import { WHY_SYSTEM_PROMPT, buildWhySummaryPrompt } from '../intelligence/decision-prompt.js';

export class WhyEngine {
  constructor(eventStore) {
    this.eventStore = eventStore;
    // NOTE: do NOT call getLLMProvider() here — ES module imports are hoisted
    // above dotenv.config(), so env vars aren't set yet at construction time.
    // The lazy getter below ensures we read the env only when first needed.
  }

  /** Lazy accessor — singleton is created on first *use*, after dotenv is loaded. */
  get llm() {
    if (!this._llm) this._llm = getLLMProvider();
    return this._llm;
  }

  async explainComponent(repository, componentName) {
    console.log(`🔍 Explaining: ${componentName} in ${repository}`);

    const relatedEvents = await this.findRelatedEvents(repository, componentName);
    const decisions = await this.findRelatedDecisions(repository, componentName);
    const summary = await this.generateSummary(componentName, decisions, relatedEvents);

    return {
      component: componentName,
      repository: repository,
      summary,
      decisions: decisions.map(d => this.formatDecision(d)),
      timeline: await this.buildTimeline(relatedEvents, decisions),
      graph: this.buildComponentGraph(componentName, relatedEvents, decisions),
      evidence: {
        total_events: relatedEvents.length,
        decision_count: decisions.length,
        confidence_score: this.calculateConfidence(decisions, relatedEvents),
        data_freshness: this.assessFreshness(relatedEvents)
      },
      gaps: this.identifyGaps(decisions, relatedEvents),
      generated_at: new Date().toISOString()
    };
  }

  async findRelatedEvents(repository, componentName) {
    const searchTerms = [componentName, componentName.toLowerCase()];
    const allEvents = [];

    for (const term of searchTerms) {
      const events = await this.eventStore.searchEvents(term, {
        repository,
        limit: 50
      });
      allEvents.push(...events);
    }

    const uniqueEvents = allEvents.filter((event, index, self) =>
      index === self.findIndex(e => e.id === event.id)
    );

    return uniqueEvents
      .map(event => ({
        ...event,
        relevance_score: this.calculateRelevanceScore(event, componentName)
      }))
      .filter(event => event.relevance_score > 0.1)
      .sort((a, b) => b.relevance_score - a.relevance_score);
  }

  async findRelatedDecisions(repository, componentName) {
    try {
      const decisions = this.eventStore.db.prepare(`
        SELECT * FROM decisions 
        WHERE repository = ? 
          AND (decision_statement LIKE ? OR rationale LIKE ?)
        ORDER BY extraction_confidence DESC, timestamp DESC
      `).all(repository, `%${componentName}%`, `%${componentName}%`);

      return decisions.map(decision => ({
        ...decision,
        involved_parties: JSON.parse(decision.involved_parties || '[]')
      }));
    } catch (error) {
      return [];
    }
  }

  calculateRelevanceScore(event, componentName) {
    const content = `${event.data.title || ''} ${event.data.body || event.data.message || ''}`.toLowerCase();
    const component = componentName.toLowerCase();

    let score = 0;

    if ((event.data.title || '').toLowerCase().includes(component)) {
      score += 0.8;
    }

    if (content.includes(component)) {
      score += 0.6;
    }

    if (event.type === 'pull_request') {
      score += 0.2;
    }

    return Math.min(score, 1.0);
  }

  /**
   * Generate a natural-language summary via LLM when available, or fall back
   * to a brief template-based summary.
   */
  async generateSummary(componentName, decisions, events) {
    // --- LLM path ---
    if (this.llm.isAvailable && (decisions.length > 0 || events.length > 0)) {
      try {
        const userPrompt = buildWhySummaryPrompt(componentName, decisions, events);
        const parsed = await this.llm.completeJSON(WHY_SYSTEM_PROMPT, userPrompt, {
          maxTokens: 512,
          temperature: 0.3
        });
        return {
          text: parsed.summary || '(no summary)',
          key_decisions: parsed.key_decisions || [],
          open_questions: parsed.open_questions || [],
          confidence: this.mapConfidenceLevel(this.calculateConfidence(decisions, events)),
          generated_by: 'llm'
        };
      } catch (err) {
        console.warn('⚠️  LLM summary failed, using fallback:', err.message);
      }
    }

    // --- Fallback: template-based ---
    if (decisions.length === 0 && events.length === 0) {
      return {
        text: 'No recorded decisions or discussions found for this component.',
        confidence: 'none',
        gaps: ['No decision history available'],
        generated_by: 'fallback'
      };
    }

    if (decisions.length === 0) {
      return {
        text: `Found ${events.length} related discussions but no structured decisions recorded.`,
        confidence: 'low',
        gaps: ['Decision extraction not completed'],
        generated_by: 'fallback'
      };
    }

    const primaryDecision = decisions[0];
    let text = primaryDecision.decision_statement;
    if (primaryDecision.rationale) text += ` Rationale: ${primaryDecision.rationale}`;

    return {
      text,
      confidence: this.mapConfidenceLevel(primaryDecision.extraction_confidence),
      primary_decision_maker: primaryDecision.primary_decision_maker,
      generated_by: 'fallback'
    };
  }

  formatDecision(decision) {
    return {
      id: decision.id,
      statement: decision.decision_statement,
      rationale: decision.rationale,
      type: decision.decision_type,
      scope: decision.scope,
      reversibility: decision.reversibility,
      decision_maker: decision.primary_decision_maker,
      confidence: this.mapConfidenceLevel(decision.extraction_confidence),
      timestamp: decision.timestamp,
      related_pr: decision.related_pr_number
    };
  }

  async buildTimeline(events, decisions) {
    const timelineItems = [];

    events.forEach(event => {
      timelineItems.push({
        type: 'event',
        timestamp: event.timestamp,
        event_type: event.type,
        author: event.data.author || 'system',
        title: event.data.title || event.data.message?.split('\n')[0] || 'Event',
        content: event.data.body || event.data.message || '',
        source_url: this.generateSourceUrl(event)
      });
    });

    decisions.forEach(decision => {
      timelineItems.push({
        type: 'decision',
        timestamp: decision.timestamp,
        author: decision.primary_decision_maker,
        title: decision.decision_statement,
        rationale: decision.rationale
      });
    });

    return timelineItems.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
  }

  buildComponentGraph(componentName, events, decisions) {
    const nodes = [];
    const edges = [];

    const nodeIds = new Set();
    const addNode = (id, label, group, title) => {
      if (!nodeIds.has(id)) {
        nodes.push({ id, label, group, title });
        nodeIds.add(id);
      }
    };

    const edgeIds = new Set();
    const addEdge = (from, to, label) => {
      const id = `${from}-${to}`;
      if (!edgeIds.has(id) && nodeIds.has(from) && nodeIds.has(to)) {
        edges.push({ from, to, label });
        edgeIds.add(id);
      }
    };

    // Add Central Component Node
    const centerId = `component-${componentName}`;
    addNode(centerId, componentName, 'component', `Target Component: ${componentName}`);

    // Decisions
    decisions.forEach(decision => {
      const decisionId = `decision-${decision.id}`;
      addNode(decisionId, decision.decision_statement, 'decision', decision.rationale || 'Decision');
      addEdge(decisionId, centerId, 'affects');

      if (decision.related_pr_number) {
        addEdge(decisionId, `pr-${decision.related_pr_number}`, 'made in');
      }

      // Connect decision makers
      if (decision.primary_decision_maker) {
        const authorId = `author-${decision.primary_decision_maker}`;
        addNode(authorId, decision.primary_decision_maker, 'author', `User: ${decision.primary_decision_maker}`);
        addEdge(authorId, decisionId, 'decided');
      }
    });

    // Events
    events.forEach(event => {
      let eventId;
      switch (event.type) {
        case 'pull_request':
          eventId = `pr-${event.data.number}`;
          addNode(eventId, `PR #${event.data.number}`, 'pull_request', event.data.title);
          addEdge(eventId, centerId, 'modifies');
          break;
        case 'commit':
          eventId = `commit-${event.data.sha.substring(0, 7)}`;
          addNode(eventId, event.data.message.split('\n')[0], 'commit', event.data.message);
          addEdge(eventId, centerId, 'touches');
          break;
        case 'issue':
          eventId = `issue-${event.data.number}`;
          addNode(eventId, `Issue #${event.data.number}`, 'issue', event.data.title);
          addEdge(eventId, centerId, 'references');
          break;
        case 'pr_comment':
        case 'pr_review':
          // Connect to PR if available instead of center directly
          if (nodeIds.has(`pr-${event.data.pr_number}`)) {
            const authorId = `author-${event.data.author}`;
            addNode(authorId, event.data.author, 'author', `User: ${event.data.author}`);
            addEdge(authorId, `pr-${event.data.pr_number}`, 'commented on');
          }
          break;
      }

      if (event.data.author && eventId) {
        const authorId = `author-${event.data.author}`;
        addNode(authorId, event.data.author, 'author', `User: ${event.data.author}`);
        addEdge(authorId, eventId, 'authored');
      }
    });

    return { nodes, edges };
  }

  calculateConfidence(decisions, events) {
    if (decisions.length === 0) {
      return events.length > 0 ? 0.3 : 0.0;
    }

    const avgDecisionConfidence = decisions.reduce((sum, d) => sum + d.extraction_confidence, 0) / decisions.length;
    return avgDecisionConfidence;
  }

  assessFreshness(events) {
    if (events.length === 0) {
      return { level: 'none', last_activity: null };
    }

    const latestEvent = events.reduce((latest, event) =>
      new Date(event.timestamp) > new Date(latest.timestamp) ? event : latest
    );

    const daysSinceLastActivity = (Date.now() - new Date(latestEvent.timestamp)) / (1000 * 60 * 60 * 24);

    let level = 'stale';
    if (daysSinceLastActivity < 30) level = 'fresh';
    else if (daysSinceLastActivity < 180) level = 'recent';
    else if (daysSinceLastActivity < 365) level = 'aging';

    return {
      level,
      last_activity: latestEvent.timestamp,
      days_ago: Math.floor(daysSinceLastActivity)
    };
  }

  identifyGaps(decisions, events) {
    const gaps = [];

    if (decisions.length === 0) {
      gaps.push("No structured decisions extracted");
    }

    if (events.length === 0) {
      gaps.push("No related discussions found");
    }

    return gaps;
  }

  async getAvailableRepositories(username = null) {
    const stats = await this.eventStore.getStats(username);
    return stats.byRepository.map(repo => ({
      name: repo.repository,
      event_count: repo.count
    }));
  }

  mapConfidenceLevel(score) {
    if (score >= 0.8) return 'high';
    if (score >= 0.6) return 'medium';
    if (score >= 0.3) return 'low';
    return 'very_low';
  }

  generateSourceUrl(event) {
    const repo = event.repository;

    if (event.type === 'pull_request') {
      return `https://github.com/${repo}/pull/${event.data.number}`;
    } else if (event.type === 'commit') {
      return `https://github.com/${repo}/commit/${event.data.sha}`;
    }

    return `https://github.com/${repo}`;
  }

  async getGraphData(repository, username = null) {
    console.log(`🌐 Generating graph data for: ${repository || 'all repositories'} for user: ${username || 'all'}`);

    let userRepos = null;
    if (username) {
      const stats = await this.eventStore.getStats(username);
      userRepos = stats.byRepository.map(r => r.repository);
      if (repository && !userRepos.includes(repository)) {
        return { nodes: [], edges: [] };
      }
    }

    // Fetch all events and decisions (filtered if a repository is provided)
    const eventParams = repository ? { repository, limit: 1000 } : { limit: 1000 };
    const allEvents = await this.eventStore.getEvents(eventParams);
    
    // Filter events by user access if needed
    const events = userRepos ? allEvents.filter(e => userRepos.includes(e.repository)) : allEvents;

    let decisions = [];
    if (repository) {
      decisions = this.eventStore.db.prepare(`
        SELECT * FROM decisions 
        WHERE repository = ?
      `).all(repository) || [];
    } else {
      decisions = this.eventStore.db.prepare(`
        SELECT * FROM decisions 
      `).all() || [];
    }
    
    // Filter decisions by user access
    if (userRepos) {
      decisions = decisions.filter(d => userRepos.includes(d.repository));
    }

    const nodes = [];
    const edges = [];

    const nodeIds = new Set();
    const addNode = (id, label, group, title) => {
      if (!nodeIds.has(id)) {
        nodes.push({ id, label, group, title });
        nodeIds.add(id);
      }
    };

    const edgeIds = new Set();
    const addEdge = (from, to, label) => {
      const id = `${from}-${to}`;
      if (!edgeIds.has(id) && nodeIds.has(from) && nodeIds.has(to)) {
        edges.push({ from, to, label });
        edgeIds.add(id);
      }
    };

    // Helper wrapper to include repo context in IDs
    const safeRepoName = (repo) => repo.replace(/[^a-zA-Z0-9-]/g, '_');

    // 1. First Pass: Create all event nodes
    for (const event of events) {
      const repoPrefix = safeRepoName(event.repository);
      switch (event.type) {
        case 'pull_request':
          addNode(
            `${repoPrefix}-pr-${event.data.number}`,
            `[${event.repository}] PR #${event.data.number}`,
            'pull_request',
            event.data.title
          );
          break;
        case 'commit':
          addNode(
            `${repoPrefix}-commit-${event.data.sha.substring(0, 7)}`,
            `[${event.repository}] ` + event.data.message.split('\n')[0],
            'commit',
            event.data.message
          );
          break;
        case 'issue':
          addNode(
            `${repoPrefix}-issue-${event.data.number}`,
            `[${event.repository}] Issue #${event.data.number}`,
            'issue',
            event.data.title
          );
          break;
      }
    }

    // 2. Second Pass: Decisions
    for (const decision of decisions) {
      const repoPrefix = safeRepoName(decision.repository);
      const decisionId = `${repoPrefix}-decision-${decision.id}`;
      addNode(
        decisionId,
        `[${decision.repository}] ` + decision.decision_statement,
        'decision',
        decision.rationale || 'Decision'
      );

      // Edge from decision to PR (if known)
      if (decision.related_pr_number) {
        addEdge(decisionId, `${repoPrefix}-pr-${decision.related_pr_number}`, 'made in');
      }
    }

    // 3. Third Pass: Relationships (Commits to PRs, Comments to PRs/Issues)
    for (const event of events) {
      const repoPrefix = safeRepoName(event.repository);

      if (event.type === 'pr_comment' || event.type === 'pr_review') {
        if (nodeIds.has(`${repoPrefix}-pr-${event.data.pr_number}`)) {
          // We don't always create nodes for every single comment to keep the graph clean,
          // but we could. For now, we'll just link the comment author to the PR.
          const authorId = `author-${event.data.author}`;
          addNode(authorId, event.data.author, 'author', `User: ${event.data.author}`);
          addEdge(authorId, `${repoPrefix}-pr-${event.data.pr_number}`, 'commented on');
        }
      } else if (event.type === 'pull_request') {
        const authorId = `author-${event.data.author}`;
        addNode(authorId, event.data.author, 'author', `User: ${event.data.author}`);
        addEdge(authorId, `${repoPrefix}-pr-${event.data.number}`, 'opened');
      } else if (event.type === 'commit') {
        const authorId = `author-${event.data.author}`;
        addNode(authorId, event.data.author, 'author', `User: ${event.data.author}`);
        addEdge(authorId, `${repoPrefix}-commit-${event.data.sha.substring(0, 7)}`, 'authored');

        // Try to link commits to PRs (this is simplistic; typically commits belong to PRs)
        // GitHub API doesn't always provide this cleanly in the events we stored, 
        // but if we had issue/pr references in the commit message:
        const msg = event.data.message || '';
        const prMatch = msg.match(/#(\\d+)/);
        if (prMatch) {
          addEdge(`${repoPrefix}-commit-${event.data.sha.substring(0, 7)}`, `${repoPrefix}-pr-${prMatch[1]}`, 'references');
          addEdge(`${repoPrefix}-commit-${event.data.sha.substring(0, 7)}`, `${repoPrefix}-issue-${prMatch[1]}`, 'references');
        }
      } else if (event.type === 'issue') {
        const authorId = `author-${event.data.author}`;
        addNode(authorId, event.data.author, 'author', `User: ${event.data.author}`);
        addEdge(authorId, `${repoPrefix}-issue-${event.data.number}`, 'opened');
      }
    }

    return { nodes, edges };
  }

  truncateText(text, maxLength) {
    if (!text) return '';
    if (text.length <= maxLength) return text;
    return text.substring(0, maxLength) + '...';
  }
}