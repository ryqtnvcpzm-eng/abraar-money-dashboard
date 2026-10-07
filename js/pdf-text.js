// Pull positioned text out of a PDF with pdf.js. Shared by the browser importer and the Node tools.
// The PDF bytes stay in memory on this device; nothing is uploaded.

export async function pdfToPages(pdfjs, data) {
  const task = pdfjs.getDocument({
    data,
    isEvalSupported: false,
    disableFontFace: true,
    useSystemFonts: false,
    stopAtErrors: false,
    verbosity: 0,
  });
  const doc = await task.promise;
  try {
    const pages = [];
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const tc = await page.getTextContent();
      pages.push(tc.items.filter((it) => typeof it.str === 'string').map((it) => ({ str: it.str, x: it.transform[4], y: it.transform[5], w: it.width })));
      page.cleanup();
    }
    return pages;
  } finally {
    await task.destroy();
  }
}
