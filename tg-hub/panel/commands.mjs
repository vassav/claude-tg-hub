// Shared control-protocol command logic for stream-json sessions, used by BOTH
// the VSCode-panel interposer and the hub-launched headless client. Maps Telegram
// commands to the stream-json control-protocol the panel itself uses:
//   /context   -> control_request{get_context_usage}  -> categories/percentage
//   /rc        -> control_request{remote_control}      -> session_url
//   /limits    -> control_request{get_usage}          -> rate_limits (5h + weekly %)
//   /interrupt -> control_request{interrupt}
//   /compact   -> injected as a user-turn (/compact)   [caller-supplied injectUser]
import { randomUUID } from 'node:crypto';

function fmtK(n) { return n >= 1000 ? (n / 1000).toFixed(n >= 100000 ? 0 : 1).replace(/\.0$/, '') + 'k' : String(n); }
function fmtContext(r) {
  const head = `🧮 Контекст: ${r.percentage ?? '?'}% (${(r.totalTokens || 0).toLocaleString('ru-RU')} / ${(r.maxTokens || 0).toLocaleString('ru-RU')})`;
  const cats = (r.categories || []).filter(c => c.name !== 'Free space' && c.tokens > 0).sort((a, b) => b.tokens - a.tokens).slice(0, 6)
    .map(c => `• ${c.name}: ${fmtK(c.tokens)}`).join('\n');
  return cats ? head + '\n' + cats : head;
}
function fmtReset(iso) {
  try {
    const d = new Date(iso), now = new Date();
    const hh = String(d.getHours()).padStart(2, '0'), mm = String(d.getMinutes()).padStart(2, '0');
    return d.toDateString() === now.toDateString()
      ? `${hh}:${mm}`
      : `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')} ${hh}:${mm}`;
  } catch { return ''; }
}
// get_usage.response.rate_limits: { five_hour:{utilization(0-100), resets_at}, seven_day:{…}, seven_day_sonnet:{…} }
function fmtUsage(r) {
  const rl = r.rate_limits;
  if (!r.rate_limits_available || !rl) return '⏳ лимиты пока недоступны';
  const row = (label, x) => (x && x.utilization != null) ? `${label}: ${x.utilization}%${x.resets_at ? ` (сброс ${fmtReset(x.resets_at)})` : ''}` : null;
  const lines = [row('⏳ 5ч', rl.five_hour), row('📅 неделя', rl.seven_day), row('📅 неделя·Sonnet', rl.seven_day_sonnet)].filter(Boolean);
  return lines.length ? lines.join('\n') : '⏳ лимиты пока недоступны';
}

// deps: { toEngine(obj), sendHub(obj), sessionId (string | () => string), owner, injectUser(text) }
export function createCommands({ toEngine, sendHub, sessionId, owner, injectUser }) {
  const pending = new Map(); // myRequestId -> { kind, chat_id, timer }

  const sid = () => (typeof sessionId === 'function' ? sessionId() : sessionId); // may be late-bound (interposer)
  const replyTo = (chat_id, text) => sendHub({ t: 'reply', sessionId: sid(), chat_id: chat_id || owner, text });
  function issue(subtype, extra, kind, chat_id) {
    const request_id = 'tg_' + randomUUID().slice(0, 12);
    const timer = setTimeout(() => { if (pending.delete(request_id)) replyTo(chat_id, '⚠️ сессия не ответила на запрос'); }, 8000);
    pending.set(request_id, { kind, chat_id, timer });
    toEngine({ type: 'control_request', request_id, request: { subtype, ...(extra || {}) } });
  }

  return {
    handle(name, chat_id) {
      switch (name) {
        case 'context': return issue('get_context_usage', {}, 'context', chat_id);
        case 'rc': case 'remote_control': return issue('remote_control', { enabled: true }, 'rc', chat_id);
        case 'limits': return issue('get_usage', {}, 'usage', chat_id);
        case 'interrupt': toEngine({ type: 'control_request', request_id: 'tg_int_' + randomUUID().slice(0, 8), request: { subtype: 'interrupt' } }); return replyTo(chat_id, '⏹ Прервано');
        case 'compact': injectUser('/compact'); return replyTo(chat_id, '🗜 Запустил /compact…');
        default: return replyTo(chat_id, `неизвестная команда: ${name}`);
      }
    },
    // True if this control_response answered one of OUR requests (caller should not
    // forward it to the extension). Sends the formatted result to Telegram.
    onControlResponse(o) {
      const rid = o.response?.request_id;
      const pc = rid && pending.get(rid);
      if (!pc) return false;
      clearTimeout(pc.timer); pending.delete(rid);
      const r = o.response?.response || {};
      if (pc.kind === 'context') replyTo(pc.chat_id, fmtContext(r));
      else if (pc.kind === 'rc') replyTo(pc.chat_id, r.session_url ? `🌐 Remote control:\n${r.session_url}\n\nОткрой ссылку на телефоне / в claude.ai, чтобы продолжить сессию.` : '⚠️ не удалось включить remote-control');
      else if (pc.kind === 'usage') replyTo(pc.chat_id, fmtUsage(r));
      return true;
    },
  };
}
