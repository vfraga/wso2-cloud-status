# Contributing

- Branch from `main`; open a pull request. CI must pass.
- Commit messages follow Conventional Commits (`feat:`, `fix:`, `docs:`,
  `chore:`, `test:`, `refactor:`, `ci:`).
- Run `make verify` (every local gate; `make -k verify` lists every
  failure) before pushing. Only CI runs gitleaks, Trivy and the statusd
  image build and smoke test.
- API changes update `api/openapi.yaml` in the same pull request.
- Never raise a lint threshold or add a `//nolint` without a written reason.
- Every source file carries the license header (`make headers` and the
  compliance job check it).
