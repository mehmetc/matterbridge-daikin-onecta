# Changelog

All notable changes to this project will be documented in this file.

## [0.1.0] - 2026-07-07

First release, published to npm.

### Added

- M4: powerful/boost mode exposed as a controllable Matter on/off switch per unit (config `exposeSwitches`); room humidity exposed as a Matter humidity sensor on units that report it.
- M3 (control): thermostat setpoints, system mode (incl. off) and fan speed changes from Matter controllers are translated to Onecta PATCH commands — debounced per control (1.5 s), coalesced, serialized, applied optimistically to the Matter state and confirmed on the next poll; failed writes trigger an early resync poll.
- M2 (read-only bridge): each AC unit is exposed as a Matter thermostat (local temperature, heating/cooling setpoints with device limits, system mode incl. dry/fan-only), an outdoor temperature sensor and a fan device; attributes update on every poll.
- Climate state mapper with unit tests against a fixture captured from real dx4 units.
- Initial plugin skeleton scaffolded from the Matterbridge plugin template (M1).
- OIDC authentication against the official Daikin Onecta API via `daikin-controller-cloud`, with token persistence in the Matterbridge storage directory.
- Device discovery: fetches all gateway devices with a single API call and logs their management points, characteristics and state.
- Day/night polling scheduler with configurable intervals, automatic backoff on the Onecta daily rate limit and retry on transient errors.
- Config schema for the Matterbridge frontend (credentials, callback port, polling windows, device exposure options).
- Jest and Vitest unit tests for the platform lifecycle and helpers.
