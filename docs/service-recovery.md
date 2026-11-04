# Service operation and recovery

## Deployment boundary

The Vercel presentation and bundled public analyst endpoint are separate from
the persistent company application. Preserve the presentation design and
existing connection. A successful static deployment is not evidence that the
company backend, workers, identity provider or external actions are configured.

The current filesystem stores require a single writer and a durable local
volume. Do not scale independent containers against the same files or use
ephemeral serverless storage for company state. Before multi-instance rollout,
move state and delivery reservations into a transactional shared database,
use a durable queue, and verify distributed idempotency and tenancy controls.
The existing root Dockerfile serves the stateless relay adapter, not the full
company application.

## Workflow recovery drill

Stop the application writer first. Keep the original directory untouched.
Use the same workspace ID and restore into a new directory:

```sh
corepack pnpm build:workbench
corepack pnpm workflow:backup backup /private/state team /private/backups/team.json
corepack pnpm workflow:backup restore /private/restored-state team /private/backups/team.json
```

The command uses the store's exclusive lock, writes new backups with private
file permissions, verifies the checksum and audit evidence, and refuses to
overwrite an existing workspace. Protect backups as sensitive data. A checksum
detects changes but is not a digital signature or proof of factual accuracy.
The command caps files at 64 MB; exceeding this is a signal to reassess storage,
not to silently omit records.

Start a separate application instance against the restored directory. Check
saved run IDs, output revisions, frozen sources and approval counts. Export an
audit package and run `corepack pnpm audit:verify <package.json>`. Keep external
writes disabled during the drill. Do not clear delivery reservations or blindly
retry a delivery whose upstream outcome is unknown.

This utility covers workflow configuration, runs and their Jira/automation
delivery records. It does **not** back up separate analyst jobs, company
directory, model/test stores, ontology, billing, provider vaults or source
repositories. A complete service backup requires a quiesced snapshot of every
configured durable store and its source corpus, plus a separately controlled
secret-manager recovery procedure. Never include raw secrets in a shared
report or repository.

## External services and health

Use authenticated read-only application checks and the existing relay health
endpoint for their respective services. Health is not proof of provider
authorization, Foundry mappings, billing or successful external delivery.
Membership revocation, tenant boundaries, restart behavior, writer locks,
idempotency and partial delivery are covered by repository tests; production
credentials and real organization setup still require deployment-specific
checks. Keep configured/unconfigured and live/replay labels truthful.

## AWS preparation

`deploy/aws-backup-foundation.json` is an unprovisioned CloudFormation artifact
for a private, encrypted, versioned backup bucket with TLS enforcement and
retention on stack removal. It creates no application, identities or access
grants. Review region, cost, retention, data residency, customer-managed KMS,
Object Lock and restoration roles before any deployment. Grant the backup
writer only the required object prefix; use a separate audited restore role.
Do not infer federal compliance or authorization from these controls.
