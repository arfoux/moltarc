# WireGuard P2P runbook (moltarc)

## 1. Why encryption lives outside the code

`src/p2p.ts` does not encrypt chunk payloads. With `MOLTARC_PSK` set, every
wire message is framed as `HMAC-SHA256(json) + '.' + json` and verified on the
raw bytes **before** `JSON.parse` (`frameWire`/`unframeWire`); the per-message
`auth` field (`wireAuth`/`authOk`) adds a second layer. HMAC provides
**integrity + authentication** — data cannot be forged or modified without the
key — but **not confidentiality**: anyone who can sniff TCP can read the JSON
chunk payload. For confidentiality across sites or over the internet, wrap the
P2P TCP connection in WireGuard. With no PSK at all, a node falls back to
trusted-LAN-only mode: anyone on the network can sync **and push** chunks — do
not expose it beyond a trusted LAN.

## 2. Set up two WireGuard peers

Generate a keypair on each host:

```sh
wg genkey | tee privatekey | wg pubkey > publickey
```

For `peer-A` (`10.44.0.1/24`, moltarc port `4171`), a minimal `wg0.conf`:

```ini
[Interface]
PrivateKey = <PRIV_A>
Address = 10.44.0.1/24
ListenPort = 51820

[Peer]
PublicKey = <PUB_B>
AllowedIPs = 10.44.0.2/32
Endpoint = <IP_B>:51820
# Optional PreSharedKey (WireGuard defense-in-depth / post-quantum layer):
# PreSharedKey = <OPTIONAL_WG_PSK>
PersistentKeepalive = 25
```

`peer-B` is the mirror image (`Address = 10.44.0.2/24`,
`AllowedIPs = 10.44.0.1/32`, `Endpoint = <IP_A>:51820`). Bring it up:

```sh
sudo wg-quick up wg0
sudo wg show   # look for "latest handshake"
```

Bind/listen moltarc only on the tunnel address (`10.44.0.x`) and keep
`AllowedIPs` narrow as above (avoid `0.0.0.0/0` unless you intentionally want a
full tunnel).

## 3. Rotate MOLTARC_PSK without downtime

Key format: 64 hex characters, or 32 bytes in base64 (`parsePsk`); do not use a
raw 32-byte value containing a comma, because commas separate keys in the list.
Generate one with:

```sh
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Two-phase rotation (contract in `PSK_ID_ENV`, `docs/contracts.md` → Sync auth):

1. Set **every** node to `MOLTARC_PSK=<new>,<old>` (primary first) and record
   the step in `MOLTARC_PSK_ID` (e.g. `rot-2026-09`). Outbound frames are
   signed/framed with the primary key (`<new>`), while inbound frames are
   verified against **all** keys in the list (`resolvePsks`/`unframeWire`/
   `authOk`) — peers on either key keep syncing.
2. Once every node holds the list, promote to `MOLTARC_PSK=<new>` alone and
   update `MOLTARC_PSK_ID`. From that point on, peers still on `<old>` only are
   rejected.

Restart nodes one at a time (rolling restart); the cluster does not need to
stop because phase 1 accepts both keys. `MOLTARC_PSK_ID` is an informational
label only — it is never read as key material or sent on the wire.

## 4. allowPeers (token SHA-256 allowlist)

The legacy token guards `hello` only (the PSK remains the primary control).
The server stores `allowPeers: sha256(token)`; an empty list serves anyone
(the LAN default). Hash a token with:

```sh
node -e "console.log(require('crypto').createHash('sha256').update('YOUR_TOKEN','utf8').digest('hex'))"
```

Install that hex value in the server's `allowPeers`, and set
`token: 'YOUR_TOKEN'` in the client's `syncFromPeer` options (`peerAllowed`
rejects an empty or wrong token whenever the list is non-empty).

## 5. Ports and firewall

> moltarc has no default port (`startNode({port})` is required — there is no
> `DEFAULT_PORT` in `src/p2p.ts`). Pick one; `4171` is used in this runbook.

- moltarc P2P: your chosen TCP port (e.g. `4171`) — open it **only** to
  `10.44.0.0/24` (or the peer IP), not to `0.0.0.0/0`.
- WireGuard: UDP `51820` between the two peers' public endpoints.
- Verify with `sudo wg show`, `curl -v telnet://10.44.0.1:4171` from the peer
  (must connect), and again from an address outside the tunnel (must be
  refused or time out).

## 6. allowedPeersCIDR / requireTunnelCIDR (opt-in, fail-closed)

A firewall can be misconfigured to over-permit; these options make the node
itself reject off-tunnel peers with an explicit message
(`peer <ip> outside allowed tunnel subnet (10.44.0.0/24)`). Server:
`startNode({ outDir, port, allowedPeersCIDR: '10.44.0.0/24' })`
(`requireTunnelCIDR` is the same alias) — an off-tunnel upgrade gets HTTP 403,
and a `hello` that clears the upgrade is rejected with an `error` frame and the
connection is closed. Client:
`syncFromPeer(url, outDir, { allowedPeersCIDR: '10.44.0.0/24' })` refuses to
dial outside the subnet before a single byte is sent
(`p2p dial refused: ...`). Both validate the CIDR up front
(`p2p allowedPeersCIDR invalid: ...` for `bogus`), so a typo never silently
opens access. Off by default (the old behavior applies when omitted), so enable
it on every tunneled node; without it, a firewall mistake leaks silently.

## 7. Verify that the handshake fails without the correct PSK

1. Both nodes with the same PSK: sync succeeds.
2. Set the client to a wrong PSK (or leave it empty): `unframeWire` returns
   `null` — the frame is dropped and the connection closed **before parsing**;
   sync fails and no chunks are applied (`MAX_CHUNK_BYTES` 4 MB /
   `MAX_SESSION_BYTES` 256 MB / `MAX_HAVE` 50000 still enforced).
3. During rotation (`<new>,<old>` on both sides, primary `<new>`): sync works
   in both directions; after promotion to `<new>` alone, an `<old>`-only peer
   fails as in step 2.
