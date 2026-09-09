import { prisma } from "@/lib/db";
import { accountTypeFromSalesforce } from "@/lib/account-types";
import { stageFromSalesforce, stageToSalesforce, type OpportunityStage } from "@/lib/stages";
import {
  SalesforceSyncError,
  type OpportunityStatusUpdate,
  type SalesforceAccount,
  type SalesforceContact,
  type SalesforceOpportunity,
  type SalesforceProviderInfo,
  type SalesforceRep,
  type SalesforceService,
} from "../types";
import { MOCK_ACCOUNTS, MOCK_CONTACTS, MOCK_OPPORTUNITIES, MOCK_USERS } from "./mock-data";

const MOCK_INSTANCE_URL = "https://ids-demo.my.salesforce.com";

const CLOSED_STAGE_NAMES = new Set(["closed won", "closed lost"]);

/**
 * Mock Salesforce/SFX provider.
 *
 * Records live in persistent tables, writes actually mutate them, and the org
 * can reject a write the way a validation rule would. After a check-in syncs
 * you can open /admin/salesforce and see the new stage and note on the record.
 */
export class MockSalesforceService implements SalesforceService {
  readonly info: SalesforceProviderInfo = {
    id: "mock",
    label: "Mock Salesforce org",
    simulated: true,
    description:
      "Demo data served through the same interface as the real integration. No external credentials required.",
  };

  /** Load the sample org. Called by the seed script. */
  async resetOrg(): Promise<void> {
    await prisma.mockSalesforceOpportunity.deleteMany();
    await prisma.mockSalesforceContact.deleteMany();
    await prisma.mockSalesforceAccount.deleteMany();
    await prisma.mockSalesforceUser.deleteMany();

    await prisma.mockSalesforceUser.createMany({ data: MOCK_USERS });
    await prisma.mockSalesforceAccount.createMany({ data: MOCK_ACCOUNTS });
    await prisma.mockSalesforceContact.createMany({ data: MOCK_CONTACTS });
    await prisma.mockSalesforceOpportunity.createMany({
      data: MOCK_OPPORTUNITIES.map((opp) => ({
        externalId: opp.externalId,
        ownerExternalId: opp.ownerExternalId,
        accountExternalId: opp.accountExternalId,
        name: opp.name,
        siteName: opp.siteName,
        amount: opp.amount,
        stageName: opp.stageName,
        closeDate: new Date(`${opp.closeDate}T00:00:00.000Z`),
        isClosed: CLOSED_STAGE_NAMES.has(opp.stageName.toLowerCase()),
        contactExternalId: opp.contactExternalId ?? null,
        syncBlocked: opp.syncBlocked ?? false,
      })),
    });
  }

  async getSalesReps(): Promise<SalesforceRep[]> {
    const users = await prisma.mockSalesforceUser.findMany({ orderBy: { name: "asc" } });
    return users.map((user) => ({
      externalId: user.externalId,
      name: user.name,
      email: user.email,
      active: user.isActive,
    }));
  }

  async getAccounts(): Promise<SalesforceAccount[]> {
    const accounts = await prisma.mockSalesforceAccount.findMany({ orderBy: { name: "asc" } });
    return accounts.map((account) => ({
      externalId: account.externalId,
      name: account.name,
      type: accountTypeFromSalesforce(account.type),
      active: account.isActive,
    }));
  }

  async getExternalContacts(options?: {
    accountExternalIds?: string[];
  }): Promise<SalesforceContact[]> {
    const contacts = await prisma.mockSalesforceContact.findMany({
      where: options?.accountExternalIds
        ? { accountExternalId: { in: options.accountExternalIds } }
        : undefined,
      orderBy: { name: "asc" },
    });

    return contacts.map((contact) => ({
      externalId: contact.externalId,
      accountExternalId: contact.accountExternalId,
      name: contact.name,
      email: contact.email,
      isPrimary: contact.isPrimary,
      active: contact.isActive,
    }));
  }

  async getOpenOpportunities(options?: {
    ownerExternalIds?: string[];
  }): Promise<SalesforceOpportunity[]> {
    const records = await prisma.mockSalesforceOpportunity.findMany({
      where: {
        isClosed: false,
        ...(options?.ownerExternalIds ? { ownerExternalId: { in: options.ownerExternalIds } } : {}),
      },
      orderBy: [{ accountExternalId: "asc" }, { amount: "desc" }],
    });

    return records.flatMap((record) => {
      const mapped = this.toDomain(record);
      // A record whose stage is outside our controlled values is skipped rather
      // than guessed at — the real provider behaves the same way.
      if (!mapped) {
        console.warn(
          `[salesforce:mock] skipped ${record.externalId} — unmapped stage "${record.stageName}"`,
        );
        return [];
      }
      return [mapped];
    });
  }

  async getOpportunity(externalId: string): Promise<SalesforceOpportunity | null> {
    const record = await prisma.mockSalesforceOpportunity.findUnique({ where: { externalId } });
    return record ? this.toDomain(record) : null;
  }

  async updateOpportunityStatus(externalId: string, stage: OpportunityStage): Promise<void> {
    const record = await this.requireRecord(externalId);
    this.assertWritable(record);

    await prisma.mockSalesforceOpportunity.update({
      where: { externalId },
      data: { stageName: stageToSalesforce(stage), lastModifiedAt: new Date() },
    });
  }

  async updateOpportunityComment(
    externalId: string,
    comment: string,
    source?: string,
  ): Promise<void> {
    const record = await this.requireRecord(externalId);
    this.assertWritable(record);

    const stamp = source ? `[${source}] ` : "";
    const entry = `${stamp}${comment}`.trim();
    const description = record.description ? `${record.description}\n${entry}` : entry;

    await prisma.mockSalesforceOpportunity.update({
      where: { externalId },
      data: { description, lastModifiedAt: new Date() },
    });
  }

  async applyUpdate(update: OpportunityStatusUpdate): Promise<void> {
    await this.updateOpportunityStatus(update.externalId, update.stage);
    if (update.comment?.trim()) {
      await this.updateOpportunityComment(update.externalId, update.comment.trim(), update.source);
    }
  }

  private async requireRecord(externalId: string) {
    const record = await prisma.mockSalesforceOpportunity.findUnique({ where: { externalId } });
    if (!record) {
      throw new SalesforceSyncError(`Opportunity ${externalId} no longer exists in Salesforce.`, {
        code: "ENTITY_IS_DELETED",
        retryable: false,
      });
    }
    return record;
  }

  private assertWritable(record: { syncBlocked: boolean; isClosed: boolean }) {
    if (record.isClosed) {
      throw new SalesforceSyncError("Opportunity is closed and can no longer be edited.", {
        code: "INVALID_FIELD_FOR_INSERT_UPDATE",
        retryable: false,
      });
    }
    if (record.syncBlocked) {
      throw new SalesforceSyncError(
        "FIELD_CUSTOM_VALIDATION_EXCEPTION: Stage cannot be changed while a pricing approval is pending.",
        { code: "FIELD_CUSTOM_VALIDATION_EXCEPTION", retryable: true },
      );
    }
  }

  private toDomain(record: {
    externalId: string;
    ownerExternalId: string;
    accountExternalId: string;
    name: string;
    siteName: string;
    amount: number;
    stageName: string;
    closeDate: Date | null;
    contactExternalId: string | null;
  }): SalesforceOpportunity | null {
    const stage = stageFromSalesforce(record.stageName);
    if (!stage) return null;

    return {
      externalId: record.externalId,
      opportunityName: record.name,
      projectName: record.name,
      customerName: record.siteName,
      amount: record.amount,
      stage,
      closeDate: record.closeDate,
      url: `${MOCK_INSTANCE_URL}/lightning/r/Opportunity/${record.externalId}/view`,
      ownerExternalId: record.ownerExternalId,
      accountExternalId: record.accountExternalId,
      contactExternalId: record.contactExternalId,
    };
  }
}
