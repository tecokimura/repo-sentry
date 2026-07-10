import puppeteer from "puppeteer-core";
import { marked } from "marked";
import { readFileSync } from "fs";
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// 引数パース
const argv = process.argv.slice(2);
let inputFile = null;
let outputFile = null;

for (let i = 0; i < argv.length; i++) {
  if (argv[i] === "--input") inputFile = argv[++i];
  else if (argv[i] === "--output") outputFile = argv[++i];
  else if (!inputFile) inputFile = argv[i];
  else if (!outputFile) outputFile = argv[i];
}

if (!inputFile || !outputFile) {
  console.error("Usage: generate-pdf.mjs <input.md> <output.pdf>");
  process.exit(2);
}

const chromiumPath = process.env.CHROMIUM_PATH || "/usr/bin/chromium";
const css = readFileSync(resolve(__dirname, "template.css"), "utf-8");
const md = readFileSync(inputFile, "utf-8");

const htmlBody = marked.parse(md);
const html = `<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>${css}</style>
</head>
<body>
${htmlBody}
</body>
</html>`;

/** h2/h3 に data 属性を付与してセクション別 CSS を有効化 */
async function injectSectionAttributes(page) {
  await page.evaluate(() => {
    // h2 に data-section を付与
    for (const h2 of document.querySelectorAll("h2")) {
      const t = h2.textContent || "";
      if (t.includes("即時対応項目")) h2.dataset.section = "immediate";
      else if (t.includes("計画対応項目")) h2.dataset.section = "planned";
      else if (t.includes("後回し可能項目")) h2.dataset.section = "deferred";
      else if (t.includes("推奨対応順序")) h2.dataset.section = "priority";
      else if (t.includes("修正ガイド")) h2.dataset.section = "fix-guide";
    }
    // 付録セクションも検出
    for (const h2 of document.querySelectorAll("h2")) {
      const t = h2.textContent || "";
      if (t.includes("付録")) h2.dataset.section = "appendix";
    }
    // 推奨対応順序内の h3 + 各セクション内の finding h3 にも属性を付与
    let currentSection = "";
    for (const el of document.querySelectorAll("h2, h3")) {
      if (el.tagName === "H2") {
        currentSection = el.dataset.section || "";
      } else {
        const t = el.textContent || "";
        // 推奨対応順序カード
        if (currentSection === "priority") {
          if (t.includes("今週中")) el.dataset.urgency = "immediate";
          else if (t.includes("今月中")) el.dataset.urgency = "planned";
          else if (t.includes("次回定期")) el.dataset.urgency = "deferred";
        }
        // 各セクション内の finding 見出し
        if (!el.dataset.urgency && currentSection) {
          el.dataset.sectionH3 = currentSection;
        }
      }
    }
  });
}

const browser = await puppeteer.launch({
  executablePath: chromiumPath,
  args: [
    "--no-sandbox",
    "--disable-setuid-sandbox",
    "--disable-dev-shm-usage",
    "--disable-gpu",
  ],
  headless: true,
});

try {
  const page = await browser.newPage();
  await page.setContent(html, { waitUntil: "networkidle0" });
  await injectSectionAttributes(page);
  await page.pdf({
    path: outputFile,
    format: "A4",
    printBackground: true,
    margin: { top: "15mm", bottom: "15mm", left: "20mm", right: "20mm" },
  });
  console.error(`[sentry-export] PDF生成完了: ${outputFile}`);
} finally {
  await browser.close();
}
