// Scannt public/images/ und public/audio/ und schreibt die gefundenen
// Dateinamen als <option>-Vorschläge in die Datalists von index.html.
// Aufruf: node tools/timestamp-tagger/sync-assets.mjs  (oder: npm run tagger:sync)

import { readdirSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(here, "..", "..");
const htmlPath = path.join(here, "index.html");

const IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".gif", ".webp", ".svg"]);
const AUDIO_EXTENSIONS = new Set([".mp3", ".wav", ".ogg", ".m4a", ".flac"]);

function listFiles(dir, allowedExtensions) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isFile() && allowedExtensions.has(path.extname(e.name).toLowerCase()))
    .map((e) => e.name)
    .sort((a, b) => a.localeCompare(b, "de"));
}

function renderOptions(files, indent) {
  return files.map((f) => `${indent}<option value="${f}"></option>`).join("\n");
}

function replaceBetweenMarkers(html, markerName, replacement) {
  const start = `<!-- AUTO-GENERATED:${markerName}:START -->`;
  const end = `<!-- AUTO-GENERATED:${markerName}:END -->`;
  const pattern = new RegExp(`${start}[\\s\\S]*?${end}`);
  if (!pattern.test(html)) {
    throw new Error(`Marker für ${markerName} nicht in index.html gefunden.`);
  }
  return html.replace(pattern, `${start}\n${replacement}\n            ${end}`);
}

async function main() {
  const images = listFiles(path.join(projectRoot, "public", "images"), IMAGE_EXTENSIONS);
  const audioFiles = listFiles(path.join(projectRoot, "public", "audio"), AUDIO_EXTENSIONS);

  let html = await readFile(htmlPath, "utf8");
  html = replaceBetweenMarkers(html, "IMAGES", renderOptions(images, "            "));
  html = replaceBetweenMarkers(html, "AUDIO", renderOptions(audioFiles, "            "));
  await writeFile(htmlPath, html, "utf8");

  console.log(`Aktualisiert: ${images.length} Bilder, ${audioFiles.length} Audiodateien gefunden`);
  console.log("→ index.html Vorschlagsliste erneuert");
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
