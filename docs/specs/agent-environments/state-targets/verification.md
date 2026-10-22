# Verification

Executed on macOS with Node v22.23.1, one change at a time on main, over the 50 published capture-built environments
(each app's latest capture). The served smoke rebuilds each manifest with the tree under test and applies every served
write tool; the serving check answers every recorded read made before the capture's first write through state serving
and compares it with the recording.

## Gates

- `npm run build:cached`, `npm run check:fast` (typecheck and lint, no new warnings in the changed files),
  `npm run format:check`, `npx knip`, `npm run scan:todos`, `npm run docs:check`, `npm run verify:test-discovery` and
  `npm run mcp-catalog:check`: passed.
- `npm run jscpd`: 3.49% duplicated lines over 4055 files.
- `npx vitest run --project domain --project services`: 8962 passed, 6 pre-existing skips.
- `npm run test:prepare`, then `npm run test:focused --` the environment serve and export CLI boundaries, the serve
  and served-writes MCP boundaries, the analysis-view CLI and MCP boundaries, the compact input schema boundary and
  tool schema validity: 8 files, 88 passed.

## Measurements

| Step            | Write tools | Served | No state target | State-backed read views | Recorded reads matching |
| --------------- | ----------- | ------ | --------------- | ----------------------- | ----------------------- |
| main            | 195         | 46     | 91              | 1,098                   | 1,833 of 1,886          |
| read-only POSTs | 189         | 46     | 84              | 1,104                   | 1,911 of 1,964          |
| adoption        | 189         | 47     | 84              | 1,104                   | 1,911 of 1,964          |
| linked creates  | 189         | 48     | 80              | 1,105                   | 1,911 of 1,964          |
| rewrite cuts    | 189         | 51     | 77              | 1,110                   | 1,922 of 1,975          |
| variant lines   | 189         | 61     | 61              | 1,150                   | 2,068 of 2,126          |
| review fixes    | 189         | 61     | 61              | 1,151                   | 2,075 of 2,133          |

The served smoke applies every served write tool at each step. No read view loses its state backing, and no served
write tool is lost.

- **Read-only POSTs:** six tools leave the write list (Mattermost `members/ids`, Miniflux `discover`, NocoDB's two
  internal tunnels, Paperless `selection_data`, PocketBase `auth-refresh`); Paperless's notes create gains a target.
  Grafana's `query-history` stays a write. Nomad `jobs/statuses` repeats its GET, but its integers exceed JSON's
  exact range, so it stays a write.
- **Adoption:** Grocy's product delete is served; Mealie's recipe delete moves from no observation to unconfirmed.
- **Linked creates:** Jellyfin's item delete is served; its playlist create and item update, and Mailpit's send, gain
  targets. Grafana's `/api/search` and Mailpit's messages no longer hold the dashboard and message their captures
  created.
- **Rewrite cuts:** Tandoor's recipe create, update and delete are served.
- **Variant lines:** Baserow's row create, update and delete, Keycloak's user delete, Miniflux's category create and
  update, PocketBase's create, update and delete, and Vikunja's task delete are served. Ghost's post create and update,
  Keycloak's user update, Miniflux's category delete, n8n's tag create and Vikunja's task update gain targets.
- **Review fixes:** no write verdict changes. A NocoDB records list whose `fields` line had rejected it becomes
  state-backed, and all 7 of its recorded reads match. Without its guard, a short id would cut 23 Tandoor views'
  initial windows at a `POST /api/view-log/` returning `{"id":1}`.

Of the 40 views variant lines make state-backed, 146 of 151 recorded reads before the first write match; the other five
(Sentry projects) are replayed, and replay returns the first of several differing recordings, as before. A paged
Paperless document list answers all five documents, a PocketBase item without `expand` answers without it, and a
NetBox `site_id` filter learned from one line is not adopted.

## Not included

- Making a value that differs between two request lines volatile: it contradicts the spec's distinct query strings and
  made 11 recorded reads answer otherwise than replay.
- Item actions (`/{type}/{id}/archive`), bulk writes at a collection path, templating literal ids by value, and
  envelope masking: each needs further recording evidence or a separate change.
