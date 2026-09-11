// Writes content/*.json (edited through Pages CMS) into the marked regions
// of public/index.html and public/llms.txt. Runs in place and is idempotent.
// Any invalid content throws, so a bad CMS edit fails the Cloudflare build
// and the live site stays on the last good version.
"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = __dirname;
const PRACTICES = { build: "Build", improve: "Improve", review: "Review" };
const NUMBER_WORDS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten",
  "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen", "twenty"];

function readJson(file) {
  return JSON.parse(fs.readFileSync(path.join(ROOT, file), "utf8"));
}

function fail(message) {
  throw new Error("Invalid content: " + message);
}

function requireText(value, where) {
  if (typeof value !== "string" || !value.trim()) fail(where + " must be non-empty text");
  return value.trim();
}

function requireRange(min, max, where) {
  if (!Number.isInteger(min) || !Number.isInteger(max) || min < 0 || max < 0) {
    fail(where + " must be whole numbers of 0 or more");
  }
  if (min > max) fail(where + " has 'from' larger than 'to'");
  return [min, max];
}

function slugify(text) {
  return text.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function validateServices(data, icons) {
  if (!Array.isArray(data.services) || !data.services.length) fail("services.json needs at least one service");
  const seen = new Set();
  return data.services.map((s, i) => {
    const where = "service #" + (i + 1);
    const name = requireText(s.name, where + " name");
    const id = slugify(name);
    if (!id) fail(where + " name needs at least one letter or digit");
    if (seen.has(id)) fail("two services are both named '" + name + "'");
    seen.add(id);
    if (!(s.practice in PRACTICES)) fail(where + " practice must be one of " + Object.keys(PRACTICES).join(", "));
    if (!icons.includes(s.icon)) fail(where + " icon '" + s.icon + "' does not exist");
    return {
      id,
      practice: s.practice,
      icon: s.icon,
      name,
      days: requireRange(s.daysMin, s.daysMax, where + " days"),
      price: requireRange(s.priceMin, s.priceMax, where + " price"),
      desc: requireText(s.description, where + " description"),
    };
  });
}

function validateSite(data) {
  const rate = requireRange(data.dayRateMin, data.dayRateMax, "day rate");
  const list = (value, where) => {
    if (!Array.isArray(value)) fail(where + " must be a list");
    return value;
  };
  return {
    rate,
    workedAt: list(data.workedAt, "worked at").map((c, i) => requireText(c, "worked at #" + (i + 1))),
    retainers: list(data.retainers, "ongoing work").map((r, i) => ({
      title: requireText(r.title, "ongoing work #" + (i + 1) + " title"),
      price: requireText(r.price, "ongoing work #" + (i + 1) + " price"),
      description: requireText(r.description, "ongoing work #" + (i + 1) + " description"),
    })),
    credentials: list(data.credentials, "credentials").map((c, i) => ({
      title: requireText(c.title, "credential #" + (i + 1) + " title"),
      place: requireText(c.place, "credential #" + (i + 1) + " place"),
    })),
  };
}

function escapeHtml(text) {
  return text.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

// Stops a "</script>" inside CMS text from closing the inline script early.
function scriptSafeJson(value, indent) {
  return JSON.stringify(value, null, indent).replace(/</g, "\\u003c");
}

function words(n) {
  return NUMBER_WORDS[n] || String(n);
}

// Replaces everything between a "cms:<name>" and a "/cms:<name>" comment.
function replaceRegion(source, name, content, open, close, file) {
  const start = open + "cms:" + name + close;
  const end = open + "/cms:" + name + close;
  const from = source.indexOf(start);
  const to = source.indexOf(end);
  if (from === -1 || to === -1 || to < from) throw new Error("Marker '" + name + "' missing in " + file);
  return source.slice(0, from + start.length) + content + source.slice(to);
}

function buildIndex(html, services, site) {
  const file = "public/index.html";
  const html_ = (name, content) => { html = replaceRegion(html, name, content, "<!-- ", " -->", file); };
  const js_ = (name, content) => { html = replaceRegion(html, name, content, "/* ", " */", file); };
  const [rateLo, rateHi] = site.rate;
  const rateText = "&euro;" + rateLo + " &ndash; " + rateHi;
  const count = services.length;

  html_("worked", "\n" + site.workedAt
    .map((c) => '      <b translate="no">' + escapeHtml(c).replace(/ /g, "&nbsp;") + "</b>\n").join("") + "      ");
  html_("services-heading", "All " + words(count) + ", priced. Tick what you need.");
  html_("services-filter-all", "All " + count);
  html_("rate-note", rateText + " per day");
  html_("retainers", "\n" + site.retainers.map((r) =>
    "        <div>\n" +
    "          <h3>" + escapeHtml(r.title) + "</h3>\n" +
    '          <span class="fig">' + escapeHtml(r.price) + "</span>\n" +
    '          <p class="small dim">' + escapeHtml(r.description) + "</p>\n" +
    "        </div>\n").join("") + "      ");
  html_("credentials", "\n" + site.credentials.map((c) =>
    '        <div class="cred rise"><b>' + escapeHtml(c.title) + "</b><span>" + escapeHtml(c.place) + "</span></div>\n").join("") + "      ");
  html_("contact-rate", rateText);
  js_("services", "\n" + services.map((s) => "    " + scriptSafeJson(s)).join(",\n") + "\n  ");

  // The structured data is rebuilt from the parsed block rather than
  // patched as text, so its prices can never drift from the catalogue.
  html = html.replace(/(<script type="application\/ld\+json">\n)([\s\S]*?)(\n<\/script>)/, (_, open, json, close) => {
    const data = JSON.parse(json);
    const business = data["@graph"].find((node) => node["@id"] === "https://melotech.dev/#business");
    const prices = services.flatMap((s) => s.price);
    business.priceRange = "€" + Math.min(...prices) + " to €" + Math.max(...prices) +
      " per engagement, €" + rateLo + " to €" + rateHi + " per day";
    business.hasOfferCatalog.itemListElement = services.map((s) => ({
      "@type": "Offer",
      itemOffered: {
        "@type": "Service",
        name: s.name,
        category: PRACTICES[s.practice],
        provider: { "@id": "https://melotech.dev/#business" },
      },
      priceSpecification: {
        "@type": "PriceSpecification",
        priceCurrency: "EUR",
        minPrice: s.price[0],
        maxPrice: s.price[1],
      },
    }));
    return open + scriptSafeJson(data, 2) + close;
  });
  return html;
}

function buildLlms(text, services, site) {
  const file = "public/llms.txt";
  const [rateLo, rateHi] = site.rate;
  text = replaceRegion(text, "pricing", "\n" +
    "Every price on the site is public. Work is quoted as days multiplied by a\n" +
    "day rate of " + rateLo + " to " + rateHi + " euro. There are " + words(services.length) +
    " fixed services plus a\n" +
    "retainer. A visitor can tick the services they need and read the total\n" +
    "without contacting anyone first.\n", "<!-- ", " -->", file);
  const groups = Object.keys(PRACTICES).map((p) => {
    const mine = services.filter((s) => s.practice === p);
    if (!mine.length) return "";
    return PRACTICES[p] + "\n" + mine.map((s) =>
      "- " + s.name + ", " + s.days[0] + " to " + s.days[1] + " days, " +
      s.price[0] + " to " + s.price[1] + " euro\n").join("");
  }).filter(Boolean);
  return replaceRegion(text, "services", "\n" + groups.join("\n"), "<!-- ", " -->", file);
}

function main() {
  const indexPath = path.join(ROOT, "public/index.html");
  const llmsPath = path.join(ROOT, "public/llms.txt");
  const html = fs.readFileSync(indexPath, "utf8");
  const icons = [...html.matchAll(/^ {4}"([a-z-]+)": '<path/gm)].map((m) => m[1]);
  const services = validateServices(readJson("content/services.json"), icons);
  const site = validateSite(readJson("content/site.json"));

  fs.writeFileSync(indexPath, buildIndex(html, services, site));
  fs.writeFileSync(llmsPath, buildLlms(fs.readFileSync(llmsPath, "utf8"), services, site));
  console.log("Built " + services.length + " services into public/index.html and public/llms.txt");
}

main();
