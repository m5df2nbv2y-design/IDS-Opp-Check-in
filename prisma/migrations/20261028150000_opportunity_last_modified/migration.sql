-- Additive only. Existing rows get NULL, which the application renders as an
-- explicit "unknown" rather than substituting a local timestamp.
ALTER TABLE "Opportunity" ADD COLUMN "salesforceLastModifiedAt" TIMESTAMP(3);
