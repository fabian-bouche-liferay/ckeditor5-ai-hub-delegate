import {Plugin} from '@ckeditor/ckeditor5-core/dist/index.js';
import {
	ButtonView,
	ContextualBalloon,
	View,
} from '@ckeditor/ckeditor5-ui/dist/index.js';
import {Widget, toWidget} from '@ckeditor/ckeditor5-widget/dist/index.js';

import {AGENTS, askAiHub} from './aiHubClient.js';
import {answerToHtml, escapeHtml} from './markdown.js';

const DRAFT_MARKER = 'aihub-draft';
const ELEMENT = 'aiHubRequest';
const TRIGGER = /(^|[\s (])(@aihub)\b([^￼]*)$/i;
const OBJECT_PLACEHOLDER = '￼';

const SPARKLE_SVG =
	'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="1em" height="1em" aria-hidden="true" focusable="false">' +
	'<path fill="currentColor" d="M12 2.5c.4 3.9 1.6 6.6 3.4 8.1 1.5 1.3 3.6 2 6.1 2.4-2.5.4-4.6 1.1-6.1 2.4-1.8 1.5-3 4.2-3.4 8.1-.4-3.9-1.6-6.6-3.4-8.1-1.5-1.3-3.6-2-6.1-2.4 2.5-.4 4.6-1.1 6.1-2.4 1.8-1.5 3-4.2 3.4-8.1Z"/>' +
	'<path fill="currentColor" d="M19 1.5c.15 1.4.6 2.4 1.25 3 .55.45 1.3.75 2.25.9-.95.15-1.7.45-2.25.9-.65.6-1.1 1.6-1.25 3-.15-1.4-.6-2.4-1.25-3-.55-.45-1.3-.75-2.25-.9.95-.15 1.7-.45 2.25-.9.65-.6 1.1-1.6 1.25-3Z" opacity=".75"/>' +
	'</svg>';

// CKEditor's IconView sizes the icon itself: no width/height here.
const TOOLBAR_ICON = SPARKLE_SVG.replace(' width="1em" height="1em"', '');

const STATUS_LABELS = {
	done: 'Answer ready',
	error: 'Failed',
	interrupted: 'Interrupted',
	pending: 'AI Hub is working…',
};

function newId() {
	return window.crypto?.randomUUID
		? window.crypto.randomUUID()
		: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

/**
 * The panel shown under a selected @aihub request.
 */
class AiHubPanelView extends View {
	constructor(locale) {
		super(locale);

		this.setTemplate({
			attributes: {
				class: ['aihub-panel', 'ck-reset_all-excluded'],
				tabindex: '-1',
			},
			tag: 'div',
		});
	}

	update({actions, agentLabel, error, prompt, result, status}) {
		if (!this.element) {
			return;
		}

		let body;

		if (status === 'pending') {
			body =
				'<div class="aihub-panel__loading"><span class="aihub-panel__dots"><i></i><i></i><i></i></span>' +
				'Working in parallel — keep writing, the answer will wait for you here.</div>';
		}
		else if (status === 'done') {
			body = `<div class="aihub-panel__result">${answerToHtml(result)}</div>`;
		}
		else {
			body = `<div class="aihub-panel__error">${escapeHtml(
				error ||
					'The request was interrupted (the document was reloaded before the answer arrived).'
			)}</div>`;
		}

		const buttons = [];

		if (status === 'done') {
			buttons.push(
				['insert', 'Insert', 'primary'],
				['copy', 'Copy', 'secondary']
			);
		}

		if (status !== 'pending') {
			buttons.push(['retry', 'Ask again', 'secondary']);
		}

		buttons.push([
			'remove',
			status === 'pending' ? 'Cancel' : 'Dismiss',
			'link',
		]);

		this.element.innerHTML = `
			<div class="aihub-panel__header">
				<span class="aihub-panel__brand">${SPARKLE_SVG}<span>AI Hub</span></span>
				<span class="aihub-panel__status aihub-panel__status--${escapeHtml(status)}">${escapeHtml(
					STATUS_LABELS[status] || status
				)}</span>
			</div>
			<div class="aihub-panel__prompt">${escapeHtml(prompt)}</div>
			${body}
			<div class="aihub-panel__footer">
				<span class="aihub-panel__agent">${escapeHtml(agentLabel || '')}</span>
				<span class="aihub-panel__actions">${buttons
					.map(
						([action, label, kind]) =>
							`<button type="button" class="btn btn-sm btn-${kind}" data-action="${action}">${label}</button>`
					)
					.join('')}</span>
			</div>`;

		for (const button of this.element.querySelectorAll('[data-action]')) {
			button.addEventListener('mousedown', (event) =>
				event.preventDefault()
			);
			button.addEventListener('click', (event) => {
				event.preventDefault();
				event.stopPropagation();
				actions[button.dataset.action]?.(button);
			});
		}
	}
}

export class AiHubMention extends Plugin {
	static get pluginName() {
		return 'AiHubMention';
	}

	static get requires() {
		return [ContextualBalloon, Widget];
	}

	init() {
		this._controllers = new Map();

		this._defineSchema();
		this._defineConverters();
		this._watchDraft();
		this._handleEnter();
		this._addToolbarButton();
		this._setUpPanel();
	}

	destroy() {
		for (const controller of this._controllers.values()) {
			controller.abort();
		}

		this._controllers.clear();

		super.destroy();
	}

	// ---------------------------------------------------------------------
	// Model
	// ---------------------------------------------------------------------

	_defineSchema() {
		this.editor.model.schema.register(ELEMENT, {
			allowAttributes: [
				'agent',
				'error',
				'prompt',
				'requestId',
				'result',
				'status',
			],
			inheritAllFrom: '$inlineObject',
		});
	}

	_defineConverters() {
		const conversion = this.editor.conversion;

		// Upcast: <span class="aihub-request" data-aihub-*>…</span>. The text
		// inside the span is only a readable fallback; it is consumed, never
		// converted.

		conversion.for('upcast').add((dispatcher) => {
			dispatcher.on(
				'element:span',
				(evt, data, conversionApi) => {
					const viewItem = data.viewItem;

					if (
						!viewItem.hasClass('aihub-request') ||
						!conversionApi.consumable.test(viewItem, {name: true})
					) {
						return;
					}

					const status = viewItem.getAttribute('data-aihub-status');

					const modelElement = conversionApi.writer.createElement(
						ELEMENT,
						{
							agent: viewItem.getAttribute('data-aihub-agent') || '',
							prompt: viewItem.getAttribute('data-aihub-prompt') || '',
							requestId:
								viewItem.getAttribute('data-aihub-id') || newId(),
							result: viewItem.getAttribute('data-aihub-result') || '',
							status:
								status === 'done' || status === 'error'
									? status
									: 'interrupted',
						}
					);

					if (!conversionApi.safeInsert(modelElement, data.modelCursor)) {
						return;
					}

					conversionApi.consumable.consume(viewItem, {
						attributes: [...viewItem.getAttributeKeys()].filter(
							(key) => key !== 'class' && key !== 'style'
						),
						classes: [...viewItem.getClassNames()],
						name: true,
					});

					for (const child of viewItem.getChildren()) {
						conversionApi.consumable.consume(child);
					}

					conversionApi.updateConversionResult(modelElement, data);
				},
				{priority: 'high'}
			);
		});

		// Data: what is saved with the web content.

		conversion.for('dataDowncast').elementToElement({
			model: ELEMENT,
			view: (modelElement, {writer}) => {
				const prompt = String(modelElement.getAttribute('prompt') || '');
				const attributes = {
					'class': 'aihub-request',
					'data-aihub-id': String(modelElement.getAttribute('requestId') || ''),
					'data-aihub-prompt': prompt,
					'data-aihub-status': String(modelElement.getAttribute('status') || ''),
				};

				if (modelElement.getAttribute('agent')) {
					attributes['data-aihub-agent'] = String(
						modelElement.getAttribute('agent')
					);
				}

				if (modelElement.getAttribute('result')) {
					attributes['data-aihub-result'] = String(
						modelElement.getAttribute('result')
					);
				}

				const span = writer.createContainerElement('span', attributes);

				writer.insert(
					writer.createPositionAt(span, 0),
					writer.createText(`@aihub ${prompt}`)
				);

				return span;
			},
		});

		// Editing: the TK-like pill. Re-rendered whenever its status changes.

		conversion.for('editingDowncast').elementToElement({
			model: {
				attributes: ['prompt', 'status'],
				name: ELEMENT,
			},
			view: (modelElement, {writer}) => {
				const status = String(modelElement.getAttribute('status') || 'pending');
				const prompt = String(modelElement.getAttribute('prompt') || '');

				const span = writer.createContainerElement('span', {
					'class': `aihub-request aihub-request--${status}`,
					'data-aihub-id': String(modelElement.getAttribute('requestId') || ''),
					'title': STATUS_LABELS[status] || '',
				});

				const at = writer.createContainerElement('span', {
					class: 'aihub-request__at',
				});

				writer.insert(writer.createPositionAt(at, 0), writer.createText('@aihub'));
				writer.insert(writer.createPositionAt(span, 'end'), at);
				writer.insert(
					writer.createPositionAt(span, 'end'),
					writer.createText(` ${prompt} `)
				);
				writer.insert(
					writer.createPositionAt(span, 'end'),
					writer.createUIElement(
						'span',
						{class: 'aihub-request__icon'},
						function (domDocument) {
							const dom = this.toDomElement(domDocument);

							dom.innerHTML = SPARKLE_SVG;

							return dom;
						}
					)
				);

				if (status !== 'pending') {
					writer.insert(
						writer.createPositionAt(span, 'end'),
						writer.createUIElement('span', {
							class: `aihub-request__badge aihub-request__badge--${status}`,
						})
					);
				}

				return toWidget(span, writer, {
					label: `AI Hub request: ${prompt}`,
				});
			},
		});

		conversion.for('editingDowncast').markerToHighlight({
			model: DRAFT_MARKER,
			view: {classes: ['aihub-draft']},
		});
	}

	// ---------------------------------------------------------------------
	// Typing "@aihub …": live highlight, then Enter turns it into a request
	// ---------------------------------------------------------------------

	_findDraftRange() {
		const model = this.editor.model;
		const selection = model.document.selection;

		if (!selection.isCollapsed) {
			return null;
		}

		const position = selection.getFirstPosition();
		const block = position.parent;

		if (!block.is('element') || !model.schema.checkChild(block, '$text')) {
			return null;
		}

		let text = '';

		for (const item of model
			.createRange(model.createPositionAt(block, 0), position)
			.getItems()) {
			text += item.is('$textProxy') ? item.data : OBJECT_PLACEHOLDER;
		}

		const match = TRIGGER.exec(text);

		if (!match) {
			return null;
		}

		return model.createRange(
			model.createPositionAt(block, match.index + match[1].length),
			position
		);
	}

	_watchDraft() {
		const model = this.editor.model;

		// Typing fires "change"; moving the caret alone only fires the
		// selection's "change:range".

		this.listenTo(model.document, 'change', () => this._updateDraft());
		this.listenTo(model.document.selection, 'change:range', () =>
			this._updateDraft()
		);
	}

	_updateDraft() {
		const model = this.editor.model;

		if (this.editor.isReadOnly) {
			return;
		}

		const range = this._findDraftRange();
		const marker = model.markers.get(DRAFT_MARKER);

		if (!range && marker) {
			model.change((writer) => writer.removeMarker(DRAFT_MARKER));
		}
		else if (range && !marker) {
			model.change((writer) =>
				writer.addMarker(DRAFT_MARKER, {
					affectsData: false,
					range,
					usingOperation: false,
				})
			);
		}
		else if (range && !marker.getRange().isEqual(range)) {
			model.change((writer) =>
				writer.updateMarker(DRAFT_MARKER, {range})
			);
		}
	}

	_handleEnter() {
		const editor = this.editor;
		const model = editor.model;

		this.listenTo(
			editor.editing.view.document,
			'enter',
			(evt, data) => {
				if (data.isSoft || editor.isReadOnly) {
					return;
				}

				const marker = model.markers.get(DRAFT_MARKER);

				if (!marker) {
					return;
				}

				const range = marker.getRange();
				const selection = model.document.selection;

				if (
					!selection.isCollapsed ||
					!selection.getFirstPosition().isEqual(range.end)
				) {
					return;
				}

				let text = '';

				for (const item of range.getItems()) {
					if (item.is('$textProxy')) {
						text += item.data;
					}
				}

				const prompt = text.replace(/^@aihub/i, '').trim();

				if (!prompt) {
					return;
				}

				const requestId = newId();

				model.change((writer) => {
					writer.removeMarker(DRAFT_MARKER);

					const start = range.start;

					writer.remove(range);

					const element = writer.createElement(ELEMENT, {
						prompt,
						requestId,
						status: 'pending',
					});

					writer.insert(element, start);
					writer.setSelection(element, 'after');
				});

				// Enter then continues normally: a new paragraph, the author
				// keeps writing while the agent works.

				this._run(requestId);
			},
			{priority: 'high'}
		);
	}

	_addToolbarButton() {
		const editor = this.editor;

		editor.ui.componentFactory.add('aiHub', (locale) => {
			const button = new ButtonView(locale);

			button.set({
				class: 'aihub-toolbar-button',
				icon: TOOLBAR_ICON,
				label: 'Ask AI Hub (type @aihub …)',
				tooltip: true,
			});

			button.bind('isEnabled').to(editor, 'isReadOnly', (readOnly) => !readOnly);

			this.listenTo(button, 'execute', () => {
				editor.model.change((writer) => {
					const position =
						editor.model.document.selection.getFirstPosition();
					const before = position.nodeBefore;
					const needsSpace =
						before &&
						before.is('$text') &&
						!/\s$/.test(before.data);

					editor.model.insertContent(
						writer.createText(`${needsSpace ? ' ' : ''}@aihub `)
					);
				});

				editor.editing.view.focus();
			});

			return button;
		});
	}

	// ---------------------------------------------------------------------
	// Running a request
	// ---------------------------------------------------------------------

	_findElement(requestId) {
		const model = this.editor.model;

		for (const root of model.document.getRoots()) {
			for (const item of model.createRangeIn(root).getItems()) {
				if (
					item.is('element', ELEMENT) &&
					item.getAttribute('requestId') === requestId
				) {
					return item;
				}
			}
		}

		return null;
	}

	_documentText(requestId) {
		const model = this.editor.model;
		const lines = [];

		const visit = (element, depth) => {
			for (const child of element.getChildren()) {
				if (!child.is('element')) {
					continue;
				}

				if (model.schema.checkChild(child, '$text')) {
					let line = '';

					for (const node of child.getChildren()) {
						if (node.is('$text')) {
							line += node.data;
						}
						else if (node.is('element', ELEMENT)) {
							line +=
								node.getAttribute('requestId') === requestId
									? ` [[@aihub]] `
									: '';
						}
						else if (node.is('element', 'softBreak')) {
							line += '\n';
						}
					}

					if (line.trim()) {
						lines.push(
							(child.name === 'listItem' ||
							child.hasAttribute('listItemId')
								? '- '
								: '') + line.trim()
						);
					}
				}
				else if (depth < 6) {
					visit(child, depth + 1);
				}
			}
		};

		for (const root of model.document.getRoots()) {
			visit(root, 0);
		}

		const text = lines.join('\n');

		if (text.length <= 8000) {
			return text;
		}

		// Keep the neighbourhood of the request when the document is long

		const markerIndex = Math.max(0, text.indexOf('[[@aihub]]'));
		const start = Math.max(0, Math.min(markerIndex - 5000, text.length - 8000));

		return '…' + text.slice(start, start + 8000) + '…';
	}

	_setStatus(requestId, attributes) {
		const element = this._findElement(requestId);

		if (!element) {
			return;
		}

		this.editor.model.enqueueChange({isUndoable: false}, (writer) => {
			for (const [key, value] of Object.entries(attributes)) {
				if (value === null || value === undefined) {
					writer.removeAttribute(key, element);
				}
				else {
					writer.setAttribute(key, value, element);
				}
			}
		});

		this._syncPanel();
	}

	async _run(requestId) {
		const editor = this.editor;
		const element = this._findElement(requestId);

		if (!element) {
			return;
		}

		this._controllers.get(requestId)?.abort();

		const controller = new AbortController();

		this._controllers.set(requestId, controller);

		const language =
			editor.locale?.contentLanguage ||
			window.Liferay?.ThemeDisplay?.getLanguageId?.() ||
			'en';

		try {
			const {agent, text} = await askAiHub({
				documentText: this._documentText(requestId),
				language,
				request: String(element.getAttribute('prompt') || ''),
				signal: controller.signal,
			});

			if (controller.signal.aborted) {
				return;
			}

			this._setStatus(requestId, {
				agent: agent.erc,
				error: null,
				result: text,
				status: 'done',
			});
		}
		catch (error) {
			if (controller.signal.aborted) {
				return;
			}

			console.error('[AI Hub]', error);

			this._setStatus(requestId, {
				error: error?.message || String(error),
				status: 'error',
			});
		}
		finally {
			if (this._controllers.get(requestId) === controller) {
				this._controllers.delete(requestId);
			}
		}
	}

	// ---------------------------------------------------------------------
	// Panel (contextual balloon under the selected pill)
	// ---------------------------------------------------------------------

	_setUpPanel() {
		const editor = this.editor;

		this._balloon = editor.plugins.get(ContextualBalloon);
		this._panel = new AiHubPanelView(editor.locale);
		this._panelRequestId = null;

		this.listenTo(editor.model.document.selection, 'change:range', () =>
			this._syncPanel()
		);
		this.listenTo(editor.model.document, 'change:data', () =>
			this._syncPanel()
		);
	}

	_selectedRequest() {
		const element = this.editor.model.document.selection.getSelectedElement();

		return element && element.is('element', ELEMENT) ? element : null;
	}

	_targetDom(requestId) {
		const element = this._findElement(requestId);

		if (!element) {
			return null;
		}

		const viewElement = this.editor.editing.mapper.toViewElement(element);

		return viewElement
			? this.editor.editing.view.domConverter.mapViewToDom(viewElement)
			: null;
	}

	_hidePanel() {
		if (this._balloon.hasView(this._panel)) {
			this._balloon.remove(this._panel);
		}

		this._panelRequestId = null;
	}

	_syncPanel() {
		const element = this._selectedRequest();

		if (!element) {
			this._hidePanel();

			return;
		}

		const requestId = element.getAttribute('requestId');
		const agentERC = element.getAttribute('agent');
		const agent = AGENTS.find((candidate) => candidate.erc === agentERC);

		if (!this._panel.isRendered) {
			this._panel.render();
		}

		this._panel.update({
			actions: {
				copy: (button) => this._copy(requestId, button),
				insert: () => this._insert(requestId),
				remove: () => this._remove(requestId),
				retry: () => this._retry(requestId),
			},
			agentLabel: agent ? `${agent.label} · ${agent.erc}` : agentERC || '',
			error: element.getAttribute('error'),
			prompt: element.getAttribute('prompt'),
			result: element.getAttribute('result'),
			status: element.getAttribute('status'),
		});

		const position = {target: () => this._targetDom(requestId)};

		if (!this._balloon.hasView(this._panel)) {
			this._balloon.add({position, view: this._panel});
		}
		else {
			this._balloon.updatePosition(position);
		}

		this._panelRequestId = requestId;
	}

	_insert(requestId) {
		const editor = this.editor;
		const model = editor.model;
		const element = this._findElement(requestId);

		if (!element) {
			return;
		}

		const html = answerToHtml(element.getAttribute('result'));
		const fragment = editor.data.toModel(editor.data.processor.toView(html));

		model.change((writer) => {
			const block = element.parent;
			const onlyChild = block.childCount === 1;

			const paragraph = writer.createElement('paragraph');

			writer.insert(paragraph, writer.createPositionAfter(block));

			writer.remove(element);

			if (onlyChild && block.childCount === 0) {
				writer.remove(block);
			}

			model.insertContent(fragment, writer.createPositionAt(paragraph, 0));
		});

		this._hidePanel();
		editor.editing.view.focus();
	}

	async _copy(requestId, button) {
		const element = this._findElement(requestId);

		if (!element) {
			return;
		}

		const text = String(element.getAttribute('result') || '');

		try {
			await navigator.clipboard.write([
				new ClipboardItem({
					'text/html': new Blob([answerToHtml(text)], {type: 'text/html'}),
					'text/plain': new Blob([text], {type: 'text/plain'}),
				}),
			]);
		}
		catch (error) {
			await navigator.clipboard?.writeText(text);
		}

		if (button) {
			button.textContent = 'Copied';
		}
	}

	_retry(requestId) {
		this._setStatus(requestId, {
			agent: null,
			error: null,
			result: null,
			status: 'pending',
		});

		this._run(requestId);
	}

	_remove(requestId) {
		this._controllers.get(requestId)?.abort();
		this._controllers.delete(requestId);

		const element = this._findElement(requestId);

		if (element) {
			this.editor.model.change((writer) => writer.remove(element));
		}

		this._hidePanel();
		this.editor.editing.view.focus();
	}
}
