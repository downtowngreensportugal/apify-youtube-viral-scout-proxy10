# YouTube Viral Scout Proxy — v0.3.5

Fixes:
- **Input schema**: usa `searchQueries: []` (não `searchQuery`). Auto-normaliza se vier string.
- **Erro detalhado**: quando o upstream falha, tenta ler `statusMessage` e mete no OUTPUT.

## Configuração
- **NÃO** definas `APIFY_TOKEN` nas env vars deste actor.
- Define **UPSTREAM_APIFY_TOKEN** (Secret) com o teu token pessoal, para chamar o actor público.

## Run input
```json
{
  "forwardInput": { "searchQueries": ["microgreens"], "maxResults": 25, "maxResultsShorts": 0, "maxResultStreams": 0 },
  "lastHours": 24, "topN": 5
}
```
