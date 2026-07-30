// tg-hub/routing-test.mjs
// Unit test for routing.mjs — pure state and formatting, no I/O.
// Run from repo root:  node tg-hub/routing-test.mjs
import assert from 'node:assert/strict';
import { createActive, createPending, sessionButton, stripActiveMark, PENDING_TTL_MS } from './routing.mjs';

let n = 0; const ok = m => { n++; console.log('  ✓', m); };

// 1. активная сессия — своя в каждом чате
const A = createActive();
assert.equal(A.get('300447655'), null, 'пустая карта — null, не undefined');
A.set('300447655', 's1');
A.set('-100123', 's2');
assert.equal(A.get('300447655'), 's1');
assert.equal(A.get('-100123'), 's2', 'второй чат не затронут первым');
A.set('300447655', 's3');                       // повторный set заменяет
assert.equal(A.get('300447655'), 's3');
assert.equal(A.get('-100123'), 's2');
assert.equal(A.get(300447655), 's3', 'числовой chatId эквивалентен строковому');
ok('createActive: чаты независимы, set заменяет, ключ нормализуется');

// 2. clearSession убирает сессию изо всех чатов и только её
A.set('-100999', 's2');
assert.deepEqual(A.chatsFor('s2').sort(), ['-100123', '-100999']);
A.clearSession('s2');
assert.equal(A.get('-100123'), null);
assert.equal(A.get('-100999'), null);
assert.equal(A.get('300447655'), 's3', 'чужая сессия не тронута');
A.clearSession('никогда-не-было');              // не бросает
ok('clearSession: чистит все чаты сессии, остальные не трогает');

// 3. придержанный текст
const P = createPending(1000);
assert.equal(P.take('c1'), null, 'ничего не клали — null');
P.put('c1', 'первый', 0);
P.put('c1', 'второй', 10);                      // второе сообщение ЗАМЕНЯЕТ первое
assert.equal(P.take('c1', 20), 'второй');
assert.equal(P.take('c1', 20), null, 'take одноразовый');
P.put('c2', 'протухнет', 0);
assert.equal(P.take('c2', 1001), null, 'после ttl не отдаётся');
P.put('c3', 'ещё живой', 0);
assert.equal(P.take('c3', 999), 'ещё живой', 'внутри ttl отдаётся');
assert.equal(PENDING_TTL_MS, 600000);
ok('createPending: замена, одноразовость, протухание по ttl');

// 4. подпись кнопки
assert.equal(sessionButton({ label: 'Ревью-PRs', cwd: 'd:\\Projects\\vassav\\teamly' }), 'teamly · Ревью-PRs');
assert.equal(sessionButton({ label: 'Ревью-PRs', cwd: '/home/v/projects/teamly/' }), 'teamly · Ревью-PRs', 'хвостовой слэш не создаёт пустой проект');
assert.equal(sessionButton({ label: 'Ревью-PRs', cwd: '' }), 'Ревью-PRs', 'без cwd — только метка, без разделителя');
assert.equal(sessionButton({ label: 'Ревью-PRs' }), 'Ревью-PRs', 'cwd вообще отсутствует');
// обрезка: проект 27 симв. -> slice(0,13)+'…', метка 33 симв. -> slice(0,21)+'…'
assert.equal(sessionButton({ label: 'Давай-разберем-что-можно-и-нельзя', cwd: 'd:\\p\\very-long-project-name-here' }),
  'very-long-pro… · Давай-разберем-что-мо…', 'проект до 14, метка до 22, с многоточием');
ok('sessionButton: проект · метка, обрезка, отсутствующий cwd');

// 5. снятие отметки активной
assert.equal(stripActiveMark('teamly · Ревью-PRs ✓'), 'teamly · Ревью-PRs');
assert.equal(stripActiveMark('teamly · Ревью-PRs'), 'teamly · Ревью-PRs');
assert.equal(stripActiveMark('  teamly · Ревью ✓  '), 'teamly · Ревью');
ok('stripActiveMark: снимает галочку и пробелы, без неё не портит');

// 6. круг: подпись → строка → поиск находит ТУ ЖЕ сессию среди похожих
const live = [
  { id: 'a', label: 'Ревью-PRs', cwd: '/p/teamly' },
  { id: 'b', label: 'Ревью-PRs', cwd: '/p/other' },   // одинаковые метки, разные проекты
  { id: 'c', label: 'Ревью', cwd: '/p/teamly' },      // метка — префикс другой
  { id: 'd', label: '  Ревью-Фиксы  ', cwd: '  /p/other  ' },  // с пробелами — нормализуется
];
for (const s of live) {
  const shown = sessionButton(s) + ' ✓';
  const found = live.find(x => sessionButton(x) === stripActiveMark(shown));
  assert.equal(found.id, s.id, `круг для ${s.id}`);
}
ok('круговой разбор: похожие метки различаются по проекту');

console.log(`\n✅ routing-test: ${n} групп проверок пройдено`);
