#!/usr/bin/env bash
# Audiator — step 6, stage 2: HTTPS in front of the accounts server.
#
#   scp deploy/setup-https.sh audiator:/root/ && ssh audiator 'bash /root/setup-https.sh'
#
# A free Let's Encrypt certificate for the server's name (renews itself), and
# nginx passing only the app's API (/api/v2/) to 127.0.0.1:3000; everything else
# answers 404. Accepting Let's Encrypt's Subscriber Agreement was agreed with the
# owner (2026-10-07). Safe to run again.
set -euo pipefail

NAME=${NAME:-audiator.duckdns.org}
LIVE=/etc/letsencrypt/live/$NAME
SITE=/etc/nginx/sites-available/audiator
export DEBIAN_FRONTEND=noninteractive
say() { printf '\n== %s\n' "$*"; }

say "certbot"
apt-get -y -q install certbot >/dev/null
install -d /var/www/html/.well-known/acme-challenge

http_only() {
  cat > "$SITE" <<EOF
# Audiator: the name $NAME. Port 80 — Let's Encrypt's check, else to HTTPS.
server {
    listen 80;
    listen [::]:80;
    server_name $NAME;
    location /.well-known/acme-challenge/ { root /var/www/html; }
    location / { return 301 https://\$host\$request_uri; }
}
EOF
}

with_https() {
  http_only
  cat >> "$SITE" <<EOF

# HTTPS: only the app's API goes through; the server's own pages (/docs …) stay shut.
server {
    listen 443 ssl http2;
    listen [::]:443 ssl http2;
    server_name $NAME;

    ssl_certificate     $LIVE/fullchain.pem;
    ssl_certificate_key $LIVE/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_prefer_server_ciphers off;
    ssl_session_cache shared:audiator:1m;
    ssl_session_timeout 1d;
    add_header Strict-Transport-Security "max-age=31536000" always;

    client_max_body_size 64k;   # support messages are up to 5000 characters

    location /api/v2/ {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host \$host;
        # Overwritten, not appended: the server takes the left-most address for
        # its per-IP limits, and a client must not be able to choose it.
        proxy_set_header X-Forwarded-For \$remote_addr;
        proxy_set_header X-Forwarded-Proto https;
        proxy_read_timeout 30s;
    }
    location / { return 404; }
}
EOF
}

say "nginx: the name on port 80"
if [ -f "$LIVE/fullchain.pem" ]; then with_https; else http_only; fi
ln -sf "$SITE" /etc/nginx/sites-enabled/audiator
nginx -t -q
systemctl reload nginx

say "certificate for $NAME"
if [ ! -f "$LIVE/fullchain.pem" ]; then
  certbot certonly --webroot -w /var/www/html -d "$NAME" \
    --agree-tos --register-unsafely-without-email --non-interactive
fi
install -d /etc/letsencrypt/renewal-hooks/deploy
cat > /etc/letsencrypt/renewal-hooks/deploy/reload-nginx <<'EOF'
#!/bin/sh
systemctl reload nginx
EOF
chmod 755 /etc/letsencrypt/renewal-hooks/deploy/reload-nginx
systemctl is-active certbot.timer
certbot certificates 2>/dev/null | grep -E 'Domains|Expiry'

say "nginx: HTTPS"
with_https
nginx -t -q
systemctl reload nginx

say "check"
curl -s -o /dev/null -w "https://$NAME/api/v2/me -> %{http_code} (401 = the server answers, no token)\n" "https://$NAME/api/v2/me"
curl -s -o /dev/null -w "https://$NAME/docs -> %{http_code} (404 = shut)\n" "https://$NAME/docs"
curl -s -o /dev/null -w "http://$NAME/ -> %{http_code} (301 = to HTTPS)\n" "http://$NAME/"
echo "done"
