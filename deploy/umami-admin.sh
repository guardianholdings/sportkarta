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
-- Distinct visits per campaign tag. Anyone can open the site with any utm_*
-- value, and this output reaches a public log, so a value prints only when it
-- has the shape of our own tags; anything else prints as "other", none as "-".
-- Labels print only for a group that 3 or more distinct sessions share, so a
-- value one person typed stays out of the log; the smaller groups share one
-- "small-groups" line with their number and their distinct visits.
WITH t AS (
  SELECT e.visit_id, e.session_id,
         CASE WHEN e.utm_source ~ '^[a-z0-9]{1,40}$' THEN e.utm_source
              WHEN coalesce(e.utm_source, '') = '' THEN '-' ELSE 'other' END AS src,
         CASE WHEN e.utm_campaign ~ '^[a-z0-9]+(-[a-z0-9]+)*$'
                   AND length(e.utm_campaign) <= 40 THEN e.utm_campaign
              WHEN coalesce(e.utm_campaign, '') = '' THEN '-' ELSE 'other' END AS cmp,
         CASE WHEN e.utm_content ~ '^([A-Z]{1,3}[0-9]{1,2}[A-Z]?|s[0-9]{1,2})$'
                   OR e.utm_content IN ('reply', 'gore-728x90', 'gore-320x100') THEN e.utm_content
              WHEN coalesce(e.utm_content, '') = '' THEN '-' ELSE 'other' END AS cnt
    FROM website w JOIN website_event e ON e.website_id = w.website_id
   WHERE w.domain = :'domain' AND w.deleted_at IS NULL
     AND e.created_at >= now() - make_interval(hours => :hours)
     AND e.event_type = 1
     AND (coalesce(e.utm_source, '') <> '' OR coalesce(e.utm_campaign, '') <> ''
          OR coalesce(e.utm_content, '') <> '')
), g AS (
  SELECT src, cmp, cnt, count(DISTINCT visit_id) AS visits,
         count(DISTINCT session_id) AS sessions
    FROM t
   GROUP BY src, cmp, cnt
)
SELECT line FROM (
  SELECT 0 AS part, visits, src, cmp, cnt,
         'utm source=' || src || ' campaign=' || cmp || ' content=' || cnt
         || ' visits=' || visits AS line
    FROM g WHERE sessions >= 3
  UNION ALL
  SELECT 1, 0, '', '', '',
         'utm small-groups=' || (SELECT count(*) FROM g WHERE sessions < 3)
         || ' visits=' || (SELECT count(DISTINCT t.visit_id)
                             FROM t JOIN g ON g.src = t.src AND g.cmp = t.cmp AND g.cnt = t.cnt
                            WHERE g.sessions < 3)
) r
 ORDER BY part, visits DESC, src, cmp, cnt;
SQL
    } | sql
  ) || die "Umami's database refused the read (see above)"
  ids=$(printf '%s\n' "$out" | sed -n 's/^website_id=//p')
  [ -n "$ids" ] || die "Umami has no website for $domain yet — run bootstrap"
  printf '%s\n' "$ids" | sed 's/^/UMAMI_WEBSITE_ID=/'
  counts=$(printf '%s\n' "$out" | grep '^since=' || true)
  [ -n "$counts" ] || die "no counts came back"
  echo "$counts${tag:+ (utm_source=$tag)}"
  printf '%s\n' "$out" | grep '^utm ' || true
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
