# Bindery

**A stack of page images in, a finished PDF out.**

Bindery turns folders of book pages into PDFs directly in your browser. Choose one
book or a library of books, set the cover and page options, and let it work through
the queue. PDFs stay beside the original images unless you choose another output folder.

The images stay on your computer. Bindery has no server, account, upload, or
database. The browser reads and writes the folder you choose.

## Use it

Open [bindery.houdaifa.dev](https://bindery.houdaifa.dev) in Chrome or Edge, then
select a folder containing JPG or PNG pages. Each folder with page images is
treated as a book. Nested folders work too.

You can choose how many square cover pages come first, move covers from the end
of the image list, add page numbers, compress images, or make interior text
searchable with local OCR. Bindery remembers finished books with a `.done` file
and lets you redo one book or the whole library. ZIP and TAR archives can be
extracted before building PDFs.

The output choice appears after you select a library. Choosing another folder
creates the same book-folder structure there, under a folder named after the
selected library. Preview PDFs are optional. Each preview uses random interior
pages from the finished PDF, skipping the configured cover pages. The automatic
count is about 10% of interior pages, with a minimum of three; you can choose
your own count instead. Previews are named `Book - Preview.pdf` beside their full PDFs.

Firefox and Safari cannot grant the folder access this app needs. Use a recent
Chromium browser.

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
| `index.html`, `css/` | Page and styling |
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

`npm test` checks page ordering, archive extraction, output paths, and previews. For the browser checks,
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
