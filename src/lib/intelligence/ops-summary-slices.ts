type FinaleActivity = Record<string, any>;

function getDateKey(value: unknown): string | null {
    if (typeof value !== 'string' || value.trim().length === 0) return null;
    const trimmed = value.trim();
    const match = trimmed.match(/^(\d{4}-\d{2}-\d{2})/);
    if (match) return match[1];

    const parsed = new Date(trimmed);
    if (Number.isNaN(parsed.getTime())) return null;

    const year = parsed.getUTCFullYear();
    const month = String(parsed.getUTCMonth() + 1).padStart(2, '0');
    const day = String(parsed.getUTCDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

export function filterFinaleActivityByDate<T extends FinaleActivity>(
    rows: T[],
    field: 'receiveDate' | 'orderDate',
    targetIsoDate: string,
): T[] {
    return rows.filter(row => getDateKey(row[field]) === targetIsoDate);
}

export function buildDailyFinaleSlices(params: {
    finaleReceivingsWtd: FinaleActivity[];
    finaleCommittedWtd: FinaleActivity[];
    yesterdayIsoDate: string;
}) {
    const {
        finaleReceivingsWtd,
        finaleCommittedWtd,
        yesterdayIsoDate,
    } = params;

    return {
        finale_receivings_wtd: finaleReceivingsWtd,
        finale_receivings_yesterday: filterFinaleActivityByDate(
            finaleReceivingsWtd,
            'receiveDate',
            yesterdayIsoDate,
        ),
        finale_committed_wtd: finaleCommittedWtd,
        finale_committed_yesterday: filterFinaleActivityByDate(
            finaleCommittedWtd,
            'orderDate',
            yesterdayIsoDate,
        ),
    };
}
