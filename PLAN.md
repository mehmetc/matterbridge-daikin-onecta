# Plan: `matterbridge-daikin-onecta`

A Matterbridge dynamic-platform plugin that bridges Daikin Onecta cloud devices
(AC units, Altherma heat pumps, hot water tanks) into Matter, so they appear in
Apple Home, Alexa, Google Home, SmartThings, Home Assistant, etc.

Reference implementation for behavior: [jwillemsen/daikin_onecta](https://github.com/jwillemsen/daikin_onecta) (Home Assistant).

---

## 1. Key research findings

| Topic              | Finding                                                                                                                                                                                                                                                                                                          | Consequence                                                                                                                                                                                                                                                                                                  |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Plugin framework   | Matterbridge plugins are TypeScript on matter.js; official [plugin template](https://github.com/Luligu/matterbridge-plugin-template) with dev container, Jest/Vitest, CI. `matterbridge` must **not** be a dependency (use `npm link matterbridge` for dev).                                                     | Scaffold from the template; name must start with `matterbridge-`.                                                                                                                                                                                                                                            |
| API client         | [`daikin-controller-cloud`](https://github.com/Apollon77/daikin-controller-cloud) v2.4.x is an actively maintained TypeScript library for the official Onecta developer-portal API: OIDC flow, automatic token refresh (`token_updated` event / `oidcTokenSetFilePath`), device model, `setData()`. Node ≥ 18.2. | We do **not** write our own HTTP/auth layer.                                                                                                                                                                                                                                                                 |
| Rate limit         | Onecta API allows **200 calls/user/day** (dev apps can request 1000/day; production stays at 200). Exceeding it blocks for the rest of the day.                                                                                                                                                                  | The single most important design constraint. One `GET /v1/gateway-devices` returns _all_ devices, so polling cost is independent of device count. 200/day ≈ one poll every ~7.5 min with zero writes; realistic budget: poll every 10–15 min daytime, 30–60 min at night, leaving headroom for PATCH writes. |
| Data model         | Gateway devices → `managementPoints` (`climateControl`, `domesticHotWaterTank`, `gateway`) → characteristics (`onOffMode`, `operationMode`, `temperatureControl`, `sensoryData`, `fanControl`, consumption data). Reads: `GET /v1/gateway-devices`. Writes: `PATCH` per characteristic.                          | Clean mapping surface to Matter endpoints.                                                                                                                                                                                                                                                                   |
| Controller support | Apple Home: thermostats fine, appliances/water-heater device types not shown. Alexa: no appliances, max 50 devices. Google: partial. Home Assistant: full Matter 1.2–1.4 coverage.                                                                                                                               | Default to the widely supported **Thermostat** device type; gate newer device types (Water Heater, energy measurement) behind config options.                                                                                                                                                                |

## 2. Architecture

```
┌────────────────────────────  matterbridge-daikin-onecta  ───────────────────────────┐
│                                                                                     │
│  DaikinOnectaPlatform (MatterbridgeDynamicPlatform)                                 │
│    ├── OnectaClient wrapper around daikin-controller-cloud                          │
│    │     • OIDC auth + token persistence (plugin storage dir)                       │
│    │     • Poll scheduler (day/night intervals, post-write suppression)             │
│    │     • Rate-limit accounting (x-ratelimit headers, 429 backoff)                 │
│    │     • Write queue with debounce/coalescing                                     │
│    ├── DeviceMapper: managementPoint → MatterbridgeEndpoint(s)                      │
│    │     • climateControl        → Thermostat (+ optional Fan endpoint)             │
│    │     • sensoryData           → Temperature/Humidity sensor endpoints            │
│    │     • domesticHotWaterTank  → Water Heater (opt-in) or heat-only Thermostat    │
│    │     • powerful/econo/streamer → On/Off switch endpoints (opt-in)               │
│    └── Lifecycle: onStart / onConfigure / onShutdown / onConfigChanged / onAction   │
└─────────────────────────────────────────────────────────────────────────────────────┘
```

- **Platform type:** `MatterbridgeDynamicPlatform` — device list comes from the cloud at runtime.
- **State flow, cloud → Matter:** poll result diffed against cached state; only changed Matter attributes are updated.
- **State flow, Matter → cloud:** command handler → write queue (debounced ~1.5 s so a setpoint drag becomes one PATCH) → `setData()` → **optimistic** local attribute update → suppress next poll for ~30 s (same trick the HA integration uses).
- **Identity:** Matter serial = `<gatewayDeviceId>-<managementPoint embeddedId>` so endpoints stay stable across restarts and re-pairs.

## 3. Authentication & onboarding UX

Same model as the HA integration — each user brings their own credentials:

1. User registers at the [Daikin Developer Portal](https://developer.cloud.daikineurope.com), creates an app, gets OAuth client ID + secret.
2. User enters client ID/secret in the plugin config (Matterbridge frontend, driven by our `.schema.json`).
3. First run: plugin starts the library's OIDC flow; the authorization URL is surfaced in the Matterbridge frontend (log + `onAction` button). The redirect URI/callback is handled by `daikin-controller-cloud`'s built-in flow — verify in Phase 1 exactly which redirect URI the portal app must be configured with and document it in the README.
4. Token set persisted to the plugin's storage directory; refreshed automatically thereafter. Never logged (Daikin ToS prohibits sharing tokens).

## 4. Matter device mapping

### climateControl → Thermostat endpoint

| Onecta                                                           | Matter Thermostat cluster                                                                                                          |
| ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `sensoryData/roomTemperature`                                    | `localTemperature`                                                                                                                 |
| `temperatureControl` setpoints (per operation mode)              | `occupiedHeatingSetpoint` / `occupiedCoolingSetpoint` (+ min/max from schema)                                                      |
| `operationMode` (heating/cooling/auto/dry/fanOnly) + `onOffMode` | `systemMode` (Off/Heat/Cool/Auto); dry/fanOnly have no Thermostat equivalent → expose via optional Fan endpoint or ignore (config) |
| unit `on/off`                                                    | `systemMode = Off`                                                                                                                 |

- **Fan control (optional, default on for AC units):** separate Fan device endpoint mapped to `fanControl` (speed levels → `FanControl` percent/mode).
- Out-of-scope for Thermostat: swing, powerful/econo — exposed as optional switches.

### sensoryData → sensor endpooints

- `outdoorTemperature` → Temperature Sensor endpoint (very useful, free — comes in the same GET).
- `leavingWaterTemperature` (Altherma) → Temperature Sensor.
- Room humidity where present → Humidity Sensor.

### domesticHotWaterTank → config choice

- **Default:** heat-only Thermostat (tank temp + setpoint + on/off) — works everywhere.
- **Opt-in:** Matter 1.3 Water Heater device type for Home Assistant users.
- `powerfulMode` (boost) → optional On/Off switch.

### Phase-2 extras

- Energy consumption data → Electrical Energy Measurement cluster (Matter 1.3; HA/SmartThings only).
- `streamer`, `econo`, holiday mode → switches.

## 5. Rate-limit strategy (the crux)

- Configurable **day/night polling** (defaults: 10 min 07:00–22:00, 30 min otherwise ≈ 120 calls/day, leaving ~80 for writes).
- **Post-write suppression** + optimistic updates: no refetch after a command.
- **Write coalescing:** debounce per characteristic; drop superseded writes.
- **Quota accounting:** read rate-limit response headers; when remaining budget is low, stretch the poll interval automatically; on 429, stop polling until the daily window resets and log clearly.
- Expose remaining quota + last-poll time in the Matterbridge frontend (log lines / plugin config info).

## 6. Repository & project setup

- Repo: `matterbridge-daikin-onecta` (GitHub), cloned from [matterbridge-plugin-template](https://github.com/Luligu/matterbridge-plugin-template).
- TypeScript strict, Node ≥ 20, Jest/Vitest from template, ESLint/Prettier from template.
- `package.json`: `daikin-controller-cloud` as the only runtime dependency (plus whatever the template mandates); `matterbridge` only linked, never a dependency.
- `matterbridge-daikin-onecta.config.json` + `.schema.json`:
  - `clientId`, `clientSecret` (secret-typed field)
  - `pollingIntervalDay` / `pollingIntervalNight` / `dayStart` / `dayEnd`
  - `exposeOutdoorTemperature`, `exposeFan`, `exposeSwitches`, `waterHeaterMode` (`thermostat` | `waterHeater` | `off`)
  - `deviceBlacklist` (by gateway id)
- CI: template's GitHub workflows (build, lint, test); publish to npm on tag; later, request listing in the Matterbridge community plugin list.

## 7. Milestones

1. **M1 – Scaffold + auth (foundation).** Template cloned, config schema in place, OIDC flow works end-to-end, token persisted, `GET /v1/gateway-devices` logged. _Exit: plugin loads in Matterbridge and prints the device tree._
2. **M2 – Read-only bridge.** Thermostat + temperature sensor endpoints appear in a Matter controller with live (polled) values; day/night poll scheduler. _Exit: values visible in Apple Home / HA and update on poll._
3. **M3 – Control.** Setpoint, mode, on/off writes with debounce, optimistic updates, post-write poll suppression. _Exit: controlling from a Matter controller changes the real unit; quota stays within budget over 24 h._
4. **M4 – Full device coverage.** DHW tank, fan speed, optional switches, multi-unit/multi-management-point handling.
5. **M5 – Hardening + release.** Rate-limit backoff paths, unit tests against captured API fixtures, README (portal setup walkthrough), npm publish, submit to community plugin list.

## 8. Testing

- **Unit:** Jest with JSON fixtures of real `GET /v1/gateway-devices` responses (capture from the actual account — anonymize ids). Test DeviceMapper (fixture → expected endpoints/attributes) and write-mapping (Matter command → expected PATCH body) without network.
- **Integration (dev):** `npm link matterbridge`, run local Matterbridge, pair with a test controller; use the Daikin **dev-tier app** (can request 1000 calls/day) during development so testing doesn't starve the quota.
- **Soak:** 24 h run logging call count vs. quota.

## 9. Risks & mitigations

| Risk                                                                     | Mitigation                                                                                                                    |
| ------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| 200 calls/day exhausted → device state goes stale for hours              | Conservative defaults, quota accounting, automatic interval stretching, clear log warnings                                    |
| Cloud-only API (no local control), Daikin outages                        | Document limitation; surface `reachable=false` on poll failures ([status page](https://daikincloudsolutions.statuspage.io))   |
| Characteristic variance across hardware/firmware (Altherma vs. split AC) | Defensive mapper — only create endpoints for characteristics actually present; collect fixtures from multiple device families |
| Matter device-type gaps per ecosystem (water heater, dry/fanOnly modes)  | Config-selectable representations; Thermostat as lowest common denominator                                                    |
| `daikin-controller-cloud` API drift                                      | Pin version; thin wrapper isolates it behind our own interface                                                                |

## 10. Decisions & remaining questions

**Decided (2026-07-05):**

- **Hardware:** split/multi-split AC units only. Build and test the `climateControl` mapper (Thermostat + Fan + outdoor temp sensor) first-class; keep the DHW/Altherma mapper defensive and fixture-driven, to be validated with community-contributed fixtures. M4 shifts focus to fan speed, powerful/econo switches, and multi-unit handling.
- **Controllers:** Apple Home + Home Assistant. Thermostat is the default representation (Apple-safe); dry/fanOnly modes and any Matter 1.3 extras (energy measurement) are exposed as opt-in config for HA users. Verify every M2/M3 exit criterion against _both_ controllers.

**Still open:**

1. **Publishing:** under your GitHub/npm account, or a new org?
2. Verify in M1 which **redirect URI** the developer-portal app needs for `daikin-controller-cloud`'s flow (portal requires it to match exactly) and document it.
