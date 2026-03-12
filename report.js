import { Client } from "pg";
import servers from "./servers.json" assert { type: "json" };

function rdNow() {
  return new Date(new Date().toLocaleString("en-US", { timeZone: "America/Santo_Domingo" }));
}

function isResetHourRD() {
  const d = rdNow();
  return d.getHours() === 12 && d.getMinutes() === 0; // ✅ 12:00 PM RD
}

function minutesBetween(a, b) {
  return Math.floor((a.getTime() - b.getTime()) / 60000);
}

// ✅ LIVE CHECK (CFX) — players reales ahora mismo (MEJORADO)
async function getLivePlayers(serverCode) {
  const urls = [
    `https://servers-frontend.fivem.net/api/servers/single/${serverCode}`,
    `https://servers.fivem.net/api/servers/single/${serverCode}`,
  ];

  for (const url of urls) {
    try {
      const controller = new AbortController();
      const t = setTimeout(() => controller.abort(), 8000);

      const res = await fetch(url, {
        method: "GET",
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
          "Accept": "application/json,text/plain,*/*",
          "Accept-Language": "es-ES,es;q=0.9,en;q=0.8",
        },
        signal: controller.signal,
      });

      clearTimeout(t);

      if (!res.ok) continue;

      const data = await res.json();

      const raw =
        data?.Data?.clients ??
        data?.Data?.Clients ??
        data?.data?.clients ??
        data?.clients;

      const players = Number(raw);

      if (Number.isFinite(players)) return { ok: true, players, source: url };
    } catch {
      // sigue al próximo url
    }
  }

  return { ok: false };
}

// ✅ Concurrencia limitada
async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let idx = 0;

  async function worker() {
    while (idx < items.length) {
      const cur = idx++;
      results[cur] = await fn(items[cur], cur);
    }
  }

  const workers = Array.from({ length: Math.min(limit, items.length) }, worker);
  await Promise.all(workers);
  return results;
}

async function ensureMessageId(webhookBaseUrl) {
  if (process.env.DISCORD_MESSAGE_ID) return process.env.DISCORD_MESSAGE_ID;

  const initPayload = {
    content: "",
    embeds: [
      {
        title: "📊 TOP EN VIVO (FiveM)",
        description: "⏳ Inicializando… en breve aparecerá el top.",
        color: 7306,
        footer: { text: "By: JayyP" },
        image: {
          url: "https://media.discordapp.net/attachments/1442556589952208947/1474185621474902036/standard_1.gif?ex=6998edd9&is=69979c59&hm=b8dbbd2ff4e9e1690e944fdb91df86c9a95b7e90e9a034f0d5a5c98faf49f023&=",
        },
        timestamp: new Date().toISOString(),
      },
    ],
    attachments: [],
    allowed_mentions: { parse: [] },
  };

  const res = await fetch(`${webhookBaseUrl}?wait=true`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(initPayload),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Webhook POST(init) ${res.status}: ${text}`);
  }

  const data = await res.json();
  if (!data?.id) throw new Error("No message id returned from webhook.");

  console.log("Created initial message. Set DISCORD_MESSAGE_ID to:", data.id);
  return data.id;
}

// ✅ SOLO ESTA FUNCIÓN CAMBIÓ (retry automático)
async function patchMessage(webhookBase, messageId, payload, retries = 3) {
  const editUrl = `${webhookBase}/messages/${messageId}`;

  try {
    const res = await fetch(editUrl, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Webhook PATCH ${res.status}: ${text}`);
    }

  } catch (err) {

    if (retries > 0) {
      console.log("Webhook error, retrying in 5s...", retries);
      await new Promise(r => setTimeout(r, 5000));
      return patchMessage(webhookBase, messageId, payload, retries - 1);
    }

    console.error("Webhook failed after retries:", err);
  }
}

function buildResetRanking() {
  return "🔄 **Reinicio diario (12:00 PM RD)**\n\n🟢 En línea: **0** | 👥 Max: **0** | Avg: **0.0** | Muestras: 0";
}

// ✅ Ventana competitiva: 12:00 PM RD → ahora
function getCompetitiveWindowRD() {
  const now = rdNow();
  const start = new Date(now);
  start.setHours(12, 0, 0, 0);

  if (now.getHours() < 12) {
    start.setDate(start.getDate() - 1);
  }

  return { start, end: now };
}

async function main() {
  if (!process.env.DATABASE_URL) throw new Error("Missing DATABASE_URL");
  if (!process.env.DISCORD_WEBHOOK_URL) throw new Error("Missing DISCORD_WEBHOOK_URL");

  const webhookBase = process.env.DISCORD_WEBHOOK_URL;
  const messageId = await ensureMessageId(webhookBase);

  if (isResetHourRD()) {
    const payloadReset = {
      content: "",
      embeds: [
        {
          title: "📊 TOP EN VIVO (FiveM)",
          description: `(Actualiza cada 30 min | Métrica: Max players)\n\n${buildResetRanking()}`,
          color: 7306,
          footer: { text: "By: JayyP" },
          image: {
            url: "https://media.discordapp.net/attachments/1442556589952208947/1474185621474902036/standard_1.gif?ex=6998edd9&is=69979c59&hm=b8dbbd2ff4e9e1690e944fdb91df86c9a95b7e90e9a034f0d5a5c98faf49f023&=",
          },
          timestamp: new Date().toISOString(),
        },
      ],
      attachments: [],
      allowed_mentions: { parse: [] },
    };

    await patchMessage(webhookBase, messageId, payloadReset);
    console.log("Reset automático aplicado (12:00 PM RD). message:", messageId);
    return;
  }

  const { start, end } = getCompetitiveWindowRD();

  const codes = servers.map((s) => s.code);
  const names = servers.map((s) => s.name);

  const db = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });

  await db.connect();

  const { rows } = await db.query(
    `
    WITH srv AS (
      SELECT * FROM unnest($3::text[], $4::text[]) AS s(server_code, server_name)
    ),
    win AS (
      SELECT *
      FROM samples
      WHERE ts >= $1 AND ts <= $2
        AND server_code = ANY($3::text[])
    ),
    agg AS (
      SELECT
        server_code,
        MAX(players) AS max_players,
        ROUND(AVG(players)::numeric, 1) AS avg_players,
        COUNT(*) AS samples
      FROM win
      GROUP BY server_code
    ),
    latest_in_win AS (
      SELECT DISTINCT ON (server_code)
        server_code,
        players AS online_in_win,
        ts AS last_seen_in_win
      FROM win
      ORDER BY server_code, ts DESC
    )
    SELECT
      srv.server_code,
      srv.server_name,
      COALESCE(agg.max_players, 0) AS max_players,
      COALESCE(agg.avg_players, 0.0) AS avg_players,
      COALESCE(agg.samples, 0) AS samples,
      latest_in_win.online_in_win,
      latest_in_win.last_seen_in_win
    FROM srv
    LEFT JOIN agg ON agg.server_code = srv.server_code
    LEFT JOIN latest_in_win ON latest_in_win.server_code = srv.server_code
    `,
    [start.toISOString(), end.toISOString(), codes, names]
  );

  await db.end();

  const liveResults = await mapLimit(servers, 4, async (s) => {
    const live = await getLivePlayers(s.code);
    return { server_code: s.code, live };
  });
  const liveMap = new Map(liveResults.map((x) => [x.server_code, x.live]));

  const offlineMinutes = Number(process.env.OFFLINE_MINUTES || "45");
  const nowRD = rdNow();

  const ordered = [...rows].sort((a, b) => Number(b.max_players) - Number(a.max_players));
  const top = ordered.slice(0, 10);

  const rankingTexto =
    top.length > 0
      ? top
          .map((r, i) => {
            const medal =
              i === 0 ? "🥇" :
              i === 1 ? "🥈" :
              i === 2 ? "🥉" :
              `**${i + 1}.**`;

            const link = `https://servers.fivem.net/servers/detail/${r.server_code}`;

            const lastSeen = r.last_seen_in_win ? new Date(r.last_seen_in_win) : null;
            const minsAgo = lastSeen ? minutesBetween(nowRD, lastSeen) : 999999;

            const staleOffline = !lastSeen || minsAgo > offlineMinutes;
            const lastPlayers = Number(r.online_in_win ?? 0);

            const live = liveMap.get(r.server_code) || { ok: false };

            let statusLine;
            if (live.ok) {
              statusLine =
                live.players > 0
                  ? `🟢 En línea: **${live.players}**`
                  : `🔴 **OFFLINE**`;
            } else {
              if (staleOffline) {
                statusLine = `🔴 **OFFLINE**`;
              } else {
                statusLine = `🟡 En línea (último sample): **${lastPlayers}**`;
              }
            }

            const maxLine = `👥 Max: **${r.max_players}** | Avg: **${r.avg_players}** | Muestras: ${r.samples}`;
            const seenLine = `⏱️ Último ping: hace **${minsAgo} min**`;

            return `${medal} **${r.server_name}**\n${statusLine}\n${maxLine}\n${seenLine}\n🔗 ${link}`;
          })
          .join("\n\n")
      : "⏳ No hay datos todavía (esperando samples del collector).";

  const payload = {
    content: "",
    embeds: [
      {
        title: "📊 TOP EN VIVO (FiveM)",
        description: `(Reinicio diario: **12:00 PM RD** | Actualiza cada 30 min | Métrica: Max players)\n\n${rankingTexto}`,
        color: 7306,
        footer: { text: "By: JayyP" },
        image: {
          url: "https://media.discordapp.net/attachments/1442556589952208947/1474185621474902036/standard_1.gif?ex=6998edd9&is=69979c59&hm=b8dbbd2ff4e9e1690e944fdb91df86c9a95b7e90e9a034f0d5a5c98faf49f023&=",
        },
        timestamp: new Date().toISOString(),
      },
    ],
    attachments: [],
    allowed_mentions: { parse: [] },
  };

  await patchMessage(webhookBase, messageId, payload);
  console.log("Report updated. Window:", start.toISOString(), "→", end.toISOString(), "message:", messageId);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
