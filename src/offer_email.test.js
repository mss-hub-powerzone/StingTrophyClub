// Standalone Node smoke test for the offer-email URL builders.
//
// The dashboard ships as a single-page index.html, so the helpers live inline
// in <script>. This test extracts the pure-function definitions, evaluates
// them in isolation (no DOM required), and asserts the encoded outputs.
//
// Run with: node src/offer_email.test.js

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const HTML = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
const SCRIPTS = HTML.match(/<script>([\s\S]*?)<\/script>/g) || [];
const APP_CODE = SCRIPTS[SCRIPTS.length - 1]
  .replace(/^<script>/, '')
  .replace(/<\/script>$/, '');

function sliceFn(name) {
  const re = new RegExp('function ' + name + '\\([^]*?\\n\\}', 'g');
  const m = APP_CODE.match(re);
  if (!m) throw new Error('helper not found: ' + name);
  return m[0];
}
function sliceConstObj(name) {
  const re = new RegExp('const ' + name + ' = \\{[^]*?^\\};', 'gm');
  const m = APP_CODE.match(re);
  if (!m) throw new Error('const not found: ' + name);
  return m[0];
}

const bundle = `
const navigator = { userAgent: 'NodeTest' };
const localStorage = { getItem: () => null, setItem: () => {} };
${sliceFn('buildOutlookComposeUrl')}
${sliceFn('buildMailtoUrl')}
${sliceFn('buildGmailComposeUrl')}
${sliceFn('buildComposeUrl')}
${sliceFn('defaultEmailClient')}
${sliceConstObj('OFFER_PDFS')}
${sliceConstObj('EMAIL_CLIENTS')}
module.exports = {
  buildOutlookComposeUrl, buildMailtoUrl, buildGmailComposeUrl,
  buildComposeUrl, defaultEmailClient, OFFER_PDFS, EMAIL_CLIENTS,
};
`;
const tmp = path.join(require('os').tmpdir(), 'stc_offer_helpers.js');
fs.writeFileSync(tmp, bundle);
const stc = require(tmp);

const draft = {
  emails: ['parent@example.com', 'mom+x@test.org'],
  subject: 'Sting Soccer U17 N1 Offer – 2026–27 Season - Test Player',
  body: 'Hi Parent/Guardian,\nLine two with comma, ampersand & space.\nDone.',
  teamKey: 'U17',
  template: { subject: 'x', body: 'y' },
};

// Outlook URL must be byte-for-byte the same shape as before.
const ow = stc.buildOutlookComposeUrl(draft);
assert.ok(ow.startsWith('https://outlook.office.com/mail/deeplink/compose?'), 'outlook prefix');
assert.ok(ow.includes('to=parent%40example.com%3Bmom%2Bx%40test.org'), 'outlook ; separator + encoded @ +');
assert.ok(/subject=.*U17.*N1.*Offer/.test(ow), 'outlook subject contains template text');

// mailto: encoding
const mt = stc.buildMailtoUrl(draft);
assert.ok(mt.startsWith('mailto:'), 'mailto prefix');
assert.ok(mt.includes('parent@example.com,mom%2Bx@test.org'), 'mailto recipients keep @ + , readable');
assert.ok(mt.includes('subject=Sting%20Soccer%20U17%20N1%20Offer'), 'mailto subject encoded');
assert.ok(mt.includes('%0A'), 'mailto body preserves newlines');
assert.ok(mt.includes('%26'), 'mailto body escapes & so it is not a query separator');

// Gmail compose
const gm = stc.buildGmailComposeUrl(draft);
assert.ok(gm.startsWith('https://mail.google.com/mail/?'), 'gmail prefix');
assert.ok(gm.includes('view=cm'), 'gmail view=cm');
assert.ok(gm.includes('to=parent%40example.com%2Cmom%2Bx%40test.org'), 'gmail to with comma');
assert.ok(/su=Sting\+Soccer\+U17/.test(gm), 'gmail subject encoded as +');

// Dispatch
assert.strictEqual(stc.buildComposeUrl(draft, 'outlookWeb'), ow);
assert.strictEqual(stc.buildComposeUrl(draft, 'mailto'), mt);
assert.strictEqual(stc.buildComposeUrl(draft, 'gmail'), gm);
assert.strictEqual(stc.buildComposeUrl(draft, 'bogus'), ow, 'unknown client falls back to Outlook Web');

// PDF assets present
assert.ok(stc.OFFER_PDFS.U17.href.endsWith('.pdf'), 'U17 pdf href');
assert.ok(stc.OFFER_PDFS.U16.href.endsWith('.pdf'), 'U16 pdf href');
const u17abs = path.join(__dirname, '..', 'public', stc.OFFER_PDFS.U17.href.replace(/^\.\//, ''));
const u16abs = path.join(__dirname, '..', 'public', stc.OFFER_PDFS.U16.href.replace(/^\.\//, ''));
assert.ok(fs.existsSync(u17abs), 'U17 packet file present at ' + u17abs);
assert.ok(fs.existsSync(u16abs), 'U16 packet file present at ' + u16abs);

// Default client picks a known option
assert.ok(['outlookWeb', 'mailto', 'gmail'].includes(stc.defaultEmailClient()), 'default client valid');

// Empty-email draft does not produce a malformed URL
const empty = { emails: [], subject: 'S', body: 'B' };
assert.ok(!stc.buildOutlookComposeUrl(empty).includes('to='), 'outlook omits to= when no recipient');
assert.ok(stc.buildMailtoUrl(empty).startsWith('mailto:?'), 'mailto with no recipient is mailto:?...');
assert.ok(!stc.buildGmailComposeUrl(empty).includes('&to='), 'gmail omits to= when no recipient');

console.log('offer_email.test.js: all assertions passed.');
