# Converter Studio File Converter

Convert files in your GitHub Actions workflows with [Converter Studio](https://converter.studio):
pictures to WebP or AVIF for a website, Word, Excel and PowerPoint files to PDF, scanned PDFs to
text with OCR, videos to MP4, audio to MP3, e-books, subtitles, data files and archives, 67 formats
in all.

Nothing has to be installed on the runner: no ImageMagick, libheif, FFmpeg, LibreOffice or
Tesseract. The action sends each file to the Converter Studio API, waits for the result and writes
it into your workspace, next to its source or into a folder you choose.

- **Paths and glob patterns**, one a line, with `!` to leave files out.
- **Several files at once** (`concurrency`), with uploads in parts for large files.
- **Results that exist already are kept** by default, and their sources are not converted again, so
  a workflow that runs on every push only spends credits on new files.
- **Outputs** list what was written (and a JSON map from each source to its result) for the steps
  that follow: commit the files, attach them to a release, upload them as an artifact.
- Clear errors: Converter Studio's own message for each file that could not be converted, shown as
  an annotation on that file.

## Quick start

1. Create a free account on [converter.studio](https://converter.studio) and an API key on your
   [account page](https://converter.studio/account#api-keys). Keys start with `cvs_live_`.
2. In your repository, open **Settings > Secrets and variables > Actions** and add a repository
   secret named `CONVERTER_STUDIO_API_KEY` with the key as its value.
3. Add a step to a workflow:

```yaml
- uses: actions/checkout@v6

- name: Convert PNG pictures to WebP
  uses: tariksucu/converter-studio-action@v1
  with:
    api-key: ${{ secrets.CONVERTER_STUDIO_API_KEY }}
    files: images/**/*.png
    to: webp
```

Each `images/…/name.png` gets an `images/…/name.webp` next to it.

## Recipes

### HEIC, PNG and JPG to WebP or AVIF for your site

Converts the pictures in `assets/photos` into `public/img` whenever pictures change on `main`, and
commits the new files. Pictures converted on an earlier run are skipped, so only new ones cost
credits. Commits made with the workflow's `GITHUB_TOKEN` do not start another workflow run.

```yaml
name: Web pictures

on:
  push:
    branches: [main]
    paths: ['assets/photos/**']

permissions:
  contents: write

jobs:
  pictures:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v6

      - name: Convert to WebP
        id: convert
        uses: tariksucu/converter-studio-action@v1
        with:
          api-key: ${{ secrets.CONVERTER_STUDIO_API_KEY }}
          files: |
            assets/photos/**/*.heic
            assets/photos/**/*.HEIC
            assets/photos/**/*.png
            assets/photos/**/*.jpg
          to: webp
          options: '{"quality": "balanced", "longSide": "1920"}'
          output-dir: public/img

      - name: Commit the new pictures
        env:
          FILES: ${{ steps.convert.outputs.files }}
        run: |
          [ -n "$FILES" ] || exit 0
          git config user.name 'github-actions[bot]'
          git config user.email '41898282+github-actions[bot]@users.noreply.github.com'
          printf '%s\n' "$FILES" | xargs -d '\n' git add --
          git commit -m 'Add WebP versions of new pictures'
          git push
```

For AVIF, set `to: avif`. `{"maxKb": 200}` keeps every picture under 200 kB instead, and
`{"lossless": true}` suits logos and screenshots. Photos lose their EXIF details (camera, date and
location) for privacy; `{"keepMetadata": true}` keeps the camera and date, and adding
`"keepLocation": true` keeps the location too.

### Word documents to PDF on every release

Converts the `.docx` files in `docs/` to PDF and attaches the PDFs to the release that started the
workflow.

```yaml
name: Release PDFs

on:
  release:
    types: [published]

permissions:
  contents: write

jobs:
  pdf:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v6

      - name: Convert DOCX to PDF
        id: pdf
        uses: tariksucu/converter-studio-action@v1
        with:
          api-key: ${{ secrets.CONVERTER_STUDIO_API_KEY }}
          files: docs/**/*.docx
          to: pdf
          output-dir: ${{ runner.temp }}/pdf

      - name: Attach the PDFs to the release
        env:
          GH_TOKEN: ${{ github.token }}
          TAG: ${{ github.event.release.tag_name }}
          FILES: ${{ steps.pdf.outputs.files }}
        run: |
          [ -n "$FILES" ] || exit 0
          printf '%s\n' "$FILES" | xargs -d '\n' gh release upload "$TAG" --clobber
```

The same works for `.xlsx`, `.pptx`, `.odt`, `.rtf`, `.md` and `.html` files. `{"pdfA": true}`
makes PDF/A files for archiving.

### OCR: scanned PDFs to text or Word

Reads the text of scanned PDFs (pictures of pages, without a text layer) and uploads the text files
as a workflow artifact.

```yaml
- name: Recognize the text of the scans
  uses: tariksucu/converter-studio-action@v1
  with:
    api-key: ${{ secrets.CONVERTER_STUDIO_API_KEY }}
    files: scans/*.pdf
    to: txt
    options: '{"ocr": true, "ocrLanguage": "auto"}'
    output-dir: ocr

- uses: actions/upload-artifact@v7
  with:
    name: ocr-text
    path: ocr/
```

Use `to: docx` for an editable Word document instead. `ocrLanguage` can also name the language
(`en`, `de`, `fr`, `es`, `tr`, `ja`…), and `{"pageRange": "1-3"}` reads only those pages. Pictures
(`.png`, `.jpg`, `.tiff`) work the same way.

### More

- **A smaller PDF:** `to: pdf` with `options: '{"compression": "balanced"}'`. Next to its source the
  result is named `name-compressed.pdf`.
- **Videos for the web:** `to: mp4` with `options: '{"height": "720", "maxSize": 25}'`, or
  `to: webm`. Videos are priced by their length, so raise `max-credits` for long ones.
- **Audio:** `to: mp3` with `options: '{"bitrate": "192", "normalize": true}'`.
- **Every option and format** is listed on [converter.studio/developers](https://converter.studio/developers).

## Inputs

| Input         | Required | Default                        | Description                                                                                                                                                                          |
| ------------- | -------- | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `api-key`     | yes      |                                | Your Converter Studio API key. Pass it from a secret: `${{ secrets.CONVERTER_STUDIO_API_KEY }}`.                                                                                     |
| `files`       | yes      |                                | Paths and glob patterns relative to the workspace, one a line. `**` matches any folders, a line that starts with `!` leaves files out, a folder means every file in it.              |
| `to`          | yes      |                                | The format to convert to: a format such as `webp`, `avif`, `jpg`, `png`, `pdf`, `docx`, `txt`, `mp4`, `mp3`, or an extension such as `jpeg`.                                         |
| `options`     | no       |                                | Conversion options as a JSON object, as the API takes them, for example `{"quality": "small"}`. Options that do not apply to a conversion are left out.                              |
| `output-dir`  | no       | next to each source            | Where to write the results. They keep their folders below the patterns' common folder: `docs/**/*.docx` with `output-dir: pdf` turns `docs/a/b.docx` into `pdf/a/b.pdf`.             |
| `if-exists`   | no       | `skip`                         | When a result's file already exists: `skip` keeps it and does not convert that file (no credits spent), `overwrite` replaces it, `fail` stops the step before anything is converted. |
| `concurrency` | no       | `4`                            | How many files to convert at once, from 1 to 10.                                                                                                                                     |
| `max-credits` | no       | `20`                           | The most credits one file may cost. A file that would cost more is not converted and nothing is charged for it.                                                                      |
| `base-url`    | no       | `https://converter.studio/api` | The address of the Converter Studio API.                                                                                                                                             |

## Outputs

| Output    | Description                                                                                                              |
| --------- | ------------------------------------------------------------------------------------------------------------------------ |
| `files`   | The files that were written, one path a line, relative to the workspace (absolute when outside it).                      |
| `map`     | A JSON object from each converted source to its result: `{"images/a.png": "images/a.webp"}`. Read it with `fromJSON(…)`. |
| `skipped` | A JSON array of the sources that were not converted because their result already existed.                                |
| `failed`  | A JSON array of the sources that could not be converted.                                                                 |

Outputs are set even when the step fails, for steps that run with `if: always()`. Pass them to a
shell through `env:`, as in the recipes, rather than writing `${{ … }}` into a script: file names
can hold characters a shell would read as code.

## How results are named

- `photo.png` with `to: webp` becomes `photo.webp`, `report.final.docx` with `to: pdf` becomes
  `report.final.pdf`.
- A result in the same format as its source (a smaller PDF) is named `name-compressed.pdf` when it
  would otherwise replace the source.
- A PDF with several pages turned into pictures (`to: png`, `jpg`, `webp`, `tiff`) comes back as a
  ZIP of the pages, `name.zip`.
- A result never replaces one of the files being converted, and two sources never share a result
  (`photo.png` and `photo.jpg` with `to: webp`): such files are reported and left out.
- Each result is written to a temporary file first and renamed into place once complete, so a
  failed download never leaves half a file.

## Limits and costs

- Conversions use your account's credits. Free accounts get 25 credits a day; most pictures and
  documents cost 1 credit, audio and video are priced by their length (video also by its frame
  size). A file that fails to convert costs nothing. Plans with more credits, larger files and
  longer media are on the [pricing page](https://converter.studio/pricing).
- The largest file and the longest video or audio depend on your plan. Files larger than 95 MiB go
  up in parts.
- Converter Studio takes up to 60 new files a minute for each API key. The action waits when it is
  asked to slow down.
- `files` patterns are case-sensitive on Linux and macOS runners (`*.heic` does not match
  `IMG_1.HEIC`), and braces such as `*.{png,jpg}` are not expanded: write one line for each.
- The action needs a runner that can reach `converter.studio` over HTTPS. It is a JavaScript action
  for Node 24 (no container), so it does not need Docker on the runner. The shell lines in the
  recipes are for Linux runners.
- Use the step's `timeout-minutes` to cap how long a step may wait for long conversions.

## Privacy and security

- **Your files are sent to Converter Studio's servers** to be converted. An upload is deleted as
  soon as its conversion ends; the result is kept for 6 hours (the action downloads it at once),
  then deleted. See the [privacy policy](https://converter.studio/privacy).
- The API key goes only to the Converter Studio API, over HTTPS. The action masks it in the log and
  never prints it, nor the upload and download links (they carry their own short-lived tokens).
  Workflow logs of public repositories are public: the action logs file names, sizes and credits
  only.
- Workflows started by pull requests from forks get no secrets, so the step fails with a message
  that the key is empty. Do not pass the key to workflows that run code from untrusted pull
  requests.
- To pin exactly what runs, use a full commit SHA instead of `@v1`:
  `uses: tariksucu/converter-studio-action@<commit-sha> # v1.0.0`.

## Support

Questions and bugs: [open an issue](https://github.com/tariksucu/converter-studio-action/issues) or
write to support@converter.studio. The API is described at
[converter.studio/developers](https://converter.studio/developers).

## Development

```sh
npm ci
npm run lint        # TypeScript, ESLint, Prettier
npm test            # unit tests, and dist/index.js run like a runner runs it, against a stand-in API
npm run build       # writes dist/ (commit it: the runner runs dist/index.js as it is)
npm run check-dist  # fails if dist/ is not what the sources build to
```

## License

[MIT](LICENSE), © Converter Studio.
