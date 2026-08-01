# LogBrew SDK Agent Guide

This public guide applies to the whole repository.

## Find the current source of truth

- Read the root `README.md`, affected package docs and manifest, shared
  contracts, and relevant workflow. Preserve unrelated or unmerged work.
- Run `python3 scripts/ci_changed_areas.py <changed-path>...` to identify the
  current family ownership. Manifests, existing scripts, and
  `.github/workflows/ci.yml` own exact build, test, lint, and format commands.
- Prefer existing verifiers over a second implementation. Keep disposable
  installs and build output outside the repository unless a script isolates
  them.

## Ownership boundaries

- Top-level family directories own public APIs, packaging, examples, and
  focused tests. Framework integrations stay thin over their ecosystem core.
- Keep validation, encoding, queue, retry, transport, flush, and shutdown in the
  canonical core or shared runtime; do not copy a client into an adapter.
- `spec/event-batch.schema.json`, `fixtures/`, and repository-level contract
  tests own cross-family wire behavior. Change the canonical contract first,
  then update every affected family.

## Choose evidence by change and risk

- Add the smallest focused failing test before changing behavior. Cover the
  relevant success, failure, retry, shutdown, or restart boundary.
- Run the affected family's native and package checks selected by CI. Shared
  runtime, schema, fixture, metadata, or workflow changes require focused
  repository contracts plus every affected family.
- Scale realism with risk: source checks for local changes, installed consumers
  for packages, separate-process recovery for persistence or concurrency, and
  exact public artifact identity plus readback for release claims.
- Stop at the first unexpected failure, find its cause, and rerun only the
  failed scoped check after correction. Do not mass-format unrelated files or
  disable strict rules to hide a design problem.
- Before handoff, final diff hygiene and the repository confidentiality checks
  must be green. Documentation changes also require the repository link check;
  scripts and workflows own their exact invocations.

## Public API and release evidence

- Preserve documented defaults, supported runtime or compiler floors, exported
  names, package-manager entry points, and architecture compatibility unless
  the task explicitly changes the public contract.
- Keep packages dependency-light. Prefer the standard library or an existing
  core seam over a new production dependency.
- Source tests, examples, fixtures, and dry runs do not prove a published
  package. Bind release claims to the exact installed source and version, then
  to protected CI, registry identity, and readback as required.
- Release scope is explicit. Do not change versions, locks, tags, selectors, or
  unrelated packages unless they are in scope. Follow the public release docs
  and tear down only resources created by the check.

## Code Review Rules

- Flag framework code that duplicates a canonical core or shared runtime, and
  flag cross-family wire changes that bypass the schema, fixtures, or contract
  tests.
- Flag unscoped public API or runtime-floor breaks, telemetry that broadens
  collection without explicit bounds and redaction, and release claims not
  tied to the exact installed public artifact.
- The safe path is to change the canonical owner, add the closest focused
  regression, fan out contract changes to every affected family, and run the
  checks selected for those paths. Keep fully mechanical policy in scripts or
  CI rather than expanding this guide.

## Public history and data boundaries

- Branch names, commits, PR text, fixtures, and CI logs are public. Use only the
  placeholder vocabulary already established in public docs and tests.
- Never commit access values, real user or project data, machine-specific paths,
  non-public links, unpublished research, task context, planning artifacts, or
  non-public release evidence.
- Keep telemetry conservative: no authorization values, payload bodies, query
  strings, raw stack text, local paths, or unbounded/high-cardinality metadata
  unless a documented public opt-in contract requires and tests it.
- Review the full proposed commit range, changed paths, staged content, and
  final diff before publishing. Remove generated artifacts before the final
  confidentiality scan.
- Do not add `CLAUDE.md`, task-state files, or planning files.
