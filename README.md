# Circlus Server

Run Circlus on your own VPS for private Circles, messages, files, and calls.
This repository contains the server, its database migrations, and a Docker
Compose setup with PostgreSQL, ICE configuration, and an optional local TURN
server. Use the [Circlus web client](https://web.circlus.org) or the
[Android app](https://circlus.org/#clients) to connect.

This repository is for running your own server and inspecting what the server
does with data it receives. Private messages and ordinary attachments are
stored as ciphertext. The server still needs routing and access metadata, and
it handles some deliberately public content and operational data in readable
form. See [what the server can see](docs/DATA_VISIBILITY.md) for the boundaries
and exceptions. Reviewing server code alone cannot establish how a client
encrypts data or handles keys.

## Requirements

- A Linux VPS with a public IPv4 address and at least 1 GB of RAM. The
  commands below use Ubuntu or Debian. On a 1 GB VPS, use the prebuilt images;
  building the services from source may need more memory. Installation and one
  two-person video call were tested on a 1 GB Oracle Cloud VM. For multiple
  Circles and simultaneous calls, plan for at least 2 GB: our 2 GB VPSs run
  that kind of workload. No maximum call or user count has been benchmarked;
  TURN relay traffic and network bandwidth also affect capacity.
- A domain or subdomain whose DNS `A` record points to the VPS. Use it for the
  first Circle's HTTPS address and as `TURN_PUBLIC_HOST`. The same hostname
  works for both services on different ports; a separate TURN hostname is
  optional.
- Open TCP ports 80 and 443 for HTTPS. For the included local TURN server,
  open TCP/UDP 3478 and UDP 49160–49200 (the default relay port range).

TURN relays call audio and video when two participants cannot connect to each
other directly, for example behind strict home or mobile networks. If its ports
are closed, calls between different networks may fail even though messages work.

Run the commands over SSH as a regular user with `sudo` access. The prebuilt
images do not require Node.js to be installed on the VPS.

**Oracle Cloud:** follow the [Oracle Cloud guide](deploy/ORACLE_CLOUD.md)
instead. It has extra firewall and network address steps specific to Oracle.

## Install

### 1. Install Docker, Git, and Nginx

```bash
sudo apt update
sudo apt install -y git docker.io docker-compose-v2 nginx certbot python3 python3-certbot-nginx curl
sudo systemctl enable --now docker
sudo docker compose version
```

The last command should print Docker Compose version 2.24 or newer. On older
Debian releases where `docker-compose-v2` is unavailable, install Docker from
[Docker's official instructions](https://docs.docker.com/engine/install/).

Docker commands below run with `sudo`. Adding your account to the `docker`
group would remove the need for it, but that group grants root-level access to
the host.

### 2. Download the server

Open the [latest published release](https://github.com/circlus-org/circlus-server/releases/latest)
and copy its tag, for example `v1.2.3`. Replace `v1.2.3` in the checkout
command below with that tag. Do not use a newer tag that has no published
release yet.

```bash
git clone https://github.com/circlus-org/circlus-server.git ~/circlus-server
cd ~/circlus-server
git switch --detach v1.2.3
```

Run all later commands from `~/circlus-server`. Keep this checkout and
its `deploy/.env` and secret files together when updating. Compose fixes the
project name to `circlus-server`, which keeps the existing volumes associated
with this installation.

### 3. Configure

```bash
cp deploy/.env.example deploy/.env
nano deploy/.env
```

Set at least these two values, using your own domain and the same tag you
checked out in step 2:

```env
TURN_PUBLIC_HOST=circle.example.com
CIRCLUS_IMAGE_TAG=v1.2.3
```

Save with `Ctrl+O`, `Enter`, then exit with `Ctrl+X`. The other settings can
stay empty; the file explains each one.

If the VPS is behind 1:1 NAT (its public IP does not appear in `ip addr`),
also set `TURN_EXTERNAL_IP` as described in the
[Oracle Cloud guide](deploy/ORACLE_CLOUD.md#create-the-vm-and-set-dns).

### 4. Generate secrets and start the server

```bash
./deploy/init-local-turn.sh
sudo ./deploy/compose.sh pull
sudo ./deploy/compose.sh up -d
sudo ./deploy/compose.sh ps -a
```

Run `init-local-turn.sh` without `sudo`. It creates the database password and
other secrets under `deploy/`. Re-running it later is safe: it keeps existing
values.

`deploy/compose.sh` runs Docker Compose with this installation's settings and
prints the full command before running it. For the commands above it is:

```bash
docker compose --env-file deploy/.env -f compose.yaml -f compose.prebuilt.yaml \
  --profile local-turn pull
```

It also stops with a hint if `CIRCLUS_IMAGE_TAG` differs from the checked-out
release, so the configuration files and the images always come from the same
version.

In the last command's output, `postgres`, `ice-config-service`, `coturn`, and
`server` should show `healthy` after a minute. `migrate` showing `Exited (0)` is
expected: it prepares the database and stops.

**Keep `deploy/.env`, `deploy/secrets/`, and `deploy/ice/turn-clusters.json`.**
They are needed for updates and to restore the server from a backup.

### 5. Open the firewall

Ports must be open in **two places**: in the hosting provider's control panel
(often called firewall or security group) and on the VPS itself.

If UFW is active on the VPS (`sudo ufw status` shows `Status: active`):

```bash
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw allow 3478/tcp
sudo ufw allow 3478/udp
sudo ufw allow 49160:49200/udp
sudo ufw status verbose
```

If UFW is inactive, you do not need to enable it. Check the provider panel and
any other firewall your host uses. Keep the SSH port open. Oracle Cloud needs
[different host rules](deploy/ORACLE_CLOUD.md#open-ports-in-oracle-cloud-and-ubuntu).

### 6. Enable HTTPS

The domain must already point to this VPS.

```bash
sudo ./deploy/add-nginx-site.sh circle.example.com
curl --fail --show-error https://circle.example.com/ready
```

The script sets up Nginx and requests a free Let's Encrypt certificate. The
last command should print JSON containing `"status":"ok"`. If you already manage
Nginx yourself, see the [included proxy example](deploy/nginx/circlus-server.conf.example).

### 7. Create your Circle

Create a one-time token that proves you are the server's owner:

```bash
sudo ./deploy/compose.sh exec -e LOG_LEVEL=warn server \
  npm run server-admin:create-claim:prod -- --ttl-hours=1
```

Copy the token from the output; it is valid for one hour. Do not share it.

Open the [Circlus web client](https://web.circlus.org) and choose **Create a
circle on my server**. Enter `https://circle.example.com` and the token. If you
already have a Circlus profile, use **Settings → Server management → Connect a
new server** instead.

### 8. Test a call

Make a call between two devices on different networks, for example a computer
on home internet and a phone on mobile data. Check audio and video in both
directions.

A successful call may use a direct connection. To confirm that the local TURN
server works, or if calls fail, follow
[TURN verification and troubleshooting](deploy/README.md#turn-verification-and-troubleshooting).

### Push notifications

After creating a Circle, open **Settings → Server management → Push
notifications** in the client and create a connection request. Send the
pre-filled request through the support contact opened by the app. Once approved,
refresh the push status until it shows **Connected and ready**.

## Updating

New versions appear on the
[Releases page](https://github.com/circlus-org/circlus-server/releases). To be
notified, click **Watch → Custom → Releases** on GitHub. Read the release notes
first: they say whether the version changes the database or needs manual steps.
On a 1 GB VPS, keep using prebuilt images; the steps below do not compile
anything on the VPS.

**1. Back up.** Run `sudo python3 deploy/backup.py create` from the repository
root. It saves PostgreSQL, `server_data`, settings, and secrets together and
prints the backup directory. Copy that whole directory off the VPS. See
[backup and restore](deploy/README.md#backups) for verification and recovery.
After a database upgrade, the older version may no longer start, so keep the
backup and its recorded code version together.

**2. Update.** Replace `v1.2.4` with the new version:

```bash
cd ~/circlus-server
git status --short                # Should print nothing; see below.
git fetch --tags
git switch --detach v1.2.4
./deploy/init-local-turn.sh --image-tag v1.2.4
sudo ./deploy/compose.sh pull
sudo ./deploy/compose.sh up -d
```

`--image-tag` saves the selected tag in `deploy/.env` only after checking that
it points to the checked-out commit and initialization succeeds. Without this
option, `init-local-turn.sh` leaves the existing tag unchanged.

- If `git status --short` prints files, stop: something in the installation
  directory was edited. Your own settings belong only in `deploy/.env` and
  `deploy/secrets/`, which Git ignores.
- If `pull` fails, stop: the server keeps running the old version. Check the
  internet connection and the version name, then try again.
- Calls in progress may be interrupted for a moment while containers restart.
- Use `up -d` as shown; `restart` does not apply a new version or settings.

**3. Check.**

```bash
sudo ./deploy/compose.sh ps -a
curl -fsS --max-time 10 https://circle.example.com/ready   # Your domain.
```

`postgres`, `ice-config-service`, `coturn`, and `server` should be `healthy`;
`migrate` should show `Exited (0)` after upgrading the database. `/ready` should
return `"status":"ok"`. If not, see the logs as described below.

## Troubleshooting

To see recent server logs:

```bash
sudo ./deploy/compose.sh logs --tail=100 server
```

Replace `server` with `migrate`, `coturn`, or `postgres` to see other services.

- **HTTPS does not work:** check that the domain resolves to the VPS
  (`getent hosts circle.example.com`), that ports 80/443 are open in both
  firewalls, and that `https://circle.example.com/ready` returns `"status":"ok"`.
- **A service is not `healthy`:** look at its logs with the command above.
- **The client cannot connect:** check HTTPS first, then the `server` logs.
- **Calls fail between different networks:** check `TURN_PUBLIC_HOST`, the
  firewall ports in both places, and
  [TURN diagnostics](deploy/README.md#turn-verification-and-troubleshooting).
- **Push notifications do not arrive:** check the status in **Server management**.
- **`migrate` exits with an error:** check its logs. Never edit SQL migration
  files that have already been applied.

## Build from source

Instead of downloading prebuilt images, you can build them on the VPS. This
takes longer and needs more memory, so it is not recommended for 1 GB servers.
Follow the steps above, but leave `CIRCLUS_IMAGE_TAG` empty in `deploy/.env`.
`deploy/compose.sh` then uses only `compose.yaml`. Skip `pull` and start with:

```bash
sudo ./deploy/compose.sh up -d --build
```

To update a source build installed from a release, use `git fetch --tags` and
`git switch --detach NEW_TAG`; `git pull` cannot update a detached checkout.
If you installed from a branch instead, use `git pull --ff-only`. Then run
`./deploy/init-local-turn.sh` and the build command above. Both methods use
the same database, data, and secrets, so you can switch between them by
setting or clearing `CIRCLUS_IMAGE_TAG`.

## More information

[Deployment details](deploy/README.md) cover the files created during setup,
host ports, additional Circle domains, backups, and emergency deletion after
owner identity loss. `deploy/.env.example` lists deployment settings;
`server/.env.example` is the complete server setting reference.

For a closer look at server behavior, see [data visibility](docs/DATA_VISIBILITY.md),
[capabilities](docs/SERVER_CAPABILITIES.md),
[request reliability](docs/REQUEST_RELIABILITY.md),
[HTTP signaling](docs/HTTP_SIGNALING.md), and
[WebSocket limits](docs/WEBSOCKET_LIMITS.md).

Deployment questions and ideas about the protocol or product can be discussed
in GitHub issues. Please report suspected vulnerabilities privately as described
in the [security policy](SECURITY.md).

## License

MIT. See [LICENSE](LICENSE).
