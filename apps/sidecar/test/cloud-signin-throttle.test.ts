import { describe, it, expect } from "vitest";
import { cloudSignIn, CloudSignInError } from "../src/cloud-signin.js";

/**
 * THE HOSTED SIGN-IN'S TWO THROTTLE REFUSALS, as this install tells them to the desktop's door:
 * each keeps its own code and a sentence that says to wait. Folded into "the hosted service
 * answered HTTP 429" a person read a fault; folded into "not accepted" they would retype.
 */
function answering(status: number, code: string): typeof fetch {
  return (async () => new Response(JSON.stringify({ error: { code, message: code } }), {
    status, headers: { "content-type": "application/json" },
  })) as unknown as typeof fetch;
}

async function refusal(status: number, code: string): Promise<CloudSignInError> {
  const err = await cloudSignIn(
    { baseUrl: "https://api.example.test", fetchImpl: answering(status, code) },
    { email: "someone@example.test", password: "pw", totp: "123456" },
  ).catch((e: unknown) => e);
  expect(err).toBeInstanceOf(CloudSignInError);
  return err as CloudSignInError;
}

describe("cloudSignIn — the throttle's refusals", () => {
  it("the address ceiling is 429 sign_in_slowed, told as a wait", async () => {
    const err = await refusal(429, "sign_in_slowed");
    expect([err.code, err.status]).toEqual(["sign_in_slowed", 429]);
    expect(err.message).toMatch(/slowed.*wait a few minutes/);
  });

  it("this client's lock is 423 account_locked, told as a wait", async () => {
    const err = await refusal(423, "account_locked");
    expect([err.code, err.status]).toEqual(["account_locked", 423]);
    expect(err.message).toMatch(/too many failed attempts.*wait fifteen minutes/);
  });

  it("a wrong password is still the credential refusal", async () => {
    const err = await refusal(401, "unauthorized");
    expect(err.code).toBe("invalid_credentials");
  });
});
