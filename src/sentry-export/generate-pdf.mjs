import puppeteer from 'puppeteer-core';
import { marked } from 'marked';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// 引数パース
const argv = process.argv.slice(2);
let inputFile = null;
let outputFile = null;

for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--input')       { inputFile  = argv[++i]; }
  else if (argv[i] === '--output') { outputFile = argv[++i]; }
  else if (!inputFile)             { inputFile  = argv[i]; }
  else if (!outputFile)            { outputFile = argv[i]; }
}

if (!inputFile || !outputFile) {
  console.error('Usage: generate-pdf.mjs <input.md> <output.pdf>');
  process.exit(2);
}

const chromiumPath = process.env.CHROMIUM_PATH || '/usr/bin/chromium';
const css = readFileSync(resolve(__dirname, 'template.css'), 'utf-8');
const md  = readFileSync(inputFile, 'utf-8');

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

const browser = await puppeteer.launch({
  executablePath: chromiumPath,
  args: [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    '--disable-gpu',
  ],
  headless: true,
});

try {
  const page = await browser.newPage();
  await page.setContent(html, { waitUntil: 'networkidle0' });
  await page.pdf({
    path: outputFile,
    format: 'A4',
    printBackground: true,
    margin: { top: '15mm', bottom: '15mm', left: '20mm', right: '20mm' },
  });
  console.error(`[sentry-export] PDF生成完了: ${outputFile}`);
} finally {
  await browser.close();
}
