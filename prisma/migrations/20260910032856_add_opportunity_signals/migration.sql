-- CreateTable
CREATE TABLE "OpportunitySignal" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "externalId" TEXT NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'smartsheet',
    "sheetName" TEXT NOT NULL,
    "signalType" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "assignedToName" TEXT,
    "dueDate" DATETIME,
    "occurredAt" DATETIME NOT NULL,
    "sourceUrl" TEXT,
    "rawAccountName" TEXT,
    "rawProjectName" TEXT,
    "rawOpportunityExternalId" TEXT,
    "matchStatus" TEXT NOT NULL DEFAULT 'UNMATCHED',
    "matchReason" TEXT,
    "opportunityId" TEXT,
    "accountId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'NEW',
    "reviewedAt" DATETIME,
    "reviewedBy" TEXT,
    "draftResponse" TEXT,
    "draftedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "OpportunitySignal_opportunityId_fkey" FOREIGN KEY ("opportunityId") REFERENCES "Opportunity" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "OpportunitySignal_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "OpportunitySignal_externalId_key" ON "OpportunitySignal"("externalId");

-- CreateIndex
CREATE INDEX "OpportunitySignal_matchStatus_idx" ON "OpportunitySignal"("matchStatus");

-- CreateIndex
CREATE INDEX "OpportunitySignal_status_idx" ON "OpportunitySignal"("status");

-- CreateIndex
CREATE INDEX "OpportunitySignal_opportunityId_idx" ON "OpportunitySignal"("opportunityId");

-- CreateIndex
CREATE INDEX "OpportunitySignal_accountId_idx" ON "OpportunitySignal"("accountId");
