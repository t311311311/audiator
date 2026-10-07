#!/usr/bin/env bash
# Audiator accounts server on a fresh Ubuntu 24.04 VPS — step 6, stage 1.
#
#   scp deploy/setup-server.sh audiator:/root/ && ssh audiator 'bash /root/setup-server.sh'
#
# Safe to run again: it updates the code and keeps the data, the secrets and
# the settings already made. Open to the internet: SSH (key only) and an empty
# port 80. The accounts server listens on 127.0.0.1:3000 until stage 2 puts
# HTTPS in front of it.
set -euo pipefail

REPO=https://github.com/t311311311/audiator.git
BRANCH=${BRANCH:-main}
APP=/opt/audiator              # code (auth-server only) and its venv
DATA=/var/lib/audiator         # the databases
LOGS=/var/log/audiator         # capped server logs (auth-server/log_setup.py)
BACKUPS=/var/backups/audiator  # daily copies of the databases, 14 kept
ENVF=/etc/audiator/auth.env    # secrets and settings, root:audiator 640

export DEBIAN_FRONTEND=noninteractive
say() { printf '\n== %s\n' "$*"; }

say "swap (1 GB of RAM: pip and apt upgrades need room)"
if ! swapon --show | grep -q .; then
  fallocate -l 1G /swapfile && chmod 600 /swapfile && mkswap -q /swapfile && swapon /swapfile
  grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi
swapon --show

say "updates; security updates install themselves from now on"
apt-get update -q
apt-get -y -q -o Dpkg::Options::=--force-confold upgrade
apt-get -y -q install unattended-upgrades fail2ban python3-systemd ufw nginx python3-venv git sqlite3 curl
cat > /etc/apt/apt.conf.d/20auto-upgrades <<'EOF'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
EOF

say "ssh: by key only (the root password went through a chat)"
sort -u /root/.ssh/authorized_keys -o /root/.ssh/authorized_keys
cat > /etc/ssh/sshd_config.d/00-audiator.conf <<'EOF'
# Audiator: sign in by key only. "00-" so it is read before 50-cloud-init.conf:
# sshd keeps the first value it reads. The HOSTKEY panel console still takes
# the root password, if the key is ever lost.
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin prohibit-password
EOF
sshd -t
systemctl restart ssh
sshd -T | grep -E '^(passwordauthentication|kbdinteractiveauthentication|permitrootlogin) '

say "fail2ban: 5 failed sign-ins in 10 minutes = an hour's ban"
cat > /etc/fail2ban/jail.d/audiator.conf <<'EOF'
[sshd]
enabled = true
backend = systemd
maxretry = 5
findtime = 10m
bantime = 1h
EOF
systemctl enable -q fail2ban
systemctl restart fail2ban
sleep 2
fail2ban-client status sshd | head -3

say "firewall: in — 22 (ssh), 80 and 443; out — everything but port 25"
# HOSTKEY unblocks SMTP on request and blocks the server for good on a spam
# complaint. We send mail only through Gmail (465/587), never straight to
# other mail servers: port 25 out stays shut even if the server were hacked.
ufw default deny incoming >/dev/null
ufw default allow outgoing >/dev/null
ufw allow 22/tcp >/dev/null
ufw allow 80/tcp >/dev/null
ufw allow 443/tcp >/dev/null
ufw deny out 25/tcp >/dev/null
ufw --force enable
ufw status verbose | sed -n '1,20p'

say "user audiator, the code ($BRANCH), its venv"
id audiator >/dev/null 2>&1 || useradd --system --home-dir "$APP" --shell /usr/sbin/nologin audiator
install -d -o audiator -g audiator "$APP" "$DATA" "$LOGS"
install -d -o root -g root -m 700 "$BACKUPS"
install -d -o root -g audiator -m 750 /etc/audiator
as_app() { runuser -u audiator -- "$@"; }
if [ -d "$APP/src/.git" ]; then
  as_app git -C "$APP/src" fetch -q origin "$BRANCH"
  as_app git -C "$APP/src" checkout -q -B "$BRANCH" "origin/$BRANCH"
else
  # Only the server and its admin script are needed: a sparse, blobless clone.
  as_app git clone -q --filter=blob:none --sparse --branch "$BRANCH" "$REPO" "$APP/src"
fi
as_app git -C "$APP/src" sparse-checkout set auth-server scripts
as_app git -C "$APP/src" log --oneline -1
[ -x "$APP/venv/bin/python" ] || as_app python3 -m venv "$APP/venv"
as_app "$APP/venv/bin/pip" install -q --upgrade pip
as_app "$APP/venv/bin/pip" install -q -r "$APP/src/auth-server/requirements.txt"

say "secrets and settings (made once, here; never in the repository)"
if [ ! -f "$ENVF" ]; then
  umask 027
  cat > "$ENVF" <<EOF
# Audiator accounts server. root:audiator 640. Made by deploy/setup-server.sh.
AUDIATOR_SECRET_KEY=$(python3 -c 'import secrets; print(secrets.token_urlsafe(48))')
BIND_HOST=127.0.0.1
DATABASE_URL=sqlite:///$DATA/audiator.db
ACCOUNTS_DATABASE_URL=sqlite:///$DATA/accounts.db
ADMIN_EMAILS=t311311311@gmail.com
PAYMENTS_ENABLED=0
LOG_DIR=$LOGS
LOG_MAX_TOTAL_MB=500
LOG_CONSOLE=0
# Mail for the sign-in codes (stage 2):
# SMTP_HOST=smtp.gmail.com
# SMTP_PORT=465
# SMTP_USER=audiatorr@gmail.com
# SMTP_PASSWORD=
# SMTP_FROM="Audiator <audiatorr@gmail.com>"
EOF
  umask 022
  chown root:audiator "$ENVF"
  chmod 640 "$ENVF"
  echo "made $ENVF"
else
  echo "$ENVF kept"
fi

say "the accounts server as a service (starts by itself after a reboot)"
cat > /etc/systemd/system/audiator-auth.service <<EOF
[Unit]
Description=Audiator accounts server
After=network-online.target
Wants=network-online.target

[Service]
User=audiator
Group=audiator
WorkingDirectory=$APP/src/auth-server
EnvironmentFile=$ENVF
ExecStart=$APP/venv/bin/python main.py
Restart=on-failure
RestartSec=3
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=$DATA $LOGS

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable -q audiator-auth
systemctl restart audiator-auth

say "digest of the messages to support, every hour; audiator-admin"
# Messages to support are not mailed one by one: support_digest.py sends one
# letter at 10 new, and a morning digest (DIGEST_HOUR_UTC, 05:00 = 09:00 GMT+4).
cat > /etc/systemd/system/audiator-digest.service <<EOF
[Unit]
Description=Audiator: digest of the messages to support
After=network-online.target

[Service]
Type=oneshot
User=audiator
Group=audiator
WorkingDirectory=$APP/src/auth-server
EnvironmentFile=$ENVF
Environment=PYTHONUTF8=1
ExecStart=$APP/venv/bin/python support_digest.py
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=$DATA
EOF
cat > /etc/systemd/system/audiator-digest.timer <<'EOF'
[Unit]
Description=Audiator: digest of the messages to support, every hour

[Timer]
OnCalendar=hourly

[Install]
WantedBy=timers.target
EOF
# scripts/admin.py with the server's settings and data, as the audiator user.
cat > /usr/local/bin/audiator-admin <<EOF
#!/bin/sh
# Audiator admin on the server:
#   audiator-admin tickets | ticket N | ticket N answered | accounts | client EMAIL
exec systemd-run --quiet --pipe --wait --collect -p User=audiator -p EnvironmentFile=$ENVF \\
  -p WorkingDirectory=$APP/src/auth-server -E PYTHONUTF8=1 \\
  $APP/venv/bin/python $APP/src/scripts/admin.py "\$@"
EOF
chmod 755 /usr/local/bin/audiator-admin
systemctl daemon-reload
systemctl enable -q --now audiator-digest.timer

say "daily backup of the databases, 14 kept"
cat > /usr/local/sbin/audiator-backup <<'EOF'
#!/bin/sh
# Daily copy of the databases. sqlite's .backup is safe while the server writes.
set -eu
D=/var/backups/audiator
T=$(date -u +%Y%m%d-%H%M)
for db in accounts audiator; do
  [ -f "/var/lib/audiator/$db.db" ] || continue
  sqlite3 "/var/lib/audiator/$db.db" ".backup '$D/$db-$T.db'"
  gzip -f "$D/$db-$T.db"
  ls -1t "$D/$db"-*.db.gz | tail -n +15 | xargs -r rm -f
done
EOF
chmod 755 /usr/local/sbin/audiator-backup
cat > /etc/systemd/system/audiator-backup.service <<'EOF'
[Unit]
Description=Audiator: copy of the databases

[Service]
Type=oneshot
ExecStart=/usr/local/sbin/audiator-backup
EOF
cat > /etc/systemd/system/audiator-backup.timer <<'EOF'
[Unit]
Description=Audiator: copy of the databases every day

[Timer]
OnCalendar=*-*-* 02:30:00 UTC
RandomizedDelaySec=10m
Persistent=true

[Install]
WantedBy=timers.target
EOF
systemctl daemon-reload
systemctl enable -q --now audiator-backup.timer

say "nginx: nothing public until HTTPS (stage 2)"
cat > /etc/nginx/conf.d/audiator.conf <<'EOF'
server_tokens off;
EOF
cat > /etc/nginx/sites-available/default <<'EOF'
# Stage 1: no site yet. Stage 2 adds HTTPS and proxies it to the accounts
# server on 127.0.0.1:3000.
server {
    listen 80 default_server;
    listen [::]:80 default_server;
    server_name _;
    location / { return 404; }
}
EOF
nginx -t -q
systemctl reload nginx

say "check"
sleep 3
systemctl is-active audiator-auth
curl -s -o /dev/null -w 'accounts server on 127.0.0.1:3000: HTTP %{http_code}\n' http://127.0.0.1:3000/docs
/usr/local/sbin/audiator-backup && ls -l "$BACKUPS"
systemctl list-timers audiator-backup.timer audiator-digest.timer --no-pager | sed -n '1,3p'
audiator-admin tickets
echo "done"
