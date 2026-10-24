import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { glob, mkdir, readdir, readFile, rm } from 'node:fs/promises';
import { extname, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import type { Loader, LoaderContext } from 'astro/loaders';
import { slug } from 'github-slugger';

const run = promisify(execFile);
// Relative to dist/src/
const FILTERS = fileURLToPath(new URL('../../filters/', import.meta.url));

export interface GenerateIdOptions {
  entry: string;
  base: URL;
}

export interface DocxLoaderOptions {
  /** Relative to the project root. */
  base: string;
  pattern?: string | string[];
  generateId?: (options: GenerateIdOptions) => string;
  /** Output paragraphs between "```{=html}" and "```" paragraphs as raw HTML. */
  rawHtml?: boolean;
}

interface Converter {
  /** Hash of everything besides the DOCX itself that affects the output */
  digest: string;
  convert: (file: string, outDir: string) => Promise<void>;
}

export function docxLoader({
  base,
  pattern = '**/*.docx',
  generateId = generateIdDefault,
  rawHtml = false,
}: DocxLoaderOptions): Loader {
  return {
    name: 'docx-loader',
    async load(context) {
      const baseUrl = new URL(
        base.endsWith('/') ? base : `${base}/`,
        context.config.root,
      );
      const dir = fileURLToPath(baseUrl);
      if (!existsSync(dir))
        context.logger.warn(`The base directory "${dir}" does not exist.`);

      const converter = await pandoc(rawHtml);
      // Sync one at a time so a page is never converted twice concurrently
      const options = { baseUrl, dir, pattern, generateId, converter };
      let queue = sync(context, options);
      await queue;

      context.watcher?.add(dir);
      const onChange = (path: string) => {
        if (!path.startsWith(dir) || !/\.docx$/i.test(path)) return;
        queue = queue
          .then(() => sync(context, options))
          .catch((error) =>
            context.logger.error(`Failed to reload ${path}: ${error.message}`),
          );
      };
      for (const event of ['add', 'change', 'unlink'])
        context.watcher?.on(event, onChange);
    },
  };
}

// Same as glob()'s default
function generateIdDefault({ entry }: GenerateIdOptions): string {
  return entry
    .slice(0, entry.length - extname(entry).length)
    .split('/')
    .map((segment) => slug(segment))
    .join('/')
    .replace(/\/index$/, '');
}

async function sync(
  { store, logger, config, renderMarkdown, parseData }: LoaderContext,
  {
    baseUrl,
    dir,
    pattern,
    generateId,
    converter,
  }: {
    baseUrl: URL;
    dir: string;
    pattern: string | string[];
    generateId: (options: GenerateIdOptions) => string;
    converter: Converter;
  },
): Promise<void> {
  // Sorted so duplicate IDs resolve the same way on every filesystem
  const entries: string[] = [];
  for await (const entry of glob(pattern, { cwd: dir }))
    entries.push(entry.split(sep).join('/'));
  entries.sort();
  const pages = new Map<string, string>();
  for (const entry of entries) {
    const id = String(generateId({ entry, base: baseUrl }));
    if (pages.has(id))
      throw new Error(
        `${pages.get(id)} and ${entry} have the same page id "${id}".`,
      );
    pages.set(id, entry);
  }

  const cachePath = '.astro/docx-loader/';
  const cacheRoot = new URL(cachePath, config.root);
  const used = new Set<string>();
  for (const [id, entry] of pages) {
    const file = join(dir, entry);
    const digest = createHash('sha256')
      .update(converter.digest)
      .update(await readFile(file))
      .digest('hex')
      .slice(0, 16);
    used.add(digest);
    const cacheUrl = new URL(`${digest}/`, cacheRoot);
    const markdownUrl = new URL('index.md', cacheUrl);
    if (store.get(id)?.digest === digest && existsSync(markdownUrl)) continue;

    // index.md is written last, so its presence means a complete conversion
    if (!existsSync(markdownUrl)) {
      logger.info(`Converting ${entry}`);
      await rm(cacheUrl, { recursive: true, force: true });
      await mkdir(cacheUrl, { recursive: true });
      await converter.convert(file, fileURLToPath(cacheUrl));
    }
    const rendered = await renderMarkdown(await readFile(markdownUrl, 'utf8'), {
      fileURL: markdownUrl,
    });
    // Without a Title-style paragraph, title is left out for the schema to reject
    const title = String(rendered.metadata?.frontmatter?.title ?? '').trim();
    store.set({
      id,
      data: await parseData({
        id,
        data: title ? { title } : {},
        filePath: file,
      }),
      digest,
      filePath: `${cachePath}${digest}/index.md`,
      rendered,
      assetImports: rendered.metadata?.imagePaths,
    });
  }

  for (const id of store.keys()) if (!pages.has(id)) store.delete(id);
  if (existsSync(cacheRoot))
    for (const name of await readdir(cacheRoot))
      if (!used.has(name))
        await rm(new URL(name, cacheRoot), { recursive: true, force: true });
}

// --standalone emits the Title-style paragraph as `title` frontmatter.
// Runs in Docker when PANDOC_IMAGE is set.
async function pandoc(rawHtml: boolean): Promise<Converter> {
  const filters = ['images.lua', ...(rawHtml ? ['raw-html.lua'] : [])];
  const args = (input: string, filterDir: string) => [
    input,
    '--to=gfm',
    '--wrap=none',
    '--standalone',
    '--extract-media=.',
    ...filters.map((filter) => `--lua-filter=${join(filterDir, filter)}`),
    '--output=index.md',
  ];
  const image = process.env.PANDOC_IMAGE;
  const version =
    image ??
    (
      await run('pandoc', ['--version']).catch(() => {
        throw new Error(
          'pandoc was not found. Install it or set PANDOC_IMAGE.',
        );
      })
    ).stdout;
  const hash = createHash('sha256').update(version);
  hash.update(JSON.stringify(args('', '')));
  for (const filter of filters)
    hash.update(await readFile(join(FILTERS, filter)));

  return {
    digest: hash.digest('hex'),
    async convert(file, outDir) {
      if (image) {
        const user = `${process.getuid?.() ?? 0}:${process.getgid?.() ?? 0}`;
        await run('docker', [
          'run',
          '--rm',
          '--user',
          user,
          '--volume',
          `${outDir}:/data`,
          '--workdir',
          '/data',
          '--volume',
          `${file}:/page.docx:ro`,
          '--volume',
          `${FILTERS}:/filters:ro`,
          image,
          ...args('/page.docx', '/filters'),
        ]);
      } else {
        await run('pandoc', args(file, FILTERS), { cwd: outDir });
      }
    },
  };
}
