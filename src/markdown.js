/**
 * Minimal, safe Markdown → HTML for agent answers: everything is escaped
 * first, then a small subset is re-enabled (paragraphs, lists, headings,
 * bold, italic, inline code, http(s) links).
 */

export function escapeHtml(value) {
	return String(value ?? '')
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#39;');
}

function inline(text) {
	return escapeHtml(text)
		.replace(/`([^`]+)`/g, '<code>$1</code>')
		.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
		.replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>')
		.replace(
			/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
			'<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>'
		);
}

const BULLET = /^\s*(?:[-*+•·]|•)\s+(.*)$/;
const ORDERED = /^\s*\d+[.)]\s+(.*)$/;
const HEADING = /^\s*(#{1,6})\s+(.*)$/;

const ALLOWED_TAGS = new Set([
	'A',
	'B',
	'BLOCKQUOTE',
	'BR',
	'CODE',
	'EM',
	'H3',
	'H4',
	'H5',
	'H6',
	'I',
	'LI',
	'OL',
	'P',
	'STRONG',
	'U',
	'UL',
]);

const HTML_HINT = /<\/?(p|ul|ol|li|strong|em|b|i|u|h[1-6]|br|a|blockquote|code)\b[^>]*>/i;

/**
 * Whitelist sanitizer for agents that answer in HTML: unknown elements are
 * unwrapped (scripts, styles and iframes dropped), every attribute except an
 * http(s) href is removed, h1/h2 are demoted to h3.
 */
function sanitizeHtml(html) {
	const doc = new DOMParser().parseFromString(
		`<body>${html}</body>`,
		'text/html'
	);

	const clean = (node) => {
		for (const child of [...node.childNodes]) {
			if (child.nodeType === Node.TEXT_NODE) {
				continue;
			}

			if (child.nodeType !== Node.ELEMENT_NODE) {
				child.remove();

				continue;
			}

			if (/^(SCRIPT|STYLE|IFRAME|OBJECT|EMBED|TEMPLATE|SVG|MATH)$/.test(child.tagName)) {
				child.remove();

				continue;
			}

			clean(child);

			let element = child;

			if (element.tagName === 'H1' || element.tagName === 'H2') {
				const h3 = doc.createElement('h3');

				h3.append(...element.childNodes);
				element.replaceWith(h3);
				element = h3;
			}

			if (!ALLOWED_TAGS.has(element.tagName)) {
				element.replaceWith(...element.childNodes);

				continue;
			}

			for (const attribute of [...element.attributes]) {
				const keep =
					element.tagName === 'A' &&
					attribute.name === 'href' &&
					/^https?:\/\//i.test(attribute.value);

				if (!keep) {
					element.removeAttribute(attribute.name);
				}
			}

			if (element.tagName === 'A') {
				element.setAttribute('target', '_blank');
				element.setAttribute('rel', 'noopener noreferrer');
			}
		}
	};

	clean(doc.body);

	return doc.body.innerHTML;
}

/**
 * Agent answer (Markdown or HTML) → safe HTML.
 */
export function answerToHtml(answer) {
	const text = String(answer ?? '');

	if (HTML_HINT.test(text) && typeof DOMParser !== 'undefined') {
		return sanitizeHtml(text);
	}

	return markdownToHtml(text);
}

export function markdownToHtml(markdown) {
	const lines = String(markdown ?? '')
		.replace(/\r\n?/g, '\n')
		.replace(/^```[a-z]*\n?|```$/gim, '')
		.split('\n');

	const html = [];

	let list = null;
	let paragraph = [];

	const flushParagraph = () => {
		if (paragraph.length) {
			html.push(`<p>${paragraph.map(inline).join('<br>')}</p>`);
			paragraph = [];
		}
	};

	const flushList = () => {
		if (list) {
			html.push(
				`<${list.tag}>${list.items
					.map((item) => `<li>${inline(item)}</li>`)
					.join('')}</${list.tag}>`
			);
			list = null;
		}
	};

	for (const line of lines) {
		let match;

		if (!line.trim()) {
			flushParagraph();
			flushList();
		}
		else if ((match = HEADING.exec(line))) {
			flushParagraph();
			flushList();

			const level = Math.min(6, Math.max(3, match[1].length + 2));

			html.push(`<h${level}>${inline(match[2])}</h${level}>`);
		}
		else if ((match = BULLET.exec(line)) || (match = ORDERED.exec(line))) {
			flushParagraph();

			const tag = ORDERED.test(line) && !BULLET.test(line) ? 'ol' : 'ul';

			if (list && list.tag !== tag) {
				flushList();
			}

			list = list || {items: [], tag};
			list.items.push(match[1]);
		}
		else {
			flushList();
			paragraph.push(line.trim());
		}
	}

	flushParagraph();
	flushList();

	return html.join('');
}
