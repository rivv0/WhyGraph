import express from 'express';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { EventStore } from '../storage/event-store.js';
import { WhyEngine } from './why-engine.js';
import { CodeTracer } from './code-tracer.js';
import { DecisionMemorySystem } from '../index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);


export class WhyServer {
  constructor(config = {}) {
    this.app = express();
    this.port = config.port || 3000;
    this.eventStore = new EventStore(config.dbPath || './storage/events.db');
    this.whyEngine = new WhyEngine(this.eventStore);
    this.codeTracer = new CodeTracer(this.eventStore);
    this.system = new DecisionMemorySystem();

    this.setupMiddleware();
    this.setupRoutes();
  }

  setupMiddleware() {
    // Parse JSON bodies
    this.app.use(express.json());

    // Serve static files
    this.app.use(express.static(join(__dirname, 'public')));

    // CORS for development
    this.app.use((req, res, next) => {
      res.header('Access-Control-Allow-Origin', '*');
      res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
      next();
    });
  }

  setupRoutes() {
    // Main application - serve minimal UI by default
    this.app.get('/', (req, res) => {
      res.sendFile(join(__dirname, 'public', 'minimal-ui.html'));
    });

    // Alternative route for original UI
    this.app.get('/classic', (req, res) => {
      res.sendFile(join(__dirname, 'public', 'index.html'));
    });

    // API Routes

    // Search for code/components
    this.app.get('/api/search', async (req, res) => {
      try {
        const { q: query, repo } = req.query;

        if (!query) {
          return res.status(400).json({ error: 'Query parameter required' });
        }

        const results = await this.codeTracer.searchCodeComponents(query, repo);
        res.json(results);
      } catch (error) {
        console.error('Search error:', error);
        res.status(500).json({ error: 'Search failed' });
      }
    });

    // Get the "why" for a specific component
    this.app.get('/api/why/:repository/:component', async (req, res) => {
      try {
        const { repository, component } = req.params;
        const decodedRepo = decodeURIComponent(repository);
        const decodedComponent = decodeURIComponent(component);

        const explanation = await this.whyEngine.explainComponent(decodedRepo, decodedComponent);
        res.json(explanation);
      } catch (error) {
        console.error('Why explanation error:', error);
        res.status(500).json({ error: 'Failed to generate explanation' });
      }
    });

    // Get decision timeline for a component
    this.app.get('/api/timeline/:repository/:component', async (req, res) => {
      try {
        const { repository, component } = req.params;
        const decodedRepo = decodeURIComponent(repository);
        const decodedComponent = decodeURIComponent(component);

        const timeline = await this.whyEngine.getDecisionTimeline(decodedRepo, decodedComponent);
        res.json(timeline);
      } catch (error) {
        console.error('Timeline error:', error);
        res.status(500).json({ error: 'Failed to get timeline' });
      }
    });

    // Get evidence for a specific decision
    this.app.get('/api/evidence/:decisionId', async (req, res) => {
      try {
        const { decisionId } = req.params;
        const evidence = await this.whyEngine.getDecisionEvidence(decisionId);
        res.json(evidence);
      } catch (error) {
        console.error('Evidence error:', error);
        res.status(500).json({ error: 'Failed to get evidence' });
      }
    });

    // Get repositories with decision data
    this.app.get('/api/repositories', async (req, res) => {
      try {
        const repos = await this.whyEngine.getAvailableRepositories();
        res.json(repos);
      } catch (error) {
        console.error('Repositories error:', error);
        res.status(500).json({ error: 'Failed to get repositories' });
      }
    });

    // Get graph nodes and edges for visualizing relationships
    this.app.get('/api/graph', async (req, res) => {
      try {
        const repoParam = req.query.repo;
        const repository = repoParam ? decodeURIComponent(repoParam) : null;

        const graphData = await this.whyEngine.getGraphData(repository);
        res.json(graphData);
      } catch (error) {
        console.error('Graph data error:', error);
        res.status(500).json({ error: 'Failed to get graph data' });
      }
    });

    // System processing routes

    // Ingest data from a repository
    this.app.post('/api/ingest', async (req, res) => {
      try {
        const { repository, options } = req.body;
        if (!repository || !repository.includes('/')) {
          return res.status(400).json({ error: 'Valid repository (owner/name) required' });
        }

        const [owner, repo] = repository.split('/');

        // Return 202 Accepted and process in background
        res.status(202).json({ message: 'Ingestion started in background' });

        try {
          // Add default options if not provided
          const ingestOptions = options || {
            maxPRs: 50,
            maxCommits: 100,
            maxIssues: 25,
            skipComments: true, // Skip comments for speed by default
            batchSize: 100
          };

          console.log(`[Web API] Starting background ingestion for ${repository}`);
          await this.system.ingestRepository(owner, repo, ingestOptions);
          console.log(`[Web API] Completed background ingestion for ${repository}`);
        } catch (bgError) {
          console.error(`[Web API] Background ingestion failed for ${repository}:`, bgError);
        }
      } catch (error) {
        console.error('Ingest API error:', error);
        res.status(500).json({ error: 'Failed to start ingestion' });
      }
    });

    // Normalize events for a repository
    this.app.post('/api/normalize', async (req, res) => {
      try {
        const { repository } = req.body;
        if (!repository || !repository.includes('/')) {
          return res.status(400).json({ error: 'Valid repository (owner/name) required' });
        }

        const [owner, repo] = repository.split('/');

        // Return 202 Accepted and process in background
        res.status(202).json({ message: 'Normalization started in background' });

        try {
          console.log(`[Web API] Starting background normalization for ${repository}`);
          await this.system.normalizeRepository(owner, repo);
          console.log(`[Web API] Completed background normalization for ${repository}`);
        } catch (bgError) {
          console.error(`[Web API] Background normalization failed for ${repository}:`, bgError);
        }
      } catch (error) {
        console.error('Normalize API error:', error);
        res.status(500).json({ error: 'Failed to start normalization' });
      }
    });

    // Extract decisions for a repository
    this.app.post('/api/extract', async (req, res) => {
      try {
        const { repository } = req.body;
        if (!repository || !repository.includes('/')) {
          return res.status(400).json({ error: 'Valid repository (owner/name) required' });
        }

        const [owner, repo] = repository.split('/');

        // Return 202 Accepted and process in background
        res.status(202).json({ message: 'Extraction started in background' });

        try {
          console.log(`[Web API] Starting background extraction for ${repository}`);
          await this.system.extractDecisions(owner, repo);
          console.log(`[Web API] Completed background extraction for ${repository}`);
        } catch (bgError) {
          console.error(`[Web API] Background extraction failed for ${repository}:`, bgError);
        }
      } catch (error) {
        console.error('Extract API error:', error);
        res.status(500).json({ error: 'Failed to start extraction' });
      }
    });

    // Run full pipeline for a repository
    this.app.post('/api/process-all', async (req, res) => {
      try {
        const { repository, options } = req.body;
        if (!repository || !repository.includes('/')) {
          return res.status(400).json({ error: 'Valid repository (owner/name) required' });
        }

        const [owner, repo] = repository.split('/');

        // Return 202 Accepted and process in background
        res.status(202).json({ message: 'Full pipeline processing started in background' });

        try {
          const ingestOptions = options || {
            maxPRs: 50,
            maxCommits: 100,
            maxIssues: 25,
            skipComments: true,
            batchSize: 100
          };

          console.log(`[Web API] Starting full pipeline for ${repository}`);
          await this.system.ingestRepository(owner, repo, ingestOptions);
          await this.system.normalizeRepository(owner, repo);
          await this.system.extractDecisions(owner, repo);
          console.log(`[Web API] Completed full pipeline for ${repository}`);
        } catch (bgError) {
          console.error(`[Web API] Background pipeline failed for ${repository}:`, bgError);
        }
      } catch (error) {
        console.error('Process All API error:', error);
        res.status(500).json({ error: 'Failed to start processing pipeline' });
      }
    });

    // Health check
    this.app.get('/api/health', (req, res) => {
      res.json({ status: 'ok', timestamp: new Date().toISOString() });
    });
  }

  async start() {
    await this.eventStore.initialize();
    await this.system.initialize();

    this.app.listen(this.port, () => {
      console.log(`🌐 Why Engine running at http://localhost:${this.port}`);
      console.log(`📊 Database: ${this.eventStore.dbPath}`);
    });
  }
}