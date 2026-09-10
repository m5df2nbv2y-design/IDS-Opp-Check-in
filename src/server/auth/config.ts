import NextAuth from "next-auth";
import Credentials from "next-auth/providers/credentials";
import MicrosoftEntraID from "next-auth/providers/microsoft-entra-id";

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
    // Nothing beyond identity is needed today. When IDS restricts access to a
    // Sales Operations group, assert the group/role claim HERE — do not
    // allow-list individual email addresses.
    async session({ session, token }) {
      if (session.user && token.sub) session.user.id = token.sub;
      return session;
    },
  },
});

/** Whether any sign-in method is available at all. */
export function authAvailable(): boolean {
  return ENTRA_CONFIGURED || DEV_BYPASS_ENABLED;
}
