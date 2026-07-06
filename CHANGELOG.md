# Changelog

All notable changes to this project will be documented in this file.

## [0.1.0] - 2026-07-06 (unreleased)

### Added

- Initial plugin skeleton scaffolded from the Matterbridge plugin template (M1).
- OIDC authentication against the official Daikin Onecta API via `daikin-controller-cloud`, with token persistence in the Matterbridge storage directory.
- Device discovery: fetches all gateway devices with a single API call and logs their management points, characteristics and state.
- Day/night polling scheduler with configurable intervals, automatic backoff on the Onecta daily rate limit and retry on transient errors.
- Config schema for the Matterbridge frontend (credentials, callback port, polling windows, device exposure options).
- Jest and Vitest unit tests for the platform lifecycle and helpers.
