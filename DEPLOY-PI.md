# Deploying to the Pi (192.168.10.5) — manual steps

State: the plugin tarball is already uploaded to the Pi at
`/root/.matterbridge/uploads/matterbridge-daikin-onecta-0.1.0.tgz`.
The Mac dev instance of Matterbridge is stopped, so the API budget is free for the Pi.

## 1. Install the plugin package

Preferred (shows errors): on the Pi, inside the Matterbridge Docker container:

```bash
docker ps                                  # find the matterbridge container name
docker exec -it <container> npm install -g /root/.matterbridge/uploads/matterbridge-daikin-onecta-0.1.0.tgz --omit=dev
```

Alternative: in the frontend (http://192.168.10.5:8283) paste the full tarball path
into the **Install plugins** field and press install.

> The automatic install after the upload did not complete, so if the npm command
> prints an error here, that error is the reason — share it and we fix it.

## 2. Register the plugin

In the frontend, the plugin should now be addable: **Install plugins** field →
type `matterbridge-daikin-onecta` → Add. It appears in the plugins list.

## 3. Configure

Gear icon on `matterbridge-daikin-onecta`:

- **Client ID / Client Secret**: same values as on the Mac.
- **External Address**: leave empty (auto-detects 192.168.10.5).
- Everything else: defaults are fine.

Save (Matterbridge asks to restart).

## 4. Restart Matterbridge (frontend restart button)

Brief interruption of the existing shelly/mqtt bridged devices is normal.

## 5. Daikin Developer Portal

Add a second redirect URI to your app: `https://192.168.10.5:8582`
(keep the Mac one or remove it, it is no longer needed).

## 6. Authorize

The plugin logs the authorization request. Open **https://192.168.10.5:8582**
in a browser on your LAN → accept the self-signed certificate warning → sign in
→ tick the consent checkbox. The 4 units (16 endpoints) appear right after.

## 7. Re-pair your Matter controller

The units now live under the Pi's bridge: add/commission the Pi's Matterbridge
in Apple Home / Home Assistant (QR in the frontend) if it isn't already paired,
and remove the stale Mac pairing.

## Notes

- **Docker updates wipe globally installed plugins.** After a container image
  update, redo step 1 (until the plugin is published to npm).
- The Pi frontend has **no password** — consider setting one
  (frontend → settings), since anyone on the LAN can administer it.
- Only run **one** authorized instance at a time: two instances polling the same
  Daikin account together exceed the 200 calls/day budget.
