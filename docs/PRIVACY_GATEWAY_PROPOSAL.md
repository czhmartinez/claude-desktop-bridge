# Proposal: Local Privacy Gateway for Automation Agents

**Status: proposed specification; not implemented or security-validated.**
**Initial implementation target:** a public, reviewable first milestone suitable for Devin to work on once access is available.

## Goal

Provide automation agents with a narrow, authenticated interface for approved, task-scoped structured information without granting access to raw prompt logs or the existing Bridge runtime APIs. The existing encrypted transport relay and cross-runtime handoff are separate systems; this proposal does not change their guarantees or approvals.

## Trust boundaries

1. Bridge and native agent runtimes retain their existing ownership and permissions.
2. A future local extraction service may process explicitly authorized conversation sources inside a trusted environment. Extraction, ontology storage and ingestion are outside the first milestone.
3. The gateway exposes only explicitly approved projections. A distilled fact can still be sensitive and is denied by default. It must never forward arbitrary text, full conversation history, credentials or attachments.
4. A cloud agent cannot reach the user's loopback address directly. A future authenticated tunnel could connect to a separately restricted gateway, not the Bridge runtime port. Cloud processing can see anything explicitly returned to it. No tunnel is included in this milestone.
5. Loopback binding alone does not protect against hostile local processes or a compromised host. The first milestone does not claim protection against compromise of the OS, gateway, or authorized endpoint.

## Day-one scope

- Use Node.js >= 22.13 and TypeScript in the existing npm workspace, with Vitest tests.
- Create a separate service bound only to 127.0.0.1 by default; reject non-loopback listen configuration in the prototype.
- Provide authenticated, read-only `GET /v1/health` and `GET /v1/synthetic-memories`; no ingestion endpoint or real data store.
- Require an explicitly provisioned high-entropy bearer credential on every endpoint, including health; compare secrets using a constant-time primitive and never log tokens. Bind each credential to an explicit capability allowlist. Missing configuration fails closed.
- Return only bounded, fixed-schema synthetic records from a fixture bundled with the service. No client-selected paths, queries over real sources, arbitrary content or passthrough.
- Reject unknown routes, methods, malformed inputs, oversized requests and unknown fields. Validate Host and Origin where applicable to resist browser-origin abuse; reject permissive CORS.
- Expose no transcript, log, file, shell, approval, message-send, agent-control, session, or ontology database endpoint. Do not forward to the existing loopback APIs.
- Audit only event type, time, opaque principal, capability, outcome and request identifier. Do not include headers, request/response bodies, prompt content, paths, or secrets. Error responses must not echo input.
- Document local launch, configuration, API schema, limitations and teardown. No production-ready or end-to-end privacy guarantee is implied.

## Acceptance tests

1. Missing, invalid and insufficient-capability credentials are denied; failure does not expose fixtures or secrets.
2. Correctly authorized calls return only the documented synthetic schema within fixed size bounds.
3. Transcript, file, shell, runtime, arbitrary proxy and control routes remain unavailable, including path traversal and malformed-method cases.
4. Invalid Host/Origin, browser-origin requests, oversized input and unsupported methods fail closed.
5. Plant unique canary strings in a mock prompt log and credential; exercise all gateway endpoints and failure paths. Assert they do not appear in responses, gateway audit output, or captured outbound traffic. Tests demonstrate only the tested paths and environment.
6. Verify the listener uses loopback only and automated tests are reproducible without real accounts or prompt logs.

## Later work

Design an authorized local extraction pipeline, provenance and deletion propagation, sensitive-fact classification, task-scoped projections, revocation, authenticated remote access and independent threat review. Any external model used for extraction or consumption receives the data explicitly sent to it; local processing is needed if raw prompts must remain local.

## Delivery

A subsequent implementation PR should include code, security tests and a runnable synthetic demo, with limitations stated honestly. This proposal is not evidence that Devin has already built, connected to, or verified the gateway.
