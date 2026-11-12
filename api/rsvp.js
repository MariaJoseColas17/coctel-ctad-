// RSVP endpoint: receives the form on the page and emails it to the organiser through Resend.
//
// Environment variables (set in the Vercel project):
//   RESEND_API_KEY  required. API key from resend.com.
//   RSVP_FROM       required. Sender on a domain verified in Resend,
//                   for example: The Alzheimer Project RSVP <rsvp@alzheimerproject.com>
//   RSVP_TO         optional. Who receives each RSVP. Defaults to DEFAULT_TO below.

const DEFAULT_TO = "maria.colas@alzheimerproject.com";
const SUBJECT = "New RSVP: The Alzheimer Project Reception, CTAD 2026";
const RESEND_TIMEOUT_MS = 15000;

// Form field name -> [label in the email, max length, required]
const FIELDS = [
  ["First name", 100, true],
  ["Last name", 100, true],
  ["email", 254, true],
  ["Institution or company", 200, true],
  ["Role", 200, false],
  ["Note", 2000, false],
];
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

const escapeHtml = (s) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function reply(req, res, status, payload, htmlMessage) {
  const wantsJson = /json/i.test(req.headers.accept || "") || /json/i.test(req.headers["content-type"] || "");
  res.setHeader("Cache-Control", "no-store");
  if (wantsJson) return res.status(status).json(payload);
  // Visitors without JavaScript post the form directly and land here.
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  return res
    .status(status)
    .send(
      '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">' +
        "<title>RSVP</title>" +
        '<body style="font-family:system-ui,sans-serif;max-width:32rem;margin:15vh auto;padding:0 16px;line-height:1.5">' +
        "<p>" + escapeHtml(htmlMessage) + '</p><p><a href="/">Back to the invitation</a></p></body>'
    );
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return reply(req, res, 405, { ok: false, errors: [{ code: "METHOD_NOT_ALLOWED" }] }, "This address only accepts RSVPs sent from the invitation page.");
  }

  // Only accept posts that come from this site's own page.
  const origin = req.headers.origin;
  if (origin) {
    let originHost = "";
    try { originHost = new URL(origin).host; } catch (_) {}
    if (originHost !== req.headers.host) {
      return reply(req, res, 403, { ok: false, errors: [{ code: "FORBIDDEN_ORIGIN" }] }, "This RSVP was not sent from the invitation page.");
    }
  }

  let body;
  try { body = req.body; } catch (_) { body = null; }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return reply(req, res, 400, { ok: false, errors: [{ code: "BAD_REQUEST" }] }, "Your RSVP could not be read. Please go back and try again.");
  }

  // Honeypot: real visitors never fill this in. Pretend it worked so bots learn nothing.
  if (typeof body._gotcha === "string" && body._gotcha.trim() !== "") {
    return reply(req, res, 200, { ok: true }, "Thank you. We have received your RSVP.");
  }

  const values = {};
  const errors = [];
  for (const [name, max, required] of FIELDS) {
    const value = typeof body[name] === "string" ? body[name].trim() : "";
    values[name] = value;
    if (required && !value) errors.push({ field: name, code: "REQUIRED" });
    else if (value.length > max) errors.push({ field: name, code: "TOO_LONG" });
  }
  if (values.email && !EMAIL_RE.test(values.email) && !errors.some((e) => e.field === "email")) {
    errors.push({ field: "email", code: "INVALID_EMAIL" });
  }
  if (errors.length) {
    return reply(req, res, 422, { ok: false, errors }, "Some required details are missing or not valid. Please go back and check the form.");
  }

  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.RSVP_FROM;
  const to = (process.env.RSVP_TO || DEFAULT_TO).split(",").map((s) => s.trim()).filter(Boolean);
  if (!apiKey || !from) {
    console.error("RSVP email is not configured: RESEND_API_KEY and RSVP_FROM must both be set.");
    return reply(req, res, 500, { ok: false, errors: [{ code: "NOT_CONFIGURED" }] }, "The RSVP form is not set up correctly yet. Please write to " + DEFAULT_TO + ".");
  }

  const oneLine = (s) => s.replace(/[\r\n]+/g, " ");
  const rows = [
    ["Name", oneLine(values["First name"] + " " + values["Last name"])],
    ["Email", values.email],
    ["Institution or company", oneLine(values["Institution or company"])],
    ["Role", oneLine(values.Role) || "(not given)"],
    ["Note", values.Note || "(none)"],
    ["Received", new Date().toISOString().replace("T", " ").slice(0, 16) + " UTC"],
  ];
  const text = "New RSVP for The Alzheimer Project Reception (CTAD 2026)\n\n" + rows.map(([k, v]) => k + ": " + v).join("\n") + "\n";
  const html =
    "<h2 style=\"font-family:system-ui,sans-serif\">New RSVP: The Alzheimer Project Reception (CTAD 2026)</h2>" +
    '<table style="font-family:system-ui,sans-serif;border-collapse:collapse">' +
    rows
      .map(([k, v]) =>
        '<tr><td style="padding:4px 16px 4px 0;color:#555;vertical-align:top">' + escapeHtml(k) +
        '</td><td style="padding:4px 0;white-space:pre-wrap">' + escapeHtml(v) + "</td></tr>")
      .join("") +
    "</table>";

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), RESEND_TIMEOUT_MS);
  try {
    const sent = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: "Bearer " + apiKey, "Content-Type": "application/json" },
      body: JSON.stringify({ from, to, reply_to: values.email, subject: SUBJECT, text, html }),
      signal: controller.signal,
    });
    if (!sent.ok) {
      console.error("Resend rejected the RSVP email:", sent.status, (await sent.text()).slice(0, 500));
      return reply(req, res, 502, { ok: false, errors: [{ code: "SEND_FAILED" }] }, "Your RSVP was not received. Please try again, or write to " + DEFAULT_TO + ".");
    }
  } catch (err) {
    console.error("Could not reach Resend:", err && err.name, err && err.message);
    return reply(req, res, 502, { ok: false, errors: [{ code: "SEND_FAILED" }] }, "Your RSVP was not received. Please try again, or write to " + DEFAULT_TO + ".");
  } finally {
    clearTimeout(timer);
  }

  return reply(req, res, 200, { ok: true }, "Thank you. We have received your RSVP. See you in Boston on Wednesday, November 18.");
};
