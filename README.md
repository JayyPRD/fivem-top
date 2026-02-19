# FIVEM TOP (Recolector + Reporte)

## Archivos
- collector.js -> recolecta players y guarda en Postgres
- report.js -> genera TOP diario y lo manda por webhook
- servers.json -> lista de servidores
- package.json

## Scripts
npm run collect
npm run report

## Variables de entorno
- DATABASE_URL
- DISCORD_WEBHOOK_URL
