# Enable / disable peers

Added in `peers.js`, wired into `main.js`.

## Routes

| Route | Description |
| --- | --- |
| `GET /disable?publicKey=<name>` | Disconnect the client, keep its key and IP |
| `GET /enable?publicKey=<name>` | Bring the same client back |
| `GET /status?publicKey=<name>` | On/off state of one client |
| `GET /peers` | All clients with their state |

`publicKey` is the *client name* here, matching how `/create` and `/remove`
already use it. `name=` works as an alias.

```bash
curl "http://127.0.0.1:7199/disable?publicKey=alice"
# {"success":true,"name":"alice","enabled":false,"changed":true,"applied":true}

curl "http://127.0.0.1:7199/peers"
# {"success":true,"peers":[{"name":"alice","enabled":false},{"name":"bob","enabled":true}]}
```

`changed:false` means it was already in that state. `applied:false` means the
interface was down, so only the file was updated — the change takes effect on
the next `wg-quick up`.

Errors: `400` invalid name, `404` client not found, `500` command failed.

## How it works

WireGuard has no "disabled" state — a peer is either present or absent. So
disabling comments out the peer block in `wg0.conf` with an `#!OFF!` prefix:

```
### Client alice          <- left untouched on purpose
#!OFF![Peer]
#!OFF!PublicKey = ...
#!OFF!PresharedKey = ...
#!OFF!AllowedIPs = 10.66.66.2/32
```

The `### Client alice` header stays visible because options 2 (list) and 3
(revoke) in `wireguard-install.sh` grep for exactly that line. Comment it out
and a disabled user would vanish from the script's menu and become impossible
to delete.

The change is then pushed with `wg syncconf`, which only touches peers that
actually changed — everyone else keeps their handshake and stays connected.

Because the state lives in `wg0.conf`, it survives a reboot.

## Do not use `wg-quick save`

`wg-quick save` rewrites `wg0.conf` from the live interface and drops every
comment, which would erase all the `### Client` headers. `peers.js` writes the
file itself and calls `wg syncconf` instead. If you add `wg-quick save`
anywhere in this project, it will break both this feature and the install
script.

## Still outstanding

These were left alone so this change stays minimal, but they are real:

- **No authentication.** Anything that can reach port 7199 can create, delete,
  or disable clients. Firewall the port to your panel's IP and add a token.
- **Command injection in `addVpn`.** `query.publicKey` is concatenated into
  `shell.exec('cat ' + filePath)`. The new routes validate their input with
  `/^[a-zA-Z0-9_-]{1,15}$/`; `addVpn` does not.
- **`findIp()` is broken.** It uses a callback with `await`, so `privateIP` is
  set asynchronously and the `sleep(2222)` calls paper over the race. Two
  concurrent `/create` calls can get the same IP.
- **`vpn.log` was removed from this archive** — it contained 30 client configs
  with real `PrivateKey` and `PresharedKey` values. Those peers should be
  revoked and reissued, and the file purged from git history.
