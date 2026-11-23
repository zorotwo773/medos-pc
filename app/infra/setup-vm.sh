#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# MedOS — one-shot provisioning for a fresh Oracle Cloud Always Free VM.
#
# Target: Ubuntu 24.04 LTS, ARM64 (VM.Standard.A1.Flex, 4 OCPU / 24 GB).
#
# What this script does
#   1. apt-get update + install base packages
#   2. Install Docker Engine + Compose v2 plugin from Docker's official APT repo
#   3. Install Tailscale (so the VM can join your tailnet and run Funnel)
#   4. Create /data directory with the right uid/gid for the container user
#   5. Tighten firewall — only ssh (22) inbound; everything else blocked
#      (Funnel rides an outbound connection, so no listener is needed)
#
# Run once, as a regular sudo-capable user (Oracle default: `ubuntu`):
#     curl -fsSL https://raw.githubusercontent.com/<owner>/<repo>/main/app/infra/setup-vm.sh | sudo bash
#   OR, if you've already cloned the repo on the VM:
#     sudo bash app/infra/setup-vm.sh
#
# Idempotent: safe to re-run.
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

log()  { printf '\n\033[1;34m[setup-vm]\033[0m %s\n' "$*"; }
warn() { printf '\n\033[1;33m[setup-vm warn]\033[0m %s\n' "$*"; }
die()  { printf '\n\033[1;31m[setup-vm fail]\033[0m %s\n' "$*" >&2; exit 1; }

[[ $EUID -eq 0 ]] || die "Run with sudo."
[[ $(uname -s) == "Linux" ]] || die "This script only runs on Linux."

# Default the unprivileged "owner" user that will run docker commands etc.
# OCI Ubuntu images come with user `ubuntu` (uid 1000). Override via TARGET_USER env.
TARGET_USER="${TARGET_USER:-${SUDO_USER:-ubuntu}}"
id "$TARGET_USER" >/dev/null 2>&1 || die "Target user '$TARGET_USER' does not exist."
TARGET_UID="$(id -u "$TARGET_USER")"
TARGET_GID="$(id -g "$TARGET_USER")"
log "Provisioning for user '$TARGET_USER' (uid=$TARGET_UID, gid=$TARGET_GID)."

# ─── 1. Base packages ──────────────────────────────────────────────────────
log "Updating apt cache and installing base packages…"
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y --no-install-recommends \
    ca-certificates curl gnupg lsb-release \
    git rsync openssh-client \
    ufw \
    htop tmux jq

# ─── 2. Docker Engine + Compose plugin ─────────────────────────────────────
if ! command -v docker >/dev/null 2>&1; then
    log "Installing Docker Engine from the official APT repo…"
    install -m 0755 -d /etc/apt/keyrings
    curl -fsSL https://download.docker.com/linux/ubuntu/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
    chmod a+r /etc/apt/keyrings/docker.gpg
    arch="$(dpkg --print-architecture)"
    codename="$(. /etc/os-release && echo "$VERSION_CODENAME")"
    echo "deb [arch=$arch signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu $codename stable" \
        > /etc/apt/sources.list.d/docker.list
    apt-get update -y
    apt-get install -y --no-install-recommends \
        docker-ce docker-ce-cli containerd.io \
        docker-buildx-plugin docker-compose-plugin
    systemctl enable --now docker
else
    log "Docker already installed — skipping."
fi

# Let the target user run docker without sudo
if ! id -nG "$TARGET_USER" | grep -qw docker; then
    log "Adding $TARGET_USER to the docker group…"
    usermod -aG docker "$TARGET_USER"
    warn "$TARGET_USER must log out and back in (or 'newgrp docker') before 'docker' works without sudo."
fi

# ─── 3. Tailscale ──────────────────────────────────────────────────────────
if ! command -v tailscale >/dev/null 2>&1; then
    log "Installing Tailscale…"
    curl -fsSL https://tailscale.com/install.sh | sh
else
    log "Tailscale already installed — skipping."
fi

# Don't auto-`tailscale up`: that needs an interactive browser auth on first
# run. Print the next step instead. (See HOSTING.md.)

# ─── 4. /data directory ────────────────────────────────────────────────────
log "Preparing /data mount point…"
mkdir -p /data
chown -R "$TARGET_UID":"$TARGET_GID" /data
chmod 755 /data

# If a separate block volume was attached, OCI presents it as /dev/sdb or
# similar. Detection is tricky and varies — script only sets ownership on the
# existing /data path. Mounting a fresh block volume is documented in
# HOSTING.md (the OCI iscsi attach + mkfs + fstab dance).

# ─── 5. Firewall ───────────────────────────────────────────────────────────
log "Configuring ufw — allow ssh only, block everything else inbound…"
ufw --force reset
ufw default deny incoming
ufw default allow outgoing
ufw allow 22/tcp comment "ssh"
# Funnel makes outbound connections to Tailscale's edge; no inbound rule needed
# for HTTP. nginx binds to 127.0.0.1:80 inside compose, not the host's external
# interface, so even if ufw weren't in the way it wouldn't be reachable from
# the public internet directly.
ufw --force enable

# Mirror to OCI's iptables-based firewall for systems where ufw doesn't
# survive a reboot. Oracle-Linux/Ubuntu uses iptables-persistent.
if command -v iptables >/dev/null 2>&1; then
    iptables -I INPUT 1 -p tcp --dport 22 -j ACCEPT 2>/dev/null || true
fi

# ─── Summary ───────────────────────────────────────────────────────────────
cat <<'EOF'

──────────────────────────────────────────────────────────────────────────
VM provisioning complete.  Next steps (run as the target user, not root):

  1. Log out and back in so docker group membership takes effect.

  2. Join Tailscale and bring the device up:
       sudo tailscale up --ssh --accept-routes --advertise-tags=tag:medos-vm
     A URL will print; open it in any browser to approve the device.

  3. Clone the repo and copy the env template:
       git clone https://github.com/<owner>/<repo>.git ~/medos
       cd ~/medos/app/infra
       cp .env.production.example .env.production
       chmod 600 .env.production
       $EDITOR .env.production   # set MEDOS_ACCESS_CODE + MEDOS_SESSION_SECRET

  4. Sync data from your PC to /data (run on the PC, not here):
       pwsh app/infra/sync-data.ps1 -VmHost <your>.<tailnet>.ts.net

  5. Build + start the stack:
       cd ~/medos/app
       docker compose -f infra/docker-compose.yml --env-file infra/.env.production up -d --build

  6. Expose the stack publicly via Tailscale Funnel (HTTPS, free, *.ts.net):
       sudo tailscale serve --bg --https=443 http://127.0.0.1:80
       sudo tailscale funnel --bg 443

       Confirm the URL with:  tailscale status

The public URL appears in `tailscale status` output and looks like:
   https://medos-vm.<tailnet>.ts.net

Share that URL + your access code with testers.  No Oracle account, no 2FA.
──────────────────────────────────────────────────────────────────────────
EOF
