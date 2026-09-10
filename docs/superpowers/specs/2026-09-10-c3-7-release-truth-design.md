# C3.7 — Единая версия и вычисляемая истина выпуска

Дата: 2026-09-10  
Дорожная карта: #370  
Родительская фаза: #378  
Принятая база: `3cf78ea0472f84438967f55ad7ed9212972ffc28`  
Зависимость #377: завершена

## 1. Решение

C3.7 использует одну каноническую версию продукта:

```text
package.json.version
```

Отдельного состояния выпуска нет. Оно вычисляется из фактов `Git` и `GitHub`:

```text
package.json.version = X.Y.Z
        ↓
expected tag = vX.Y.Z
        ↓
tag resolves to exact commit
        ↓
published GitHub Release for the same tag
        ↓
released | unreleased
```

`released` и `unreleased` — результат проверки, а не сохраняемое поле.

Главный инвариант:

```text
если для ответа «эта версия выпущена?»
нужно читать ещё один собственный файл repo-guard,
дизайн нарушен
```

## 2. Единственный источник версии

Каноническая версия читается только из:

```text
package.json.version
```

Не создаются:

```text
VERSION
release-state.json
target-version.json
persisted RELEASED / UNRELEASED
version field in repo-policy.json
```

`package-lock.json` может содержать то же значение как обязательное зеркало `npm`. Это не второй источник истины.

Правило:

```text
package.json.version = authority
package-lock.json version fields = derived mirror
```

При изменении версии `package-lock.json` обязан синхронно обновиться и совпасть с `package.json`, но версия никогда не определяется из `package-lock.json`.

## 3. Переход на `3.0.0`

Архитектурное сжатие 3.0 — несовместимая публичная граница, поэтому C3.7 меняет:

```text
2.0.0 -> 3.0.0
```

Это ещё не выпуск.

После принятия C3.7 ожидается:

```text
package.json.version = 3.0.0
expected tag = v3.0.0
tag = absent
published release = absent
state = unreleased
```

Не вводятся промежуточные сущности только ради внутреннего процесса:

```text
NO 3.0.0-dev
NO 3.0.0-rc
NO separate target version
```

## 4. Граница C3.7 и C3.10

C3.7 создаёт строгую проверяемую границу выпуска, но не публикует `v3.0.0`.

```text
C3.7
  version = 3.0.0
  + strict verifier
  + tests
  + docs
  + Pages projection
        ↓
C3.8
        ↓
C3.9
        ↓
C3.10 final acceptance
        ↓
exact accepted SHA S
        ↓
tag v3.0.0 -> S
        ↓
published GitHub Release v3.0.0
        ↓
release verification
        ↓
optional npm publish
```

До C3.10 потребители используют полный неизменяемый `SHA`.

## 5. Формальная истина выпуска

Для версии `X.Y.Z` и точного коммита `S`:

```text
released(X.Y.Z, S) :=
  package.json.version == X.Y.Z
  AND expected_tag == "v" + X.Y.Z
  AND tag(expected_tag) exists
  AND resolve_tag_to_commit(expected_tag) == S
  AND matching GitHub Release exists
  AND release.draft == false
  AND release.prerelease == false
```

Отдельный `release_commit` не хранится.

Точный коммит выпуска определяется неизменяемым тегом:

```text
vX.Y.Z -> exact commit S
```

`GitHub Release` подтверждает публикацию этого же тега.

## 6. Лёгкие и аннотированные теги

Проверка обязана разрешать оба вида тегов.

Лёгкий:

```text
refs/tags/vX.Y.Z -> commit S
```

Аннотированный:

```text
refs/tags/vX.Y.Z -> tag object -> ... -> commit S
```

Конечный объект обязан иметь тип `commit`.

Неизвестная, циклическая или неразрешимая цепочка завершается ошибкой.

## 7. Источник ожидаемого `SHA`

Новый файл с `SHA` не нужен.

При строгой проверке ожидаемый коммит — текущая рабочая копия:

```text
git rev-parse HEAD
```

В `GitHub Actions` процесс выпуска сначала делает `checkout` официального тега, затем существующий проверяющий скрипт доказывает:

```text
remote tag -> exact current HEAD
```

Если точный `HEAD` недоступен там, где требуется доказательство официального выпуска, проверка завершается ошибкой.

## 8. Один проверяющий механизм

Существующий:

```text
scripts/verify-release-ref.mjs
```

остаётся единственной строгой границей проверки выпуска.

Он уже проверяет имя версии, существование тега и выпуска. C3.7 усиливает именно его:

```text
1. read package.json.version
2. compute v<version>
3. require supplied tag == expected tag
4. read tag ref
5. resolve tag objects to commit SHA
6. read exact checkout HEAD
7. require resolved tag SHA == HEAD
8. read GitHub Release for the same tag
9. require exact matching tag_name
10. require draft == false
11. require prerelease == false
12. return structured PASS / FAIL evidence
```

Новый параллельный проверяющий механизм не создаётся.

## 9. Ошибки и запрет по умолчанию

Строгая проверка даёт `FAIL`, если:

```text
package version invalid
supplied tag mismatches package version
tag absent
GitHub API unavailable
tag object malformed
tag chain cannot resolve to commit
resolved commit != current HEAD
release absent
release malformed
release draft
release prerelease
release tag_name mismatches expected tag
```

Ответ `200 OK` с неполными данными не считается успехом.

Ошибка `GitHub API` не превращается в «релиз отсутствует».

## 10. Наблюдение и строгая проверка

Сохраняем две разные операции, но не две истины.

```text
strict verification
  -> verify-release-ref
  -> release-integrity
  -> prepublishOnly
  -> PASS / FAIL

read-only observation
  -> Policy Observatory
  -> package-only | published representation
```

Общая внутренняя функция допустима только если действительно уменьшает дублирование. Создавать новую библиотеку ради симметрии запрещено.

## 11. `Policy Observatory`

Обсерватория остаётся проекцией только для чтения.

До C3.10 она должна честно показывать:

```text
Версия пакета: 3.0.0
Ожидаемый тег: v3.0.0
Опубликованный выпуск: отсутствует
```

После реального выпуска:

```text
Версия пакета: 3.0.0
Тег: v3.0.0
Опубликованный выпуск: присутствует
Точный commit: S
```

Она не хранит состояние выпуска и не получает функций записи.

## 12. `init` и потребители

Модель ссылок остаётся простой:

```text
candidate / unreleased -> full 40-char SHA
published release      -> exact vX.Y.Z
```

Не рекомендуются и не создаются псевдонимы:

```text
main
latest
v3
v3.0
```

C3.7 не добавляет поддержку устаревшей совместимости.

`init` не обязан заново выполнять полную проверку выпуска. Его задача — принять только синтаксически допустимый неизменяемый `SHA` или строгий тег версии, совпадающий с текущей версией из `package.json`.

## 13. Официальный выпуск

После C3.10 последовательность минимальна:

```text
A. main = exact accepted candidate S
B. required checks for S = GREEN
C. package.json.version already = 3.0.0
D. create tag v3.0.0 -> S
E. publish non-prerelease GitHub Release v3.0.0
F. release-integrity checks out v3.0.0
G. verify-release-ref proves tag -> S and release published
H. only then npm publish is allowed
```

Между `S` и созданием тега не допускается изменение семантики или кода.

Если требуется исправление, создаётся новый PR, появляется новый принятый `SHA`, и финальная приёмка повторяется.

## 14. `npm publish`

Существующий `prepublishOnly` остаётся границей с запретом по умолчанию.

После C3.7 пакет нельзя опубликовать, если не доказано:

```text
package version matches tag
AND tag resolves to current exact checkout
AND matching published non-prerelease release exists
```

Это блокирует публикацию с неправильного или устаревшего коммита.

## 15. `release-integrity`

Существующий процесс:

```text
.github/workflows/release-integrity.yml
```

остаётся проверкой только для чтения.

```text
release published
      ↓
checkout release tag
      ↓
verify-release-ref
      ↓
PASS | FAIL
```

Он не создаёт теги, выпуски или пакеты.

Права на запись для него не нужны.

Если C3.7 меняет этот `workflow`, изменение требует отдельного доверенного `GovernanceGrant` только на нужный управляющий путь.

## 16. Семантическое версионирование

Правило остаётся обычным:

```text
breaking public contract -> major
compatible additive capability -> minor
compatible correctness fix -> patch
```

Архитектурное сжатие 3.0 — несовместимый мажорный переход, поэтому текущая целевая версия:

```text
3.0.0
```

Устаревшие псевдонимы не сохраняются ради уменьшения номера версии.

## 17. Документация

C3.7 синхронизирует только публичные места, связанные с истиной версии и выпуска:

```text
package.json
package-lock.json as derived npm mirror
README.md
RELEASING.md
release verifier tests
release workflow contract tests where needed
Policy Observatory projection/tests where needed
```

Документация до C3.10 не должна утверждать, что `v3.0.0` уже выпущен.

## 18. Публичная CLI не растёт

C3.7 не добавляет команды:

```text
repo-guard release
repo-guard publish
repo-guard version-state
```

Публичный набор остаётся:

```text
validate
check-diff
check-pr
init
doctor
```

`npm run verify:release-ref` остаётся внутренним инструментом выпуска.

## 19. Ядро политики не растёт

C3.7 не добавляет:

```text
FactRef source
relation descriptor
runtime constraint kind
release-specific policy DSL
second evaluator
```

Истина выпуска — продуктовая граница, а не новый язык политики.

## 20. Направление реализации через TDD

План реализации должен начинать каждый поведенческий срез с проверки, которая сначала падает.

Минимальные доказательства:

```text
A. version cutover
   package.json/package-lock -> 3.0.0
   Pages/docs still say unreleased

B. wrong exact commit
   RED: correct tag name points to another commit and old verifier passes
   GREEN: verifier rejects it

C. annotated tag
   RED: tag object SHA is mistaken for commit SHA
   GREEN: resolution reaches exact commit

D. malformed/prerelease release
   RED: insufficient successful response passes
   GREEN: fail-closed

E. release workflow
   same verifier proves checked-out tag == remote tag commit
```

План реализации может объединить такие проверки, если это уменьшает число транзакций без потери наблюдаемого перехода `RED → GREEN`.

## 21. Не входит в C3.7

```text
NO actual v3.0.0 tag
NO actual GitHub Release v3.0.0
NO npm publication
NO tag/release write automation
NO changelog subsystem
NO floating major tag
NO speculative signing subsystem
NO speculative SBOM/provenance subsystem
NO C3.8 CI redesign
NO C3.9 final docs sweep
NO C3.10 external acceptance
```

C3.7 создаёт истину выпуска, а не платформу выпуска.

## 22. Критерии приёмки

C3.7 завершена, когда доказано:

```text
1. package.json.version = only canonical version authority
2. package-lock version = derived matching mirror
3. accepted package version = 3.0.0
4. no v3.0.0 tag/release still means unreleased
5. expected tag derives from package version
6. lightweight tag resolves to exact current commit
7. annotated tag resolves to exact current commit
8. wrong commit is rejected
9. matching GitHub Release must be published, non-draft, non-prerelease
10. malformed/API errors fail closed
11. prepublishOnly uses the same strict verifier
12. release-integrity uses the same strict verifier
13. Pages shows release truth without authority
14. README/RELEASING do not claim v3.0.0 is released before C3.10
15. candidate consumers use immutable SHA
16. public CLI does not grow
17. policy semantic core does not grow
18. no second stored release-state/version authority exists
```

После этого #378 может быть закрыта как завершённая. Официальный выпуск `v3.0.0` остаётся задачей C3.10.

## 23. Инвариант простоты

Итоговую модель должно быть возможно объяснить одной цепочкой:

```text
package.json.version
        ↓
v<version>
        ↓
exact immutable tag commit
        ↓
published GitHub Release
```

Никакой дополнительной сущности между этими четырьмя фактами C3.7 не вводит.
