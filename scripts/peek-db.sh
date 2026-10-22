#!/usr/bin/env bash
# Quick read-only look at recent activity. Diagnostic aid, not part of the app.
#   wsl -u root -- bash scripts/peek-db.sh   (from the repo root)
set -uo pipefail

q() { su postgres -c "psql -d tailorai -t -A -F'|' -c \"$1\""; }

echo "--- recent users ---"
q 'SELECT email, "createdAt" FROM "User" ORDER BY "createdAt" DESC LIMIT 6;'

echo ""
echo "--- recent consents ---"
q 'SELECT u.email, c.kind, c.granted FROM "Consent" c JOIN "User" u ON u.id=c."userId" ORDER BY c."grantedAt" DESC LIMIT 6;'

echo ""
echo "--- recent jobs ---"
q 'SELECT id, status, progress, "errorCode" FROM "ReconstructionJob" ORDER BY "queuedAt" DESC LIMIT 5;'
