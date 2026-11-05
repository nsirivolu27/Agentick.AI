import type { ChatAccessSummary } from "./chat-access.js";

export function integrationGuide(access?: ChatAccessSummary): string {
  const free = access?.tier === "free";
  return `<section class="panel account-panel" aria-labelledby="integration-start">
    <h2 id="integration-start">${free ? "Start with Free" : "Start with your connections"}</h2>
    <p>Use local models or your own API keys. No Agentick subscription is required for those chat connections. Provider and hosting costs remain yours.</p>
    <ol>
      <li><strong>Choose a model.</strong> ${access ? "Use a server model below or verify a personal API key." : "Configure chat access on the local or company server."}</li>
      <li><strong>Test chat.</strong> <a href="#/base-chat">Send a short request</a> and check the reported tokens.</li>
      <li><strong>Add evidence.</strong> <a href="#/documents">Save a reference document</a>, then use Ask Agent to draft an answer.</li>
      <li><strong>Build a workflow.</strong> <a href="#/agent-studio">Prepare and test an agent</a> before requesting approval.</li>
    </ol>
    <details><summary>What Free includes</summary>
      <p>Manual model selection, local model access, personal OpenAI / Claude / Gemini API connections, and revocable chat MCP access when configured.</p>
      <p>Personal keys belong to one member in one workspace. Scheduled agents use administrator-configured models, not personal keys. Workspace roles, tool grants and approval gates still apply.</p>
      <p>Free does not include managed model credits or managed Auto routing. Pro and Max require verified billing and a configured model plan. There is no promise of unlimited usage or a free hosted company workspace.</p>
      <p>Email sign-in identifies you; it does not connect a model account. Use an API key authorized for the selected models.</p>
    </details>
    <details><summary>Workspace integrations</summary>
      <p>These are setup destinations, not connection health checks; the directory above shows each connector's current state.</p>
      <ul>
        <li><a href="#/zenfluence">Jira and Confluence</a> — read tickets and pages; attach reviewed evidence. Jira delivery is separately configured. Confluence publishing is not implemented.</li>
        <li><a href="#/documents">Reference documents</a> — save text and attach it to work. No external account required.</li>
        <li><a href="#/mcp">MCP tools</a> — inspect approved tools and access. External servers require administrator setup.</li>
        <li><a href="#/analyst">Public data analyst</a> — inspect public-data evidence. Live company workflows require a configured Foundry mapping.</li>
        <li><a href="#/pipelines">Workflow operations</a> — inspect stages and delivery evidence. Lambda invocation uses a separate admin API.</li>
        <li><a href="#/account">Account and company access</a> — inspect sign-in and billing configuration. Email domains never grant membership.</li>
      </ul>
    </details>
    <details><summary>Chat REST API</summary>
      <p>Use the authenticated session for the current workspace. Do not put provider keys in chat messages.</p>
      <dl>
        <dt>GET <code>/api/chat/access</code></dt><dd>Plan, saved connections and MCP credential expiry; no secrets.</dd>
        <dt>GET <code>/api/chat/models</code></dt><dd>Models available to this member. Listed access is not an inference test.</dd>
        <dt>POST <code>/api/chat/connections</code></dt><dd>Connect or disconnect a personal provider. The form below supplies the validated request.</dd>
        <dt>POST <code>/api/base-chat</code></dt><dd>General chat without workspace tools.</dd>
        <dt>POST <code>/api/chat</code></dt><dd>Workspace chat with authorized read tools.</dd>
        <dt>POST <code>/api/chat/access</code></dt><dd>Issue or revoke a seven-day credential for <code>/api/chat-mcp</code>.</dd>
      </dl>
      <p>Configuration and membership are required. A missing connector is not a successful empty result. Provider usage may be unknown; never interpret that as zero cost.</p>
    </details>
  </section>`;
}
