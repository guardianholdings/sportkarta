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
#   share      Boss's read-only share link (#34.10): the site's website gets
#              exactly one share, overview only, at the slug read from stdin
#              (the workflow sends the UMAMI_SHARE_SLUG secret). The slug is
#              never printed: this job's log is public, and the slug is the
#              link. The same slug again changes nothing; a new slug replaces
#              the old link, which stops working at once.
#   unshare    Deletes the site's shares: every share link stops working at
#              once. Nothing else changes.
#
# Usage: umami-admin.sh bootstrap | check [utm_source] [hours] | share | unshare
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
  bootstrap | check | share | unshare) ;;
  *) die "usage: umami-admin.sh bootstrap | check [utm_source] [hours] | share | unshare" ;;
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
    # The share slug is the link itself, so it is masked the same way.
    # shellcheck disable=SC2016 # literal $ signs in a pattern, not expansions
    local masks=(-e 's/\$2[aby]\$[0-9]{2}\$[./A-Za-z0-9]{53}/[hash]/g')
    [ -z "${slug:-}" ] || masks+=(-e "s/$slug/[slug]/g")
    printf '%s\n' "$err" | sed -E "${masks[@]}" >&2
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

# share / unshare. share_type 1 is Umami's ENTITY_TYPE.website (3.3.0,
# src/lib/constants.ts); a share row is what Umami's own "Share" button makes.
if [ "$mode" = share ] || [ "$mode" = unshare ]; then
  slug=''
  if [ "$mode" = share ]; then
    IFS= read -r slug || true
    # Umami's own share slugs are 8-50 letters and digits (SHARE_ID_REGEX).
    slug_re='^[A-Za-z0-9]{16,50}$'
    [[ $slug =~ $slug_re ]] || die "share: no usable slug on stdin (16-50 letters and digits; is UMAMI_SHARE_SLUG set?); nothing changed"
  fi
  out=$(
    {
      printf '\\set domain %s\n\\set slug %s\n\\set mode %s\n' "'$domain'" "'$slug'" "'$mode'"
      cat <<'SQL'
BEGIN;
WITH site AS (
  SELECT website_id FROM website WHERE domain = :'domain' AND deleted_at IS NULL
), gone AS (
  DELETE FROM share s USING site
   WHERE s.entity_id = site.website_id AND s.share_type = 1
     AND (:'mode' = 'unshare' OR s.slug <> :'slug')
  RETURNING s.share_id
), made AS (
  INSERT INTO share (share_id, entity_id, name, share_type, slug, parameters, created_at, updated_at)
  SELECT gen_random_uuid(), website_id, 'Read-only overview (#34.10)', 1, :'slug',
         '{"overview": true}'::jsonb, now(), now()
    FROM site
   WHERE :'mode' = 'share' AND NOT EXISTS (SELECT 1 FROM share WHERE slug = :'slug')
  RETURNING share_id
)
SELECT 'sites=' || (SELECT count(*) FROM site) || ' removed=' || (SELECT count(*) FROM gone)
    || ' created=' || (SELECT count(*) FROM made);
COMMIT;
SQL
    } | sql
  ) || die "Umami's database refused (see above); nothing changed"
  sites=$(printf '%s\n' "$out" | sed -n 's/^sites=\([0-9]*\) .*/\1/p')
  [ "$sites" = 1 ] || die "$sites websites for $domain (expected 1; run bootstrap or check)"
  printf '%s\n' "$out" | sed -n 's/^sites=1 //p'
  if [ "$mode" = share ]; then
    echo "Share link: https://umami.$domain/share/<UMAMI_SHARE_SLUG> (overview only; not printed here)"
  else
    echo "Every share link for $domain is gone"
  fi
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
