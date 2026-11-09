import { escape } from "./ui.js";

export function zenfluenceGuide(project = "PROJECT"): string {
  const read = JSON.stringify({ action: "read", source: { kind: "jira", id: `${project}-123` } }, null, 2);
  const attach = JSON.stringify({ action: "attach", source: { kind: "confluence", id: "123456" },
    runId: "<work-item UUID>", expectedRevision: 1, expectedSourceHash: "<contentHash from read>" }, null, 2);
  return `<section class="panel zen-guide" aria-label="Integration guide">
    <div class="zen-head"><h2>Use connected evidence</h2><a href="#/documents">Reference documents</a></div>
    <ol class="zen-journey">
      <li><strong>1. Read</strong><span>Paste a ticket or page link.</span></li>
      <li><strong>2. Attach</strong><span>Save its snapshot to a work item.</span></li>
      <li><strong>3. Review</strong><span>Check the answer and citations.</span></li>
      <li><strong>4. Deliver</strong><span>Review a separate outbound action.</span></li>
    </ol>
    <p class="text-3">Example: use a service request and its runbook to draft a response for the service desk.</p>
    <details><summary>Send work back to Jira or Confluence</summary>
      <p>Attaching a source does not send the answer back. Configure a Jira-enabled workflow, then open its saved event in <a href="#/pipelines">Workflow operations</a> to review the destination and exact action before delivery.</p>
      <p>Jira delivery needs its own configured adapter and authorized reviewer. Preview mode saves locally. Confluence page publishing is not implemented.</p>
    </details>
    <details><summary>REST API guide</summary>
      <p>These are Agentick endpoints. Use your deployment’s authenticated workspace session; never send an Atlassian API token to them. Membership is checked on every request; the server selects the workspace.</p>
      <dl class="zen-facts">
        <div><dt>GET</dt><dd><code>/api/zenfluence</code> — configuration status, not an upstream connectivity test.</dd></div>
        <div><dt>POST</dt><dd><code>/api/zenfluence</code> — JSON read or attach request.</dd></div>
      </dl>
      <p>Read a source:</p><pre>${escape(read)}</pre>
      <p>Or use <code>source.kind: "link"</code> and the full Jira / Confluence URL as <code>source.id</code>. Only the configured site is accepted.</p>
      <p>The response includes <code>kind</code>, <code>id</code>, <code>title</code>, <code>text</code>, <code>url</code>, <code>revision</code>, <code>contentHash</code>, <code>retrievedAt</code> and <code>truncated</code>.</p>
      <p>Attach using the current work-item revision and returned source hash:</p><pre>${escape(attach)}</pre>
      <p>Only the owning author or an admin can attach. A changed source or work item returns 409; read it again before retrying. Unauthenticated calls return 401; missing membership or prohibited access returns 403. An unavailable connector returns 404.</p>
      <p><a href="https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issues/" target="_blank" rel="noopener noreferrer">Jira REST reference ↗</a> ·
      <a href="https://developer.atlassian.com/cloud/confluence/rest/v2/api-group-page/" target="_blank" rel="noopener noreferrer">Confluence REST reference ↗</a></p>
    </details>
    <details><summary>Access and data handling</summary>
      <p>Every workspace member reads through the configured service account. This is shared access, not personal Atlassian sign-in. Use an account limited to the approved project and space.</p>
      <p>Reads retain a source URL, revision, retrieval time and fingerprint. Excerpts over 4,500 characters are labelled. A snapshot is not a live sync.</p>
      <p>This adapter supports Atlassian Cloud site-based API tokens. OAuth, Data Center and government-specific endpoints are not supported. Agency approval, data classification and hosting authorization must be established before using controlled data.</p>
    </details>
    <details><summary>Other workspace sources</summary>
      <p><a href="#/documents">Reference documents</a> — add approved text.
      <a href="#/mcp">MCP tools</a> — inspect workspace tools.
      <a href="#/analyst">Public data analyst</a> — inspect data evidence and its source.</p>
      <p>Each connector needs its own configuration and permissions. Model sign-in does not connect company data.</p>
    </details>
  </section>`;
}
