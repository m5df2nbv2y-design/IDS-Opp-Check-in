-- CreateTable
CREATE TABLE "Account" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "externalId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" TEXT NOT NULL DEFAULT 'OTHER',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "ExternalContact" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "externalId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "isPrimary" BOOLEAN NOT NULL DEFAULT false,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "ExternalContact_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "SalesRep" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "externalId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "Opportunity" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "externalId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "customerName" TEXT NOT NULL,
    "opportunityName" TEXT NOT NULL,
    "projectName" TEXT,
    "amount" REAL NOT NULL,
    "currentStage" TEXT NOT NULL,
    "internalRepId" TEXT NOT NULL,
    "contactId" TEXT,
    "resolutionStatus" TEXT NOT NULL DEFAULT 'UNRESOLVED',
    "resolutionReason" TEXT,
    "salesforceUrl" TEXT NOT NULL,
    "closeDate" DATETIME,
    "isOpen" BOOLEAN NOT NULL DEFAULT true,
    "lastSyncedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Opportunity_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Opportunity_internalRepId_fkey" FOREIGN KEY ("internalRepId") REFERENCES "SalesRep" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Opportunity_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "ExternalContact" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Campaign" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "period" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" DATETIME,
    "completedAt" DATETIME
);

-- CreateTable
CREATE TABLE "CheckInRecipient" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "campaignId" TEXT NOT NULL,
    "contactId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "tokenHint" TEXT NOT NULL,
    "expiresAt" DATETIME NOT NULL,
    "sentAt" DATETIME,
    "deliveredAt" DATETIME,
    "openedAt" DATETIME,
    "startedAt" DATETIME,
    "completedAt" DATETIME,
    "revokedAt" DATETIME,
    "sendStatus" TEXT NOT NULL DEFAULT 'PENDING',
    "sendError" TEXT,
    "remindedAt" DATETIME,
    "reminderCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CheckInRecipient_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "CheckInRecipient_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "ExternalContact" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "CheckInOpportunity" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "recipientId" TEXT NOT NULL,
    "opportunityId" TEXT NOT NULL,
    "customerName" TEXT NOT NULL,
    "opportunityName" TEXT NOT NULL,
    "projectName" TEXT,
    "amount" REAL NOT NULL,
    "salesforceUrl" TEXT NOT NULL,
    "accountName" TEXT NOT NULL,
    "internalRepName" TEXT NOT NULL,
    "previousStatus" TEXT NOT NULL,
    "updatedStatus" TEXT,
    "repComment" TEXT,
    "submittedAt" DATETIME,
    "syncStatus" TEXT NOT NULL DEFAULT 'PENDING',
    "syncedAt" DATETIME,
    "syncError" TEXT,
    "syncAttempts" INTEGER NOT NULL DEFAULT 0,
    "position" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "CheckInOpportunity_recipientId_fkey" FOREIGN KEY ("recipientId") REFERENCES "CheckInRecipient" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "CheckInOpportunity_opportunityId_fkey" FOREIGN KEY ("opportunityId") REFERENCES "Opportunity" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "AuditEvent" (
    "id" TEXT NOT NULL PRIMARY KEY,
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
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AuditEvent_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "AuditEvent_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "AuditEvent_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "ExternalContact" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "AuditEvent_repId_fkey" FOREIGN KEY ("repId") REFERENCES "SalesRep" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "AuditEvent_opportunityId_fkey" FOREIGN KEY ("opportunityId") REFERENCES "Opportunity" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "EmailMessage" (
    "id" TEXT NOT NULL PRIMARY KEY,
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
    "deliveredAt" DATETIME,
    "openedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "MockSalesforceUser" (
    "externalId" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true
);

-- CreateTable
CREATE TABLE "MockSalesforceAccount" (
    "externalId" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true
);

-- CreateTable
CREATE TABLE "MockSalesforceContact" (
    "externalId" TEXT NOT NULL PRIMARY KEY,
    "accountExternalId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "isPrimary" BOOLEAN NOT NULL DEFAULT false
);

-- CreateTable
CREATE TABLE "MockSalesforceOpportunity" (
    "externalId" TEXT NOT NULL PRIMARY KEY,
    "ownerExternalId" TEXT NOT NULL,
    "accountExternalId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "siteName" TEXT NOT NULL,
    "amount" REAL NOT NULL,
    "stageName" TEXT NOT NULL,
    "closeDate" DATETIME,
    "isClosed" BOOLEAN NOT NULL DEFAULT false,
    "contactExternalId" TEXT,
    "description" TEXT,
    "lastModifiedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "syncBlocked" BOOLEAN NOT NULL DEFAULT false
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
CREATE INDEX "MockSalesforceContact_accountExternalId_idx" ON "MockSalesforceContact"("accountExternalId");

-- CreateIndex
CREATE INDEX "MockSalesforceOpportunity_ownerExternalId_idx" ON "MockSalesforceOpportunity"("ownerExternalId");

-- CreateIndex
CREATE INDEX "MockSalesforceOpportunity_accountExternalId_idx" ON "MockSalesforceOpportunity"("accountExternalId");
