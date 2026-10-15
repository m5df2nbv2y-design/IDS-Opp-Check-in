/** Preview short-circuits before fetch; real check-ins retain server token guards. */
export async function postCheckInResponse(token: string, payload: unknown, preview = false): Promise<boolean> {
  if (preview) return true;
  try {
    const response = await fetch(`/api/checkin/${encodeURIComponent(token)}/responses`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
    return response.ok;
  } catch { return false; }
}

export async function completeCheckIn(token: string, preview = false): Promise<boolean> {
  if (preview) return true;
  try { return (await fetch(`/api/checkin/${encodeURIComponent(token)}/complete`, { method: "POST" })).ok; }
  catch { return false; }
}
