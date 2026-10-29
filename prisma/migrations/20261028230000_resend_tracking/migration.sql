ALTER TABLE "EmailMessage" ADD COLUMN "requestKey" TEXT, ADD COLUMN "providerMessageId" TEXT;
CREATE UNIQUE INDEX "EmailMessage_requestKey_key" ON "EmailMessage"("requestKey");
CREATE UNIQUE INDEX "EmailMessage_providerMessageId_key" ON "EmailMessage"("providerMessageId");
