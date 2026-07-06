# matterbridge-daikin-onecta

A [Matterbridge](https://matterbridge.io/) plugin that bridges **Daikin Onecta** cloud devices (AC units, heat pumps) into **Matter**, so they appear in Apple Home, Home Assistant, Alexa, Google Home and other Matter controllers.

> **Status: early development (M1).** The plugin authenticates against the official Daikin Onecta API, discovers your devices and logs their capabilities. Matter device mapping (thermostat, sensors, fan) is the next milestone. See [PLAN.md](PLAN.md) for the roadmap.

## Prerequisites

1. A [Daikin Developer Portal](https://developer.cloud.daikineurope.com) account (free) with an application:
   - Note the **Client ID** and **Client Secret**.
   - Register the redirect URI `https://<ip-of-your-matterbridge-machine>:8582` (the exact URI is also printed in the Matterbridge log during the first authorization).
2. Your devices onboarded in the Daikin **Onecta** app.
3. Matterbridge >= 3.9.0 on Node.js >= 20.

## Installation & configuration

Until the plugin is published to npm, install from source:

```bash
git clone <this repo> && cd matterbridge-daikin-onecta
npm install
npm link matterbridge
npm run build
matterbridge --add .
```

Then configure in the Matterbridge frontend (or `~/.matterbridge/matterbridge-daikin-onecta.config.json`):

| Option                                        | Default           | Description                                                                            |
| --------------------------------------------- | ----------------- | -------------------------------------------------------------------------------------- |
| `clientId` / `clientSecret`                   | —                 | Credentials of your Daikin Developer Portal app.                                       |
| `callbackPort`                                | `8582`            | Port of the local HTTPS OAuth callback server; must match the registered redirect URI. |
| `externalAddress`                             | detected LAN IP   | Address of this machine as reachable from your browser during authorization.           |
| `pollingIntervalDay` / `pollingIntervalNight` | `10` / `30` min   | Cloud polling intervals inside/outside the day window.                                 |
| `dayStart` / `dayEnd`                         | `07:00` / `22:00` | The day window.                                                                        |
| `exposeOutdoorTemperature`                    | `true`            | Expose the outdoor temperature as a Matter sensor (M2).                                |
| `exposeFan`                                   | `true`            | Expose AC fan speed as a Matter fan device (M2).                                       |
| `whiteList` / `blackList`                     | empty             | Limit which devices are exposed.                                                       |

### First authorization

On first start the plugin prints an authorization URL (`https://<your-ip>:8582`). Open it in a browser on the same network, accept the self-signed certificate warning, sign in with your Daikin account and grant access. The token set is stored in `~/.matterbridge/matterbridge-daikin-onecta.tokenset.json` and refreshed automatically. Never share these tokens — the Daikin developer terms prohibit it.

## Rate limits

The Onecta API allows only **200 calls per user per day**. The default polling settings (~120 calls/day) leave headroom for commands. The plugin reads the rate-limit headers, logs the remaining budget at debug level, and backs off automatically when the limit is reached.

## Development

```bash
npm run build      # compile
npm run test       # jest unit tests
npm run test:vitest
npm run lint       # oxlint
npm run format     # oxfmt
```

The Onecta API layer is provided by [daikin-controller-cloud](https://github.com/Apollon77/daikin-controller-cloud). The Home Assistant integration [jwillemsen/daikin_onecta](https://github.com/jwillemsen/daikin_onecta) served as the behavioral reference.

## License

Apache-2.0
