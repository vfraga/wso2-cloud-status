# Security policy

## Reporting a vulnerability

Do not open a public issue, pull request or discussion about a security
problem in this repository or in the WSO2 Cloud status page and its API.
Report it privately, through WSO2's published process
([Report Security Issues](https://security.docs.wso2.com/en/latest/security-reporting/report-security-issues/)):

- Email **cloud-security@wso2.com**, WSO2's confidential list for its SaaS
  products. Encrypt the report with the list's OpenPGP key, fingerprint
  `5A40 1772 ED46 127D 197B  00AB 754F 670C 1845 8E05`
  ([public key](https://keys.openpgp.org/search?q=cloud-security@wso2.com)).
- WSO2 subscription customers may instead open a confidential ticket on
  the [WSO2 Support Portal](https://support.wso2.com/).

Prepare the report as the
[Vulnerability Reporting Guidelines](https://security.docs.wso2.com/en/latest/security-reporting/vulnerability-reporting-guidelines/)
ask: the affected URL and parameters, steps to reproduce, and your
assessment of severity and impact. Do not share the details with anyone
else until WSO2 has completed mitigation. Eligible reports may be
recognised through the
[Reward and Acknowledgement Program](https://security.docs.wso2.com/en/latest/security-reporting/reward-and-acknowledgement-program/).

The page publishes the same contact at `/.well-known/security.txt`
(RFC 9116; `frontend/docker/security.txt`).

## Scope

The status API (`backend/go`), the web frontend and its nginx image, the
configuration in `config/`, and the build and release workflows in
`.github/workflows/`. A vulnerability in a product whose status the page
shows goes to the same address.

## Supported versions

The latest release in `CHANGELOG.md`, and `main`. A fix ships as a new
release; earlier releases are not patched.
