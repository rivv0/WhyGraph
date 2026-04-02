import express from 'express';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { EventStore } from '../storage/event-store.js';
import { WhyEngine } from './why-engine.js';
import { CodeTracer } from './code-tracer.js';
import { DecisionMemorySystem } from '../index.js';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import cookieParser from 'cookie-parser';

const JWT_SECRET = process.env.JWT_SECRET || 'graphs-are-cool-secret';

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
    this.app.use(express.json());
    this.app.use(cookieParser());
    this.app.use(express.static(join(__dirname, 'public')));
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

    // --- Authentication ---
    const requireAuth = (req, res, next) => {
      const token = req.cookies.token;
      if (!token) return res.status(401).json({ error: 'Unauthorized. Please log in.' });
      try {
        req.user = jwt.verify(token, JWT_SECRET);
        next();
      } catch (err) {
        res.status(401).json({ error: 'Invalid token. Please log in again.' });
      }
    };

    const checkAccess = async (req, res, next) => {
      const repoParam = req.params.repository || req.body.repository || req.query.repo;
      if (repoParam) {
        const decodedRepo = decodeURIComponent(repoParam);
        const hasAccess = await this.eventStore.checkUserAccess(req.user.username, decodedRepo);
        if (!hasAccess) {
          return res.status(403).json({ error: 'Forbidden: You do not have access to this repository or it does not exist in your account.' });
        }
      }
      next();
    };

    this.app.post('/api/register', async (req, res) => {
      try {
        const { username, password } = req.body;
        if (!username || !password) return res.status(400).json({ error: 'Username and password required' });
        const existing = await this.eventStore.getUser(username);
        if (existing) return res.status(400).json({ error: 'Username already taken' });
        const hash = await bcrypt.hash(password, 10);
        await this.eventStore.createUser(username, hash);
        const token = jwt.sign({ username }, JWT_SECRET, { expiresIn: '7d' });
        res.cookie('token', token, { httpOnly: true, sameSite: 'strict' }).json({ username });
      } catch (e) {
        console.error('Registration error:', e);
        res.status(500).json({ error: 'Registration failed' });
      }
    });

    this.app.post('/api/login', async (req, res) => {
      try {
        const { username, password } = req.body;
        const user = await this.eventStore.getUser(username);
        if (!user || !(await bcrypt.compare(password, user.password_hash))) {
          return res.status(401).json({ error: 'Invalid credentials' });
        }
        const token = jwt.sign({ username }, JWT_SECRET, { expiresIn: '7d' });
        res.cookie('token', token, { httpOnly: true, sameSite: 'strict' }).json({ username });
      } catch (e) {
        console.error('Login error:', e);
        res.status(500).json({ error: 'Login failed' });
      }
    });

    this.app.post('/api/logout', (req, res) => {
      res.clearCookie('token').json({ message: 'Logged out successfully' });
    });

    this.app.get('/api/me', requireAuth, (req, res) => {
      res.json({ username: req.user.username });
    });
    // -----------------------


    // API Routes (Protected)

    this.app.get('/api/search', requireAuth, checkAccess, async (req, res) => {
      try {
        const { q: query, repo } = req.query;
        if (!query) return res.status(400).json({ error: 'Query parameter required' });
        const results = await this.codeTracer.searchCodeComponents(query, repo);
        res.json(results);
      } catch (error) {
        console.error('Search error:', error);
        res.status(500).json({ error: 'Search failed' });
      }
    });

    this.app.get('/api/why/:repository/:component', requireAuth, checkAccess, async (req, res) => {
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

    this.app.get('/api/timeline/:repository/:component', requireAuth, checkAccess, async (req, res) => {
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

    this.app.get('/api/evidence/:decisionId', requireAuth, async (req, res) => {
      try {
        const { decisionId } = req.params;
        // Ideally we would verify the decision's repo access here
        const evidence = await this.whyEngine.getDecisionEvidence(decisionId);
        res.json(evidence);
      } catch (error) {
        console.error('Evidence error:', error);
        res.status(500).json({ error: 'Failed to get evidence' });
      }
    });

    this.app.get('/api/repositories', requireAuth, async (req, res) => {
      try {
        // Pass username to get ONLY user's repositories
        const repos = await this.whyEngine.getAvailableRepositories(req.user.username);
        res.json(repos);
      } catch (error) {
        console.error('Repositories error:', error);
        res.status(500).json({ error: 'Failed to get repositories' });
      }
    });

    this.app.get('/api/graph', requireAuth, checkAccess, async (req, res) => {
      try {
        const repoParam = req.query.repo;
        const repository = repoParam ? decodeURIComponent(repoParam) : null;
        // Pass username to getGraphData
        const graphData = await this.whyEngine.getGraphData(repository, req.user.username);
        res.json(graphData);
      } catch (error) {
        console.error('Graph data error:', error);
        res.status(500).json({ error: 'Failed to get graph data' });
      }
    });

    // System processing routes

    this.app.post('/api/ingest', requireAuth, async (req, res) => {
      try {
        const { repository, options } = req.body;
        if (!repository || !repository.includes('/')) {
          return res.status(400).json({ error: 'Valid repository (owner/name) required' });
        }

        const [owner, repo] = repository.split('/');
        
        // Return 202 Accepted and process in background
        res.status(202).json({ message: 'Ingestion started in background' });

        try {
          const ingestOptions = options || {
            maxPRs: 50,
            maxCommits: 100,
            maxIssues: 25,
            skipComments: true,
            batchSize: 100
          };

          console.log(`[Web API] Starting background ingestion for ${repository} by ${req.user.username}`);
          
          // Link this repository to the user FIRST so they see it right away
          await this.eventStore.linkUserToRepository(req.user.username, repository);

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

    this.app.post('/api/normalize', requireAuth, checkAccess, async (req, res) => {
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

    this.app.post('/api/extract', requireAuth, checkAccess, async (req, res) => {
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

    this.app.post('/api/process-all', requireAuth, async (req, res) => {
      try {
        const { repository, options } = req.body;
        if (!repository || !repository.includes('/')) {
          return res.status(400).json({ error: 'Valid repository (owner/name) required' });
        }

        const [owner, repo] = repository.split('/');

        res.status(202).json({ message: 'Full pipeline processing started in background' });

        try {
          const ingestOptions = options || {
            maxPRs: 50,
            maxCommits: 100,
            maxIssues: 25,
            skipComments: true,
            batchSize: 100
          };

          console.log(`[Web API] Starting full pipeline for ${repository} by ${req.user.username}`);
          
          // Link this repository to the user FIRST so they see it right away
          await this.eventStore.linkUserToRepository(req.user.username, repository);

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