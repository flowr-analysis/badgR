const Hex = 'M32 2 L62 19.5 L62 54.5 L32 72 L2 54.5 L2 19.5 Z';

/**
 * The badger: a hexagon, the shape of an R package sticker, that is itself the face. White fur, two black
 * stripes from the upper corners down to the snout, the eyes inside them, and the nose at the lower corner.
 * Drawn on a 64 x 74 grid and scaled to `height`, with ids of its own so several can share a page.
 */
export function badgerMark(x: number, y: number, height: number, id = 'badgr', outline = 3.5, fur = '#f4f1ea'): string {
	const s = height / 74;
	return `<g transform="translate(${x} ${y}) scale(${s})">
    <clipPath id="${id}-hex"><path d="${Hex}"/></clipPath>
    <g clip-path="url(#${id}-hex)">
      <rect width="64" height="74" fill="${fur}"/>
      <path d="M5 13 L23 3 L32 60 L28 62 Z" fill="#1d1c1a"/>
      <path d="M59 13 L41 3 L32 60 L36 62 Z" fill="#1d1c1a"/>
      <path d="M25 58.5 Q32 55 39 58.5 L35 66.5 Q32 69 29 66.5 Z" fill="#1d1c1a"/>
    </g>
    <circle cx="19" cy="29" r="2.8" fill="${fur}"/><circle cx="45" cy="29" r="2.8" fill="${fur}"/>
    <path d="${Hex}" fill="none" stroke="#1d1c1a" stroke-width="${outline}" stroke-linejoin="round"/>
  </g>`;
}

/** the logo; `named` adds the name below, as on a package sticker */
export function logoSvg(size = 128, named = true): string {
	const h = Math.round(size * (named ? 92 : 74) / 64);
	return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${h}" viewBox="0 0 64 ${named ? 92 : 74}" role="img" aria-label="badgR">
  <title>badgR</title>
  ${badgerMark(0, 0, 74, 'badgr-logo')}
  ${named ? '<text x="32" y="88" text-anchor="middle" font-family="ui-monospace,Menlo,Consolas,monospace" font-size="12" font-weight="700" fill="#1d1c1a">badgR</text>' : ''}
</svg>
`;
}

function escapeXml(s: string): string {
	return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&apos;' }[c] as string));
}

/** an estimate of the text width in Verdana 11px, as shields.io badges use */
function textWidth(s: string): number {
	let w = 0;
	for(const c of s) {
		w += /[il.,:;|!'1*]/.test(c) ? 3.5 : /[mwMW]/.test(c) ? 10 : /[A-Z]/.test(c) ? 8 : 6.6;
	}
	return Math.ceil(w);
}

/** what a badge says besides the tier */
export interface BadgeMarks {
	/** the left text, `badgR` by default */
	readonly label?:    string
	/** checked against another policy than badgR's default: the tier gets a `*` */
	readonly custom?:   boolean
	/** every finding was reviewed and none is left to fix: the tier gets a check mark */
	readonly reviewed?: boolean
}

/** what the marks of a badge mean, for its title and for screen readers */
export function badgeTitle(tier: string, marks: BadgeMarks = {}): string {
	return [`${marks.label ?? 'badgR'}: ${tier}`, marks.custom ? 'custom policy' : undefined, marks.reviewed ? 'all findings reviewed' : undefined].filter(Boolean).join(', ');
}

/**
 * A shields.io style badge: the badger and `badgR` on the left, the tier in its color on the right; a
 * custom policy adds `*` to the tier, a complete review a check mark.
 */
export function badgeSvg(tier: string, color: string, marks: BadgeMarks = {}): string {
	const label = marks.label ?? 'badgR';
	const shown = `${tier}${marks.custom ? '*' : ''}`;
	const icon = 15;
	const check = marks.reviewed ? 12 : 0;
	const lw = 5 + icon + 4 + textWidth(label) + 6;
	const rw = 8 + textWidth(shown) + check + 8;
	const w = lw + rw;
	const t = escapeXml(shown);
	const l = escapeXml(label);
	const title = escapeXml(badgeTitle(tier, marks));
	/* ids of their own, so several badges can share one page */
	const id = `badgr-${tier.replace(/[^\w-]/g, '')}${marks.custom ? '-c' : ''}${marks.reviewed ? '-r' : ''}`;
	const tx = lw + 8 + textWidth(shown) / 2;
	/* the check mark is drawn, not a glyph, so it looks the same in every font */
	const mark = marks.reviewed
		? `\n  <path d="M${lw + 8 + textWidth(shown) + 3} 10.5 l2.6 2.8 l5 -6" fill="none" stroke="#010101" stroke-opacity=".3" stroke-width="2" transform="translate(0 1)"/>\n  <path d="M${lw + 8 + textWidth(shown) + 3} 10.5 l2.6 2.8 l5 -6" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`
		: '';
	return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="20" role="img" aria-label="${title}">
  <title>${title}</title>
  <linearGradient id="${id}-s" x2="0" y2="100%"><stop offset="0" stop-color="#bbb" stop-opacity=".1"/><stop offset="1" stop-opacity=".1"/></linearGradient>
  <clipPath id="${id}-r"><rect width="${w}" height="20" rx="3" fill="#fff"/></clipPath>
  <g clip-path="url(#${id}-r)">
    <rect width="${lw}" height="20" fill="#555"/>
    <rect x="${lw}" width="${rw}" height="20" fill="${escapeXml(color)}"/>
    <rect width="${w}" height="20" fill="url(#${id}-s)"/>
  </g>
  ${badgerMark(5, 1.5, 17, `${id}-mark`, 4, escapeXml(color))}
  <g fill="#fff" text-anchor="middle" font-family="Verdana,Geneva,DejaVu Sans,sans-serif" font-size="11">
    <text x="${5 + icon + 4 + textWidth(label) / 2}" y="15" fill="#010101" fill-opacity=".3" textLength="${textWidth(label)}">${l}</text>
    <text x="${5 + icon + 4 + textWidth(label) / 2}" y="14" textLength="${textWidth(label)}">${l}</text>
    <text x="${tx}" y="15" fill="#010101" fill-opacity=".3" textLength="${textWidth(shown)}">${t}</text>
    <text x="${tx}" y="14" textLength="${textWidth(shown)}">${t}</text>
  </g>${mark}
</svg>
`;
}
