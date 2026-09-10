import NextAuth from "next-auth";
import Credentials from "next-auth/providers/credentials";
import MicrosoftEntraID from "next-auth/providers/microsoft-entra-id";
import { claimsFromProfile } from "./authorization";

/**
 * Authentication for the IDS admin console.
 *
 * Only /admin is protected. The external contact experience at
 * /checkin/[token] deliberately has no authentication at all — recipients
 * authenticate with the token in their email and must never see a login screen.
 *
 * ---------------------------------------------------------------------------
 * The development bypass
 * ---------------------------------------------------------------------------
 * Running the mock demo should not require an Entra tenant. A credentials
 * provider therefore signs in a local admin — but it is only REGISTERED when
 * both conditions hold:
 *
 *   NODE_ENV !== "production"   AND   AUTH_DEV_BYPASS === "true"
 *
 * In a production build the provider is not in the array at all, so the code
 * path does not exist rather than merely being discouraged. Fails closed: an
 * unset or misspelled variable yields no bypass.
 */

const IS_PRODUCTION = process.env.NODE_ENV === "production";

export const DEV_BYPASS_ENABLED = !IS_PRODUCTION && process.env.AUTH_DEV_BYPASS === "true";

export const ENTRA_CONFIGURED = Boolean(
  process.env.AUTH_MICROSOFT_ENTRA_ID_ID && process.env.AUTH_MICROSOFT_ENTRA_ID_SECRET,
);

/** The local admin identity used by the development bypass. */
const DEV_ADMIN = {
  id: "dev-admin",
  name: "Local Admin (development)",
  email: "local-admin@ids.invalid",
};

/** Marks the development identity so authorization can recognise it. */
export const DEV_ADMIN_ID = DEV_ADMIN.id;

function buildProviders() {
  const providers = [];

  if (ENTRA_CONFIGURED) {
    providers.push(
      MicrosoftEntraID({
        clientId: process.env.AUTH_MICROSOFT_ENTRA_ID_ID!,
        clientSecret: process.env.AUTH_MICROSOFT_ENTRA_ID_SECRET!,
        // Defaults to the multi-tenant "common" issuer when unset. Set this to
        // your Directory (tenant) ID to restrict sign-in to IDS.
        issuer: process.env.AUTH_MICROSOFT_ENTRA_ID_ISSUER,
      }),
    );
  }

  if (DEV_BYPASS_ENABLED) {
    providers.push(
      Credentials({
        id: "dev-bypass",
        name: "Local development admin",
        credentials: {},
        // No secret to check: this provider only exists outside production.
        authorize: async () => DEV_ADMIN,
      }),
    );
  }

  return providers;
}

export const { handlers, auth, signIn, signOut } = NextAuth({
  providers: buildProviders(),
  session: { strategy: "jwt" },
  pages: { signIn: "/signin" },
  callbacks: {
    /**
     * Capture the authorization claims onto the token at sign-in. Roles are
     * carried in the JWT so every subsequent request can be authorized without
     * a round trip to Entra — and so a mutation is authorized from the token,
     * not from anything the client sends.
     */
    async jwt({ token, profile, account }) {
      if (account?.provider === "dev-bypass") {
        token.isDevAdmin = true;
        return token;
      }

      if (profile) {
        const claims = claimsFromProfile(profile as Record<string, unknown>);
        token.roles = claims.roles;
        token.groups = claims.groups;
        token.groupsOverage = claims.groupsOverage;
        // Entra's stable per-tenant identifier. Recorded in the audit trail
        // alongside the email, which can change.
        if (typeof (profile as Record<string, unknown>).oid === "string") {
          token.oid = (profile as Record<string, unknown>).oid as string;
        }
      }

      return token;
    },

    async session({ session, token }) {
      if (session.user) {
        if (token.sub) session.user.id = token.sub;
        session.user.roles = (token.roles as string[]) ?? [];
        session.user.groups = (token.groups as string[]) ?? [];
        session.user.groupsOverage = Boolean(token.groupsOverage);
        session.user.isDevAdmin = Boolean(token.isDevAdmin);
        session.user.oid = typeof token.oid === "string" ? token.oid : null;
      }
      return session;
    },
  },
});

/** Whether any sign-in method is available at all. */
export function authAvailable(): boolean {
  return ENTRA_CONFIGURED || DEV_BYPASS_ENABLED;
}
