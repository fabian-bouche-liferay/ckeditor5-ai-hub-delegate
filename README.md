# aihub-mention-ckeditor

`@aihub` mentions in Liferay's CKEditor 5, modeled on [tk.xyz](https://tk.xyz): the author types a request into the text, and a [Liferay AI Hub](https://learn.liferay.com/w/ai-hub/integrating-ai-hub-with-liferay-dxp) agent works on it in parallel while the author keeps writing.

A Liferay client extension of type `editorConfigContributor`. It declares no `editorConfigKeys`, so it applies to every CKEditor 5 editor (web content, descriptions, and so on). Verified on DXP 2026.q4.0 (CKEditor 46.0.3) on 2026-11-13.

## Demo

![Demo: two @aihub requests run in parallel in CKEditor 5, then their answers are inserted](docs/aihub-mention-demo.gif)

Full-quality video: [docs/aihub-mention-demo.webm](docs/aihub-mention-demo.webm) (48 s). Two `@aihub` requests run in parallel while the author keeps writing, then both answers are inserted.

## Experience

1. Type `@aihub` followed by the request. The text is highlighted in blue as you type.
1. **Enter**: the request becomes an `@aihub … ✦` pill. The sparkle pulses and a shimmer runs across the pill while the agent works. The caret moves to the next paragraph and you keep writing.
1. A green dot appears on the pill when the answer is ready (about 5 s).
1. Click the pill: a panel shows the answer with **Insert** (replaces the pill with the formatted answer), **Copy**, **Ask again**, and **Dismiss**.

The ✦ toolbar button inserts `@aihub ` at the caret. Several requests can run at the same time.

## Requirements

- Liferay DXP **2026.Q3 or later** with CKEditor 5 as the content editor (verified on 2026.q4.0).
- Access to **Liferay AI Hub** (`https://ai.hub.liferay.com`) with an account allowed to create agents.
- A **Liferay workspace** to build and deploy the extension (Blade, Node.js).
- A **public HTTPS URL** for DXP. AI Hub refuses `localhost` as the environment URL; for local work, use a tunnel such as ngrok.

## Setup

### 1. Connect DXP to AI Hub

1. **DXP:** Control Panel → Instance Settings → Feature Flags → **Release** → enable **AI Hub (`LPD-62272`)**.
1. **AI Hub:** AI Hub → Configurations → set **Environment URL** to the public HTTPS URL of DXP (not an AI Hub URL). Save, then copy the **Client ID** and **Client Secret** shown. Keep the secret out of source control.
1. **DXP:** Control Panel → Instance Settings → **AI Hub** → paste the Client ID and Client Secret, set Service URL to `https://ai.hub.liferay.com/`, and save.

**Behind a tunnel or reverse proxy**, DXP must know its public port and protocol, or the URLs it builds for itself carry the JVM's port (`8080`) after the public `https://` host. Add to `portal-ext.properties`, then restart:

```properties
web.server.http.port=80
web.server.https.port=443

web.server.forwarded.host.enabled=true
web.server.forwarded.port.enabled=true
web.server.forwarded.protocol.enabled=true
```

Do not also set `web.server.host` or `web.server.protocol` while the matching `forwarded.*.enabled` property is on.

### 2. Create the Agent in AI Hub

The extension calls a dedicated agent, `AIHUB_WRITING_COMPANION_FBO`. Agents are created in the AI Hub UI, not over the API. Go to AI Hub → Agent Builder → Agents → New and enter:

```text
AGENT
  Title:                    AI Hub Writing Companion (FBO)
  External Reference Code:  AIHUB_WRITING_COMPANION_FBO
  Description:              Writing companion invoked from an @aihub mention in a rich-text editor.
                            Receives the author's request and the document being written, and returns
                            content ready to be inserted where the request was typed.
  Input Variables:          request,document,language
  Output Variable:          output
  → Save as Draft BEFORE Edit Workflow (otherwise the form is lost)

WORKFLOW: Start → LLM → End
  LLM node
    Input Variables:   [{"name": "request", "type": "string"},
                        {"name": "document", "type": "string"},
                        {"name": "language", "type": "string"}]
    Output Variables:  [{"name": "output", "type": "string"}]
    Prompt:            You are a writing companion working in parallel with an author inside a
                       rich-text editor. The marker [[@aihub]] in the document shows where the author
                       asked you something. Produce exactly the content that fulfils the request, ready
                       to be inserted at that marker: same language as the request, consistent with the
                       document's tone, concise. Markdown allowed (paragraphs, "- " lists, **bold**).
                       No preamble, never repeat the request, no code fences.
    User Message:      === DOCUMENT START ===
                       {{document}}
                       === DOCUMENT END ===
                       Editor language: {{language}}
                       Request: {{request}}
  → Update, then Enable Agent and Publish
```

- Every variable used as `{{name}}` must be declared in the node's Input Variables, or it is sent literally.
- **Never write `<<` or `>>` in the prompt or the user message.** The web application firewall in front of AI Hub rejects any request body containing these sequences with an HTML `403` that carries no CORS header, and the browser then only reports "Failed to fetch" (verified 2026-11-13). The extension replaces these sequences in all text it sends.
- The ERC is suffixed per developer (`_FBO`), as in a shared AI Hub. To use another ERC, change the first entry of `AGENTS` in `src/aiHubClient.js` and rebuild.
- The agent runs **as the signed-in DXP user**. An author who cannot see the agent (another AI Hub account) gets a `404`, and the extension then uses the fallback agent below.

#### What the Agent Can Do Depends on Its Tools

The extension only carries the request and the document to the agent and displays what comes back: **everything the agent knows or can do is decided in AI Hub**, by the nodes and sources attached to its workflow. With the `Start → LLM → End` workflow above, the agent works from the model's own knowledge and the document alone. It can rewrite, summarize, argue, suggest titles or translate, but it cannot answer "any recent news about this?", read your site's content, or look anything up.

To make `@aihub` do more, attach tools to the agent in Agent Builder. No change to the extension is needed:

| Attach in AI Hub | The agent can then | Notes |
| --- | --- | --- |
| A **Liferay Search** node, with a Search Blueprint | Answer from DXP content (web content, CMS entries), as RAG | Respects the author's permissions, since the agent runs as the signed-in user |
| An **HTTP Request** node to `{{aiHubCellLiferayDXPURL}}/o/...` | Read live DXP data through the Headless APIs (objects, accounts, orders, the author's profile) | The token's scopes come from the OAuth2 application of the AI Hub connection in DXP: grant the narrowest scope the call needs; a non-2xx response stops the workflow |
| A **Data Source** (External Website) assigned to the agent | Answer from a public website it has indexed | Run **Sync Now** after the site changes; public content only |
| Other tools AI Hub offers to agents | Whatever those tools provide | Check what your AI Hub release exposes in Agent Builder |

Each tool node reads the request as `{{request}}` and the document as `{{document}}`, declared in that node's Input Variables like on the LLM node. A common shape is `Start → <tool node> → LLM → End`, with the LLM node turning the tool's raw output into text ready to insert. Keep in mind that the editor waits for the whole workflow: every node added makes the pill take longer to turn green.

**Without this agent**, the extension still works: it falls back to the system agent `L_GENERATE_FIELD_VALUE`, which accepts a free-form instruction, with a prompt assembled in the browser. The dedicated agent moves that prompt out of the code and makes it tunable in AI Hub.

### 3. Install the Client Extension

Clone this repository into the `client-extensions/` folder of a Liferay workspace, then deploy:

```bash
cd <workspace>/client-extensions
git clone <this-repository-url> aihub-mention-ckeditor

cd aihub-mention-ckeditor
blade gw deploy
```

The workspace plugin runs `npm run build` (esbuild) and packages `build/` into `<workspace>/bundles/osgi/client-extensions/aihub-mention-ckeditor.zip`. Success is the log line `STARTED aihubmentionckeditor_…`, and `GET /o/aihub-mention-ckeditor/index.js` answering `200`.

The `@ckeditor/*` packages are not bundled: Liferay's import map resolves them to the running editor's own instances, so the plugin shares the exact classes the editor uses. Keep the folder name `aihub-mention-ckeditor`: it is the project name, and the assets are served under `/o/aihub-mention-ckeditor/`.

### 4. Verify

1. Sign in to DXP through its public URL and open the browser console on any page:

	```javascript
	await fetch('/o/ai-hub-cell/v1.0/authorization-tokens', {
		headers: {'x-csrf-token': Liferay.authToken},
		method: 'POST',
	}).then((response) => response.status);
	```

	`200` means DXP can obtain AI Hub tokens for you. `404` means the feature flag is off or the Cell module is absent; `401`/`403` means you are not signed in or the connection in Instance Settings is wrong.

1. Open a web content editor. The ✦ button appears at the end of the toolbar once the extension has loaded.
1. Type `@aihub say hello`, press Enter, then click the pill once the green dot appears. The panel's footer shows the agent that answered: `Writing Companion · AIHUB_WRITING_COMPANION_FBO`, or `Generate Field Value · L_GENERATE_FIELD_VALUE` when the fallback was used.

## How It Works

| Step | Call |
| --- | --- |
| Cell token for the signed-in user (same origin, CSRF) | `POST /o/ai-hub-cell/v1.0/authorization-tokens` |
| Synchronous agent run, on behalf of that user | `POST {serviceURL}/o/ai-hub/v1.0/agent-instances` with `Authorization: Bearer <accessToken>` and `Liferay-AI-Hub-Cell-On-Behalf-Of: <userToken>` |

DXP obtains the tokens from AI Hub with the Instance Settings connection, so the browser never sees the AI Hub client secret. Tokens last 600 s and are cached until 30 s before they expire.

The agent receives the request and the document text (at most 8,000 characters, centered on the request), with a `[[@aihub]]` marker where the request was typed. The answer is read from the response's `output` key.

Agents tried in order (`src/aiHubClient.js` → `AGENTS`):

1. `AIHUB_WRITING_COMPANION_FBO`, the dedicated agent. A `404` (absent or invisible to this user) skips it for the rest of the page session.
1. `L_GENERATE_FIELD_VALUE`, the system fallback.

Markdown or HTML answers are converted to whitelist-sanitized HTML (`src/markdown.js`) before display and insertion.

### Source Layout

| File | Role |
| --- | --- |
| `client-extension.yaml` | The `editorConfigContributor` entry; `assemble` copies `build/` into the zip |
| `build.mjs` | esbuild bundle, `@ckeditor/*` kept external, CSS imported as text |
| `src/index.js` | Editor config transformer: adds the plugin and the `aiHub` toolbar item to CKEditor 5 editors only |
| `src/AiHubMention.js` | The CKEditor 5 plugin: `@aihub` detection, the pill widget, the result panel, insertion |
| `src/aiHubClient.js` | Cell token, agent calls, fallback, firewall-safe text |
| `src/markdown.js` | Markdown to HTML and HTML sanitizer for answers |
| `src/styles/aihub.css` | Pill, draft highlight, and panel styles (injected once per page) |
| `docs/` | Demo video, not deployed |

## Persistence

Not yet verified with a save followed by a reload: only the HTML produced by `getData()` was checked.

An unresolved request is saved with the content as `<span class="aihub-request" data-aihub-…>@aihub …</span>`. On reload, a completed request gets its answer back; a request still running shows as "Interrupted" with **Ask again**. Resolve or dismiss the pills before publishing: the published page renders that span as plain text.

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| No ✦ button, `@aihub` never highlights | Extension not deployed, or the page loaded before it | Check `STARTED` in the log and `GET /o/aihub-mention-ckeditor/index.js`; reload the editor |
| Pill turns red: "Unable to obtain an AI Hub token" | Not signed in, or the AI Hub connection in Instance Settings is missing or wrong | Step 4.1; re-enter Client ID and Secret |
| Pill turns red: "AI Hub is not available on this instance" | `authorization-tokens` answered `404` | Enable `LPD-62272` (step 1) |
| Pill turns red: "could not be reached or refused the request" | Browser-side failure: CORS rejected the page's origin, or the firewall rejected the body | Open DXP through the URL set as Environment URL in AI Hub; look in DevTools → Network for an HTML `403` from `ai.hub.liferay.com` |
| Footer shows `L_GENERATE_FIELD_VALUE` | The dedicated agent is missing, unpublished, or in another AI Hub account | Step 2; check that the agent is enabled and published |
| Answer ignores part of the request | A `{{variable}}` is not declared in the LLM node's Input Variables | Declare `request`, `document`, `language` on the node |

Origins accepted by AI Hub's CORS were checked on one environment: both the configured public URL and `http://localhost:8080` were accepted. Re-check yours with DevTools if you open DXP another way.
