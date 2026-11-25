# Bindery

**A stack of page images in, a finished PDF out.**

Bindery turns folders of book pages into PDFs and combines existing PDFs directly in your browser. Choose one
book or a library of books, set the cover and page options, and let it work through
the queue. PDFs stay beside the original images unless you choose another output folder.

The images stay on your computer. Bindery has no server, account, upload, or
database. The browser reads and writes the folder you choose.

## Use it

Choose **Merge PDFs**, then **Choose folder** to select a library in Chrome or Edge.
Each folder with at least two source PDFs becomes one result. Recognizable cover
and thumbnail names come first by default, followed by the worksheets in natural
filename order. If your cover and thumbnails are the last files, turn on **Covers
at end** and set **Cover count** to their total. Bindery moves the last PDFs to the
front in their existing order, just as it does for images.
Choose **Merge all pending** or merge an individual folder. Bindery saves
`Folder name - Merged.pdf` beside the source files. Rebuilding gets a new filename,
so existing copies with filled answers are protected. All source pages keep their
original order within each PDF, dimensions, and content. Standard PDF form
fields stay editable and retain their current values. Duplicate field names in
different files are made unique so one worksheet's answers do not populate another.
Turn on **Create preview PDFs** to save a separate watermarked sample beside the
full PDF. Automatic mode takes about 10% of the worksheet pages. Both automatic
and manual counts use at least three pages when available. Covers and thumbnails
are excluded. The sampled pages keep their original dimensions, content, and
fillable fields. An existing full PDF can be kept while Bindery adds its preview.
Signed, password-protected, and XFA PDFs require their original document. Bindery
also flags scripts that would lose their original scope in the merged file. The
files stay on your device.

### Build PDFs from images

Open [bindery.houdaifa.dev](https://bindery.houdaifa.dev) in Chrome or Edge, then
select a folder containing JPG or PNG pages. Each folder with page images is
treated as a book. Nested folders work too.

You can choose how many cover and thumbnail pages come first, move covers from the end
of the image list, add page numbers, compress images, or make interior text
searchable with local OCR. Bindery remembers finished books with a `.done` file
and lets you redo one book or the whole library. ZIP and TAR archives can be
extracted before building PDFs.

**Original-size covers** is on by default in **PDF settings**. Each cover and
thumbnail gets its own full-bleed page at one PDF point per source pixel. Cover images
retain their pixel dimensions and bypass JPEG recompression. The interior pages
use US Letter and follow your quality setting. With the switch off, cover images
fit inside 8.5-inch square pages.

The output choice appears after you select a library. Without another output
folder, each PDF stays beside its images. With one, the default puts all PDFs
in that folder; you can instead keep the selected library's folder structure.
The page shows examples using a few of the books it found. Existing PDFs are
protected from name collisions.

Preview PDFs are optional. Each preview uses random interior pages from the
finished PDF, skipping any covers still included. The automatic count is about
10% of interior pages, with a minimum of three when enough pages exist; you can
choose your own count instead. Every preview page carries three large, aligned
`PREVIEW` watermarks. Previews sit beside their full PDFs in either layout.

PDF settings also include an optional **Skip first pages** control, off by
default and set to four pages when enabled. It turns off cover handling and
removes the first images in folder order without changing the source files.
Turning it off restores the previous cover settings. If too few pages remain
for a book, Bindery reports that book as an error instead of making an empty PDF.

**Add answer keys?** appears after you select a library, and is off by default.
**Add automatically** adds every PDF found with each book to the end of its full
PDF: PDFs in the book's folder or its subfolders, or beside the book's folder when
that folder holds only this book. A PDF shared by several books is left out and
listed so you can assign it. **Choose for each book** lets you pick the PDF in the
book list, and offers any PDFs it found. Bindery never treats a book's own earlier
output as a key, never changes the key files, and leaves previews without answers.
A folder counts as finished only once Bindery has built it, so images beside a
PDF still show as pending. Added pages keep their own size, numbering, and text. A password-protected or
damaged key fails only that book, by name, and writes nothing for it.

Use Chrome or Edge for folder access.

## Run locally

There is no build step for local development. Serve the folder over localhost:

```sh
python3 -m http.server 8756
```

Then open `http://localhost:8756` in Chrome or Edge. Opening `index.html` as a
file will not give the app the browser permissions it needs.

## Project map

| Path | Purpose |
| --- | --- |
| `index.html`, `merge/`, `css/` | Pages and styling |
| `js/` | Folder scanning, PDF creation, OCR, and UI |
| `vendor/tesseract/` | Pinned OCR runtime and English model |
| `test/` | Browser checks and Node tests |
| `scripts/build.mjs` | Copies deployable files into `dist/` |
| `_headers` | Cloudflare caching rules |

The `dist/` folder is generated and ignored by Git. It contains only the site
files Cloudflare should receive.

## Checks

```sh
npm ci
npm test
npm run build
```

`npm test` checks page ordering, archive extraction, output paths, skipped pages, previews, answer keys, and fillable PDF merges. For the browser checks,
visit `/test/test.html` on your local server. Optional PDF fixtures live in
`test/build-*.mjs`; the OCR and page-numbering fixtures need
`BINDERY_QA_BOOK` set to a local folder of page images. Generated PDFs and test
libraries are kept out of Git.

## Deployment

The GitHub workflow tests and builds the site, then uploads `dist/` to the
existing Cloudflare Pages project named `bindery` when `main` is pushed. It
also supports a manual run from GitHub Actions. The workflow uses these repository secrets:

| Secret | Value |
| --- | --- |
| `CLOUDFLARE_ACCOUNT_ID` | The account ID from the Cloudflare dashboard |
| `CLOUDFLARE_API_TOKEN` | A token with **Account → Cloudflare Pages → Edit** permission |

The workflow deploys to the project's `main` production branch. If the Pages
project uses a different production branch, update it in Cloudflare before
running the workflow. The existing custom domain stays attached to the Pages
project.

The app includes local copies of `pdf-lib`, Lucide, and Tesseract so its core
features do not depend on a CDN.
