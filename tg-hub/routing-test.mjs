// tg-hub/routing-test.mjs
// Unit test for routing.mjs — pure state and formatting, no I/O.
// Run from repo root:  node tg-hub/routing-test.mjs
import assert from 'node:assert/strict';
import { createActive, createPending, buttonLabel, projectOf, groupSessions, stripActiveMark, PENDING_TTL_MS } from './routing.mjs';

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

// 4. подпись инлайн-кнопки — только имя, обрезка до 18
assert.equal(buttonLabel('Ревью-PRs'), 'Ревью-PRs');
assert.equal(buttonLabel('  Ревью-PRs  '), 'Ревью-PRs', 'пробелы по краям снимаются');
assert.equal(buttonLabel('Давай-разберем-что-можно-и-нельзя'), 'Давай-разберем-чт…', 'длинное режется до 18 с многоточием');
assert.equal(buttonLabel('Давай-разберем-что-можно-и-нельзя').length, 18);
assert.equal(buttonLabel(''), '');
assert.equal(buttonLabel(undefined), '');
ok('buttonLabel: только имя, обрезка до 18, пустое не роняет');

// 4b. проект и группировка для текста /sessions
assert.equal(projectOf('d:\\Projects\\vassav\\teamly'), 'teamly');
assert.equal(projectOf('/home/v/projects/teamly/'), 'teamly', 'хвостовой слэш не создаёт пустой проект');
assert.equal(projectOf(''), '?', 'без cwd — заглушка, а не пустая строка');
assert.equal(projectOf(undefined), '?');
const grouped = groupSessions([
  { id: 'a', label: 'Ревью', cwd: '/p/teamly' },
  { id: 'b', label: 'Сводка', cwd: '/p/hub' },
  { id: 'c', label: 'Правки', cwd: '/p/teamly' },   // возвращаемся к первому проекту
]);
assert.deepEqual(grouped.map(g => g.project), ['teamly', 'hub'], 'порядок проектов — по первому появлению');
assert.deepEqual(grouped[0].items.map(x => x.id), ['a', 'c'], 'сессии одного проекта собраны вместе');
assert.deepEqual(grouped[1].items.map(x => x.id), ['b']);
assert.deepEqual(groupSessions([]), []);
assert.deepEqual(groupSessions(undefined), [], 'undefined не роняет');
ok('projectOf / groupSessions: папка проекта, группировка, устойчивый порядок');

// 5. снятие отметки активной — так её рисует нижняя клавиатура: метка плюс ' ✓'
assert.equal(stripActiveMark('Ревью-PRs ✓'), 'Ревью-PRs');
assert.equal(stripActiveMark('Ревью-PRs'), 'Ревью-PRs');
assert.equal(stripActiveMark('  Ревью ✓  '), 'Ревью');
ok('stripActiveMark: снимает галочку и пробелы, без неё не портит');

// 6. круг для НИЖНЕЙ клавиатуры: она рисует голую метку, Telegram возвращает её текстом,
// хаб ищет сессию сравнением с меткой. Подпись инлайн-кнопки тут не участвует — там в
// callback_data лежит id и разбирать нечего.
const live = [
  { id: 'a', label: 'Ревью-PRs' },
  { id: 'b', label: 'Ревью' },          // метка — префикс другой
  { id: 'c', label: 'Ревью-PRs-2' },    // и суффикс тоже
];
for (const s of live) {
  const shown = s.label + ' ✓';                                  // как рисует replyKeyboard активную
  const found = live.find(x => x.label === stripActiveMark(shown));
  assert.equal(found.id, s.id, `круг для ${s.id}`);
}
for (const s of live) {                                          // и без галочки, для неактивных
  const found = live.find(x => x.label === stripActiveMark(s.label));
  assert.equal(found.id, s.id, `круг без галочки для ${s.id}`);
}
ok('круговой разбор нижней клавиатуры: метка ↔ тап, похожие метки не путаются');

console.log(`\n✅ routing-test: ${n} групп проверок пройдено`);
