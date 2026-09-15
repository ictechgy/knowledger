# Security

The local application is a development simulation. It binds to loopback and uses fictional, switchable personas. It does not provide production user authentication or separate organizational administration. Do not expose it through a public tunnel or reverse proxy as a production service.

Shared document bodies are deliberately replicated ledger content. Keep department-private documents in the local vault or an organization-owned source. The publication preview is an explicit disclosure step, not an automatic secret detector. Invalid Fabric transactions may still retain submitted content in blocks.

No external LLM or embedding service is called by this release. A retrieved document cannot grant tool permissions. `use-context` revalidation does not authorize arbitrary downstream actions.

For a suspected vulnerability, prepare a minimal reproduction using fictional content. Do not include credentials, private documents, cookies, or database files in public issues. A private reporting channel must be configured by the maintainer when the repository is hosted; this local repository has no public reporting endpoint yet.

See [the threat and privacy design](docs/04-SECURITY.md) and [runtime boundaries](docs/11-RUNTIME.md) before integrating real organizational identities.
