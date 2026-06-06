# LogBrew SDK Readiness Memory

- 2026-06-07: All initial `0.1.0` public package marketplaces are live and verified: npm JS packages, PyPI core/FastAPI/Django packages, NuGet `LogBrew`, RubyGems, Packagist, crates.io, Maven Central Java/Kotlin artifacts, and OpenUPM Unity package.
- 2026-06-07: Published GitHub Releases now own repeat package updates through `publish-release.yml`, which dispatches `publish-packages.yml` with real `target=all`, PyPI extras, crates, Packagist, and Maven Central enabled. Manual dispatch remains dry-run-safe by default.
- 2026-06-07: Packagist auto-updates from GitHub; optional Packagist update-hook settings can speed up refresh, but absence is non-blocking because the workflow verifies the public registry after retries.
- 2026-06-07: Maven Central repeat automation has release-environment auth and signing settings configured. Local signed Central bundle proof built 80 entries; the next versioned GitHub Release is the first real automated Central upload proof because `0.1.0` cannot be uploaded again.
- 2026-06-07: User granted standing permission for autonomous commits, pushes, tags, GitHub Releases, and public registry package publishing when thermo-nuclear review, verifier evidence, and GitHub Actions are healthy. Resolve blockers first with available GitHub/Chrome/Computer access, then report only if blocked.
