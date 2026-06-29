---
'@vicoop-bridge/client': patch
---

upgrade: resolve the latest release from the public GitHub Atom feed
(`github.com/<repo>/releases.atom`) instead of the `api.github.com` REST
API. The REST API caps unauthenticated requests at 60/hr per IP, so
`vicoop-client upgrade` / `upgrade --check` would fail with a hard
`403 rate limit exceeded` on shared provider egress IPs — exactly when
an operator is rolling out a release (#405). The web feed has its own,
far more generous anonymous limit and needs no `GITHUB_TOKEN`.
