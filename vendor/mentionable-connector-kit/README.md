# Vendored connector-kit OAuth federation contract

This directory contains the OAuth federation wire registry, request evaluator,
and reference verifier from `planetarium/mentionable` commit
`f32c8898c7d81b254ec9a562ea2892525db14de6` (`packages/connector-kit`).

The upstream package is a `0.0.0` unpublished workspace package whose
`workspace:*` dependencies cannot currently be installed from a consumer
repository. Only the dependency-free OAuth contract files needed by the
bridge STS are vendored here, byte-for-byte; `index.ts` and `signing.ts` are
minimal export facades. Replace this package with the published upstream
artifact once one exists.
