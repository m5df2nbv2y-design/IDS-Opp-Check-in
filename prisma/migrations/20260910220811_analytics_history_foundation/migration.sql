-- AlterTable
ALTER TABLE "CampaignSelection" ADD COLUMN "amountAtSelection" REAL;
ALTER TABLE "CampaignSelection" ADD COLUMN "closeDateAtSelection" DATETIME;
ALTER TABLE "CampaignSelection" ADD COLUMN "stageAtSelection" TEXT;

-- AlterTable
ALTER TABLE "Opportunity" ADD COLUMN "closedAt" DATETIME;
ALTER TABLE "Opportunity" ADD COLUMN "finalAmount" REAL;
ALTER TABLE "Opportunity" ADD COLUMN "finalStage" TEXT;
ALTER TABLE "Opportunity" ADD COLUMN "isWon" BOOLEAN;
ALTER TABLE "Opportunity" ADD COLUMN "outcomeObservedAt" DATETIME;

-- CreateTable
CREATE TABLE "OpportunitySnapshot" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "opportunityId" TEXT,
    "externalId" TEXT NOT NULL,
    "observedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "source" TEXT NOT NULL,
    "amount" REAL NOT NULL,
    "stage" TEXT NOT NULL,
    "closeDate" DATETIME,
    "isOpen" BOOLEAN NOT NULL,
    "isWon" BOOLEAN,
    "accountId" TEXT,
    "accountName" TEXT NOT NULL,
    "internalRepId" TEXT,
    "internalRepName" TEXT NOT NULL,
    CONSTRAINT "OpportunitySnapshot_opportunityId_fkey" FOREIGN KEY ("opportunityId") REFERENCES "Opportunity" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "OpportunitySnapshot_opportunityId_observedAt_idx" ON "OpportunitySnapshot"("opportunityId", "observedAt");

-- CreateIndex
CREATE INDEX "OpportunitySnapshot_observedAt_idx" ON "OpportunitySnapshot"("observedAt");

-- CreateIndex
CREATE INDEX "OpportunitySnapshot_externalId_idx" ON "OpportunitySnapshot"("externalId");

-- CreateIndex
CREATE INDEX "OpportunitySnapshot_source_idx" ON "OpportunitySnapshot"("source");

-- CreateIndex
CREATE INDEX "Opportunity_isOpen_idx" ON "Opportunity"("isOpen");
