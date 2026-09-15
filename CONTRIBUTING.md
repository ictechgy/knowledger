# Contributing

Knowledge Consensus Ledger is licensed under MIT. Contributions use the same license.

Discuss changes to the consensus protocol, publication boundary, or authorization model before changing their behavior. Keep document content immutable and treat the schemas and protocol examples as compatibility contracts.

Use small commits with focused tests for behavior changes. Never commit credentials, private department documents, local databases, generated identities, or model prompts containing confidential information. Use fictional fixtures.

The local runtime and checks run without installing dependencies. Use Node.js 24+ and Python 3:

```sh
npm run check
npm run demo
```

See [runtime setup](docs/11-RUNTIME.md). Describe the exact environment and commands used in a pull request; distinguish local simulation, an injected SDK/shim test, a modeled MVCC race, and a real Fabric network.

The built-in Node TypeScript loader executes erasable TypeScript; it does not perform static type checking. Changes to the Fabric adapter also need validation against the pinned official SDK packages before an operational release. Keep generated packages, dependency directories, credentials, and runtime data out of commits.
