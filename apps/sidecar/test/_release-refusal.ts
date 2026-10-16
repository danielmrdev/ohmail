import { ClaimReleaseError, META_RECORDS_MAX_PER_FETCH } from "@trafficflow/core/adapters/organizer-lease";

/**
 * THE REFUSAL A RELEASE MEETS ON A REAL SERVER — what `makeLeaseIo().findOwnRecords` throws.
 *
 * The product's one lease io never answers `null` there: a read that dies is `unreadable` with
 * the provider's fault in `cause`, and a folder past one read is `over_ceiling`. A double that
 * answered `null` took `releaseMailboxClaim`'s `search_refused` arm, which only a double reaches.
 * The core meta-window suite drives the real io into both codes; `lease-io-doubles.test.ts`
 * refuses a double whose `findOwnRecords` returns `null`.
 */
export function releaseRefusal(code: "unreadable" | "over_ceiling" = "unreadable"): ClaimReleaseError {
  if (code === "over_ceiling") {
    return new ClaimReleaseError(
      "over_ceiling",
      `ohmail/_meta holds more records where one read may take ${META_RECORDS_MAX_PER_FETCH}, so a `
      + "complete release cannot be told from a partial one and nothing was removed",
    );
  }
  const dropped = Object.assign(new Error("Connection not available"), { code: "NoConnection" });
  return new ClaimReleaseError(
    "unreadable",
    "the records in ohmail/_meta could not be read on this connection, so a complete release "
    + "cannot be told from a partial one and nothing was removed",
    { cause: dropped },
  );
}
