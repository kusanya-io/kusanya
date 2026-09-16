/** Fixed, self-contained styles only. No source definition can supply CSS or URLs. */
export const printStyles = `
:root { color-scheme: light; font-family: Arial, Helvetica, sans-serif; color: #162b38; background: #eaf0f3; }
* { box-sizing: border-box; }
body { margin: 0; font-size: 14px; line-height: 1.5; }
main { max-width: 1000px; margin: 32px auto; padding: 40px; background: white; }
.eyebrow { color: #375766; font-size: 12px; font-weight: bold; letter-spacing: .08em; text-transform: uppercase; }
h1 { font-size: 30px; line-height: 1.2; margin: 10px 0 18px; }
h2 { margin: 32px 0 14px; font-size: 22px; }
h3 { margin: 0 0 12px; font-size: 17px; line-height: 1.4; }
h4 { margin: 18px 0 8px; font-size: 14px; }
p { margin: 8px 0; }
a { color: #1d4b60; }
code { font-family: Consolas, 'Courier New', monospace; font-size: .94em; }
.literal, code, td, dd, h1, h2, h3, li { overflow-wrap: anywhere; word-break: normal; }
.literal { white-space: pre-wrap; unicode-bidi: plaintext; }
.muted { color: #455a64; }
.notice { padding: 14px 18px; border: 2px solid #735713; background: #fff9e8; margin: 18px 0; }
.notice h2 { margin: 0 0 8px; font-size: 16px; }
.question, .mapping { border-top: 2px solid #ccd7de; padding: 20px 0; }
.container { border-top: 3px solid #375766; }
.number { color: #526a78; margin-right: 8px; font-variant-numeric: tabular-nums; }
.type { display: inline-block; font-size: 12px; font-weight: normal; border: 1px solid #68808c; padding: 1px 7px; margin-left: 8px; }
.label { font-size: 16px; margin-bottom: 14px; }
dl { display: grid; grid-template-columns: minmax(135px, 28%) minmax(0, 1fr); gap: 7px 16px; margin: 12px 0; }
dt { font-weight: bold; margin: 0; }
dd { margin: 0; }
.author { border-left: 3px solid #6a6978; padding: 8px 14px; margin: 14px 0; background: #f3f2f5; }
.author h4 { margin-top: 0; }
table { border-collapse: collapse; width: 100%; table-layout: fixed; margin: 10px 0; }
caption { text-align: left; font-weight: bold; margin-bottom: 6px; }
th, td { border: 1px solid #ccd7de; padding: 7px 9px; text-align: left; vertical-align: top; }
th { background: #edf2f4; }
thead { display: table-header-group; }
.value { width: 32%; }
ul { padding-left: 24px; }
.contents { columns: 2; column-gap: 32px; }
.contents li { break-inside: avoid; margin: 4px 0; }
.summary { border-top: 1px solid #ccd7de; padding-top: 12px; }
footer { margin-top: 30px; padding-top: 12px; border-top: 2px solid #ccd7de; font-size: 12px; }
@media (max-width: 650px) {
  main { margin: 0; padding: 20px; }
  .contents { columns: 1; }
  h1 { font-size: 25px; }
  dl { display: block; }
  dt { margin-top: 8px; }
  dd { margin: 2px 0 8px; }
}
@page { size: A4; margin: 15mm; }
@media print {
  :root { background: white; color: black; }
  body { font-size: 10pt; line-height: 1.4; }
  main { max-width: none; margin: 0; padding: 0; }
  h1 { font-size: 22pt; }
  h2 { font-size: 16pt; }
  h3 { font-size: 12pt; }
  h2, h3, h4, dt, caption { break-after: avoid; }
  p, li, dd { orphans: 3; widows: 3; }
  tr { break-inside: avoid; }
  .question, .mapping { padding: 12pt 0; }
  .notice, .author { background: white; }
  .contents { columns: 2; }
  .screen-only { display: none; }
  a { color: black; text-decoration: none; }
  .muted, .eyebrow, .number { color: #333; }
}
`;
