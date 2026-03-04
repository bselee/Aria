import chokidar, { FSWatcher } from 'chokidar';
import fs from 'fs';
import path from 'path';

// Define a global to hold the chokidar instance so it survives HMR in Next.js
declare global {
    var __folderWatcher: FSWatcher | undefined;
    var __watchedFolders: Set<string> | undefined;
}

const watchers = global.__folderWatcher || chokidar.watch([], {
    ignored: /(^|[\/\\])\../, // ignore dotfiles
    ignoreInitial: true, // ignore files that are already there when we start watching
    persistent: true,
});

const watchedFolders = global.__watchedFolders || new Set<string>();

if (process.env.NODE_ENV !== 'production') {
    global.__folderWatcher = watchers;
    global.__watchedFolders = watchedFolders;
}

// Ensure the watcher only binds ONE set of events across hot reloads
if (!watchers.listenerCount('add')) {
    watchers.on('add', async (filePath: string) => {
        console.log(`[FolderWatcher] New file detected: ${filePath}`);

        try {
            // Read the file buffer
            const buffer = fs.readFileSync(filePath);
            const filename = path.basename(filePath);

            // Determine Mime Type simply based on extension
            const ext = path.extname(filename).toLowerCase();
            let mimeType = 'application/octet-stream';
            if (ext === '.pdf') mimeType = 'application/pdf';
            if (ext === '.png') mimeType = 'image/png';
            if (ext === '.jpg' || ext === '.jpeg') mimeType = 'image/jpeg';
            if (ext === '.csv') mimeType = 'text/csv';
            if (ext === '.xlsx') mimeType = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

            const base64 = buffer.toString('base64');

            // Local call to our own upload endpoint
            // (Note: in Next.js Server Actions or internal calls we can't reliably do an external `fetch` 
            // to our own localhost port in some environments without knowing the exact URL. 
            // BUT we can use an internal function if we refactor upload logic, OR 
            // we can just default to the current host / port. Since we are running in dev, it's typically localhost:3000)
            const port = process.env.PORT || 3000;
            const res = await fetch(`http://localhost:${port}/api/dashboard/upload`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ filename, mimeType, base64 })
            });

            if (!res.ok) {
                console.error(`[FolderWatcher] Upload failed for ${filename}:`, await res.text());
            } else {
                console.log(`[FolderWatcher] Successfully processed and uploaded ${filename}`);
            }

        } catch (err: any) {
            console.error(`[FolderWatcher] Error processing file ${filePath}:`, err.message);
        }
    });

    watchers.on('error', (error: any) => console.log(`[FolderWatcher] Watcher error: ${error}`));
}

export function addWatchedFolder(folderPath: string) {
    if (!fs.existsSync(folderPath) || !fs.statSync(folderPath).isDirectory()) {
        throw new Error(`Invalid local directory path: ${folderPath}`);
    }

    // Normalize path to prevent duplicates
    const normalized = path.resolve(folderPath);

    if (!watchedFolders.has(normalized)) {
        watchers.add(normalized);
        watchedFolders.add(normalized);
        console.log(`[FolderWatcher] Now watching folder: ${normalized}`);
    }

    return Array.from(watchedFolders);
}

export function removeWatchedFolder(folderPath: string) {
    const normalized = path.resolve(folderPath);
    if (watchedFolders.has(normalized)) {
        watchers.unwatch(normalized);
        watchedFolders.delete(normalized);
        console.log(`[FolderWatcher] Stopped watching folder: ${normalized}`);
    }

    return Array.from(watchedFolders);
}

export function getWatchedFolders() {
    return Array.from(watchedFolders);
}
