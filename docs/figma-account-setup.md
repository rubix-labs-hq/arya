# Figma account connection

The public sign-in service, its domain, hosting and Figma app registration are not set up yet. Finish these steps before advertising account sign-in for general users. Local test results do not establish a working public OAuth app.

Public-facing product and registration copy use Arya. Existing `reelfigma` callbacks, `ReelFigmaBrokerURL`, bundle identifiers and Keychain names remain compatibility identifiers. Per-user import methods work today without the public service.

## Implemented flow

The native app starts an `ASWebAuthenticationSession` with a fresh state and device proof. The broker requests only `current_user:read` and `file_content:read`. Its HTTPS callback exchanges the authorization code immediately with Figma using the app secret and S256 PKCE. The callback returns a short-lived transfer ticket to `reelfigma://oauth/callback`. The app must prove it owns the original verifier before it receives an access token.

The broker returns an encrypted refresh handle. It keeps the provider's refresh token out of the native app and stores no account credentials on disk. The app stores its access token, encrypted refresh handle and issuing broker origin in this device's Keychain. Refreshes go to that stored origin. Disconnect removes the local connection and invalidates pending requests. Users can also revoke Reel in Figma's settings.

Imports use read-only Figma endpoints. They copy downloaded images into the project and create editable Reel compositions, text, shapes and supported vector paths. Unsupported effects use rendered fallback layers and report warnings. The import report must state those limits; a flattened fallback does not make every original layer editable.

## Deferred provider setup

1. Choose an Arya-owned HTTPS hostname and hosting account. Confirm who operates the service and receives alerts.
2. Create Arya's OAuth app at [Figma developer apps](https://www.figma.com/developers/apps). Store the client secret in the hosting account's secret manager. Do not paste it into source, logs, an app bundle or a chat.
3. Register `https://<chosen-host>/v1/figma/callback` exactly. Select `current_user:read` and `file_content:read`.
4. Deploy `editor/services/figma-oauth-broker.mjs` behind a TLS reverse proxy with request limits. Set `FIGMA_BROKER_ORIGIN`, `FIGMA_CLIENT_ID`, `FIGMA_CLIENT_SECRET`, `FIGMA_BROKER_KEY` and `PORT`. The encryption key must decode to 32 random bytes and must remain stable between restarts. Rotating it requires users to reconnect.
5. Run one service instance. Pending sign-ins and transfer tickets exist only in bounded memory for ten and two minutes respectively. A restart cancels pending sign-ins. Multiple instances require a shared expiring transaction store with atomic one-time consumption before rollout. Add provider monitoring and abuse limits at the reverse proxy.
6. Set the native build's public `ReelFigmaBrokerURL` to that HTTPS origin. It contains no secret. Keep it unset until the service exists. Advanced settings can supply a test origin.
7. Test with the app creator's test account. Verify sign-in, cancel, disconnect during sign-in, expiry, refresh, inaccessible files and rate limits. Import copies of real design frames, compare rendered output, inspect editable layers and verify that the source file has not changed.
8. Submit the public app to Figma for approval. Provide Arya's logo, description, privacy policy and the review instructions below. Draft apps work only for their creator and plan admins. Private apps restrict access to the selected team or organization.
9. After approval, repeat the complete flow with an unrelated account and a signed release build. Record the provider app ID, deployment revision, build revision and test result in the release evidence.

## Instructions for Figma's app review

Open a Reel project and choose Figma, then Connect Figma. Approve the two read-only scopes in the system browser. Paste a design link for a file shared with your account, browse its frames and import one onto the timeline. Open the resulting composition, edit a text layer and move a shape. Inspect the import report for any rendered fallback layers. Close and reopen the project to confirm that its copied assets remain available. Disconnect the Figma account and confirm that remote browsing now requires sign-in. Reel does not change the original Figma file.

Use [Figma's OAuth documentation](https://developers.figma.com/docs/rest-api/oauth-apps/) for registration and browser requirements. Use the [May 16, 2025 API changelog](https://developers.figma.com/docs/rest-api/changelog/) for the current refresh endpoint, `/v1/oauth/token` with `grant_type=refresh_token`. The OAuth overview still shows the supported legacy refresh endpoint.
