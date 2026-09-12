# WireGuard P2P runbook (moltarc)

## 1. Kenapa tanpa enkripsi di kode

`src/p2p.ts` tidak mengenkripsi isi chunk: dengan `MOLTARC_PSK` setiap pesan
wire di-frame sebagai `HMAC-SHA256(json) + '.' + json` dan diverifikasi pada
raw bytes **sebelum** `JSON.parse` (`frameWire`/`unframeWire`); field `auth`
per pesan (`wireAuth`/`authOk`) menambah lapis kedua. HMAC memberi
**integritas + autentikasi** (data tidak bisa dipalsukan/diubah tanpa kunci),
tapi **bukan kerahasiaan** — siapa pun yang bisa sniff TCP melihat isi JSON
chunk. Untuk kerahasiaan antar site / lewat internet, bungkus TCP P2P di
WireGuard. Tanpa PSK sama sekali node berjalan dalam fallback
trusted-LAN-only: siapa pun di jaringan bisa sync DAN push chunk — jangan
ekspos melampaui LAN yang dipercaya.

## 2. Pasang WireGuard 2 peer

Buat keypair di tiap host:

```sh
wg genkey | tee privatekey | wg pubkey > publickey
```

`peer-A` (`10.44.0.1/24`, moltarc port `4171`), `wg0.conf` minimal:

```ini
[Interface]
PrivateKey = <PRIV_A>
Address = 10.44.0.1/24
ListenPort = 51820

[Peer]
PublicKey = <PUB_B>
AllowedIPs = 10.44.0.2/32
Endpoint = <IP_B>:51820
# PreSharedKey opsional (lapis quantum-resistance / defense-in-depth WireGuard):
# PreSharedKey = <PSK_WG_OPSIONAL>
PersistentKeepalive = 25
```

`peer-B` cerminnya (`Address = 10.44.0.2/24`, `AllowedIPs = 10.44.0.1/32`,
`Endpoint = <IP_A>:51820`). Aktifkan:

```sh
sudo wg-quick up wg0
sudo wg show   # cari "latest handshake"
```

Arahkan moltarc hanya lewat tunnel: bind/listen `10.44.0.x`, dan set
`AllowedIPs` sempit seperti di atas (jangan `0.0.0.0/0` kecuali memang mau
full-tunnel).

## 3. Rotasi MOLTARC_PSK tanpa downtime

Format kunci: 64 hex chars, atau 32 bytes base64 (`parsePsk`); jangan pakai
raw 32-byte yang mengandung koma karena koma = pemisah list. Generate:

```sh
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Two-phase (kontrak di `PSK_ID_ENV`, `docs/contracts.md` → Sync auth):

1. Set **semua** node ke `MOLTARC_PSK=<new>,<old>` (primary dulu) dan catat
   langkah di `MOLTARC_PSK_ID` (mis. `rot-2026-09`). Outbound di-sign/frame
   dengan primary (`<new>`), inbound diverifikasi terhadap **semua** kunci
   list (`resolvePsks`/`unframeWire`/`authOk`) — peer campuran tetap sync.
2. Setelah semua node pegang list, promosikan ke `MOLTARC_PSK=<new>` saja dan
   update `MOLTARC_PSK_ID`. Peer yang masih kunci-lama saja ditolak sejak
   titik ini.

Restart per node satu-satu (rolling); tidak perlu stop cluster karena fase 1
menerima kedua kunci. `MOLTARC_PSK_ID` murni label informasional — tidak
pernah dibaca sebagai materi kunci / dikirim di wire.

## 4. allowPeers (token sha256)

Token legacy hanya menjaga `hello` (PSK tetap yang utama). Server menyimpan
`allowPeers: sha256(token)`; list kosong = layani siapa saja (default LAN).
Hash satu token:

```sh
node -e "console.log(require('crypto').createHash('sha256').update('TOKEN_ANDA','utf8').digest('hex'))"
```

Pasang hex itu di `allowPeers` server, dan set `token: 'TOKEN_ANDA'` di
opsi `syncFromPeer` klien (`peerAllowed` menolak token kosong/salah saat
list non-kosong).

## 5. Port / firewall

> moltarc tidak punya default port (`startNode({port})` wajib diisi —
> tidak ada `DEFAULT_PORT` di `src/p2p.ts`). Pilih sendiri, contoh `4171`.

- moltarc P2P: TCP port pilihanmu (contoh `4171`) — buka **hanya** untuk
  `10.44.0.0/24` (atau IP peer), bukan `0.0.0.0/0`.
- WireGuard: UDP `51820` antar endpoint publik kedua peer.
- Verifikasi: `sudo wg show`, `curl -v telnet://10.44.0.1:4171` dari peer
  (harus tersambung), dan ulangi dari IP luar tunnel (harus ditolak/timeout).

## 6. Verifikasi handshake gagal tanpa PSK benar

1. Kedua node dengan PSK sama: sync berhasil.
2. Set klien ke PSK salah (atau kosongkan): `unframeWire` return `null` —
   frame di-drop dan koneksi ditutup **sebelum parse**; sync gagal, tidak ada
   chunk teraplikasi (`MAX_CHUNK_BYTES` 4 MB / `MAX_SESSION_BYTES` 256 MB /
   `MAX_HAVE` 50000 tetap ditegakkan).
3. Selama rotasi (`<new>,<old>` di kedua sisi, primary `<new>`): sync
   berhasil dua arah; setelah promosi ke `<new>` saja, peer `<old>`-saja
   gagal seperti poin 2.
