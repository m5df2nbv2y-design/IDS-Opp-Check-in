/**
 * Sample org used by the mock Salesforce provider.
 *
 * This is the ONLY file in the application containing fake Salesforce records.
 * It is loaded into the mock org tables by `npm run db:seed` and read back
 * through the same `SalesforceService` interface the real provider implements.
 *
 * The data deliberately covers every recipient-resolution case the real org
 * will throw at us — see RECIPIENT-RESOLUTION.md:
 *   - distributor with one primary contact                    (ABC Distribution)
 *   - agency whose opportunities span three internal IDS reps (XYZ Agency)
 *   - agency where each opportunity names its own contact     (Northstar Agency)
 *   - account whose only contact is not flagged primary       (Cornerstone)
 *   - account whose primary contact is inactive               (Trailhead)
 *   - duplicate contact records sharing one email             (Gulf Coast)
 *   - opportunity naming an inactive contact                  (Harborview)
 *   - account with no contacts at all → admin attention       (Ridgeline)
 */

export type MockUserSeed = {
  externalId: string;
  name: string;
  email: string;
  isActive: boolean;
};

export type MockAccountSeed = {
  externalId: string;
  name: string;
  /** Salesforce Account.Type picklist value. */
  type: string;
  isActive: boolean;
};

export type MockContactSeed = {
  externalId: string;
  accountExternalId: string;
  name: string;
  email: string;
  isActive: boolean;
  isPrimary: boolean;
};

export type MockOpportunitySeed = {
  externalId: string;
  ownerExternalId: string;
  accountExternalId: string;
  /** Opportunity.Name */
  name: string;
  /** End customer / project site. */
  siteName: string;
  amount: number;
  stageName: string;
  closeDate: string;
  /** Opportunity Contact Role, when the org names one. */
  contactExternalId?: string;
  syncBlocked?: boolean;
};

// ---- Internal IDS sales reps (Salesforce Users) ----------------------------

export const MOCK_USERS: MockUserSeed[] = [
  { externalId: "005Ab00000JmT01AAK", name: "John Smith", email: "john.smith@ids-demo.com", isActive: true },
  { externalId: "005Ab00000JmT02AAK", name: "Sarah Jones", email: "sarah.jones@ids-demo.com", isActive: true },
  { externalId: "005Ab00000JmT03AAK", name: "Mike Brown", email: "mike.brown@ids-demo.com", isActive: true },
  { externalId: "005Ab00000JmT04AAK", name: "Lisa Davis", email: "lisa.davis@ids-demo.com", isActive: true },
  { externalId: "005Ab00000JmT05AAK", name: "David Chen", email: "david.chen@ids-demo.com", isActive: true },
  { externalId: "005Ab00000JmT09AAK", name: "Karen Whitfield", email: "karen.whitfield@ids-demo.com", isActive: false },
];

const JOHN = MOCK_USERS[0].externalId;
const SARAH = MOCK_USERS[1].externalId;
const MIKE = MOCK_USERS[2].externalId;
const LISA = MOCK_USERS[3].externalId;
const DAVID = MOCK_USERS[4].externalId;
const KAREN = MOCK_USERS[5].externalId;

// ---- External organizations (Salesforce Accounts) --------------------------

export const MOCK_ACCOUNTS: MockAccountSeed[] = [
  { externalId: "001Ab00000Acc01AAA", name: "ABC Distribution", type: "Distributor", isActive: true },
  { externalId: "001Ab00000Acc02AAA", name: "XYZ Agency", type: "Agency", isActive: true },
  { externalId: "001Ab00000Acc03AAA", name: "Northstar Agency", type: "Agency", isActive: true },
  { externalId: "001Ab00000Acc04AAA", name: "Cascade Medical Supply", type: "Distributor", isActive: true },
  { externalId: "001Ab00000Acc05AAA", name: "Memorial Health Network", type: "Direct Client", isActive: true },
  { externalId: "001Ab00000Acc06AAA", name: "Cornerstone Health Partners", type: "Direct Client", isActive: true },
  { externalId: "001Ab00000Acc07AAA", name: "Beacon Surgical Group", type: "Direct Client", isActive: true },
  { externalId: "001Ab00000Acc08AAA", name: "Trailhead Imaging Partners", type: "Agency", isActive: true },
  { externalId: "001Ab00000Acc09AAA", name: "Gulf Coast Medical Distributors", type: "Distributor", isActive: true },
  { externalId: "001Ab00000Acc10AAA", name: "Ridgeline Health Advisors", type: "Agency", isActive: true },
  { externalId: "001Ab00000Acc11AAA", name: "Summit Care Alliance", type: "Direct Client", isActive: true },
  { externalId: "001Ab00000Acc12AAA", name: "Harborview Health System", type: "Direct Client", isActive: true },
];

const ABC = MOCK_ACCOUNTS[0].externalId;
const XYZ = MOCK_ACCOUNTS[1].externalId;
const NORTHSTAR = MOCK_ACCOUNTS[2].externalId;
const CASCADE = MOCK_ACCOUNTS[3].externalId;
const MEMORIAL = MOCK_ACCOUNTS[4].externalId;
const CORNERSTONE = MOCK_ACCOUNTS[5].externalId;
const BEACON = MOCK_ACCOUNTS[6].externalId;
const TRAILHEAD = MOCK_ACCOUNTS[7].externalId;
const GULF = MOCK_ACCOUNTS[8].externalId;
const RIDGELINE = MOCK_ACCOUNTS[9].externalId;
const SUMMIT = MOCK_ACCOUNTS[10].externalId;
const HARBORVIEW = MOCK_ACCOUNTS[11].externalId;

// ---- External contacts (Salesforce Contacts) -------------------------------

export const MOCK_CONTACTS: MockContactSeed[] = [
  // ABC Distribution — one primary plus an inactive-in-practice backup who owns
  // nothing. Proves we email the primary, not everyone at the account.
  { externalId: "003Ab00000Con01AAA", accountExternalId: ABC, name: "Jane Doe", email: "jane.doe@abcdistribution-demo.com", isActive: true, isPrimary: true },
  { externalId: "003Ab00000Con02AAA", accountExternalId: ABC, name: "Victor Lang", email: "victor.lang@abcdistribution-demo.com", isActive: true, isPrimary: false },

  // XYZ Agency — one primary who covers opportunities from three IDS reps.
  { externalId: "003Ab00000Con03AAA", accountExternalId: XYZ, name: "Marcus Webb", email: "marcus.webb@xyzagency-demo.com", isActive: true, isPrimary: true },
  { externalId: "003Ab00000Con04AAA", accountExternalId: XYZ, name: "Priya Raman", email: "priya.raman@xyzagency-demo.com", isActive: true, isPrimary: false },

  // Northstar Agency — opportunities name their own contact, so both receive one.
  { externalId: "003Ab00000Con05AAA", accountExternalId: NORTHSTAR, name: "Elena Ruiz", email: "elena.ruiz@northstaragency-demo.com", isActive: true, isPrimary: true },
  { externalId: "003Ab00000Con06AAA", accountExternalId: NORTHSTAR, name: "Tom Becker", email: "tom.becker@northstaragency-demo.com", isActive: true, isPrimary: false },

  { externalId: "003Ab00000Con07AAA", accountExternalId: CASCADE, name: "Ray Ortiz", email: "ray.ortiz@cascademedical-demo.com", isActive: true, isPrimary: true },
  { externalId: "003Ab00000Con08AAA", accountExternalId: MEMORIAL, name: "Dana Whitfield", email: "dana.whitfield@memorialhealth-demo.com", isActive: true, isPrimary: true },

  // Cornerstone — a single active contact, nobody flagged primary.
  { externalId: "003Ab00000Con09AAA", accountExternalId: CORNERSTONE, name: "Alan Pierce", email: "alan.pierce@cornerstonehealth-demo.com", isActive: true, isPrimary: false },

  { externalId: "003Ab00000Con10AAA", accountExternalId: BEACON, name: "Nina Patel", email: "nina.patel@beaconsurgical-demo.com", isActive: true, isPrimary: true },

  // Trailhead — the designated primary has left; fall through to the active one.
  { externalId: "003Ab00000Con11AAA", accountExternalId: TRAILHEAD, name: "Chris Vega", email: "chris.vega@trailheadimaging-demo.com", isActive: false, isPrimary: true },
  { externalId: "003Ab00000Con12AAA", accountExternalId: TRAILHEAD, name: "Morgan Lee", email: "morgan.lee@trailheadimaging-demo.com", isActive: true, isPrimary: false },

  // Gulf Coast — two records, one human. Must not receive two emails.
  { externalId: "003Ab00000Con13AAA", accountExternalId: GULF, name: "Sam Whitaker", email: "sam.whitaker@gulfcoastmed-demo.com", isActive: true, isPrimary: true },
  { externalId: "003Ab00000Con14AAA", accountExternalId: GULF, name: "Samuel Whitaker", email: "Sam.Whitaker@gulfcoastmed-demo.com", isActive: true, isPrimary: false },

  // Ridgeline Health Advisors has no contacts at all — see the opportunity below.

  { externalId: "003Ab00000Con15AAA", accountExternalId: SUMMIT, name: "Olivia Brandt", email: "olivia.brandt@summitcare-demo.com", isActive: true, isPrimary: true },
  { externalId: "003Ab00000Con16AAA", accountExternalId: SUMMIT, name: "Derek Shaw", email: "derek.shaw@summitcare-demo.com", isActive: false, isPrimary: false },

  // Harborview — one opportunity names Greta, who has left.
  { externalId: "003Ab00000Con17AAA", accountExternalId: HARBORVIEW, name: "Felix Moreau", email: "felix.moreau@harborviewhealth-demo.com", isActive: true, isPrimary: true },
  { externalId: "003Ab00000Con18AAA", accountExternalId: HARBORVIEW, name: "Greta Sims", email: "greta.sims@harborviewhealth-demo.com", isActive: false, isPrimary: false },
];

const JANE = MOCK_CONTACTS[0].externalId;
const ELENA = MOCK_CONTACTS[4].externalId;
const TOM = MOCK_CONTACTS[5].externalId;
const GRETA = MOCK_CONTACTS[17].externalId;

// ---- Opportunities ---------------------------------------------------------

export const MOCK_OPPORTUNITIES: MockOpportunitySeed[] = [
  // ---- ABC Distribution → Jane Doe (6, spanning three IDS reps) ------------
  { externalId: "006Ab00000Opp01AAA", ownerExternalId: JOHN, accountExternalId: ABC, name: "MRI Suite Renovation", siteName: "Memorial Hospital", amount: 450000, stageName: "Proposal", closeDate: "2026-12-18" },
  { externalId: "006Ab00000Opp02AAA", ownerExternalId: JOHN, accountExternalId: ABC, name: "CT Scanner Replacement", siteName: "Lakeview Regional Hospital", amount: 385000, stageName: "Qualification", closeDate: "2027-01-22" },
  { externalId: "006Ab00000Opp03AAA", ownerExternalId: JOHN, accountExternalId: ABC, name: "Nuclear Medicine Shielding Retrofit", siteName: "Memorial Hospital", amount: 96000, stageName: "Qualification", closeDate: "2027-04-09" },
  { externalId: "006Ab00000Opp04AAA", ownerExternalId: SARAH, accountExternalId: ABC, name: "Interventional Radiology Buildout", siteName: "Riverside Health System", amount: 1275000, stageName: "Specified", closeDate: "2027-03-05" },
  { externalId: "006Ab00000Opp05AAA", ownerExternalId: SARAH, accountExternalId: ABC, name: "Surgical Imaging Upgrade", siteName: "St. Anne's Hospital", amount: 218500, stageName: "Negotiation", closeDate: "2026-11-30", contactExternalId: JANE },
  { externalId: "006Ab00000Opp06AAA", ownerExternalId: MIKE, accountExternalId: ABC, name: "Mobile MRI Pad & Utilities", siteName: "Cedar County Health", amount: 152000, stageName: "Proposal", closeDate: "2026-12-04" },

  // ---- XYZ Agency → Marcus Webb (9, spanning three IDS reps) ---------------
  { externalId: "006Ab00000Opp07AAA", ownerExternalId: JOHN, accountExternalId: XYZ, name: "Cardiac Cath Lab Modernization", siteName: "Northgate Heart Institute", amount: 2150000, stageName: "Negotiation", closeDate: "2026-11-20" },
  { externalId: "006Ab00000Opp08AAA", ownerExternalId: JOHN, accountExternalId: XYZ, name: "Hybrid OR — Design Assist", siteName: "Northgate Heart Institute", amount: 3400000, stageName: "Qualification", closeDate: "2027-09-15" },
  { externalId: "006Ab00000Opp09AAA", ownerExternalId: JOHN, accountExternalId: XYZ, name: "PACS Infrastructure Refresh", siteName: "Northgate Heart Institute", amount: 134000, stageName: "Qualification", closeDate: "2027-05-01" },
  { externalId: "006Ab00000Opp10AAA", ownerExternalId: JOHN, accountExternalId: XYZ, name: "Women's Imaging Expansion", siteName: "Grace Community Hospital", amount: 520000, stageName: "Proposal", closeDate: "2027-02-27" },
  { externalId: "006Ab00000Opp11AAA", ownerExternalId: SARAH, accountExternalId: XYZ, name: "Emergency Department X-Ray Suite", siteName: "Grace Community Hospital", amount: 295000, stageName: "Proposal", closeDate: "2026-12-11" },
  { externalId: "006Ab00000Opp12AAA", ownerExternalId: SARAH, accountExternalId: XYZ, name: "Linear Accelerator Vault", siteName: "Harbor Oncology Center", amount: 1680000, stageName: "Specified", closeDate: "2027-06-30" },
  { externalId: "006Ab00000Opp13AAA", ownerExternalId: SARAH, accountExternalId: XYZ, name: "Sterile Processing Renovation", siteName: "Harbor Oncology Center", amount: 730000, stageName: "Proposal", closeDate: "2027-04-24" },
  { externalId: "006Ab00000Opp14AAA", ownerExternalId: MIKE, accountExternalId: XYZ, name: "Ambulatory Surgery Center Fit-Out", siteName: "Meridian Surgical Group", amount: 875000, stageName: "Specified", closeDate: "2027-01-15" },
  { externalId: "006Ab00000Opp15AAA", ownerExternalId: MIKE, accountExternalId: XYZ, name: "Ultrasound Fleet Standardization", siteName: "Meridian Surgical Group", amount: 410000, stageName: "Qualification", closeDate: "2027-03-19" },

  // ---- Northstar Agency → per-opportunity contacts (3 Elena, 2 Tom) --------
  { externalId: "006Ab00000Opp16AAA", ownerExternalId: LISA, accountExternalId: NORTHSTAR, name: "Children's Imaging Wing", siteName: "Bayfront Children's Hospital", amount: 4250000, stageName: "Specified", closeDate: "2027-08-14", contactExternalId: ELENA },
  { externalId: "006Ab00000Opp17AAA", ownerExternalId: LISA, accountExternalId: NORTHSTAR, name: "PET/CT Suite Addition", siteName: "Bayfront Children's Hospital", amount: 1890000, stageName: "Negotiation", closeDate: "2026-12-19", contactExternalId: ELENA },
  { externalId: "006Ab00000Opp18AAA", ownerExternalId: DAVID, accountExternalId: NORTHSTAR, name: "Radiology Reading Room Redesign", siteName: "University Medical Partners", amount: 265000, stageName: "Proposal", closeDate: "2027-03-27", contactExternalId: ELENA },
  { externalId: "006Ab00000Opp19AAA", ownerExternalId: DAVID, accountExternalId: NORTHSTAR, name: "Campus-Wide Equipment Planning", siteName: "University Medical Partners", amount: 980000, stageName: "Qualification", closeDate: "2027-07-10", contactExternalId: TOM },
  { externalId: "006Ab00000Opp20AAA", ownerExternalId: LISA, accountExternalId: NORTHSTAR, name: "Simulation Center Equipment", siteName: "Westbrook University", amount: 375000, stageName: "Proposal", closeDate: "2027-05-14", contactExternalId: TOM },

  // ---- Cascade Medical Supply → Ray Ortiz (3) ------------------------------
  { externalId: "006Ab00000Opp21AAA", ownerExternalId: MIKE, accountExternalId: CASCADE, name: "Rural Clinic Imaging Package", siteName: "Prairie Valley Clinics", amount: 168000, stageName: "Proposal", closeDate: "2026-12-29" },
  { externalId: "006Ab00000Opp22AAA", ownerExternalId: MIKE, accountExternalId: CASCADE, name: "Urgent Care Network Rollout", siteName: "QuickCare Holdings", amount: 486000, stageName: "Specified", closeDate: "2027-05-22" },
  { externalId: "006Ab00000Opp23AAA", ownerExternalId: DAVID, accountExternalId: CASCADE, name: "Mobile Imaging Fleet Expansion", siteName: "Trailhead Mobile Diagnostics", amount: 655000, stageName: "Negotiation", closeDate: "2026-11-06" },

  // ---- Memorial Health Network → Dana Whitfield (2) ------------------------
  { externalId: "006Ab00000Opp24AAA", ownerExternalId: LISA, accountExternalId: MEMORIAL, name: "Trauma Center X-Ray Replacement", siteName: "Metro General Hospital", amount: 340000, stageName: "Proposal", closeDate: "2026-11-27" },
  { externalId: "006Ab00000Opp25AAA", ownerExternalId: LISA, accountExternalId: MEMORIAL, name: "Mammography Suite Refresh", siteName: "Metro General Hospital", amount: 415000, stageName: "Specified", closeDate: "2027-02-20", syncBlocked: true },

  // ---- Cornerstone → Alan Pierce, the only active contact (2) --------------
  { externalId: "006Ab00000Opp26AAA", ownerExternalId: DAVID, accountExternalId: CORNERSTONE, name: "Research Imaging Core Lab", siteName: "Halcyon Life Sciences", amount: 1450000, stageName: "Qualification", closeDate: "2027-09-01" },
  { externalId: "006Ab00000Opp27AAA", ownerExternalId: DAVID, accountExternalId: CORNERSTONE, name: "Specimen Radiography Install", siteName: "Halcyon Life Sciences", amount: 92000, stageName: "Proposal", closeDate: "2026-12-22" },

  // ---- Beacon Surgical Group → Nina Patel (1) ------------------------------
  { externalId: "006Ab00000Opp28AAA", ownerExternalId: MIKE, accountExternalId: BEACON, name: "Orthopedic Clinic Fluoroscopy", siteName: "Summit Orthopedic Partners", amount: 212000, stageName: "Proposal", closeDate: "2027-01-08" },

  // ---- Trailhead → primary is inactive, falls through to Morgan Lee (2) ----
  { externalId: "006Ab00000Opp29AAA", ownerExternalId: SARAH, accountExternalId: TRAILHEAD, name: "Outpatient Imaging Center — Phase 2", siteName: "Summit Orthopedic Partners", amount: 640000, stageName: "Proposal", closeDate: "2027-02-12" },
  { externalId: "006Ab00000Opp30AAA", ownerExternalId: JOHN, accountExternalId: TRAILHEAD, name: "Veterinary Imaging Suite", siteName: "Front Range Animal Hospital", amount: 129000, stageName: "Qualification", closeDate: "2027-02-06" },

  // ---- Gulf Coast → duplicate contact records, one human (2) ---------------
  { externalId: "006Ab00000Opp31AAA", ownerExternalId: DAVID, accountExternalId: GULF, name: "VA Clinic Imaging Modernization", siteName: "Federal Health Contracting", amount: 2780000, stageName: "Specified", closeDate: "2027-10-15" },
  { externalId: "006Ab00000Opp32AAA", ownerExternalId: DAVID, accountExternalId: GULF, name: "Shielding Compliance Survey Program", siteName: "Federal Health Contracting", amount: 118000, stageName: "Qualification", closeDate: "2027-02-03" },

  // ---- Ridgeline → NO contacts on the account. Needs admin attention. ------
  { externalId: "006Ab00000Opp33AAA", ownerExternalId: SARAH, accountExternalId: RIDGELINE, name: "Cath Lab Relocation", siteName: "Metro General Hospital", amount: 1120000, stageName: "Negotiation", closeDate: "2027-06-05" },

  // ---- Summit Care Alliance → Olivia Brandt (1) ----------------------------
  { externalId: "006Ab00000Opp34AAA", ownerExternalId: LISA, accountExternalId: SUMMIT, name: "MRI 3T Upgrade", siteName: "Coastal Neuroscience Institute", amount: 2250000, stageName: "Proposal", closeDate: "2027-04-30" },

  // ---- Harborview → one opportunity names Greta, who has left (2) ----------
  { externalId: "006Ab00000Opp35AAA", ownerExternalId: JOHN, accountExternalId: HARBORVIEW, name: "Imaging Equipment Service Agreement", siteName: "Coastal Neuroscience Institute", amount: 88000, stageName: "Qualification", closeDate: "2027-01-30", contactExternalId: GRETA },
  { externalId: "006Ab00000Opp36AAA", ownerExternalId: MIKE, accountExternalId: HARBORVIEW, name: "Dental Practice CBCT Install", siteName: "Brightsmile Dental Partners", amount: 74500, stageName: "Negotiation", closeDate: "2026-11-14" },

  // ---- Owned by an inactive IDS rep: excluded from every campaign ----------
  { externalId: "006Ab00000Opp40AAA", ownerExternalId: KAREN, accountExternalId: MEMORIAL, name: "Legacy Account Imaging Refresh", siteName: "Old Mill Community Hospital", amount: 240000, stageName: "Proposal", closeDate: "2027-03-01" },
];
