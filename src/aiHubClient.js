/**
 * Browser-side AI Hub client.
 *
 * 1. DXP mints a Cell token for the signed-in user (same origin, CSRF token):
 *    POST /o/ai-hub-cell/v1.0/authorization-tokens
 * 2. The agent runs on AI Hub on behalf of that user:
 *    POST {serviceURL}/o/ai-hub/v1.0/agent-instances
 *
 * The browser never sees the AI Hub client secret.
 */

/**
 * Agents tried in order. The first one is a dedicated "writing companion"
 * agent (see README.md for its build sheet); while it does not exist (404),
 * the client falls back to the system agent L_GENERATE_FIELD_VALUE, which
 * accepts a free-form instruction.
 */
export const AGENTS = [
	{
		buildContext: ({documentText, language, request}) => ({
			document: documentText,
			language,
			request,
		}),
		erc: 'AIHUB_WRITING_COMPANION_FBO',
		label: 'Writing Companion',
		readOutput: (output) => String(output ?? ''),
	},
	{
		buildContext: ({documentText, language, request}) => ({
			instruction: [
				'Field to generate: "answer" (rich text; Markdown allowed: paragraphs, "- " bullet lists, **bold**, *italic*, [links](url)).',
				'',
				'You are AI Hub, a writing companion working in parallel with an author inside a rich-text editor.',
				'The author typed an @aihub request in the middle of the document. The marker [[@aihub]] shows where.',
				'',
				'=== DOCUMENT START ===',
				documentText,
				'=== DOCUMENT END ===',
				'',
				`Author's request: "${request}"`,
				'',
				'Produce the content that fulfils the request so that it can be inserted into the document right where the marker is.',
				`Write in the language of the request (editor language: ${language}). Be concise and ready to paste: no preamble, do not repeat the request, do not wrap in code fences.`,
			].join('\n'),
		}),
		erc: 'L_GENERATE_FIELD_VALUE',
		label: 'Generate Field Value',
		readOutput: readJSONProperty,
	},
];

const UNAVAILABLE_AGENTS = new Set();

let tokenPromise = null;
let tokenCache = null;

function pathContext() {
	return window.Liferay?.ThemeDisplay?.getPathContext?.() || '';
}

function decodeExpiry(accessToken) {
	try {
		const payload = JSON.parse(
			atob(accessToken.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))
		);

		if (payload.exp) {
			return payload.exp * 1000;
		}
	}
	catch (error) {

		// Opaque token: fall through to a conservative lifetime

	}

	return Date.now() + 4 * 60 * 1000;
}

async function fetchCellToken() {
	const response = await fetch(
		`${pathContext()}/o/ai-hub-cell/v1.0/authorization-tokens`,
		{
			credentials: 'same-origin',
			headers: {
				'Accept': 'application/json',
				'x-csrf-token': window.Liferay?.authToken || '',
			},
			method: 'POST',
		}
	);

	if (response.status === 404) {
		throw new Error(
			'AI Hub is not available on this instance (feature flag LPD-62272 or the AI Hub connection is missing).'
		);
	}

	if (!response.ok) {
		throw new Error(
			`Unable to obtain an AI Hub token (HTTP ${response.status}). Are you signed in?`
		);
	}

	const data = await response.json();

	return {
		accessToken: data.accessToken,
		expiresAt: decodeExpiry(data.accessToken),
		serviceURL: String(data.serviceURL || 'https://ai.hub.liferay.com').replace(
			/\/+$/,
			''
		),
		userToken: data.userToken,
	};
}

export async function getCellToken(force = false) {
	if (!force && tokenCache && tokenCache.expiresAt - Date.now() > 30000) {
		return tokenCache;
	}

	if (!tokenPromise) {
		tokenPromise = fetchCellToken()
			.then((token) => {
				tokenCache = token;

				return token;
			})
			.finally(() => {
				tokenPromise = null;
			});
	}

	return tokenPromise;
}

/**
 * AI Hub sits behind a web application firewall that rejects any body
 * containing "<<" or ">>" with an HTML 403 that carries no CORS headers, so
 * the browser only sees "Failed to fetch" (verified 2026-11-13). Author text
 * can contain them, so they are neutralized in every value sent.
 */
function wafSafe(value) {
	if (typeof value !== 'string') {
		return value;
	}

	return value.replace(/<{2,}/g, (run) => '‹'.repeat(run.length)).replace(
		/>{2,}/g,
		(run) => '›'.repeat(run.length)
	);
}

async function postAgentInstance(erc, rawContext, signal, retry = true) {
	const token = await getCellToken(!retry);

	const context = Object.fromEntries(
		Object.entries(rawContext).map(([key, value]) => [key, wafSafe(value)])
	);

	let response;

	try {
		response = await fetch(
			`${token.serviceURL}/o/ai-hub/v1.0/agent-instances`,
			{
				body: JSON.stringify({
					agentDefinitionExternalReferenceCode: erc,
					asynchronous: false,
					context,
				}),
				headers: {
					'Accept': 'application/json',
					'Authorization': `Bearer ${token.accessToken}`,
					'Content-Type': 'application/json',
					'Liferay-AI-Hub-Cell-On-Behalf-Of': token.userToken,
				},
				method: 'POST',
				signal,
			}
		);
	}
	catch (error) {
		if (signal?.aborted) {
			throw error;
		}

		throw new Error(
			'AI Hub could not be reached or refused the request (network error or firewall rule).'
		);
	}

	if (response.status === 401 && retry) {
		return postAgentInstance(erc, context, signal, false);
	}

	return response;
}

/**
 * Runs the first available agent of AGENTS and returns {agent, text}.
 */
export async function askAiHub({documentText, language, request, signal}) {
	let lastError = null;

	for (const agent of AGENTS) {
		if (UNAVAILABLE_AGENTS.has(agent.erc)) {
			continue;
		}

		const response = await postAgentInstance(
			agent.erc,
			agent.buildContext({documentText, language, request}),
			signal
		);

		if (response.status === 404) {
			UNAVAILABLE_AGENTS.add(agent.erc);

			continue;
		}

		const body = await response.text();

		if (!response.ok) {
			lastError = new Error(
				`AI Hub agent ${agent.erc} failed (HTTP ${response.status}).`
			);

			continue;
		}

		let data = {};

		try {
			data = JSON.parse(body);
		}
		catch (error) {
			data = {output: body};
		}

		const text = agent.readOutput(data.output).trim();

		if (!text) {
			lastError = new Error(`AI Hub agent ${agent.erc} returned nothing.`);

			continue;
		}

		return {agent, text};
	}

	throw lastError || new Error('No AI Hub agent is available.');
}

function readJSONProperty(output) {
	if (output === null || output === undefined) {
		return '';
	}

	let value = output;

	if (typeof value === 'string') {
		const trimmed = value.trim();

		if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) {
			return value;
		}

		try {
			value = JSON.parse(trimmed);
		}
		catch (error) {
			return value;
		}
	}

	return flatten(value);
}

function flatten(value) {
	if (typeof value === 'string') {
		return value;
	}

	if (Array.isArray(value)) {
		return value.map((item) => `- ${flatten(item)}`).join('\n');
	}

	if (value && typeof value === 'object') {
		if (typeof value.answer === 'string') {
			return value.answer;
		}

		return Object.values(value).map(flatten).join('\n\n');
	}

	return String(value ?? '');
}
