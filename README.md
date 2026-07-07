# matterbridge-daikin-onecta

[![npm version](https://img.shields.io/npm/v/matterbridge-daikin-onecta.svg)](https://www.npmjs.com/package/matterbridge-daikin-onecta)
[![npm downloads](https://img.shields.io/npm/dt/matterbridge-daikin-onecta.svg)](https://www.npmjs.com/package/matterbridge-daikin-onecta)
[![license](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)

A [Matterbridge](https://matterbridge.io/) plugin that bridges **Daikin Onecta** cloud devices (AC units, heat pumps) into **Matter**, so they appear in Apple Home, Home Assistant, Alexa, Google Home and other Matter controllers.

> **Status: beta (M4).** Each AC unit appears as a Matter **thermostat** (room temperature, heating/cooling setpoints, mode incl. on/off), an **outdoor temperature sensor**, a **fan** device, a **powerful/boost mode switch**, and a **humidity sensor** on units that report it — all **controllable** from Matter controllers. Controller changes are debounced (a setpoint drag becomes one API call), applied optimistically and confirmed on the next poll. See [PLAN.md](PLAN.md) for the roadmap.

## Prerequisites

1. Your Daikin devices onboarded in the Daikin **Onecta** app.
2. Matterbridge >= 3.9.0 on Node.js >= 20.
3. A (free) [Daikin Developer Portal](https://developer.cloud.daikineurope.com) app — created in [step 1 of the authorization guide](#step-1--create-an-app-on-the-daikin-developer-portal) below.

## Installation

In the Matterbridge frontend, type `matterbridge-daikin-onecta` in the **Install plugins** field and install — that's it. Update the same way when a new version is released (the frontend shows available updates).

Command line alternative:

```bash
npm install -g matterbridge-daikin-onecta
matterbridge --add matterbridge-daikin-onecta
```

> Running Matterbridge in Docker? Install via the frontend as above; after a container image update just reinstall the same way.

## Authorization guide

Daikin's API uses OAuth: you log in **once** with your normal Daikin account in a browser, and the plugin receives tokens that it stores and refreshes automatically. You never need a terminal, `curl`, or the raw `/v1/oidc/authorize` URL from Daikin's API docs — the plugin builds all of that for you. You only need a browser.

### How it works (read this first, it explains the weird parts)

During authorization the plugin starts a **small temporary HTTPS server on the Matterbridge machine** (port `8582` by default). Your browser talks to it twice: once to be forwarded to Daikin's login page, and once when Daikin's login page sends you back with the authorization code. Two consequences:

- **Your machine does NOT need to be reachable from the internet.** Daikin's servers never connect to it. The "redirect" is your own browser being told to navigate back to `https://<lan-ip>:8582` — which works because your browser is on the same local network. Outbound internet access is all the plugin needs.
- **You will get a certificate warning.** Daikin requires the redirect URI to be `https://`, so the plugin's temporary server uses a self-signed certificate. Your browser can't verify it and shows _"Your connection is not private"_ (or similar). This is expected — click **Advanced → Proceed/Continue** the one time you authorize.

### Step 1 — Create an app on the Daikin Developer Portal

1. Find the LAN IP of the machine running Matterbridge (e.g. `ipconfig getifaddr en0` on macOS, `hostname -I` on Linux). Example: `192.168.1.50`.
2. Go to https://developer.cloud.daikineurope.com, sign up or log in (you can use your existing Daikin account).
3. Create a new application (name is up to you, e.g. `Matterbridge`).
4. As **redirect URI**, register exactly:

   ```
   https://<lan-ip-of-matterbridge-machine>:8582
   ```

   e.g. `https://192.168.1.50:8582`. Mind the details — all of these matter and all must match what the plugin uses:
   - `https`, not `http`
   - the **LAN IP**, not `localhost` and not a public IP
   - the port (default `8582`, or whatever you set as `callbackPort`)
   - no trailing slash or path

5. Note the app's **Client ID** and **Client Secret**.

> The plugin prints the exact redirect URI it expects in the Matterbridge log during authorization — if in doubt, copy it from there into the portal.

### Step 2 — Enter the credentials

Open the Matterbridge frontend (`http://<lan-ip>:8283`), go to the plugin's config, paste the **Client ID** and **Client Secret**, and save. Matterbridge restarts the plugin.

### Step 3 — Authorize in the browser

After the restart the plugin starts an authorization attempt and logs:

```
Daikin Onecta authorization required:
1. On the Daikin Developer Portal make sure your app has "https://192.168.1.50:8582" registered as redirect URI.
2. Open https://192.168.1.50:8582 in a browser on this network and accept the self-signed certificate warning.
3. Sign in with your Daikin account and grant access. The request times out after 10 minutes.
```

Now, **in a browser on a device in the same network** (the machine itself is fine, a phone on the same Wi-Fi too):

1. Open `https://<lan-ip>:8582`.
2. Certificate warning appears → **Advanced → Proceed** (see above for why).
3. You are forwarded to the Daikin login page. Sign in.
4. **Tick the consent checkbox** granting the integration access to your devices and confirm.
5. You land back on a local _"Authorization complete"_ page. Done.

The plugin immediately fetches your devices; from now on tokens are refreshed automatically and no browser interaction is ever needed again. The tokens are stored in `~/.matterbridge/matterbridge-daikin-onecta.tokenset.json` — never share this file, the Daikin developer terms prohibit it.

### Authorization troubleshooting

| Symptom                                                       | Cause / fix                                                                                                                                                                                                                 |
| ------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Daikin shows an OAuth error instead of the login page         | The redirect URI in the portal doesn't **exactly** match `https://<ip>:<port>` — check scheme, IP, port, no trailing slash.                                                                                                 |
| `Fetching Daikin devices failed: Authorization time out`      | Nobody completed the browser flow within 10 minutes. Harmless: the plugin retries every 5 minutes and logs the URL again.                                                                                                   |
| `Fetching Daikin devices failed: listen EADDRINUSE ... :8582` | A previous authorization attempt is still holding the port (each attempt waits up to 10 minutes and can't be aborted, e.g. after a plugin restart). Also harmless: wait for the retry, or check nothing else uses the port. |
| Browser can't reach `https://<ip>:8582`                       | You're on a different network/VLAN than the Matterbridge machine, or a firewall blocks the port. Use a browser on the same LAN.                                                                                             |
| Your machine's LAN IP changed (DHCP)                          | The registered redirect URI no longer matches, which only matters if you ever need to re-authorize. Update the URI in the portal (or give the machine a static IP / DHCP reservation). Normal token refresh is unaffected.  |

## Configuration

Set in the Matterbridge frontend (or `~/.matterbridge/matterbridge-daikin-onecta.config.json`):

| Option                                        | Default           | Description                                                                                                                                                               |
| --------------------------------------------- | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `clientId` / `clientSecret`                   | —                 | Credentials of your Daikin Developer Portal app.                                                                                                                          |
| `callbackPort`                                | `8582`            | Port of the local HTTPS OAuth callback server; must match the registered redirect URI.                                                                                    |
| `externalAddress`                             | detected LAN IP   | Address of this machine as reachable from your browser during authorization. Only set it if the auto-detected address is wrong (multiple network interfaces, containers). |
| `pollingIntervalDay` / `pollingIntervalNight` | `10` / `30` min   | Cloud polling intervals inside/outside the day window.                                                                                                                    |
| `dayStart` / `dayEnd`                         | `07:00` / `22:00` | The day window.                                                                                                                                                           |
| `exposeOutdoorTemperature`                    | `true`            | Expose the outdoor temperature as a Matter sensor.                                                                                                                        |
| `exposeFan`                                   | `true`            | Expose AC fan speed as a Matter fan device.                                                                                                                               |
| `whiteList` / `blackList`                     | empty             | Limit which devices are exposed.                                                                                                                                          |

## Rate limits

The Onecta API allows only **200 calls per user per day**. The default polling settings (~120 calls/day) leave headroom for commands. The plugin reads the rate-limit headers, logs the remaining budget at debug level, and backs off automatically when the limit is reached.

## Development

To develop from source:

```bash
git clone https://github.com/mehmetc/matterbridge-daikin-onecta.git && cd matterbridge-daikin-onecta
npm install
npm link matterbridge   # requires a matterbridge dev install, see the Matterbridge dev guide
npm run build
matterbridge --add .
```

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
