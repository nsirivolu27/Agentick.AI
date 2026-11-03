const el = id => document.getElementById(id);
let approvals = 0;
el("task").addEventListener("submit", async event => {
  event.preventDefault();
  if (el("run").disabled) return;
  el("run").disabled = true;
  el("output").hidden = true;
  el("status").textContent = "Reading the work item and checking its source records…";
  try {
    const params = new URLSearchParams({county: el("county").value.trim()});
    const response = await fetch("/api/analyst?" + params, {cache:"no-store"});
    if (!response.ok) throw new Error("Analyst unavailable");
    const data = await response.json();
    el("trace").replaceChildren();
    for (const call of data.trace) {
      const item = document.createElement("li");
      const details = document.createElement("details");
      const summary = document.createElement("summary");
      summary.textContent = call.tool;
      const pre = document.createElement("pre");
      pre.textContent = JSON.stringify({arguments: call.arguments, result: call.result}, null, 2);
      details.append(summary, pre);
      item.append(details);
      el("trace").append(item);
    }
    el("brief").textContent = data.brief;
    el("limit").textContent = data.limit;
    el("status").textContent = data.trace.length + " MCP calls completed. Expand a call to inspect its inputs and result.";
    approvals = 0;
    el("approve").disabled = false;
    el("approve").textContent = "Approve as Reviewer 1";
    el("decision").textContent = "Awaiting review";
    el("output").hidden = false;
  } catch {
    el("status").textContent = "The analyst could not complete the tool run. Try again.";
  } finally {
    el("run").disabled = false;
  }
});
el("approve").addEventListener("click", () => {
  approvals++;
  el("decision").textContent = approvals === 1 ? "1 of 2 approvals · Pending" : "2 of 2 approvals · Handoff complete";
  el("approve").textContent = approvals === 1 ? "Approve as Reviewer 2" : "Handoff complete";
  el("approve").disabled = approvals === 2;
});
