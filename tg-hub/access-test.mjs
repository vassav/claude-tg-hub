// tg-hub/access-test.mjs
// Unit test for access.mjs — no network, no Telegram. Points the module at a temp
// state dir, so the real ~/.claude/channels/hub is untouched.
// Run from repo root:  node tg-hub/access-test.mjs
import { mkdtempSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import assert from 'node:assert/strict';
import * as access from './access.mjs';

const CFG = join(mkdtempSync(join(tmpdir(), 'access-test-')), 'hub');   // not created yet: save() must make it
access.init(CFG);
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
assert.equal(can('123', 'channel'), false, 'списочник в channel — нельзя');
assert.equal(can('123', undefined), false, 'списочник без chatType — нельзя');
assert.equal(can(OWNER, 'group'), true, 'владелец в group');
assert.equal(can(OWNER, 'channel'), true, 'владелец в channel');
assert.equal(can(OWNER, undefined), true, 'владелец без chatType');
assert.equal(can('999', 'group'), false, 'чужак в группе');
assert.equal(can('123', 'group', true), false, 'бот');
access.remove('123');
assert.equal(can('123', 'group'), false, 'пустой список — не проходит никто, кроме владельца');
assert.equal(can(OWNER, 'private'), true);
// falsy owner guard
access.add('123', 'ivan', OWNER);
const canNoOwner = (userId, chatType, isBot = false) => access.canUse({ userId, chatType, isBot }, { owner: undefined });
const canEmptyOwner = (userId, chatType, isBot = false) => access.canUse({ userId, chatType, isBot }, { owner: '' });
assert.equal(canNoOwner(undefined, 'private'), false, 'undefined owner, undefined userId → false');
assert.equal(canNoOwner('999', 'private'), false, 'undefined owner, random userId → false');
assert.equal(canNoOwner('123', 'group'), false, 'undefined owner, listed user in group → false');
assert.equal(canEmptyOwner(undefined, 'private'), false, 'empty owner, undefined userId → false');
assert.equal(canEmptyOwner('999', 'private'), false, 'empty owner, random userId → false');
assert.equal(canEmptyOwner('123', 'group'), false, 'empty owner, listed user in group → false');
ok('canUse: таблица гейта');

// 7. parseTarget
assert.deepEqual(access.parseTarget('', { id: 55, username: 'vasya' }), { id: '55', name: 'vasya' });
assert.deepEqual(access.parseTarget('', { id: 55, first_name: 'Вася' }), { id: '55', name: 'Вася' });
assert.deepEqual(access.parseTarget('42 Петя', null), { id: '42', name: 'Петя' });
assert.deepEqual(access.parseTarget('42', null), { id: '42', name: '42' });
assert.equal(access.parseTarget('не число', null), null);
assert.equal(access.parseTarget('', null), null);
ok('parseTarget: реплай, "<id> имя", "<id>", мусор');

// 8. inRoots
assert.equal(access.inRoots('D:\\Anything', []), true, 'без корней — всё');
assert.equal(access.inRoots('', ['D:\\Work']), false, 'пустой cwd при корнях — нет');
if (process.platform === 'win32') {
  const roots = ['D:\\Work', 'E:\\Lab\\'];
  assert.equal(access.inRoots('D:\\Work', roots), true, 'сам корень');
  assert.equal(access.inRoots('d:/work/proj/sub', roots), true, 'внутри, другой регистр и слэши');
  assert.equal(access.inRoots('E:\\Lab\\x', roots), true, 'второй корень, корень со слэшем на конце');
  assert.equal(access.inRoots('D:\\Workshop', roots), false, 'соседняя папка с общим префиксом');
  assert.equal(access.inRoots('D:\\Work\\..\\Other', roots), false, 'выход через ..');
  assert.equal(access.inRoots('D:\\Work\\..foo', roots), true, 'папка, начинающаяся с ..');
  assert.equal(access.inRoots('C:\\Work', roots), false, 'другой диск');
} else {
  const roots = ['/work', '/lab/'];
  assert.equal(access.inRoots('/work/proj', roots), true, 'внутри');
  assert.equal(access.inRoots('/workshop', roots), false, 'общий префикс');
  assert.equal(access.inRoots('/work/../etc', roots), false, 'выход через ..');
}
ok('inRoots: корень, вложенность, регистр, префикс, .., диск');

console.log(`\n✅ access-test: ${n} групп проверок пройдено`);
