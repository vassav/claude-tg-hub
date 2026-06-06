#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// claude-tg-hub — Phase-1 PROTOCOL SPIKE: минимальный Claude Code "channel" сервер.
//
// Цель спайка (НЕ продакшн): доказать, что НАШ собственный MCP-сервер может
// зацепиться как `--channels server:hub` на целевой версии claude.exe и
// увидеть реальный wire-протокол канала:
//   1) движок спавнит нас и проходит MCP `initialize` (мы объявляем channel-capability);
//   2) мы ловим `permission_request` (аппрув) и можем ответить решением;
//   3) мы можем ИНЖЕКТНУТЬ входящее сообщение в сессию (`notifications/claude/channel`).
//
// Транспорт MCP stdio = JSON-RPC 2.0, по одному сообщению на строку (newline-delimited).
// ВАЖНО: stdout — это канал протокола. Любой лог идёт в stderr + файл, НИКОГДА в stdout.
// ─────────────────────────────────────────────────────────────────────────────
import { appendFileSync, watch, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, basename } from 'node:path';

const DIR = dirname(fileURLToPath(import.meta.url));
// Пути лога/инъекции настраиваемы через env (чтобы тест-папка была самодостаточной).
const LOG = process.env.CHANNEL_LOG || join(DIR, 'channel.log');
const INJECT = process.env.CHANNEL_INJECT || join(DIR, 'inject.txt'); // запиши сюда текст -> уйдёт в сессию как входящее

function log(tag, data) {
  const line = `[${new Date().toISOString()}] ${tag} ${data === undefined ? '' : JSON.stringify(data)}\n`;
  try { appendFileSync(LOG, line); } catch { /* ignore */ }
  try { process.stderr.write(line); } catch { /* ignore */ }
}

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n');
  log('OUT', msg);
}

log('START', { argv: process.argv.slice(2), cwd: process.cwd(), pid: process.pid });

// ── stdin: построчный JSON-RPC ───────────────────────────────────────────────
let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buf += chunk;
  let idx;
  while ((idx = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); }
    catch { log('PARSE_ERR', { raw: line.slice(0, 500) }); continue; }
    try { handle(msg); }
    catch (e) { log('HANDLE_ERR', { err: String(e), msg }); }
  }
});
process.stdin.on('end', () => { log('STDIN_END'); process.exit(0); });

// ── обработчик входящих JSON-RPC ─────────────────────────────────────────────
function handle(msg) {
  log('IN', msg);
  const { id, method, params } = msg;

  // Ответ движка на НАШ запрос (например, на наш notifications-ответ) — просто лог.
  if (method === undefined) { log('RESULT/ACK', msg); return; }

  if (method === 'initialize') {
    send({
      jsonrpc: '2.0', id,
      result: {
        protocolVersion: params?.protocolVersion || '2025-06-18',
        capabilities: {
          // ⭐ ключевое: объявляем обе channel-capability
          experimental: { 'claude/channel': {}, 'claude/channel/permission': {} },
          tools: {},
        },
        serverInfo: { name: 'tg-hub-channel-spike', version: '0.0.1' },
      },
    });
    return;
  }

  if (method === 'notifications/initialized') { return; } // нотификация, без ответа

  if (method === 'tools/list') {
    send({
      jsonrpc: '2.0', id,
      result: {
        tools: [{
          name: 'reply',
          description: 'Send a text reply out over the channel (spike: logged only).',
          inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
        }],
      },
    });
    return;
  }

  if (method === 'tools/call') {
    log('TOOL_CALL', params);
    send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: '(spike) reply logged' }] } });
    return;
  }

  // ⭐ Headline-фича: запрос аппрува по каналу. Имя метода может отличаться —
  // ловим по подстроке, чтобы спайк пережил расхождение в наименовании.
  if (method.includes('permission')) {
    const requestId = params?.request_id ?? params?.requestId ?? params?.id;
    log('PERMISSION_REQUEST', { method, params });
    // авто-allow; эхо request_id обратно
    send({
      jsonrpc: '2.0',
      method: 'notifications/claude/channel/permission',
      params: { request_id: requestId, behavior: 'allow' },
    });
    return;
  }

  // Неизвестный запрос (есть id) — корректный method-not-found, чтобы не стопать handshake.
  if (id !== undefined) {
    log('UNKNOWN_REQUEST', { method });
    send({ jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } });
    return;
  }

  log('UNKNOWN_NOTIFICATION', { method });
}

// ── Инъекция входящего сообщения для теста (без Telegram) ─────────────────────
// Запиши текст в inject.txt -> уйдёт в сессию как `notifications/claude/channel`.
try { if (existsSync(INJECT)) writeFileSync(INJECT, ''); } catch { /* ignore */ }
try {
  const injectDir = dirname(INJECT);
  const injectName = basename(INJECT);
  watch(injectDir, (_ev, file) => {
    if (file !== injectName || !existsSync(INJECT)) return;
    let content = '';
    try { content = readFileSync(INJECT, 'utf8').trim(); } catch { return; }
    if (!content) return;
    send({
      jsonrpc: '2.0',
      method: 'notifications/claude/channel',
      params: {
        content,
        meta: {
          chat_id: 'spike', message_id: String(Date.now()),
          user: 'spike', user_id: '0', ts: new Date().toISOString(),
        },
      },
    });
    try { writeFileSync(INJECT, ''); } catch { /* ignore */ }
  });
} catch (e) { log('WATCH_ERR', { err: String(e) }); }
