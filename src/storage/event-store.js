import Database from 'better-sqlite3';
import { mkdir } from 'fs/promises';
import { dirname } from 'path';

/**
 * Event Store - Immutable storage for all engineering signals
 * 
 * Why SQLite?
 * - Simple deployment (single file)
 * - ACID transactions
 * - Fast queries for timeline reconstruction
 * - Easy backup and replication
 * 
 * Why immutable storage?
 * - Events are never updated, only appended
 * - Enables complete replay of decision history
 * - Supports multiple processing models over same data
 * - Maintains audit trail for compliance
 */
export class EventStore {
  constructor(dbPath = './storage/events.db') {
    this.dbPath = dbPath;
    this.db = null;
  }

  async initialize() {
    // Ensure storage directory exists
    await mkdir(dirname(this.dbPath), { recursive: true });
    
    this.db = new Database(this.dbPath);
    
    // Enable WAL mode for better concurrent access
    this.db.pragma('journal_mode = WAL');
    
    await this.createTables();
    console.log(`📦 Event store initialized at ${this.dbPath}`);
  }

  /**
   * Create the events table
   * Design principles:
   * - Single table for all event types (simplifies queries)
   * - JSON column for flexible event data
   * - Indexes for common query patterns
   */
  async createTables() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS events (
        id TEXT PRIMARY KEY,
        timestamp TEXT NOT NULL,
        type TEXT NOT NULL,
        action TEXT NOT NULL,
        source TEXT NOT NULL,
        repository TEXT NOT NULL,
        data JSON NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      -- Indexes for common query patterns
      CREATE INDEX IF NOT EXISTS idx_events_timestamp ON events(timestamp);
      CREATE INDEX IF NOT EXISTS idx_events_type ON events(type);
      CREATE INDEX IF NOT EXISTS idx_events_repository ON events(repository);
      CREATE INDEX IF NOT EXISTS idx_events_type_repo ON events(type, repository);
      
      -- Full-text search on event data (for decision extraction)
      CREATE VIRTUAL TABLE IF NOT EXISTS events_fts USING fts5(
        id UNINDEXED,
        type UNINDEXED,
        repository UNINDEXED,
        content,
        content=events,
        content_rowid=rowid
      );

      -- Trigger to keep FTS table in sync
      CREATE TRIGGER IF NOT EXISTS events_fts_insert AFTER INSERT ON events BEGIN
        INSERT INTO events_fts(rowid, id, type, repository, content)
        VALUES (new.rowid, new.id, new.type, new.repository, 
                new.data || ' ' || new.type || ' ' || new.action);
      END;

      CREATE TABLE IF NOT EXISTS users (
        username TEXT PRIMARY KEY,
        password_hash TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS user_repositories (
        username TEXT,
        repository TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (username, repository),
        FOREIGN KEY (username) REFERENCES users(username)
      );
    `);
  }

  // --- User Auth Methods ---
  async createUser(username, hash) {
    const stmt = this.db.prepare('INSERT INTO users (username, password_hash) VALUES (?, ?)');
    stmt.run(username, hash);
  }

  async getUser(username) {
    return this.db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  }

  async linkUserToRepository(username, repository) {
    if (!username) return;
    const stmt = this.db.prepare('INSERT OR IGNORE INTO user_repositories (username, repository) VALUES (?, ?)');
    stmt.run(username, repository);
  }
  
  async checkUserAccess(username, repository) {
    const result = this.db.prepare('SELECT count(*) as count FROM user_repositories WHERE username = ? AND repository = ?').get(username, repository);
    return result.count > 0;
  }
  // -------------------------

  /**
   * Store multiple events in a single transaction (OPTIMIZED)
   */
  async storeBatch(events) {
    if (events.length === 0) return;

    const stmt = this.db.prepare(`
      INSERT OR IGNORE INTO events (id, timestamp, type, action, source, repository, data)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    const transaction = this.db.transaction((events) => {
      for (const event of events) {
        stmt.run(
          event.id,
          event.timestamp,
          event.type,
          event.action,
          event.source,
          event.repository,
          JSON.stringify(event.data)
        );
      }
    });

    try {
      transaction(events);
      console.log(`📦 Stored batch of ${events.length} events`);
    } catch (error) {
      console.error('❌ Batch storage failed:', error.message);
      throw error;
    }
  }

  /**
   * Store an immutable event (LEGACY - kept for compatibility)
   */
  async store(event) {
    const stmt = this.db.prepare(`
      INSERT INTO events (id, timestamp, type, action, source, repository, data)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    try {
      stmt.run(
        event.id,
        event.timestamp,
        event.type,
        event.action,
        event.source,
        event.repository,
        JSON.stringify(event.data)
      );
    } catch (error) {
      if (error.code === 'SQLITE_CONSTRAINT_PRIMARYKEY') {
        // Event already exists (idempotent ingestion)
        return;
      }
      throw error;
    }
  }

  /**
   * Query events by type and repository
   */
  async getEvents(filters = {}) {
    let query = 'SELECT * FROM events WHERE 1=1';
    const params = [];

    if (filters.type) {
      query += ' AND type = ?';
      params.push(filters.type);
    }

    if (filters.repository) {
      query += ' AND repository = ?';
      params.push(filters.repository);
    }

    if (filters.after) {
      query += ' AND timestamp > ?';
      params.push(filters.after);
    }

    if (filters.before) {
      query += ' AND timestamp < ?';
      params.push(filters.before);
    }

    query += ' ORDER BY timestamp DESC';

    if (filters.limit) {
      query += ' LIMIT ?';
      params.push(filters.limit);
    }

    const stmt = this.db.prepare(query);
    const rows = stmt.all(...params);

    return rows.map(row => ({
      ...row,
      data: JSON.parse(row.data)
    }));
  }

  /**
   * Search events by content (for decision extraction)
   */
  async searchEvents(searchTerm, filters = {}) {
    let query = `
      SELECT events.* FROM events_fts
      JOIN events ON events.rowid = events_fts.rowid
      WHERE events_fts MATCH ?
    `;
    const params = [searchTerm];

    if (filters.repository) {
      query += ' AND events.repository = ?';
      params.push(filters.repository);
    }

    if (filters.type) {
      query += ' AND events.type = ?';
      params.push(filters.type);
    }

    query += ' ORDER BY events.timestamp DESC';

    if (filters.limit) {
      query += ' LIMIT ?';
      params.push(filters.limit);
    }

    const stmt = this.db.prepare(query);
    const rows = stmt.all(...params);

    return rows.map(row => ({
      ...row,
      data: JSON.parse(row.data)
    }));
  }

  /**
   * Get event statistics
   */
  async getStats(filterUsername = null) {
    let repoCondition = "";
    const params = [];
    if (filterUsername) {
      repoCondition = "WHERE repository IN (SELECT repository FROM user_repositories WHERE username = ?)";
      params.push(filterUsername);
    }
    
    const totalEvents = this.db.prepare(`SELECT COUNT(*) as count FROM events ${repoCondition}`).get(...params);
    
    const eventsByType = this.db.prepare(`
      SELECT type, COUNT(*) as count 
      FROM events 
      ${repoCondition}
      GROUP BY type 
      ORDER BY count DESC
    `).all(...params);

    const eventsByRepo = this.db.prepare(`
      SELECT repository, COUNT(*) as count 
      FROM events 
      ${repoCondition}
      GROUP BY repository 
      ORDER BY count DESC
    `).all(...params);

    let finalRepos = eventsByRepo;
    if (filterUsername) {
      const userRepos = this.db.prepare('SELECT repository FROM user_repositories WHERE username = ?').all(filterUsername);
      const repoMap = new Map(eventsByRepo.map(r => [r.repository, r]));
      finalRepos = userRepos.map(ur => {
        if (repoMap.has(ur.repository)) {
           return repoMap.get(ur.repository);
        } else {
           return { repository: ur.repository, count: 0 };
        }
      });
      finalRepos.sort((a,b) => b.count - a.count);
    }

    return {
      total: totalEvents.count,
      byType: eventsByType,
      byRepository: finalRepos
    };
  }

  /**
   * Get events in a time range (for timeline reconstruction)
   */
  async getEventTimeline(repository, startDate, endDate) {
    const stmt = this.db.prepare(`
      SELECT * FROM events 
      WHERE repository = ? 
        AND timestamp BETWEEN ? AND ?
      ORDER BY timestamp ASC
    `);

    const rows = stmt.all(repository, startDate, endDate);
    
    return rows.map(row => ({
      ...row,
      data: JSON.parse(row.data)
    }));
  }

  close() {
    if (this.db) {
      this.db.close();
    }
  }
}