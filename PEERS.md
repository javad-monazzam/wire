# Enable / disable peers

`wg0.conf` is never modified. Disabling removes the peer from the **running
interface** only and records the name in `/etc/wireguard/disabled.json` — the
same approach the WGDashboard panel uses.

## Routes

| Route | Description |
| --- | --- |
| `GET /disable?publicKey=<name>` | Drop the client from the live interface |
| `GET /enable?publicKey=<name>` | Put it back with the same key, PSK and IP |
| `GET /status?publicKey=<name>` | On/off state of one client |
| `GET /peers` | All clients: state, IP, live connection |

```bash
curl "http://127.0.0.1:7199/peers"
# {"success":true,"peers":[
#   {"name":"turkish",  "enabled":false,"ip":"156.6.86.108","connected":false},
#   {"name":"turkish34","enabled":true, "ip":"156.6.86.109","connected":true}]}
```

`changed:false` means it was already in that state. `applied:false` means the
interface was down, so only the state file changed.

## Why not comment the block out

The first version prefixed disabled peer lines with `#!OFF!`. That corrupts the
next client creation:

1. `findIp()` in main.js only matches lines **starting with** `AllowedIPs`, so
   `#!OFF!AllowedIPs = 156.6.86.108/32` is invisible and `.108` looks free.
2. `wireguard-install.sh` greps the raw file (`grep -c "$CLIENT_WG_IPV4/32"`),
   and grep still finds the commented line. It rejects the octet and re-prompts.
3. stdin is already closed, so `read` returns empty and you get
   `AllowedIPs = 156.6.86./32` — a broken client.

Leaving the file untouched keeps `findIp()` and the install script in
agreement. The IP also stays reserved automatically, since the peer block is
still there in full.

## Reboot

`wg0.conf` still lists every peer, so `wg-quick up` reloads disabled ones too.
`applyDisabled()` runs on `require('./peers')` — that is, whenever the panel
starts — and strips them again. Nothing to configure.

If you reboot and the panel does not come back up, disabled clients will be
connectable until it does. If that matters, add to
`/etc/systemd/system/jwpn.service`:

```ini
After=wg-quick@wg0.service
Wants=wg-quick@wg0.service
```

## First run: clean up the old markers

If the commenting version already ran, `wg0.conf` has `#!OFF!` lines in it:

```bash
sudo bash cleanup.sh
```

It backs up the conf, strips every marker, writes the affected names into
`disabled.json` so they stay disabled, and reports any client whose
`AllowedIPs` the old bug corrupted. Those clients cannot be repaired — the
address was never assigned — so delete and recreate them:

```bash
curl "http://127.0.0.1:7199/remove?publicKey=turkish34"
curl "http://127.0.0.1:7199/create?publicKey=turkish34"
```

## Note on the API paths

The NestJS service calls `/vpn/activate` and `/vpn/deactivate` on port 4500,
while these routes are `/enable` and `/disable` on port 7199. One side needs to
change or `toggleStatus` will always land in its catch block.

## Still outstanding

- **No authentication** on port 7199. Firewall it to the panel's IP.
- `vpn.log` was removed from this archive: it contained 30 client configs with
  real `PrivateKey` and `PresharedKey` values. Revoke those peers and purge the
  file from git history.
- `SERVER_PRIV_KEY` was posted in a chat message. Rotate it.
