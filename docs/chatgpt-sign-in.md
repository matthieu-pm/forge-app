# Sign in with ChatGPT

Forge uses two separate permissions: identity sign-in for a Forge account, and local ChatGPT plan usage for desktop models. Website sign-in does not enable subscription inference on Forge's hosted runtime.

## Website and desktop account sign-in

Request an approved website OAuth client from OpenAI: https://developers.openai.com/siwc/request-client-id. Register the exact callback for each deployment:

```
https://YOUR_FORGE_HOST/api/auth/callback/chatgpt
```

Set server-side `OPENAI_CLIENT_ID` to that registered client ID. Public clients use `OPENAI_CLIENT_AUTH_METHOD=none` (the default). For a provisioned confidential client, set `OPENAI_CLIENT_AUTH_METHOD=client_secret_basic` and `OPENAI_CLIENT_SECRET` through the deployment's secret manager. These are OAuth credentials, not `OPENAI_API_KEY`; never add a `VITE_` prefix. The button appears on login, signup and desktop browser authorization only when configuration is complete.

Returning email/password users must sign in with their existing method and choose **Link ChatGPT account** in Profile settings. Email matches do not automatically link accounts. The website verifies issuer, signature, audience, expiry and a transaction-bound nonce, and saves only the identity mapping. Better Auth handles the expiring browser-bound state, PKCE transaction and Forge session. No OpenAI ID/access/refresh token is retained in the hosted account database.

## Desktop ChatGPT models

In AI & Agents, choose **Continue with ChatGPT**. Forge registers itself using the public local-app flow, receives the callback on `127.0.0.1`, and stores credentials using Electron's OS-backed encryption under its user-data `chatgpt` directory. No API key or website client is needed for this plan connection. This version maintains one connected ChatGPT registration per desktop installation.

The model picker uses `GET https://api.openai.com/v1/models` with the same OAuth credential used for inference. It preserves the server's visible model names and slugs rather than substituting Codex's bundled catalog. **Refresh models** reloads account availability; **Manage usage** opens ChatGPT's usage controls.

Codex CLI remains the local tool-execution runtime. Forge starts an isolated app-server home, points it at the public Responses API, supplies the local access token only to that child, disables response storage and WebSockets, and refreshes credentials before subsequent requests. It does not read or reuse the user's Codex credentials. Install/update Codex if the runtime is unavailable. Reauthorize with Continue with ChatGPT if the session expires or is revoked.

Local plan tokens must not be uploaded into Forge's hosted model vault. Hosted ChatGPT plan inference requires a separately approved partner integration; existing managed/BYOK models remain separate billing sources.

## Verification

Focused tests cover signed ID-token validation and rejection, website identity-only scopes and token stripping, callback state/client binding, local encrypted storage, returning registration, serialized refresh and catalog visibility. Run these with the model broker, process supervisor, AI settings and auth-session suites, plus typecheck and desktop build. A live end-to-end sign-in still requires the person to authorize in OpenAI's browser flow; hosted sign-in additionally requires the approved client.

Sources: https://developers.openai.com/siwc/website, https://developers.openai.com/siwc/token-sharing-open-source/sign-in, https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference, https://developers.openai.com/siwc/token-sharing-open-source/codex-app-server.
