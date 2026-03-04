import { NextResponse } from 'next/server';
import { addWatchedFolder, removeWatchedFolder, getWatchedFolders } from '@/lib/intelligence/folder-watcher';

export async function GET() {
    try {
        const folders = getWatchedFolders();
        return NextResponse.json({ folders });
    } catch (err: any) {
        return NextResponse.json({ error: err.message }, { status: 500 });
    }
}

export async function POST(req: Request) {
    try {
        const { action, folderPath } = await req.json();

        if (!folderPath) {
            return NextResponse.json({ error: 'folderPath is required' }, { status: 400 });
        }

        let folders;
        if (action === 'add') {
            folders = addWatchedFolder(folderPath);
        } else if (action === 'remove') {
            folders = removeWatchedFolder(folderPath);
        } else {
            return NextResponse.json({ error: 'invalid action. Use add or remove.' }, { status: 400 });
        }

        return NextResponse.json({ folders });
    } catch (err: any) {
        console.error('Watch API err:', err.message);
        return NextResponse.json({ error: err.message }, { status: 500 });
    }
}
