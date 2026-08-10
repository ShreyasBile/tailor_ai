\pset border 2
\echo '--- recent users ---'
SELECT email, "createdAt" FROM "User" ORDER BY "createdAt" DESC LIMIT 6;

\echo '--- recent consents ---'
SELECT u.email, c.kind, c.granted, c."grantedAt"
FROM "Consent" c JOIN "User" u ON u.id = c."userId"
ORDER BY c."grantedAt" DESC LIMIT 6;

\echo '--- recent jobs ---'
SELECT id, status, progress, "errorCode" FROM "ReconstructionJob"
ORDER BY "queuedAt" DESC LIMIT 5;
