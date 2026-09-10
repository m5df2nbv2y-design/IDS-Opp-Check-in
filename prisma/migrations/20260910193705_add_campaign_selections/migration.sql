-- CreateTable
CREATE TABLE "CampaignSelection" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "campaignId" TEXT NOT NULL,
    "opportunityId" TEXT NOT NULL,
    "selectedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "selectedBy" TEXT,
    CONSTRAINT "CampaignSelection_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "CampaignSelection_opportunityId_fkey" FOREIGN KEY ("opportunityId") REFERENCES "Opportunity" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "CampaignSelection_campaignId_idx" ON "CampaignSelection"("campaignId");

-- CreateIndex
CREATE UNIQUE INDEX "CampaignSelection_campaignId_opportunityId_key" ON "CampaignSelection"("campaignId", "opportunityId");
