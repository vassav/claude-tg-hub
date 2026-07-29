// tg-hub/access-test.mjs
// Unit test for access.mjs — no network, no Telegram. Redirects HOME/USERPROFILE to a
// temp dir BEFORE importing the module, so the real ~/.claude/channels/hub is untouched.
// Run from repo root:  node tg-hub/access-test.mjs
import { mkdtempSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import assert from 'node:assert/strict';

const HOME = mkdtempSync(join(tmpdir(), 'access-test-'));
process.env.HOME = HOME; process.env.USERPROFILE = HOME;   // must happen BEFORE the import below
const CFG = join(HOME, '.claude', 'channels', 'hub');

const access = await import('./access.mjs');
let n = 0; const ok = m => { n++; console.log('  ✓', m); };

// 1. пустой старт — файла нет
assert.equal(access.roleOf('123'), null);
assert.deepEqual(access.list(), []);
ok('пустой старт: файла нет, ошибок нет');

// 2. add
assert.equal(access.add('123', 'ivan', '300447655'), true);
assert.equal(access.roleOf('123'), 'owner');
assert.equal(access.add('123', 'ivan', '300447655'), false);      // повторное добавление
const [u] = access.list();
assert.equal(u.id, '123'); assert.equal(u.name, 'ivan'); assert.equal(u.by, '300447655');
assert.ok(u.added, 'added — ISO-таймстамп');
ok('add: роль, имя, by, added; повтор → false');

// 3. персист
access.reload();
assert.equal(access.roleOf('123'), 'owner');
ok('персист переживает reload()');

// 4. remove
assert.equal(access.remove('123'), true);
assert.equal(access.remove('123'), false);
access.reload();
assert.equal(access.roleOf('123'), null);
ok('remove: удаляет в памяти и на диске');

// 5. битый JSON
access.add('777', 'x', '1');
writeFileSync(join(CFG, 'access.json'), '{ not json');
access.reload();
assert.equal(access.roleOf('777'), null);
assert.ok(readdirSync(CFG).some(f => f.startsWith('access.json.corrupt-')), 'бэкап создан');
ok('битый JSON: бэкап создан, список пуст, исключения нет');

// 6. canUse — таблица гейта из §2 спеки
const OWNER = '300447655';
access.add('123', 'ivan', OWNER);
const can = (userId, chatType, isBot = false) => access.canUse({ userId, chatType, isBot }, { owner: OWNER });
assert.equal(can(OWNER, 'private'), true, 'владелец в личке');
assert.equal(can(OWNER, 'supergroup'), true, 'владелец в группе');
assert.equal(can('123', 'group'), true, 'списочник в группе');
assert.equal(can('123', 'supergroup'), true, 'списочник в супергруппе');
assert.equal(can('123', 'private'), false, 'списочник в личке — нельзя');
assert.equal(can('999', 'group'), false, 'чужак в группе');
assert.equal(can('123', 'group', true), false, 'бот');
access.remove('123');
assert.equal(can('123', 'group'), false, 'пустой список — не проходит никто, кроме владельца');
assert.equal(can(OWNER, 'private'), true);
ok('canUse: таблица гейта');

// 7. parseTarget
assert.deepEqual(access.parseTarget('', { id: 55, username: 'vasya' }), { id: '55', name: 'vasya' });
assert.deepEqual(access.parseTarget('', { id: 55, first_name: 'Вася' }), { id: '55', name: 'Вася' });
assert.deepEqual(access.parseTarget('42 Петя', null), { id: '42', name: 'Петя' });
assert.deepEqual(access.parseTarget('42', null), { id: '42', name: '42' });
assert.equal(access.parseTarget('не число', null), null);
assert.equal(access.parseTarget('', null), null);
ok('parseTarget: реплай, "<id> имя", "<id>", мусор');

console.log(`\n✅ access-test: ${n} групп проверок пройдено`);
