import http from "node:http";
import { existsSync } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "@playwright/test";
import pixelmatch from "pixelmatch";
import { PNG } from "pngjs";

const MIME_TYPES = new Map([
  [".css", "text/css"],
  [".gif", "image/gif"],
  [".html", "text/html; charset=utf-8"],
  [".jpeg", "image/jpeg"],
  [".jpg", "image/jpeg"],
  [".js", "text/javascript"],
  [".json", "application/json"],
  [".png", "image/png"],
  [".svg", "image/svg+xml"],
  [".txt", "text/plain; charset=utf-8"],
  [".webp", "image/webp"],
]);

const VIEWPORTS = [
  { name: "desktop", width: 1440, height: 1200 },
  { name: "tablet", width: 1024, height: 1200 },
  { name: "mobile", width: 390, height: 1200 },
];

function parseArgs(argv) {
  const args = {};

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) {
      throw new Error(`Unexpected argument: ${arg}`);
    }

    const key = arg.slice(2);
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`Missing value for --${key}`);
    }

    args[key] = value;
    i += 1;
  }

  return args;
}

function required(args, key) {
  if (!args[key]) {
    throw new Error(`Missing required argument --${key}`);
  }

  return args[key];
}

function optional(args, key, defaultValue = "") {
  return args[key] ?? defaultValue;
}

function parseSelectors(value) {
  return value
    .split(/[\n,]/)
    .map((selector) => selector.trim())
    .filter(Boolean);
}

function normalizeRelativeUrl(value) {
  return value.replace(/^\/+/, "");
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

async function startStaticServer(rootDir) {
  const root = path.resolve(rootDir);

  const server = http.createServer(async (request, response) => {
    try {
      const requestUrl = new URL(request.url ?? "/", "http://localhost");
      const relativePath = decodeURIComponent(requestUrl.pathname);
      let filePath = path.resolve(root, `.${relativePath}`);

      if (!filePath.startsWith(root)) {
        response.writeHead(403);
        response.end("Forbidden");
        return;
      }

      const fileStat = await stat(filePath);
      if (fileStat.isDirectory()) {
        filePath = path.join(filePath, "index.html");
      }

      const body = await readFile(filePath);
      const contentType = MIME_TYPES.get(path.extname(filePath)) ?? "application/octet-stream";
      response.writeHead(200, { "content-type": contentType });
      response.end(body);
    } catch {
      response.writeHead(404);
      response.end("Not found");
    }
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });

  const address = server.address();
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

async function waitForStablePage(page, url) {
  await page.goto(url, { waitUntil: "networkidle", timeout: 90_000 });
  await page.evaluate(async () => {
    if (document.fonts?.ready) {
      await document.fonts.ready;
    }
  });
  await page.waitForTimeout(500);
}

async function applyIgnoredSelectors(page, selectors) {
  if (selectors.length === 0) {
    return;
  }

  const css = selectors
    .map((selector) => `${selector} { visibility: hidden !important; }`)
    .join("\n");

  await page.addStyleTag({ content: css });
}

async function getPageMetrics(page) {
  return page.evaluate(() => {
    const root = document.scrollingElement ?? document.documentElement;
    const viewportWidth = window.innerWidth;
    const scrollWidth = Math.ceil(root.scrollWidth);
    const scrollHeight = Math.ceil(root.scrollHeight);

    const overflowElements = Array.from(document.body.querySelectorAll("*"))
      .map((element) => {
        const rect = element.getBoundingClientRect();

        if (rect.width <= 0 || rect.height <= 0) {
          return null;
        }

        if (rect.right <= viewportWidth + 1 && rect.left >= -1) {
          return null;
        }

        const id = element.id ? `#${element.id}` : "";
        const classes = Array.from(element.classList)
          .slice(0, 3)
          .map((className) => `.${className}`)
          .join("");
        const text = (element.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 80);

        return {
          selector: `${element.tagName.toLowerCase()}${id}${classes}`,
          left: Math.round(rect.left),
          right: Math.round(rect.right),
          width: Math.round(rect.width),
          text,
        };
      })
      .filter(Boolean)
      .slice(0, 10);

    const headings = Array.from(document.querySelectorAll("h1, h2, h3, h4, h5, h6"))
      .map((heading) => ({
        level: heading.tagName.toLowerCase(),
        text: (heading.textContent ?? "").replace(/\s+/g, " ").trim(),
      }))
      .filter((heading) => heading.text);

    return {
      scrollWidth,
      scrollHeight,
      viewportWidth,
      hasHorizontalOverflow: scrollWidth > viewportWidth + 1,
      overflowElements,
      headings,
    };
  });
}

async function captureViewportWidthFullPage(page, imagePath, viewport, pageHeight) {
  const target = new PNG({ width: viewport.width, height: pageHeight });

  for (let y = 0; y < pageHeight; y += viewport.height) {
    const height = Math.min(viewport.height, pageHeight - y);

    await page.evaluate((scrollY) => {
      window.scrollTo(0, scrollY);
    }, y);
    await page.waitForTimeout(50);

    const tileBuffer = await page.screenshot({
      clip: {
        x: 0,
        y: 0,
        width: viewport.width,
        height,
      },
    });
    const tile = PNG.sync.read(tileBuffer);
    PNG.bitblt(tile, target, 0, 0, viewport.width, height, 0, y);
  }

  await writeFile(imagePath, PNG.sync.write(target));
}

async function capturePage(page, url, imagePath, selectors, viewport) {
  await waitForStablePage(page, url);
  await applyIgnoredSelectors(page, selectors);

  const metrics = await getPageMetrics(page);
  await captureViewportWidthFullPage(page, imagePath, viewport, metrics.scrollHeight);

  return metrics;
}

function padPng(source, width, height) {
  if (source.width === width && source.height === height) {
    return source;
  }

  const target = new PNG({ width, height, fill: true });
  PNG.bitblt(source, target, 0, 0, source.width, source.height, 0, 0);
  return target;
}

async function compareImages(basePath, headPath, diffPath) {
  const base = PNG.sync.read(await readFile(basePath));
  const head = PNG.sync.read(await readFile(headPath));
  const width = Math.max(base.width, head.width);
  const height = Math.max(base.height, head.height);
  const paddedBase = padPng(base, width, height);
  const paddedHead = padPng(head, width, height);
  const diff = new PNG({ width, height });
  const diffPixels = pixelmatch(
    paddedBase.data,
    paddedHead.data,
    diff.data,
    width,
    height,
    { threshold: 0.1 },
  );

  await writeFile(diffPath, PNG.sync.write(diff));

  return {
    diffPixels,
    totalPixels: width * height,
    ratio: diffPixels / (width * height),
    baseSize: `${base.width}x${base.height}`,
    headSize: `${head.width}x${head.height}`,
    comparedSize: `${width}x${height}`,
  };
}

async function writeReports(outDir, results, threshold, failOnDifference) {
  const changed = results.filter((result) => result.ratio > threshold);
  const overflowed = results.filter(
    (result) => result.baseMetrics.hasHorizontalOverflow || result.headMetrics.hasHorizontalOverflow,
  );
  const outlineDiff = compareHeadings(results[0]?.baseMetrics.headings ?? [], results[0]?.headMetrics.headings ?? []);
  const summaryLines = [
    "# Visual regression",
    "",
    `Threshold: ${(threshold * 100).toFixed(2)}%`,
    `Fail on difference: ${failOnDifference}`,
    `Changed viewports: ${changed.length}/${results.length}`,
    `Horizontal overflow: ${overflowed.length}/${results.length}`,
    `Heading changes: ${outlineDiff.added.length} added, ${outlineDiff.removed.length} removed`,
    "",
    "| viewport | difference | base | head | overflow |",
    "| --- | ---: | --- | --- | --- |",
    ...results.map((result) => {
      const percentage = `${(result.ratio * 100).toFixed(3)}%`;
      const overflow = [
        result.baseMetrics.hasHorizontalOverflow ? `base ${result.baseMetrics.scrollWidth}px` : "",
        result.headMetrics.hasHorizontalOverflow ? `head ${result.headMetrics.scrollWidth}px` : "",
      ].filter(Boolean).join(", ") || "no";
      return `| ${result.name} | ${percentage} | ${result.baseSize} | ${result.headSize} | ${overflow} |`;
    }),
    "",
  ];

  const htmlRows = results.map((result) => `
    <section>
      <h2>${escapeHtml(result.name)} - ${(result.ratio * 100).toFixed(3)}%</h2>
      <p>Base: ${escapeHtml(result.baseSize)}. Head: ${escapeHtml(result.headSize)}. Compared at ${escapeHtml(result.width)}px viewport width.</p>
      ${renderOverflowDetails(result)}
      <div class="grid">
        <figure><figcaption><a href="${escapeHtml(result.baseImage)}">Base</a></figcaption><div class="shot"><img src="${escapeHtml(result.baseImage)}"></div></figure>
        <figure><figcaption><a href="${escapeHtml(result.headImage)}">Head</a></figcaption><div class="shot"><img src="${escapeHtml(result.headImage)}"></div></figure>
        <figure><figcaption><a href="${escapeHtml(result.diffImage)}">Diff</a></figcaption><div class="shot"><img src="${escapeHtml(result.diffImage)}"></div></figure>
      </div>
    </section>
  `).join("\n");

  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Visual regression report</title>
  <style>
    body { color: #17202a; font: 16px/1.5 system-ui, sans-serif; margin: 2rem; }
    h1, h2 { line-height: 1.2; }
    section { border-top: 1px solid #d8dee9; margin-top: 2rem; padding-top: 1rem; }
    .grid { display: grid; gap: 1rem; grid-template-columns: repeat(3, minmax(0, 1fr)); }
    .grid.two { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    figure { margin: 0; }
    figcaption { font-weight: 700; margin-bottom: .5rem; }
    .shot { border: 1px solid #d8dee9; max-height: 80vh; overflow: auto; }
    .shot img { display: block; width: 100%; }
    .overflow { background: #fff8e5; border: 1px solid #f0d98c; padding: .75rem 1rem; }
    code { background: #eef2f7; padding: .1rem .25rem; }
    table { border-collapse: collapse; margin: .5rem 0 1rem; width: 100%; }
    th, td { border: 1px solid #d8dee9; padding: .35rem .5rem; text-align: left; vertical-align: top; }
  </style>
</head>
<body>
  <h1>Visual regression report</h1>
  <p>Changed viewports: ${changed.length}/${results.length}.</p>
  ${renderHeadingDiff(outlineDiff)}
  ${htmlRows}
</body>
</html>
`;

  await writeFile(path.join(outDir, "summary.md"), summaryLines.join("\n"));
  await writeFile(path.join(outDir, "report.html"), html);
  await writeFile(path.join(outDir, "results.json"), JSON.stringify(results, null, 2));
}

function headingKey(heading) {
  return `${heading.level}:${heading.text}`;
}

function compareHeadings(baseHeadings, headHeadings) {
  const baseKeys = new Set(baseHeadings.map(headingKey));
  const headKeys = new Set(headHeadings.map(headingKey));

  return {
    added: headHeadings.filter((heading) => !baseKeys.has(headingKey(heading))),
    removed: baseHeadings.filter((heading) => !headKeys.has(headingKey(heading))),
  };
}

function renderHeadingList(headings) {
  if (headings.length === 0) {
    return "<p>None.</p>";
  }

  return `<ul>${headings.slice(0, 30).map((heading) => (
    `<li><code>${escapeHtml(heading.level)}</code> ${escapeHtml(heading.text)}</li>`
  )).join("\n")}</ul>`;
}

function renderHeadingDiff(outlineDiff) {
  if (outlineDiff.added.length === 0 && outlineDiff.removed.length === 0) {
    return "";
  }

  return `<section>
    <h2>Heading changes</h2>
    <div class="grid two">
      <div>
        <h3>Added in head (${outlineDiff.added.length})</h3>
        ${renderHeadingList(outlineDiff.added)}
      </div>
      <div>
        <h3>Removed from base (${outlineDiff.removed.length})</h3>
        ${renderHeadingList(outlineDiff.removed)}
      </div>
    </div>
  </section>`;
}

function renderOverflowDetails(result) {
  const rows = [
    ...result.baseMetrics.overflowElements.map((element) => ({ side: "Base", ...element })),
    ...result.headMetrics.overflowElements.map((element) => ({ side: "Head", ...element })),
  ];

  if (!result.baseMetrics.hasHorizontalOverflow && !result.headMetrics.hasHorizontalOverflow) {
    return "";
  }

  const overflowSummary = [
    result.baseMetrics.hasHorizontalOverflow
      ? `Base scroll width: ${result.baseMetrics.scrollWidth}px`
      : "Base has no horizontal overflow",
    result.headMetrics.hasHorizontalOverflow
      ? `Head scroll width: ${result.headMetrics.scrollWidth}px`
      : "Head has no horizontal overflow",
  ].join(". ");

  const table = rows.length === 0
    ? ""
    : `<table>
        <thead><tr><th>Side</th><th>Element</th><th>Position</th><th>Text</th></tr></thead>
        <tbody>
          ${rows.map((row) => `
            <tr>
              <td>${escapeHtml(row.side)}</td>
              <td><code>${escapeHtml(row.selector)}</code></td>
              <td>${escapeHtml(row.left)}-${escapeHtml(row.right)}px (${escapeHtml(row.width)}px)</td>
              <td>${escapeHtml(row.text)}</td>
            </tr>
          `).join("\n")}
        </tbody>
      </table>`;

  return `<div class="overflow"><strong>Horizontal overflow detected.</strong> ${escapeHtml(overflowSummary)}${table}</div>`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const baseDir = path.resolve(required(args, "base-dir"));
  const headDir = path.resolve(required(args, "head-dir"));
  const outDir = path.resolve(required(args, "out-dir"));
  const pagePath = normalizeRelativeUrl(required(args, "path"));
  const threshold = Number(required(args, "threshold"));
  const failOnDifference = required(args, "fail-on-difference") === "true";
  const ignoredSelectors = parseSelectors(optional(args, "ignore-selectors"));

  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) {
    throw new Error("--threshold must be a number between 0 and 1");
  }

  if (!existsSync(path.join(baseDir, pagePath))) {
    throw new Error(`Base page not found: ${path.join(baseDir, pagePath)}`);
  }

  if (!existsSync(path.join(headDir, pagePath))) {
    throw new Error(`Head page not found: ${path.join(headDir, pagePath)}`);
  }

  await mkdir(outDir, { recursive: true });

  const baseServer = await startStaticServer(baseDir);
  const headServer = await startStaticServer(headDir);
  const browser = await chromium.launch();
  const results = [];

  try {
    for (const viewport of VIEWPORTS) {
      const page = await browser.newPage({
        deviceScaleFactor: 1,
        viewport: { width: viewport.width, height: viewport.height },
      });

      const baseImage = `base-${viewport.name}.png`;
      const headImage = `head-${viewport.name}.png`;
      const diffImage = `diff-${viewport.name}.png`;

      const baseMetrics = await capturePage(
        page,
        `${baseServer.url}/${pagePath}`,
        path.join(outDir, baseImage),
        ignoredSelectors,
        viewport,
      );

      const headMetrics = await capturePage(
        page,
        `${headServer.url}/${pagePath}`,
        path.join(outDir, headImage),
        ignoredSelectors,
        viewport,
      );

      await page.close();

      const comparison = await compareImages(
        path.join(outDir, baseImage),
        path.join(outDir, headImage),
        path.join(outDir, diffImage),
      );

      results.push({
        ...viewport,
        ...comparison,
        baseImage,
        headImage,
        diffImage,
        baseMetrics,
        headMetrics,
        changed: comparison.ratio > threshold,
      });
    }
  } finally {
    await browser.close();
    await baseServer.close();
    await headServer.close();
  }

  await writeReports(outDir, results, threshold, failOnDifference);

  const changed = results.filter((result) => result.changed);
  for (const result of results) {
    console.log(`${result.name}: ${(result.ratio * 100).toFixed(3)}%`);
  }

  if (failOnDifference && changed.length > 0) {
    throw new Error(`${changed.length} viewport(s) exceeded the threshold`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
