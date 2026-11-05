const descriptions: Record<string, string> = {
  fema: "Manage OpenFEMA briefings and reviews",
  analyst: "Brief public data with source evidence",
  workspace: "Find your next action",
  desk: "Run work and review its output",
  "base-chat": "Ask a question or draft text",
  activity: "Trace who changed what",
  canvas: "Connect agents into a sequence",
  workflows: "Inspect stages and assignments",
  "agent-studio": "Build and test an agent",
  marketplace: "Find templates and reviewed packages",
  assistants: "Chat with a workspace assistant",
  evaluations: "Compare model-release results",
  studio: "Prepare model training",
  agents: "Review definitions served through MCP",
  documents: "Add source material to work",
  zenfluence: "Bring in Jira and Confluence evidence",
  connections: "Check model and tool access",
  mcp: "Inspect callable workspace tools",
  approvals: "Review model releases",
  workflow: "Inspect signing requirements",
  account: "Manage sign-in and plans",
  pipelines: "Edit workflow configuration",
  email: "Inspect messages before delivery",
};

export function addServiceDescriptions(root: HTMLElement): void {
  for (const link of root.querySelectorAll<HTMLAnchorElement>("a[data-route]")) {
    const description = descriptions[link.dataset.route ?? ""];
    if (!description || link.querySelector(".service-purpose")) continue;
    // Keep link names stable for keyboard and screen-reader navigation.
    const name = [...link.childNodes].filter(node => node.nodeType === Node.TEXT_NODE).map(node => node.textContent?.trim()).filter(Boolean).join(" ");
    const label = document.createElement("span");
    label.className = "service-label";
    while (link.firstChild) label.append(link.firstChild);
    const purpose = document.createElement("small");
    purpose.className = "service-purpose";
    purpose.id = `service-purpose-${link.dataset.route}`;
    purpose.textContent = description;
    if (name) link.setAttribute("aria-label", name);
    link.setAttribute("aria-describedby", purpose.id);
    link.append(label, purpose);
  }
}
