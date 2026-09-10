import { signOut } from "@/server/auth/config";

export function SignOutButton() {
  return (
    <form
      action={async () => {
        "use server";
        await signOut({ redirectTo: "/signin" });
      }}
    >
      <button
        type="submit"
        className="rounded-lg px-2 py-1 text-[13px] font-medium text-muted transition-colors hover:text-ink"
      >
        Sign out
      </button>
    </form>
  );
}
