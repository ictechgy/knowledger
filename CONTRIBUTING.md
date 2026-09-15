# Contributing

Knowledge Consensus Ledger is licensed under MIT. Contributions use the same license.

Discuss changes to the consensus protocol, publication boundary, or authorization model before changing their behavior. Keep document content immutable and treat the schemas and protocol examples as compatibility contracts.

Use small commits with focused tests for behavior changes. Never commit credentials, private department documents, local databases, generated identities, or model prompts containing confidential information. Use fictional fixtures.

The existing design checks run without installing dependencies:

```sh
python3 -B tools/validate_design.py
python3 -B tools/check_docs.py
```

Runtime setup and verification commands will be documented in the README alongside the implementation. Describe the exact environment and commands used in a pull request; distinguish local simulation from a real Fabric network.
