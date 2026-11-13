/**
 * editorConfigContributor entry point: adds the AiHubMention plugin and its
 * toolbar button to every CKEditor 5 instance.
 */

import {AiHubMention} from './AiHubMention.js';
import css from './styles/aihub.css';

const STYLE_ID = 'aihub-mention-ckeditor-styles';

function injectStyles() {
	if (document.getElementById(STYLE_ID)) {
		return;
	}

	const style = document.createElement('style');

	style.id = STYLE_ID;
	style.textContent = css;

	document.head.appendChild(style);
}

function addToolbarItem(toolbar, item) {
	if (Array.isArray(toolbar)) {
		return toolbar.includes(item) ? toolbar : [...toolbar, '|', item];
	}

	if (toolbar && Array.isArray(toolbar.items)) {
		return toolbar.items.includes(item)
			? toolbar
			: {...toolbar, items: [...toolbar.items, '|', item]};
	}

	return toolbar;
}

const editorConfigTransformer = (config) => {
	if (!config || config.editorType !== 'ckeditor5') {
		return config;
	}

	injectStyles();

	const extraPlugins = Array.isArray(config.extraPlugins)
		? config.extraPlugins.filter(Boolean)
		: [];

	return {
		...config,
		extraPlugins: extraPlugins.includes(AiHubMention)
			? extraPlugins
			: [...extraPlugins, AiHubMention],
		toolbar: addToolbarItem(config.toolbar, 'aiHub'),
	};
};

export default {editorConfigTransformer};
