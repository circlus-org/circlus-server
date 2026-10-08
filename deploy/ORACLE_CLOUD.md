# Oracle Cloud Ubuntu installation

This guide covers the Oracle Cloud Infrastructure (OCI) steps that differ from
the general [Circlus Server installation](../README.md). It is intended for an
Ubuntu VM with a public IPv4 address. On a 1 GB VM, install from a published
server release image so the VM does not compile Node.js services.

Oracle lists the AMD `VM.Standard.E2.1.Micro` shape as an [Always Free eligible
1 GB VM](https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm).
Availability, account limits, and the eligibility of other resources depend on
the account and home region; check the **Always Free eligible** label and limits
in the OCI Console before provisioning. Published server images support both
`amd64` and `arm64`. The 1 GB test described below used an AMD VM; it does not
establish capacity for concurrent calls or an Arm VM.

## Create the VM and set DNS

1. Create an Ubuntu VM in a public subnet with a public IPv4 address. Upload
   or save the SSH key offered by the console. Record the **Public IP** shown
   for its VNIC in OCI. You do not need to create a second public IP if one is
   already assigned. Connect with `ssh ubuntu@PUBLIC_IP` (add
   `-i path/to/private-key` if the key is not your default one).
2. Point the Circle domain's DNS `A` record to that public IPv4 address. The
   same domain can serve HTTPS and TURN on their different ports.
3. On the VM, find the private address of its network interface:

   ```bash
   ip -4 route get 1.1.1.1
   ```

   Use the address after `src`, for example `10.0.0.83`. OCI [attaches the
   public IP to the VNIC's private IP](https://docs.oracle.com/en-us/iaas/Content/Network/Tasks/managingpublicIPs.htm),
   so the public address need not appear in `ip addr`.

## Open ports in Oracle Cloud and Ubuntu

In the OCI Console, open the VM's subnet, then **Security → Security Lists**.
Open a security list *attached to that subnet*. Add these **Ingress Rules**;
leave any working SSH rules in place. If the VNIC uses a Network Security Group
instead, you can add equivalent rules there. For all rows set **Source Type**
to `CIDR`, **Source CIDR** to `0.0.0.0/0`, **Source Port Range** to `All`, and
leave **Stateless** unchecked:

| Protocol | Destination Port Range | Purpose |
| --- | --- | --- |
| TCP | `80` | Certificate issuance and HTTP redirect |
| TCP | `443` | HTTPS and WebSocket signaling |
| TCP | `3478` | TURN over TCP |
| UDP | `3478` | TURN over UDP |
| UDP | `49160-49200` | TURN relay traffic |

The table assumes the default ports in `deploy/.env`. Existing rules do not
need duplicates. Security List rules apply to every instance in the attached
subnet; use an instance-specific Network Security Group if that distinction
matters. See [OCI's ingress rule fields](https://docs.oracle.com/en-us/iaas/Content/Network/Tasks/scenarioc.htm).

OCI's Ubuntu image may also have an `iptables` `REJECT` rule even when `ufw`
is absent. Check the host rules:

```bash
sudo iptables -L INPUT -n -v --line-numbers
```

If the required ports are not already allowed, add rules **before** that
`REJECT`. On a fresh VM, these commands insert the five specific allowances at
the beginning of `INPUT`:

```bash
sudo iptables -I INPUT 1 -p tcp --dport 80 -j ACCEPT
sudo iptables -I INPUT 1 -p tcp --dport 443 -j ACCEPT
sudo iptables -I INPUT 1 -p tcp --dport 3478 -j ACCEPT
sudo iptables -I INPUT 1 -p udp --dport 3478 -j ACCEPT
sudo iptables -I INPUT 1 -p udp --dport 49160:49200 -j ACCEPT
sudo iptables -L INPUT -n --line-numbers
```

Run only the missing allowances on an already configured VM. Do not flush the
existing rules: they include SSH and Oracle service access.

Save the rules so they survive a reboot, then check the saved file. If
`netfilter-persistent` is missing, install `iptables-persistent` first:

```bash
sudo netfilter-persistent save
sudo grep -E -- '--dport (80|443|3478|49160)' /etc/iptables/rules.v4
```

The last command should print the five allowances. If it prints nothing, the
rules are not saved: HTTPS and calls will stop working after the next reboot,
including a maintenance reboot by Oracle. Oracle [advises against enabling UFW on its Ubuntu
image](https://docs.oracle.com/en-us/iaas/Content/Compute/References/bestpracticescompute.htm).

Keep API, ICE service, and PostgreSQL ports `3000`, `3090`, and `5432` off the
public ingress list; Compose binds the first two to loopback and does not
publish PostgreSQL to the host.

## Install published server images

Install Git, Docker Compose, Nginx, and Certbot on the VM:

```bash
sudo apt update
sudo apt install -y git docker.io docker-compose-v2 nginx certbot python3 python3-certbot-nginx curl
sudo systemctl enable --now docker
sudo docker compose version
```

Open the [latest published release](https://github.com/circlus-org/circlus-server/releases/latest)
and copy its tag, for example `v1.2.3`. Replace `v1.2.3` in the checkout
command below with that tag. Do not use a newer tag that has no published
release yet.

```bash
git clone https://github.com/circlus-org/circlus-server.git ~/circlus-server
cd ~/circlus-server
git switch --detach v1.2.3
cp deploy/.env.example deploy/.env
nano deploy/.env
```

Set at least these values in `deploy/.env`, substituting your own domain,
public IP, private IP, and the same tag you checked out above:

```env
TURN_PUBLIC_HOST=circle.example.com
TURN_EXTERNAL_IP=203.0.113.10/10.0.0.83
CIRCLUS_IMAGE_TAG=v1.2.3
```

`203.0.113.10` is a documentation example, not an address to use. The
`PUBLIC_IP/PRIVATE_IP` mapping tells coturn to advertise a reachable relay
address behind OCI's public-to-private mapping. See [coturn's `external-ip`
format](https://github.com/coturn/coturn/blob/master/README.turnserver).

Save with `Ctrl+O`, `Enter`, then exit with `Ctrl+X`. Generate local
credentials (without `sudo`) and start the images:

```bash
./deploy/init-local-turn.sh
sudo ./deploy/compose.sh pull
sudo ./deploy/compose.sh up -d
sudo ./deploy/compose.sh ps -a
```

`deploy/compose.sh` adds this installation's Compose files and profile and
prints the full `docker compose` command before running it.

`postgres`, `ice-config-service`, `coturn`, and `server` should become healthy.
`migrate` finishing as `Exited (0)` is expected. Keep `deploy/.env`,
`deploy/secrets/`, and `deploy/ice/turn-clusters.json` when updating or backing
up this VM. If you initialized secrets under another account or an older
release, follow the [secret permission instructions](README.md#files-created-during-setup).

## Enable HTTPS and test a Circle

Run the Nginx and Certbot setup with the Circle domain:

```bash
sudo ./deploy/add-nginx-site.sh circle.example.com
curl -fsS --max-time 10 https://circle.example.com/ready
```

The response should contain `"status":"ok"`. Create a one-time server-admin
claim token with the server container; do not share the token:

```bash
sudo ./deploy/compose.sh exec -e LOG_LEVEL=warn server \
  npm run server-admin:create-claim:prod -- --ttl-hours=1
```

In the [Circlus web client](https://web.circlus.org), choose **Create a circle
on my server** and enter its HTTPS URL and the claim token. Then
[test a call](../README.md#8-test-a-call) as described in the main README. To
confirm that media uses the local relay, follow the
[TURN call check](README.md#verify-a-call-through-turn).

Optional on a 1 GB VM: during a test call, check `free -m` (especially
`available`) and `sudo docker stats --no-stream`. One initial AMD VM test with
two people, video, screen sharing, and a UDP TURN relay kept 305-330 MiB
`available` and showed no OOM event in the sampled interval. This is a
single-call observation, not a concurrency or uptime guarantee.

Optional reboot check: after ending the call, reboot the VM and confirm that
Docker, HTTPS, and host firewall allowances return:

```bash
sudo reboot
# Reconnect by SSH, then:
cd ~/circlus-server
sudo ./deploy/compose.sh ps -a
curl -fsS --max-time 10 https://circle.example.com/ready
sudo iptables -L INPUT -n --line-numbers
```

If you perform the reboot check, make a new call to verify TURN externally.

## Updating this VM

Follow the [update steps in the main README](../README.md#updating): back up,
switch to the new version, set the same version in `deploy/.env`, `pull`, and
`up -d`, then check the services and `/ready`. This uses the published images
and does not compile anything on the 1 GB VM. The [deployment README](README.md)
covers logs, TURN diagnostics, and backups.
