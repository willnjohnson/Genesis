import { format } from 'date-fns';

// How a video card writes its dates and view counts: the Library grid's cards (components/VideoList.tsx) and the hover
// preview of a video's name (components/VideoPreview.tsx) share these, so the two read alike.

export function formatDate(dateStr: string | undefined) {
    if (!dateStr) return 'Unknown';
    const d = new Date(dateStr);
    if (isNaN(d.getTime())) {
        return dateStr;
    }
    return format(d, 'MMM dd, yyyy');
}

export function parseViewCount(count: string): number {
    if (!count || count === "Saved") return 0;
    const clean = count.toLowerCase().replace(/,/g, '').trim();
    let multiplier = 1;
    if (clean.includes('k')) multiplier = 1000;
    else if (clean.includes('m')) multiplier = 1000000;
    else if (clean.includes('b')) multiplier = 1000000000;
    const num = parseFloat(clean.replace(/[^0-9.]/g, ''));
    if (isNaN(num)) return 0;
    return Math.floor(num * multiplier);
}

export function formatViewCount(count: string): string {
    if (count === "Saved") return 'Saved';
    if (!count) return '0';
    if (count.toLowerCase().includes('view')) {
        return count.split(' ')[0];
    }
    const n = parseViewCount(count);
    if (n >= 1000000000) return (n / 1000000000).toFixed(1) + 'B';
    if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
    if (n >= 1000) return (n / 1000).toFixed(1) + 'K';
    return n.toLocaleString();
}
