import type { DefaultSession } from "next-auth";

/**
 * Authorization claims carried on the session. Populated in the jwt/session
 * callbacks from the Entra token — never from anything the client supplies.
 */
declare module "next-auth" {
  interface Session {
    user: {
      id: string;
      roles: string[];
      groups: string[];
      groupsOverage: boolean;
      isDevAdmin: boolean;
      /** Entra object id — stable per tenant, unlike email. */
      oid: string | null;
    } & DefaultSession["user"];
  }
}

declare module "next-auth/jwt" {
  interface JWT {
    roles?: string[];
    groups?: string[];
    groupsOverage?: boolean;
    isDevAdmin?: boolean;
    oid?: string;
  }
}
