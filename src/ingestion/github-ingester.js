import { Octokit } from '@octokit/rest';
import { v4 as uuidv4 } from 'uuid';
import { EventStore } from '../storage/event-store.js';

/**
 * Phase 1: Data Ingestion (Signals Layer)
 * 
 * This class captures engineering activity as immutable events from GitHub.
 * Key principle: Store raw events, not summaries, to enable future reprocessing.
 * 
 * Why immutable events?
 * - Future-proofing: Better LLMs can reprocess the same raw data
 * - Context preservation: Summaries lose important nuance
 * - Replay capability: Reconstruct decision timelines from scratch
 * - Multiple interpretations: Same data, different query perspectives
 */
export class GitHubIngester {
  constructor(token, eventStore) {
    this.octokit = new Octokit({ auth: token });
    this.eventStore = eventStore;
  }


  async ingestRepository(owner, repo, options = {}) {
    const {
      maxPRs = 100,        // Limit PRs for faster ingestion
      maxCommits = 200,    // Limit commits
      maxIssues = 50,      // Limit issues
      skipComments = false, // Option to skip comments for speed
      batchSize = 50       // Batch database writes
    } = options;

    console.log(`🔄 Starting OPTIMIZED ingestion for ${owner}/${repo}`);
    console.log(`📊 Limits: ${maxPRs} PRs, ${maxCommits} commits, ${maxIssues} issues`);
    
    try {
      // Capture different types of engineering signals in parallel
      const startTime = Date.now();
      
      await Promise.all([
        this.ingestPullRequestsOptimized(owner, repo, maxPRs, skipComments, batchSize),
        this.ingestCommitsOptimized(owner, repo, maxCommits, batchSize),
        this.ingestIssuesOptimized(owner, repo, maxIssues, batchSize)
      ]);
      
      const duration = ((Date.now() - startTime) / 1000).toFixed(1);
      console.log(`✅ Completed OPTIMIZED ingestion in ${duration}s`);
    } catch (error) {
      console.error(`❌ Ingestion failed:`, error.message);
      throw error;
    }
  }

  /**
   * OPTIMIZED: Capture Pull Request metadata and discussions
   */
  async ingestPullRequestsOptimized(owner, repo, maxPRs, skipComments, batchSize) {
    console.log(`📥 Ingesting up to ${maxPRs} pull requests...`);
    
    // Get PRs with pagination limit
    const pulls = await this.octokit.paginate(
      this.octokit.rest.pulls.list,
      {
        owner,
        repo,
        state: 'all',
        sort: 'updated',
        direction: 'desc',
        per_page: 100
      },
      (response, done) => {
        if (response.data.length >= maxPRs) {
          done();
        }
        return response.data.slice(0, maxPRs);
      }
    );

    const limitedPRs = pulls.slice(0, maxPRs);
    console.log(`📊 Processing ${limitedPRs.length} PRs...`);

    // Batch process PRs
    const events = [];
    
    for (const pr of limitedPRs) {
      // Store the PR event
      events.push({
        type: 'pull_request',
        action: 'created',
        source: 'github',
        repository: `${owner}/${repo}`,
        data: {
          id: pr.id,
          number: pr.number,
          title: pr.title,
          body: pr.body,
          author: pr.user.login,
          state: pr.state,
          created_at: pr.created_at,
          updated_at: pr.updated_at,
          merged_at: pr.merged_at,
          closed_at: pr.closed_at,
          base_branch: pr.base.ref,
          head_branch: pr.head.ref,
          additions: pr.additions,
          deletions: pr.deletions,
          changed_files: pr.changed_files
        }
      });

      // Only get comments for recent/important PRs to save time
      if (!skipComments && (pr.state === 'open' || pr.comments > 0)) {
        try {
          const comments = await this.octokit.rest.issues.listComments({
            owner,
            repo,
            issue_number: pr.number,
            per_page: 20 // Limit comments per PR
          });

          for (const comment of comments.data) {
            events.push({
              type: 'pr_comment',
              action: 'created',
              source: 'github',
              repository: `${owner}/${repo}`,
              data: {
                id: comment.id,
                pr_number: pr.number,
                author: comment.user.login,
                body: comment.body,
                created_at: comment.created_at,
                updated_at: comment.updated_at
              }
            });
          }
        } catch (error) {
          console.warn(`⚠️ Failed to get comments for PR #${pr.number}:`, error.message);
        }
      }

      // Batch write events
      if (events.length >= batchSize) {
        await this.storeBatchEvents(events);
        events.length = 0; // Clear array
      }
    }

    // Store remaining events
    if (events.length > 0) {
      await this.storeBatchEvents(events);
    }

    console.log(`📥 Ingested ${limitedPRs.length} pull requests`);
  }

  /**
   * OPTIMIZED: Capture commits with limits
   */
  async ingestCommitsOptimized(owner, repo, maxCommits, batchSize) {
    console.log(`📥 Ingesting up to ${maxCommits} commits...`);
    
    const commits = await this.octokit.paginate(
      this.octokit.rest.repos.listCommits,
      { 
        owner, 
        repo,
        per_page: 100
      },
      (response, done) => {
        if (response.data.length >= maxCommits) {
          done();
        }
        return response.data.slice(0, maxCommits);
      }
    );

    const limitedCommits = commits.slice(0, maxCommits);
    const events = [];

    for (const commit of limitedCommits) {
      events.push({
        type: 'commit',
        action: 'created',
        source: 'github',
        repository: `${owner}/${repo}`,
        data: {
          sha: commit.sha,
          message: commit.commit.message,
          author: commit.commit.author.name,
          author_email: commit.commit.author.email,
          committer: commit.commit.committer.name,
          date: commit.commit.author.date,
          additions: commit.stats?.additions || 0,
          deletions: commit.stats?.deletions || 0,
          total_changes: commit.stats?.total || 0
        }
      });

      // Batch write
      if (events.length >= batchSize) {
        await this.storeBatchEvents(events);
        events.length = 0;
      }
    }

    // Store remaining
    if (events.length > 0) {
      await this.storeBatchEvents(events);
    }

    console.log(`📥 Ingested ${limitedCommits.length} commits`);
  }

  /**
   * OPTIMIZED: Capture issues with limits
   */
  async ingestIssuesOptimized(owner, repo, maxIssues, batchSize) {
    console.log(`📥 Ingesting up to ${maxIssues} issues...`);
    
    const issues = await this.octokit.paginate(
      this.octokit.rest.issues.list,
      {
        owner,
        repo,
        state: 'all',
        sort: 'updated',
        direction: 'desc',
        per_page: 100
      },
      (response, done) => {
        if (response.data.length >= maxIssues) {
          done();
        }
        return response.data.slice(0, maxIssues);
      }
    );

    const limitedIssues = issues.slice(0, maxIssues).filter(issue => !issue.pull_request);
    const events = [];

    for (const issue of limitedIssues) {
      events.push({
        type: 'issue',
        action: 'created',
        source: 'github',
        repository: `${owner}/${repo}`,
        data: {
          id: issue.id,
          number: issue.number,
          title: issue.title,
          body: issue.body,
          author: issue.user.login,
          state: issue.state,
          created_at: issue.created_at,
          updated_at: issue.updated_at,
          closed_at: issue.closed_at,
          labels: issue.labels.map(label => label.name)
        }
      });

      // Batch write
      if (events.length >= batchSize) {
        await this.storeBatchEvents(events);
        events.length = 0;
      }
    }

    // Store remaining
    if (events.length > 0) {
      await this.storeBatchEvents(events);
    }

    console.log(`📥 Ingested ${limitedIssues.length} issues`);
  }

  /**
   * OPTIMIZED: Batch store events for better performance
   */
  async storeBatchEvents(events) {
    const batchEvents = events.map(eventData => ({
      id: this.generateEventId(),
      timestamp: new Date().toISOString(),
      ...eventData
    }));

    // Use transaction for batch insert
    await this.eventStore.storeBatch(batchEvents);
  }

  /**
   * Generate unique event ID
   */
  generateEventId() {
    return `evt_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  /**
   * Capture Pull Request metadata and discussions
   * PRs are rich sources of decision-making context
   */
  async ingestPullRequests(owner, repo) {
    console.log(`📥 Ingesting pull requests...`);
    
    const pulls = await this.octokit.paginate(
      this.octokit.rest.pulls.list,
      {
        owner,
        repo,
        state: 'all', // Include both open and closed PRs
        sort: 'updated',
        direction: 'desc'
      }
    );

    for (const pr of pulls) {
      // Store the PR as an immutable event
      await this.storeEvent({
        type: 'pull_request',
        action: 'created',
        source: 'github',
        repository: `${owner}/${repo}`,
        data: {
          id: pr.id,
          number: pr.number,
          title: pr.title,
          body: pr.body,
          author: pr.user.login,
          state: pr.state,
          created_at: pr.created_at,
          updated_at: pr.updated_at,
          merged_at: pr.merged_at,
          closed_at: pr.closed_at,
          base_branch: pr.base.ref,
          head_branch: pr.head.ref,
          additions: pr.additions,
          deletions: pr.deletions,
          changed_files: pr.changed_files
        }
      });

      // Capture PR comments (where decisions often happen)
      await this.ingestPRComments(owner, repo, pr.number);
      
      // Capture PR reviews (approval/rejection decisions)
      await this.ingestPRReviews(owner, repo, pr.number);
    }

    console.log(`📥 Ingested ${pulls.length} pull requests`);
  }

  /**
   * Capture PR comments - often contain decision rationale
   */
  async ingestPRComments(owner, repo, prNumber) {
    const comments = await this.octokit.paginate(
      this.octokit.rest.issues.listComments,
      { owner, repo, issue_number: prNumber }
    );

    for (const comment of comments) {
      await this.storeEvent({
        type: 'pr_comment',
        action: 'created',
        source: 'github',
        repository: `${owner}/${repo}`,
        data: {
          id: comment.id,
          pr_number: prNumber,
          author: comment.user.login,
          body: comment.body,
          created_at: comment.created_at,
          updated_at: comment.updated_at
        }
      });
    }
  }

  /**
   * Capture PR reviews - explicit decision points
   */
  async ingestPRReviews(owner, repo, prNumber) {
    const reviews = await this.octokit.paginate(
      this.octokit.rest.pulls.listReviews,
      { owner, repo, pull_number: prNumber }
    );

    for (const review of reviews) {
      await this.storeEvent({
        type: 'pr_review',
        action: review.state.toLowerCase(), // approved, changes_requested, commented
        source: 'github',
        repository: `${owner}/${repo}`,
        data: {
          id: review.id,
          pr_number: prNumber,
          author: review.user.login,
          state: review.state,
          body: review.body,
          submitted_at: review.submitted_at
        }
      });
    }
  }

  /**
   * Capture commit messages - implementation decisions
   */
  async ingestCommits(owner, repo) {
    console.log(`📥 Ingesting commits...`);
    
    const commits = await this.octokit.paginate(
      this.octokit.rest.repos.listCommits,
      { owner, repo }
    );

    for (const commit of commits) {
      await this.storeEvent({
        type: 'commit',
        action: 'created',
        source: 'github',
        repository: `${owner}/${repo}`,
        data: {
          sha: commit.sha,
          message: commit.commit.message,
          author: commit.commit.author.name,
          author_email: commit.commit.author.email,
          committer: commit.commit.committer.name,
          date: commit.commit.author.date,
          additions: commit.stats?.additions || 0,
          deletions: commit.stats?.deletions || 0,
          total_changes: commit.stats?.total || 0
        }
      });
    }

    console.log(`📥 Ingested ${commits.length} commits`);
  }

  /**
   * Capture issues - problem statements and discussions
   */
  async ingestIssues(owner, repo) {
    console.log(`📥 Ingesting issues...`);
    
    const issues = await this.octokit.paginate(
      this.octokit.rest.issues.list,
      {
        owner,
        repo,
        state: 'all',
        sort: 'updated',
        direction: 'desc'
      }
    );

    for (const issue of issues) {
      // Skip pull requests (they're handled separately)
      if (issue.pull_request) continue;

      await this.storeEvent({
        type: 'issue',
        action: 'created',
        source: 'github',
        repository: `${owner}/${repo}`,
        data: {
          id: issue.id,
          number: issue.number,
          title: issue.title,
          body: issue.body,
          author: issue.user.login,
          state: issue.state,
          created_at: issue.created_at,
          updated_at: issue.updated_at,
          closed_at: issue.closed_at,
          labels: issue.labels.map(label => label.name)
        }
      });
    }

    console.log(`📥 Ingested ${issues.length} issues`);
  }

  /**
   * Store an event in the immutable event store
   * Each event gets a unique ID and timestamp
   */
  async storeEvent(eventData) {
    const event = {
      id: uuidv4(),
      timestamp: new Date().toISOString(),
      ...eventData
    };

    await this.eventStore.store(event);
  }
}