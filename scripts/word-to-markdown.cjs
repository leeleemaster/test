const fs = require('fs');
const path = require('path');

const mammoth = require('mammoth');
const TurndownService = require('turndown');
const { gfm } = require('turndown-plugin-gfm');

const SUPPORTED_EXTENSIONS = new Set(['.docx', '.docm', '.dotx', '.dotm']);
const CONTENT_TYPE_TO_EXTENSION = {
  'image/bmp': '.bmp',
  'image/gif': '.gif',
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/svg+xml': '.svg',
  'image/tiff': '.tif',
  'image/webp': '.webp',
};

function printHelp() {
  console.log(`Usage:
  npm run word:md -- <input.docx> [output.md] [--images-dir <dir>]

Examples:
  npm run word:md -- ./docs/source.docx
  npm run word:md -- ./docs/source.docx ./out/source.md
  npm run word:md -- ./docs/source.docx ./out/source.md --images-dir ./out/source-assets

Notes:
  - OOXML Word files (.docx, .docm, .dotx, .dotm) are supported.
  - Legacy .doc files must be resaved as .docx before conversion.
  - Images are extracted as separate files and linked from Markdown.`);
}

function parseArgs(argv) {
  const args = [...argv];
  const options = {
    help: false,
    inputPath: null,
    outputPath: null,
    imagesDirPath: null,
  };

  while (args.length > 0) {
    const arg = args.shift();

    if (arg === '--help' || arg === '-h') {
      options.help = true;
      continue;
    }

    if (arg === '--images-dir') {
      if (args.length === 0) {
        throw new Error('--images-dir requires a directory path');
      }

      options.imagesDirPath = args.shift();
      continue;
    }

    if (arg.startsWith('--')) {
      throw new Error(`Unknown option: ${arg}`);
    }

    if (!options.inputPath) {
      options.inputPath = arg;
      continue;
    }

    if (!options.outputPath) {
      options.outputPath = arg;
      continue;
    }

    throw new Error(`Unexpected argument: ${arg}`);
  }

  return options;
}

function normalizePathForMarkdown(filePath) {
  return encodeURI(filePath.split(path.sep).join('/'));
}

function escapeMarkdownAltText(text) {
  return String(text || '')
    .replace(/\\/g, '\\\\')
    .replace(/\[/g, '\\[')
    .replace(/\]/g, '\\]');
}

function escapeMarkdownTableCell(text) {
  return String(text || '')
    .replace(/\|/g, '\\|')
    .trim();
}

function flattenMarkdownForTableCell(markdown) {
  return escapeMarkdownTableCell(
    String(markdown || '')
      .replace(/\r/g, '')
      .replace(/\n{2,}/g, '<br><br>')
      .replace(/\n/g, '<br>')
      .replace(/\s+/g, ' ')
      .trim(),
  );
}

function getMarkdownTableRows(tableNode, turndownService) {
  const tableRows = Array.from(tableNode.rows || []);

  return tableRows.map((row) => {
    const rowCells = [];

    for (const cell of Array.from(row.cells || [])) {
      const content = flattenMarkdownForTableCell(turndownService.turndown(cell.innerHTML || ''));
      const colspan = Math.max(Number.parseInt(cell.getAttribute('colspan') || '1', 10) || 1, 1);

      rowCells.push(content);

      for (let index = 1; index < colspan; index += 1) {
        rowCells.push('');
      }
    }

    return {
      isHeader: Array.from(row.cells || []).some((cell) => cell.nodeName === 'TH'),
      cells: rowCells,
    };
  });
}

function renderMarkdownTable(tableNode, turndownService) {
  const rows = getMarkdownTableRows(tableNode, turndownService).filter((row) => row.cells.length > 0);

  if (rows.length === 0) {
    return '';
  }

  const columnCount = Math.max(...rows.map((row) => row.cells.length));
  const normalizedRows = rows.map((row) => ({
    isHeader: row.isHeader,
    cells: [...row.cells, ...new Array(Math.max(columnCount - row.cells.length, 0)).fill('')],
  }));
  const headerRowIndex = normalizedRows.findIndex((row) => row.isHeader);
  const effectiveHeaderRowIndex = headerRowIndex >= 0 ? headerRowIndex : 0;
  const headerRow = normalizedRows[effectiveHeaderRowIndex].cells;
  const bodyRows = normalizedRows.filter((row, index) => index !== effectiveHeaderRowIndex);
  const lines = [
    `| ${headerRow.join(' | ')} |`,
    `| ${new Array(columnCount).fill('---').join(' | ')} |`,
  ];

  for (const row of bodyRows) {
    lines.push(`| ${row.cells.join(' | ')} |`);
  }

  if (bodyRows.length === 0) {
    lines.push(`| ${new Array(columnCount).fill('').join(' | ')} |`);
  }

  return lines.join('\n');
}

function createTurndownService() {
  const service = new TurndownService({
    bulletListMarker: '-',
    codeBlockStyle: 'fenced',
    headingStyle: 'atx',
  });

  service.use(gfm);

  service.addRule('tables', {
    filter(node) {
      return node.nodeName === 'TABLE';
    },
    replacement(content, node) {
      const tableMarkdown = renderMarkdownTable(node, service);

      return tableMarkdown ? `\n\n${tableMarkdown}\n\n` : '\n\n';
    },
  });

  service.addRule('images', {
    filter(node) {
      return node.nodeName === 'IMG';
    },
    replacement(content, node) {
      const alt = escapeMarkdownAltText(node.getAttribute('alt') || 'image');
      const src = node.getAttribute('src');

      if (!src) {
        return '';
      }

      return `![${alt}](${src})`;
    },
  });

  return service;
}

function ensureSupportedInput(inputPath) {
  const extension = path.extname(inputPath).toLowerCase();

  if (!SUPPORTED_EXTENSIONS.has(extension)) {
    if (extension === '.doc') {
      throw new Error('Legacy .doc files are not supported directly. Save the file as .docx and run the converter again.');
    }

    throw new Error(`Unsupported file type: ${extension || '(none)'}`);
  }
}

function getDefaultOutputPath(inputPath) {
  const parsed = path.parse(inputPath);
  return path.join(parsed.dir, `${parsed.name}.md`);
}

function getDefaultImagesDirPath(outputPath) {
  const parsed = path.parse(outputPath);
  return path.join(parsed.dir, `${parsed.name}-assets`);
}

function getImageExtension(contentType) {
  return CONTENT_TYPE_TO_EXTENSION[contentType] || '.bin';
}

function formatMessage(message) {
  const type = message.type || 'info';
  const text = message.message || String(message);
  return `[${type}] ${text}`;
}

async function convertDocxToMarkdown(inputPath, outputPath, imagesDirPath) {
  ensureSupportedInput(inputPath);

  const resolvedInputPath = path.resolve(inputPath);
  const resolvedOutputPath = path.resolve(outputPath || getDefaultOutputPath(resolvedInputPath));
  const resolvedImagesDirPath = path.resolve(
    imagesDirPath || getDefaultImagesDirPath(resolvedOutputPath),
  );
  const markdownDir = path.dirname(resolvedOutputPath);
  let imageIndex = 0;
  let createdImagesDir = false;

  await fs.promises.mkdir(markdownDir, { recursive: true });

  const result = await mammoth.convertToHtml(
    { path: resolvedInputPath },
    {
      convertImage: mammoth.images.imgElement(async (image) => {
        imageIndex += 1;

        if (!createdImagesDir) {
          await fs.promises.mkdir(resolvedImagesDirPath, { recursive: true });
          createdImagesDir = true;
        }

        const extension = getImageExtension(image.contentType);
        const fileName = `image-${String(imageIndex).padStart(3, '0')}${extension}`;
        const absoluteImagePath = path.join(resolvedImagesDirPath, fileName);
        const imageBuffer = Buffer.from(await image.read('base64'), 'base64');

        await fs.promises.writeFile(absoluteImagePath, imageBuffer);

        return {
          src: normalizePathForMarkdown(path.relative(markdownDir, absoluteImagePath) || fileName),
        };
      }),
    },
  );

  const turndownService = createTurndownService();
  const markdown = `${turndownService.turndown(result.value).trim()}\n`;

  await fs.promises.writeFile(resolvedOutputPath, markdown, 'utf8');

  return {
    outputPath: resolvedOutputPath,
    imagesDirPath: createdImagesDir ? resolvedImagesDirPath : null,
    imageCount: imageIndex,
    messages: result.messages || [],
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));

  if (options.help || !options.inputPath) {
    printHelp();
    return;
  }

  const result = await convertDocxToMarkdown(
    options.inputPath,
    options.outputPath,
    options.imagesDirPath,
  );

  console.log(`markdown=${result.outputPath}`);

  if (result.imagesDirPath) {
    console.log(`images=${result.imagesDirPath}`);
  }

  console.log(`imageCount=${result.imageCount}`);

  for (const message of result.messages) {
    console.warn(formatMessage(message));
  }
}

module.exports = {
  convertDocxToMarkdown,
  parseArgs,
};

if (require.main === module) {
  main().catch((error) => {
    console.error(error && error.stack ? error.stack : String(error));
    process.exit(1);
  });
}