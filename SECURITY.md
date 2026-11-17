# Security policy

Windkeel runs code it did not write: the verifier executes a pull request's checks, and the factory
runs a coding agent in a sandbox. Security reports are the most valuable reports we get.

## Reporting a vulnerability

Please report privately through GitHub:
**[Report a vulnerability](https://github.com/jyothepro/windkeel/security/advisories/new)**.
Do not open a public issue, discussion or pull request for a vulnerability.

Include what you found, how to reproduce it, and what an attacker could do with it. A proof of
concept against your own repository or deployment is welcome.

## What to expect

| Step | Target |
| --- | --- |
| Acknowledgement | 3 business days |
| First assessment and severity | 7 business days |
| Fix or mitigation for critical and high severity | 30 days |
| Public advisory | When a fix is released, with credit if you want it |

We will keep you informed while we work on it, and we will not take legal action against good-faith
research that follows this policy.

## In scope

- The `windkeel` CLI and the verification engine (`packages/cli`, `packages/verification`)
- The GitHub Action (`action.yml`), including a candidate pull request escaping the `verify` job,
  reading the model key or OIDC token, or forging an evidence package that `verify-package` accepts
- The factory: sandbox escape, crossing from the maker into the verifier, credential exposure,
  tenancy bypass between accounts or organizations, and billing manipulation
- The managed service's control-plane API and console

The README's "In GitHub Actions" section describes what a single Actions job cannot guarantee.
A report that only restates those documented limits is out of scope, but a way around the
two-job `verify` / `seal` setup is very much in scope.

## Out of scope

- Findings that need a compromised maintainer account or a malicious workflow author
- Denial of service by volume against the managed service
- Missing hardening headers with no demonstrated impact
- Vulnerabilities in dependencies with no path to exploit them in Windkeel

## Supported versions

Security fixes go to the latest release of the CLI and the Action, and to the managed service.
Pin the Action to a commit SHA and update when an advisory is published.
