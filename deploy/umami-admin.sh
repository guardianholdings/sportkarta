#!/usr/bin/env bash
# Umami maintenance, run ON the server from /opt/sportkarta by
# .github/workflows/umami-admin.yml (Actions → Umami admin → Run workflow).
#
#   bootstrap  Umami ships with a documented default admin login, and only the
#              basic-auth lock in the Caddyfile stands in front of it. This
#              gives that login the lock's own password, ADMIN_TOOLS_PASSWORD,
#              by copying the bcrypt hash deploy.yml already renders into .env
#              as ADMIN_TOOLS_HASH (Umami checks passwords with bcrypt too). No
#              plaintext is sent, typed or printed, and the old password is not
#              needed — so after rotating the secret: run Deploy, then this.
#              It then makes sure Umami has exactly one website for the site's
#              domain and prints its Website ID, which is public (every page
#              carries it in the tracker tag). Re-running changes nothing new.
#   check      Read-only. The Website ID and, for the last <hours>, aggregate
#              counts: pageviews, visits, and pageviews whose utm_source is
#              <utm_source>. Nothing about any single visitor is printed.
#
# Usage: umami-admin.sh bootstrap | check [utm_source] [hours]
# Writes only to Umami's own database (`umami`), never the app's.
set -euo pipefail

mode="${1:-}"
tag="${2:-}"
hours="${3:-2}"

die() {
  echo "umami-admin: $*" >&2
  exit 1
}

case "$mode" in
  bootstrap | check) ;;
  *) die "usage: umami-admin.sh bootstrap | check [utm_source] [hours]" ;;
esac
tag_re='^[A-Za-z0-9._-]{0,40}$'
[[ $tag =~ $tag_re ]] || die "utm_source: letters, digits and . _ - only, at most 40"
hours_re='^[1-9][0-9]{0,2}$'
[[ $hours =~ $hours_re ]] || die "hours: a whole number from 1 to 999"

cd "${UMAMI_ADMIN_DIR:-/opt/sportkarta}"
[ -r .env ] || die "no .env here — has Deploy ever run?"

# The site's domain as deploy.yml rendered it. IP-only mode has none, and the
# tracker never runs there.
domain=$(sed -n 's/^DOMAIN=//p' .env | tail -n 1)
domain_re='^[a-z0-9]([a-z0-9.-]*[a-z0-9])?\.[a-z]{2,}$'
[[ $domain =~ $domain_re ]] || die "no site domain in .env (IP-only mode?); nothing changed"

# SQL goes in on stdin, never on a command line (-X: ignore any psqlrc). psql
# quotes a failing statement in its error, so anything shaped like a bcrypt
# hash is masked before stderr reaches the log.
sql() {
  local err rc=0
  { err=$(docker compose -f compose.prod.yml exec -T db \
    psql -X -q -t -A -v ON_ERROR_STOP=1 -v VERBOSITY=terse -U sportkarta -d umami \
    2>&1 1>&3 3>&-); } 3>&1 || rc=$?
  if [ -n "$err" ]; then
    # shellcheck disable=SC2016 # literal $ signs in a pattern, not expansions
    printf '%s\n' "$err" | sed -E 's/\$2[aby]\$[0-9]{2}\$[./A-Za-z0-9]{53}/[hash]/g' >&2
  fi
  return "$rc"
}

if [ "$mode" = check ]; then
  out=$(
    {
      printf '\\set domain %s\n\\set tag %s\n\\set hours %s\n' "'$domain'" "'$tag'" "$hours"
      cat <<'SQL'
SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY;
SELECT 'website_id=' || website_id FROM website
 WHERE domain = :'domain' AND deleted_at IS NULL ORDER BY created_at;
SELECT 'since=' || to_char(now() AT TIME ZONE 'UTC' - make_interval(hours => :hours),
                           'YYYY-MM-DD"T"HH24:MI"Z"')
    || ' pageviews=' || count(*) FILTER (WHERE e.event_type = 1)
    || ' visits=' || count(DISTINCT e.visit_id)
    || ' tagged=' || count(*) FILTER (WHERE e.event_type = 1 AND :'tag' <> ''
                                        AND e.utm_source = :'tag')
  FROM website w JOIN website_event e ON e.website_id = w.website_id
 WHERE w.domain = :'domain' AND w.deleted_at IS NULL
   AND e.created_at >= now() - make_interval(hours => :hours);
SQL
    } | sql
  ) || die "Umami's database refused the read (see above)"
  ids=$(printf '%s\n' "$out" | sed -n 's/^website_id=//p')
  [ -n "$ids" ] || die "Umami has no website for $domain yet — run bootstrap"
  printf '%s\n' "$ids" | sed 's/^/UMAMI_WEBSITE_ID=/'
  counts=$(printf '%s\n' "$out" | grep '^since=' || true)
  [ -n "$counts" ] || die "no counts came back"
  echo "$counts${tag:+ (utm_source=$tag)}"
  exit 0
fi

# bootstrap. deploy.yml stores the hash base64-encoded, the form Caddy reads.
b64=$(sed -n "s/^ADMIN_TOOLS_HASH='\\(.*\\)'\$/\\1/p" .env | tail -n 1)
[ -n "$b64" ] || die "ADMIN_TOOLS_HASH is not in .env — run Deploy first; nothing changed"
hash=$(printf '%s' "$b64" | base64 -d 2>/dev/null) || die "ADMIN_TOOLS_HASH is not base64; nothing changed"
# shellcheck disable=SC2016 # literal $ signs in a pattern, not expansions
hash_re='^\$2[aby]\$[0-9]{2}\$[./A-Za-z0-9]{53}$'
[[ $hash =~ $hash_re ]] || die "ADMIN_TOOLS_HASH is not a bcrypt hash; nothing changed"

# One transaction: on any error psql stops before COMMIT and nothing is kept.
out=$(
  {
    printf '\\set hash %s\n\\set domain %s\n' "'$hash'" "'$domain'"
    cat <<'SQL'
BEGIN;
WITH admin AS (
  UPDATE "user" SET password = :'hash', updated_at = now()
   WHERE username = 'admin' AND deleted_at IS NULL
  RETURNING user_id
), site AS (
  INSERT INTO website (website_id, name, domain, user_id, created_by)
  SELECT gen_random_uuid(), 'POPS', :'domain', user_id, user_id FROM admin
   WHERE NOT EXISTS (SELECT 1 FROM website WHERE domain = :'domain' AND deleted_at IS NULL)
  RETURNING website_id
)
SELECT 'admin=' || (SELECT count(*) FROM admin) || ' created=' || (SELECT count(*) FROM site);
SELECT 'website_id=' || website_id FROM website
 WHERE domain = :'domain' AND deleted_at IS NULL ORDER BY created_at;
COMMIT;
SQL
  } | sql
) || die "Umami's database refused (see above); nothing changed"

admin=$(printf '%s\n' "$out" | sed -n 's/^admin=\([0-9]*\) created=[0-9]*$/\1/p')
created=$(printf '%s\n' "$out" | sed -n 's/^admin=[0-9]* created=\([0-9]*\)$/\1/p')
ids=$(printf '%s\n' "$out" | sed -n 's/^website_id=//p')
[ -n "$admin" ] || die "Umami's database gave no answer; nothing changed"
[ "$admin" = 1 ] || die "Umami has no active user 'admin' (renamed?); nothing changed"
echo "Umami admin login: password is now the dashboard lock's (ADMIN_TOOLS_PASSWORD)"
n=$(printf '%s\n' "$ids" | grep -c . || true)
[ "$n" = 1 ] || die "$n websites for $domain — keep one by hand: $(printf '%s\n' "$ids" | tr '\n' ' ')"
if [ "$created" = 1 ]; then
  echo "Umami website POPS ($domain): created"
else
  echo "Umami website POPS ($domain): already there"
fi
echo "UMAMI_WEBSITE_ID=$ids"
