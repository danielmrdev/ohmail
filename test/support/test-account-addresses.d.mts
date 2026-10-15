/** The test-account address reader; the rules are stated in `test-account-addresses.mjs`. */

export const ACCOUNTS: string;
export const TEST_ACCOUNT_LABEL: RegExp;

export function accountsCandidates(root: string): string[];
export function addressesIn(text: string): string[];
export function labelledIn(text: string): string[];
export function hitsIn(root: string, needles: string[], files?: string[] | null): string[];
