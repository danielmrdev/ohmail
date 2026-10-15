import { describe, it, expect } from "vitest";
import {
  detectTrackers, rewriteRemoteImages, isKnownTracker, isBeaconUrl, hostOf,
} from "../../src/privacy/tracker-blocker.js";

describe("detectTrackers", () => {
  it("flags a 1×1 tracking pixel (attribute dimensions)", () => {
    const html = `<p>hi</p><img src="https://analytics.example.com/o.gif" width="1" height="1">`;
    const hits = detectTrackers(html);
    expect(hits).toHaveLength(1);
    expect(hits[0]!.isPixel).toBe(true);
    expect(hits[0]!.kind).toBe("pixel");
    expect(hits[0]!.host).toBe("analytics.example.com");
  });

  it("flags a 1×1 pixel declared via inline style", () => {
    const html = `<img src="https://x.example.com/p.png" style="width:1px;height:1px;border:0">`;
    const hits = detectTrackers(html);
    expect(hits).toHaveLength(1);
    expect(hits[0]!.isPixel).toBe(true);
  });

  it("flags an image from a known tracker host (not 1×1) as a remote_image beacon", () => {
    const html = `<img src="https://ct.sendgrid.net/r/abc.jpg" width="600" height="200">`;
    const hits = detectTrackers(html);
    expect(hits).toHaveLength(1);
    expect(hits[0]!.kind).toBe("remote_image");
    expect(hits[0]!.isPixel).toBe(false);
    expect(hits[0]!.host).toContain("sendgrid.net");
  });

  /** The client's label, asked of the server's hit list: size or beacon path, never a query. */
  it("calls a beacon path a pixel whatever its size, and a sized picture with a size query nothing", () => {
    const beacon = detectTrackers(`<img src="https://t.example/wf/open?u=abc" width="600" height="20">`);
    expect(beacon.map((x) => x.kind)).toEqual(["pixel"]);
    expect(detectTrackers(`<img src="https://images.example/p.png?w=120" width="120" height="120">`)).toEqual([]);
  });

  it("does NOT flag a normal inline remote image", () => {
    const html = `<img src="https://cdn.example.com/photo.jpeg" width="600" height="400" alt="a photo">`;
    expect(detectTrackers(html)).toHaveLength(0);
  });

  it("does NOT flag data: or cid: images", () => {
    const html =
      `<img src="data:image/png;base64,iVBORw0KGgo=" width="1" height="1">` +
      `<img src="cid:logo@corp" width="1" height="1">`;
    expect(detectTrackers(html)).toHaveLength(0);
  });

  it("dedupes repeated urls", () => {
    const html =
      `<img src="https://t.example.com/p.gif" width="1" height="1">` +
      `<img src="https://t.example.com/p.gif" width="1" height="1">`;
    expect(detectTrackers(html)).toHaveLength(1);
  });
});

describe("isBeaconUrl: a beacon path or a per-recipient key is evidence, no other query is", () => {
  it.each([
    "https://t.example/wf/open?upn=abc",
    "https://t.example/open?u=1",
    "https://t.example/track/open.php?u=1",
    "https://t.example/pixel.gif?id=1",
    "https://cl.t.example/open.aspx?x=1",
    "https://t.example/beacon",
    "https://images.example/p.png?uid=abc123",
    "https://t.example/img.jpg?x=1&recipient=r-1",
  ])("%s is a beacon", (url) => expect(isBeaconUrl(url)).toBe(true));
  it.each([
    "https://images.example/p.png?w=120",
    "https://images.example/p.gif?e2e=1",
    "https://shop.example/hero.jpg?utm_medium=email",
    "https://shop.example/hero.jpg?campaign=fall",
    "https://cdn.example/open-source-logo.png",
    "https://cdn.example/opened.png",
    "https://open.example.com/logo.png",
    "https://images.example/p.png?next=/open",
  ])("%s is not", (url) => expect(isBeaconUrl(url)).toBe(false));
});

describe("isKnownTracker / hostOf", () => {
  it("matches known hosts and their subdomains", () => {
    expect(isKnownTracker("list-manage.com")).toBe(true);
    expect(isKnownTracker("us1.list-manage.com")).toBe(true);
    expect(isKnownTracker("ct.sendgrid.net")).toBe(true);
    expect(isKnownTracker("cdn.example.com")).toBe(false);
  });
  it("an ESP's picture host is not a tracking host, and a name merely containing one is not either", () => {
    expect(isKnownTracker("gallery.mailchimp.com")).toBe(false);
    expect(isKnownTracker("files.constantcontact.com")).toBe(false);
    expect(isKnownTracker("cdn.mcauto-images-production.sendgrid.net")).toBe(false);
    expect(isKnownTracker("notlist-manage.com")).toBe(false);
    expect(isKnownTracker("list-manage.com.pictures.example")).toBe(false);
  });
  it("hostOf parses the host and lowercases it", () => {
    expect(hostOf("https://Analytics.Example.COM/p.gif?x=1")).toBe("analytics.example.com");
    expect(hostOf("not a url")).toBe("");
  });
  it("hostOf is the host the gate dials: no root dot, no port, no userinfo — so the list matches every spelling", () => {
    expect(hostOf("https://us1.list-manage.com./r/abc123.jpg")).toBe("us1.list-manage.com");
    expect(hostOf("https://US1.LIST-MANAGE.COM./r/abc123.jpg")).toBe("us1.list-manage.com");
    expect(hostOf("https://us1.list-manage.com:8443/r/abc123.jpg")).toBe("us1.list-manage.com");
    expect(hostOf("https://u:p@us1.list-manage.com/r/abc123.jpg")).toBe("us1.list-manage.com");
    // `new URL` refuses a port past 65535; the fallback reads the same host the same way.
    expect(hostOf("https://u@US1.LIST-MANAGE.COM.:99999/r/abc123.jpg")).toBe("us1.list-manage.com");
    expect(isKnownTracker(hostOf("https://us1.list-manage.com./r/abc123.jpg"))).toBe(true);
    expect(isKnownTracker("US1.List-Manage.com.")).toBe(true);
  });
  it("CONTROL: hostOf drops ONE root dot, as the gate does, and a lookalike stays a lookalike", () => {
    expect(hostOf("https://us1.list-manage.com../r/abc123.jpg")).toBe("us1.list-manage.com.");
    expect(isKnownTracker("list-manage.com.pictures.example.")).toBe(false);
    expect(isKnownTracker("notlist-manage.com.")).toBe(false);
  });
});

describe("rewriteRemoteImages", () => {
  const PROXY = "/api/v1/img";
  const MID = "11111111-1111-1111-1111-111111111111";

  it("points every remote <img> src at the proxy with mid + encoded original url", () => {
    const url = "https://cdn.example.com/a.png";
    const { html } = rewriteRemoteImages(`<img src="${url}">`, PROXY, MID);
    expect(html).toContain(`${PROXY}?mid=${MID}&u=${encodeURIComponent(url)}`);
    expect(html).not.toContain(`src="${url}"`);
  });

  it("leaves data: and cid: srcs untouched", () => {
    const html = `<img src="data:image/png;base64,AAAA"><img src="cid:logo@corp">`;
    const out = rewriteRemoteImages(html, PROXY, MID).html;
    expect(out).toContain(`src="data:image/png;base64,AAAA"`);
    expect(out).toContain(`src="cid:logo@corp"`);
    expect(out).not.toContain(PROXY);
  });

  it("rewrites CSS background-image url() when remote", () => {
    const url = "https://cdn.example.com/bg.jpg";
    const out = rewriteRemoteImages(`<div style="background-image: url('${url}')"></div>`, PROXY, MID).html;
    expect(out).toContain(`${PROXY}?mid=${MID}&u=${encodeURIComponent(url)}`);
  });

  it("returns the detected trackers alongside the rewritten html", () => {
    const html =
      `<img src="https://spy.example.com/o.gif" width="1" height="1">` +
      `<img src="https://cdn.example.com/photo.png" width="500" height="300">`;
    const { html: out, trackers } = rewriteRemoteImages(html, PROXY, MID);
    // Both remote imgs get proxied…
    expect((out.match(/\/api\/v1\/img\?mid=/g) ?? []).length).toBe(2);
    // …but only the pixel is reported as a tracker.
    expect(trackers).toHaveLength(1);
    expect(trackers[0]!.isPixel).toBe(true);
    expect(trackers[0]!.host).toBe("spy.example.com");
  });
});
