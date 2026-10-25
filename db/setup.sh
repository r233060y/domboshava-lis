#!/usr/bin/env bash
# Build the database from scratch (Linux / macOS). Windows: run the same
# psql commands by hand, as shown in the README.
#
#   ./db/setup.sh                 # creates domboshava_lis
#   ./db/setup.sh my_test_db      # or any name you give
#
# Uses the usual PG* environment variables (PGHOST, PGPORT, PGUSER) and
# must connect as a role that can create databases (e.g. postgres).
set -euo pipefail
DB="${1:-domboshava_lis}"
HERE="$(cd "$(dirname "$0")" && pwd)"

echo "Creating database $DB ..."
createdb "$DB"
for f in 01_schema.sql 02_audit_and_security.sql 03_seed.sql; do
  echo "Running $f ..."
  psql -v ON_ERROR_STOP=1 -q -d "$DB" -f "$HERE/$f"
done

cat <<EOF

Done. Now set the two role passwords (there are no defaults):
  psql -d $DB -c "ALTER ROLE lis_api PASSWORD 'choose-one'"
  psql -d $DB -c "ALTER ROLE lis_public PASSWORD 'choose-another'"
(The roles belong to the whole PostgreSQL server: set them once.)
EOF
