-- CreateTable
CREATE TABLE "Account" (
    "id" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" TEXT NOT NULL DEFAULT 'OTHER',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Account_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExternalContact" (
    "id" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "isPrimary" BOOLEAN NOT NULL DEFAULT false,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ExternalContact_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SalesRep" (
    "id" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SalesRep_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Opportunity" (
    "id" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "customerName" TEXT NOT NULL,
    "opportunityName" TEXT NOT NULL,
    "projectName" TEXT,
    "amount" DOUBLE PRECISION NOT NULL,
    "currentStage" TEXT NOT NULL,
    "internalRepId" TEXT NOT NULL,
    "contactId" TEXT,
    "resolutionStatus" TEXT NOT NULL DEFAULT 'UNRESOLVED',
    "resolutionReason" TEXT,
    "salesforceUrl" TEXT NOT NULL,
    "closeDate" TIMESTAMP(3),
    "isOpen" BOOLEAN NOT NULL DEFAULT true,
    "isWon" BOOLEAN,
    "finalStage" TEXT,
    "finalAmount" DOUBLE PRECISION,
    "closedAt" TIMESTAMP(3),
    "outcomeObservedAt" TIMESTAMP(3),
    "lastSyncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Opportunity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Campaign" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "period" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "Campaign_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CheckInRecipient" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "contactId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "tokenHint" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "sentAt" TIMESTAMP(3),
    "deliveredAt" TIMESTAMP(3),
    "openedAt" TIMESTAMP(3),
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "sendStatus" TEXT NOT NULL DEFAULT 'PENDING',
    "sendError" TEXT,
    "remindedAt" TIMESTAMP(3),
    "reminderCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CheckInRecipient_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CheckInOpportunity" (
    "id" TEXT NOT NULL,
    "recipientId" TEXT NOT NULL,
    "opportunityId" TEXT NOT NULL,
    "customerName" TEXT NOT NULL,
    "opportunityName" TEXT NOT NULL,
    "projectName" TEXT,
    "amount" DOUBLE PRECISION NOT NULL,
    "salesforceUrl" TEXT NOT NULL,
    "accountName" TEXT NOT NULL,
    "internalRepName" TEXT NOT NULL,
    "previousStatus" TEXT NOT NULL,
    "updatedStatus" TEXT,
    "repComment" TEXT,
    "submittedAt" TIMESTAMP(3),
    "previousCloseDate" TIMESTAMP(3),
    "updatedCloseDate" TIMESTAMP(3),
    "syncStatus" TEXT NOT NULL DEFAULT 'PENDING',
    "syncedAt" TIMESTAMP(3),
    "syncError" TEXT,
    "syncAttempts" INTEGER NOT NULL DEFAULT 0,
    "position" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CheckInOpportunity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditEvent" (
    "id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "actor" TEXT NOT NULL,
    "actorKind" TEXT NOT NULL DEFAULT 'SYSTEM',
    "fromStatus" TEXT,
    "toStatus" TEXT,
    "detail" TEXT,
    "campaignId" TEXT,
    "accountId" TEXT,
    "contactId" TEXT,
    "repId" TEXT,
    "opportunityId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EmailMessage" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "toEmail" TEXT NOT NULL,
    "toName" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "html" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "linkUrl" TEXT,
    "campaignId" TEXT,
    "contactId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'SENT',
    "error" TEXT,
    "deliveredAt" TIMESTAMP(3),
    "openedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EmailMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CampaignSelection" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "opportunityId" TEXT NOT NULL,
    "selectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "selectedBy" TEXT,
    "amountAtSelection" DOUBLE PRECISION,
    "stageAtSelection" TEXT,
    "closeDateAtSelection" TIMESTAMP(3),

    CONSTRAINT "CampaignSelection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OpportunitySnapshot" (
    "id" TEXT NOT NULL,
    "opportunityId" TEXT,
    "externalId" TEXT NOT NULL,
    "observedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "source" TEXT NOT NULL,
    "amount" DOUBLE PRECISION NOT NULL,
    "stage" TEXT NOT NULL,
    "closeDate" TIMESTAMP(3),
    "isOpen" BOOLEAN NOT NULL,
    "isWon" BOOLEAN,
    "accountId" TEXT,
    "accountName" TEXT NOT NULL,
    "internalRepId" TEXT,
    "internalRepName" TEXT NOT NULL,

    CONSTRAINT "OpportunitySnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OpportunitySignal" (
    "id" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'smartsheet',
    "sheetName" TEXT NOT NULL,
    "signalType" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "assignedToName" TEXT,
    "dueDate" TIMESTAMP(3),
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "sourceUrl" TEXT,
    "rawAccountName" TEXT,
    "rawProjectName" TEXT,
    "rawOpportunityExternalId" TEXT,
    "matchStatus" TEXT NOT NULL DEFAULT 'UNMATCHED',
    "matchReason" TEXT,
    "opportunityId" TEXT,
    "accountId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'NEW',
    "reviewedAt" TIMESTAMP(3),
    "reviewedBy" TEXT,
    "draftResponse" TEXT,
    "draftedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OpportunitySignal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MockSalesforceUser" (
    "externalId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "MockSalesforceUser_pkey" PRIMARY KEY ("externalId")
);

-- CreateTable
CREATE TABLE "MockSalesforceAccount" (
    "externalId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "MockSalesforceAccount_pkey" PRIMARY KEY ("externalId")
);

-- CreateTable
CREATE TABLE "MockSalesforceContact" (
    "externalId" TEXT NOT NULL,
    "accountExternalId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "isPrimary" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "MockSalesforceContact_pkey" PRIMARY KEY ("externalId")
);

-- CreateTable
CREATE TABLE "MockSalesforceOpportunity" (
    "externalId" TEXT NOT NULL,
    "ownerExternalId" TEXT NOT NULL,
    "accountExternalId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "siteName" TEXT NOT NULL,
    "amount" DOUBLE PRECISION NOT NULL,
    "stageName" TEXT NOT NULL,
    "closeDate" TIMESTAMP(3),
    "isClosed" BOOLEAN NOT NULL DEFAULT false,
    "contactExternalId" TEXT,
    "description" TEXT,
    "lastModifiedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "syncBlocked" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "MockSalesforceOpportunity_pkey" PRIMARY KEY ("externalId")
);

-- CreateIndex
CREATE UNIQUE INDEX "Account_externalId_key" ON "Account"("externalId");

-- CreateIndex
CREATE UNIQUE INDEX "ExternalContact_externalId_key" ON "ExternalContact"("externalId");

-- CreateIndex
CREATE INDEX "ExternalContact_accountId_idx" ON "ExternalContact"("accountId");

-- CreateIndex
CREATE UNIQUE INDEX "SalesRep_externalId_key" ON "SalesRep"("externalId");

-- CreateIndex
CREATE UNIQUE INDEX "Opportunity_externalId_key" ON "Opportunity"("externalId");

-- CreateIndex
CREATE INDEX "Opportunity_accountId_idx" ON "Opportunity"("accountId");

-- CreateIndex
CREATE INDEX "Opportunity_contactId_idx" ON "Opportunity"("contactId");

-- CreateIndex
CREATE INDEX "Opportunity_internalRepId_idx" ON "Opportunity"("internalRepId");

-- CreateIndex
CREATE INDEX "Opportunity_isOpen_idx" ON "Opportunity"("isOpen");

-- CreateIndex
CREATE UNIQUE INDEX "CheckInRecipient_tokenHash_key" ON "CheckInRecipient"("tokenHash");

-- CreateIndex
CREATE INDEX "CheckInRecipient_contactId_idx" ON "CheckInRecipient"("contactId");

-- CreateIndex
CREATE UNIQUE INDEX "CheckInRecipient_campaignId_contactId_key" ON "CheckInRecipient"("campaignId", "contactId");

-- CreateIndex
CREATE INDEX "CheckInOpportunity_syncStatus_idx" ON "CheckInOpportunity"("syncStatus");

-- CreateIndex
CREATE UNIQUE INDEX "CheckInOpportunity_recipientId_opportunityId_key" ON "CheckInOpportunity"("recipientId", "opportunityId");

-- CreateIndex
CREATE INDEX "AuditEvent_campaignId_idx" ON "AuditEvent"("campaignId");

-- CreateIndex
CREATE INDEX "AuditEvent_createdAt_idx" ON "AuditEvent"("createdAt");

-- CreateIndex
CREATE INDEX "EmailMessage_createdAt_idx" ON "EmailMessage"("createdAt");

-- CreateIndex
CREATE INDEX "CampaignSelection_campaignId_idx" ON "CampaignSelection"("campaignId");

-- CreateIndex
CREATE UNIQUE INDEX "CampaignSelection_campaignId_opportunityId_key" ON "CampaignSelection"("campaignId", "opportunityId");

-- CreateIndex
CREATE INDEX "OpportunitySnapshot_opportunityId_observedAt_idx" ON "OpportunitySnapshot"("opportunityId", "observedAt");

-- CreateIndex
CREATE INDEX "OpportunitySnapshot_observedAt_idx" ON "OpportunitySnapshot"("observedAt");

-- CreateIndex
CREATE INDEX "OpportunitySnapshot_externalId_idx" ON "OpportunitySnapshot"("externalId");

-- CreateIndex
CREATE INDEX "OpportunitySnapshot_source_idx" ON "OpportunitySnapshot"("source");

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

-- CreateIndex
CREATE INDEX "MockSalesforceContact_accountExternalId_idx" ON "MockSalesforceContact"("accountExternalId");

-- CreateIndex
CREATE INDEX "MockSalesforceOpportunity_ownerExternalId_idx" ON "MockSalesforceOpportunity"("ownerExternalId");

-- CreateIndex
CREATE INDEX "MockSalesforceOpportunity_accountExternalId_idx" ON "MockSalesforceOpportunity"("accountExternalId");

-- AddForeignKey
ALTER TABLE "ExternalContact" ADD CONSTRAINT "ExternalContact_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Opportunity" ADD CONSTRAINT "Opportunity_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Opportunity" ADD CONSTRAINT "Opportunity_internalRepId_fkey" FOREIGN KEY ("internalRepId") REFERENCES "SalesRep"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Opportunity" ADD CONSTRAINT "Opportunity_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "ExternalContact"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CheckInRecipient" ADD CONSTRAINT "CheckInRecipient_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CheckInRecipient" ADD CONSTRAINT "CheckInRecipient_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "ExternalContact"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CheckInOpportunity" ADD CONSTRAINT "CheckInOpportunity_recipientId_fkey" FOREIGN KEY ("recipientId") REFERENCES "CheckInRecipient"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CheckInOpportunity" ADD CONSTRAINT "CheckInOpportunity_opportunityId_fkey" FOREIGN KEY ("opportunityId") REFERENCES "Opportunity"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditEvent" ADD CONSTRAINT "AuditEvent_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditEvent" ADD CONSTRAINT "AuditEvent_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditEvent" ADD CONSTRAINT "AuditEvent_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "ExternalContact"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditEvent" ADD CONSTRAINT "AuditEvent_repId_fkey" FOREIGN KEY ("repId") REFERENCES "SalesRep"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditEvent" ADD CONSTRAINT "AuditEvent_opportunityId_fkey" FOREIGN KEY ("opportunityId") REFERENCES "Opportunity"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CampaignSelection" ADD CONSTRAINT "CampaignSelection_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CampaignSelection" ADD CONSTRAINT "CampaignSelection_opportunityId_fkey" FOREIGN KEY ("opportunityId") REFERENCES "Opportunity"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OpportunitySnapshot" ADD CONSTRAINT "OpportunitySnapshot_opportunityId_fkey" FOREIGN KEY ("opportunityId") REFERENCES "Opportunity"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OpportunitySignal" ADD CONSTRAINT "OpportunitySignal_opportunityId_fkey" FOREIGN KEY ("opportunityId") REFERENCES "Opportunity"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OpportunitySignal" ADD CONSTRAINT "OpportunitySignal_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE SET NULL ON UPDATE CASCADE;
