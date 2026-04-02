#!/usr/bin/env node

import dotenv from 'dotenv';

// Load environment variables FIRST
dotenv.config();

import { GitHubIngester } from './ingestion/github-ingester.js';
import { EventStore } from './storage/event-store.js';
import { EventNormalizer } from './normalization/event-normalizer.js';
import { DecisionExtractor } from './extraction/decision-extractor.js';
import { getLLMProvider } from './intelligence/llm-provider.js';
import config from '../config/default.js';

/**
 * Engineering Decision Memory System - Main Entry Point
 * 
 * This system captures and analyzes engineering decisions from GitHub activity.
 * It follows an 11-phase architecture designed to build organizational memory.
 */
export class DecisionMemorySystem {
  constructor() {
    this.eventStore = new EventStore(config.storage.eventStore);
    this.githubIngester = new GitHubIngester(process.env.GITHUB_TOKEN, this.eventStore);
    this.eventNormalizer = new EventNormalizer(this.eventStore);
    this.decisionExtractor = new DecisionExtractor(this.eventStore);
  }

  async initialize() {
    console.log('🚀 Initializing Engineering Decision Memory System');

    // Validate configuration
    if (!process.env.GITHUB_TOKEN) {
      throw new Error('GITHUB_TOKEN environment variable is required');
    }

    // Initialize LLM provider (logs which AI provider was selected)
    getLLMProvider();

    // Initialize storage
    await this.eventStore.initialize();

    console.log('✅ System initialized successfully');
  }

  async ingestRepository(owner, repo, customOptions = {}) {
    console.log(`\n📊 Phase 1: OPTIMIZED Data Ingestion`);
    console.log(`Target: ${owner}/${repo}`);
    console.log(`Strategy: Fast capture with smart limits.`);

    const startTime = Date.now();

    // Default optimized options
    const defaultOptions = {
      maxPRs: 100,        // Recent PRs only
      maxCommits: 200,    // Recent commits
      maxIssues: 50,      // Recent issues
      skipComments: false, // Include comments for decisions
      batchSize: 50       // Batch database writes
    };

    const options = { ...defaultOptions, ...customOptions };

    console.log(`📊 Limits: ${options.maxPRs} PRs, ${options.maxCommits} commits, ${options.maxIssues} issues`);
    if (options.skipComments) console.log(`⚡ Skipping comments for faster ingestion.`);

    await this.githubIngester.ingestRepository(owner, repo, options);
    const duration = ((Date.now() - startTime) / 1000).toFixed(1);

    // Show ingestion statistics
    const stats = await this.eventStore.getStats();
    console.log(`\n📈 Ingestion Complete in ${duration}s:`);
    console.log(`- Total events: ${stats.total}`);
    console.log(`- Event types:`, stats.byType);
  }

  /**
   * Phase 2: Normalize events for decision extraction
   */
  async normalizeRepository(owner, repo) {
    const repository = `${owner}/${repo}`;
    console.log(`\n🔄 Phase 2: Event Normalization`);
    console.log(`Target: ${repository}`);
    console.log(`Strategy: Unified format + decision signal detection`);

    await this.eventNormalizer.normalizeRepository(repository);

    // Show normalization statistics
    const stats = await this.eventNormalizer.getNormalizationStats(repository);
    console.log(`\n📊 Normalization Complete:`);
    console.log(`- Total normalized: ${stats.total}`);
    console.log(`- By confidence:`, stats.byConfidence);
    console.log(`- By event type:`, stats.byEventType);

    // Show decision candidates
    const candidates = await this.eventNormalizer.getDecisionCandidates(repository, 0.4);
    console.log(`\n🎯 Decision Candidates (confidence >= 0.4): ${candidates.length}`);

    candidates.slice(0, 5).forEach(candidate => {
      console.log(`\n[${candidate.confidence_score.toFixed(2)}] ${candidate.event_type} by ${candidate.author_login}`);
      console.log(`  ${candidate.title || candidate.content.substring(0, 80)}...`);
      console.log(`  Indicators: ${candidate.decision_indicators.map(i => i.type).join(', ')}`);
    });
  }

  /**
   * Phase 3: Extract structured decisions from normalized events
   */
  async extractDecisions(owner, repo) {
    const repository = `${owner}/${repo}`;
    console.log(`\n🤖 Phase 3: Decision Extraction`);
    console.log(`Target: ${repository}`);
    console.log(`Strategy: LLM-powered extraction → structured decisions`);

    const result = await this.decisionExtractor.extractDecisions(repository, 0.4);

    // Show extraction statistics
    const stats = await this.decisionExtractor.getExtractionStats(repository);
    console.log(`\n📊 Extraction Complete:`);
    console.log(`- Total decisions: ${stats.total}`);
    console.log(`- By type:`, stats.byType);
    console.log(`- By confidence:`, stats.byConfidence);
    console.log(`- Average confidence: ${stats.avgConfidence.toFixed(2)}`);

    // Show sample decisions
    const decisions = await this.decisionExtractor.getDecisions(repository, { limit: 5 });
    console.log(`\n🎯 Sample Decisions:`);

    decisions.forEach(decision => {
      console.log(`\n[${decision.extraction_confidence.toFixed(2)}] ${decision.decision_type} by ${decision.primary_decision_maker}`);
      console.log(`  Statement: ${decision.decision_statement}`);
      if (decision.rationale) {
        console.log(`  Rationale: ${decision.rationale}`);
      }
      if (decision.problem_statement) {
        console.log(`  Problem: ${decision.problem_statement}`);
      }
      console.log(`  Scope: ${decision.scope}, Reversibility: ${decision.reversibility}`);
    });
  }

  async showStatus() {
    const stats = await this.eventStore.getStats();

    console.log('\n📊 System Status:');
    console.log(`Total events stored: ${stats.total}`);
    console.log('\nEvents by type:');
    stats.byType.forEach(({ type, count }) => {
      console.log(`  ${type}: ${count}`);
    });

    console.log('\nEvents by repository:');
    stats.byRepository.forEach(({ repository, count }) => {
      console.log(`  ${repository}: ${count}`);
    });
  }

  /**
   * Search events (useful for debugging and exploration)
   */
  async searchEvents(searchTerm, filters = {}) {
    console.log(`\n🔍 Searching for: "${searchTerm}"`);

    const events = await this.eventStore.searchEvents(searchTerm, {
      limit: 10,
      ...filters
    });

    console.log(`Found ${events.length} matching events:`);
    events.forEach(event => {
      console.log(`\n[${event.timestamp}] ${event.type}/${event.action}`);
      console.log(`Repository: ${event.repository}`);

      // Show relevant data based on event type
      if (event.type === 'pull_request') {
        console.log(`PR #${event.data.number}: ${event.data.title}`);
        console.log(`Author: ${event.data.author}`);
      } else if (event.type === 'pr_comment') {
        console.log(`Comment by ${event.data.author} on PR #${event.data.pr_number}`);
        console.log(`Content: ${event.data.body.substring(0, 100)}...`);
      } else if (event.type === 'commit') {
        console.log(`Commit: ${event.data.message.split('\n')[0]}`);
        console.log(`Author: ${event.data.author}`);
      }
    });
  }

  async shutdown() {
    console.log('🛑 Shutting down system...');
    this.eventStore.close();
    console.log('✅ Shutdown complete');
  }
}

/**
 * CLI Interface
 */
async function main() {
  const system = new DecisionMemorySystem();

  try {
    await system.initialize();

    const args = process.argv.slice(2);
    const command = args[0];

    switch (command) {
      case 'web':
        console.log('🌐 Starting web interface...');
        console.log('Run: npm run web');
        console.log('Then open: http://localhost:3000');
        break;

      case 'extract':
        if (args.length < 3) {
          console.error('Usage: npm run dev extract <owner> <repo>');
          process.exit(1);
        }
        await system.extractDecisions(args[1], args[2]);
        break;

      case 'normalize':
        if (args.length < 3) {
          console.error('Usage: npm run dev normalize <owner> <repo>');
          process.exit(1);
        }
        await system.normalizeRepository(args[1], args[2]);
        break;

      case 'ingest-fast':
        if (args.length < 3) {
          console.error('Usage: npm run dev ingest-fast <owner> <repo>');
          process.exit(1);
        }
        console.log('🚀 Using FAST ingestion mode');
        const fastOptions = {
          maxPRs: 50,
          maxCommits: 100,
          maxIssues: 25,
          skipComments: true, // Skip comments for speed
          batchSize: 100
        };
        await system.ingestRepository(args[1], args[2], fastOptions);
        break;

      case 'ingest':
        if (args.length < 3) {
          console.error('Usage: npm run dev ingest <owner> <repo>');
          process.exit(1);
        }
        await system.ingestRepository(args[1], args[2]);
        break;

      case 'status':
        await system.showStatus();
        break;

      case 'search':
        if (args.length < 2) {
          console.error('Usage: npm run dev search <term>');
          process.exit(1);
        }
        await system.searchEvents(args[1]);
        break;

      case 'why':
        if (args.length < 4) {
          console.error('Usage: npm run dev why <owner> <repo> <component>');
          console.error('Example: npm run dev why facebook react useCache');
          process.exit(1);
        }
        
        const { WhyEngine } = await import('./web/why-engine.js');
        const whyEngine = new WhyEngine(system.eventStore);
        const repoFullName = `${args[1]}/${args[2]}`;
        
        const explanation = await whyEngine.explainComponent(repoFullName, args[3]);
        
        console.log(`\n======================================================`);
        console.log(`🧠 WHY DOES THIS EXIST: "${args[3]}" in ${repoFullName}`);
        console.log(`======================================================\n`);
        
        console.log(`[Summary]`);
        console.log(explanation.summary?.text || 'No summary available.');
        
        if (explanation.summary?.key_decisions?.length) {
          console.log(`\n[Key Decisions]`);
          explanation.summary.key_decisions.forEach(d => console.log(`• ${d}`));
        }

        console.log(`\n[Evidence]`);
        console.log(`- Events Analyzed: ${explanation.evidence.total_events}`);
        console.log(`- Decisions Found: ${explanation.evidence.decision_count}`);
        
        if (explanation.decisions?.length) {
          console.log(`\n[Extracted Decisions]`);
          explanation.decisions.slice(0, 5).forEach(d => {
            console.log(`\n- ${d.statement}`);
            if (d.rationale) console.log(`  Reason: ${d.rationale}`);
            console.log(`  Source: ${d.type} by ${d.author}`);
          });
        }
        
        if (explanation.gaps?.length) {
          console.log(`\n[Information Gaps ⚠]`);
          explanation.gaps.forEach(g => console.log(`• ${g}`));
        }
        
        console.log(`\n`);
        break;

      default:
        console.log(`
🧠 Engineering Decision Memory System

Available commands:
  ingest <owner> <repo>     - Ingest GitHub repository data (100 PRs, 200 commits, 50 issues)
  ingest-fast <owner> <repo> - Fast ingestion (50 PRs, 100 commits, 25 issues, no comments)
  normalize <owner> <repo>  - Normalize events for decision extraction (Phase 2)
  extract <owner> <repo>    - Extract structured decisions (Phase 3)
  web                       - Start web interface
  status                    - Show system status and statistics  
  search <term>             - Search events by content
  why <owner> <repo> <comp> - Run WhyEngine from the terminal to explain a component

Examples:
  npm run dev why facebook react useCache   # Explain a specific component
  npm run dev ingest-fast facebook react    # Fast ingestion (~2-5 minutes)
  npm run dev ingest facebook react         # Full ingestion (~5-15 minutes)
  npm run dev normalize facebook react
  npm run dev extract facebook react
  npm run web                               # Start web interface
  npm run dev status

⚡ PERFORMANCE OPTIMIZATIONS:
- Parallel processing of PRs, commits, and issues
- Batch database writes (50 events per batch)
- Smart limits to focus on recent/important content
- Transaction-based storage for speed

Phase 1: Data Ingestion ✅ (OPTIMIZED)
- GitHub API integration with rate limiting
- Parallel processing and batch writes
- Smart limits for faster ingestion
- Full-text search capability

Phase 2: Event Normalization ✅
- Unified author identification
- Standardized content extraction
- Entity relationship mapping
- Decision signal detection

Phase 3: Decision Extraction ✅
- Rule-based decision identification
- Structured decision data
- Confidence scoring
- Traceability to source events

Phase 4: Web Interface ✅
- "Why does this exist?" search
- Component tracing to decisions
- Interactive timeline visualization
- Evidence-based explanations

Coming next: Phase 5 - Knowledge Graph Construction
        `);
    }

  } catch (error) {
    console.error('❌ Error:', error.message);
    process.exit(1);
  } finally {
    await system.shutdown();
  }
}

// Handle graceful shutdown
process.on('SIGINT', async () => {
  console.log('\n🛑 Received SIGINT, shutting down gracefully...');
  process.exit(0);
});

process.on('SIGTERM', async () => {
  console.log('\n🛑 Received SIGTERM, shutting down gracefully...');
  process.exit(0);
});

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}