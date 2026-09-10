# C3.7 — Единая версия и вычисляемая истина выпуска

Дата: 2026-09-10  
Дорожная карта: #370  
Родительская фаза: #378  
Принятая база: `3cf78ea0472f84438967f55ad7ed9212972ffc28`  
Зависимость #377: закрыта как завершённая

## 1. Решение

C3.7 вводит минимальную универсальную модель версии и выпуска для `repo-guard`.

Хранимая версия существует ровно в одном месте:

```text
package.json.version
```

C3.7 не создаёт второй файл версии, отдельный статус выпуска или специальную модель жизненного цикла.

Все остальные факты выводятся:

```text
package.json.version = X.Y.Z
        ↓
expected tag = vX.Y.Z
        ↓
Git tag exists?
        ↓
tag resolves to exact commit
        ↓
published GitHub Release for vX.Y.Z exists?
        ↓
released | unreleased
```

Слова `released` и `unreleased` являются результатом проверки, а не сохраняемым состоянием.

Архитектурный ответ C3.7:

```text
Can release truth be derived from one persisted version
and immutable Git/GitHub facts without a release-state subsystem?
YES.
```

## 2. Главный принцип

Система не хранит то, что можно однозначно вывести.

Хранимая истина:

```text
package.json.version
```

Наблюдаемые факты:

```text
Git tag refs
Git tag objects when annotated
Git commit objects
GitHub Releases
current exact checkout SHA
```

Вычисляемая истина:

```text
expected tag
resolved tag commit
matching published release
released/unreleased
```

Запрещены параллельные источники:

```text
NO VERSION file
NO release-state.json
NO target-version.json
NO persisted RELEASED / UNRELEASED flag
NO duplicated version in repo-policy.json
NO mutable main/latest as release identity
```

## 3. Переход на `3.0.0`

Архитектурное сжатие 3.0 является несовместимым публичным переходом. Поэтому в C3.7 каноническая версия меняется:

```text
2.0.0
  ↓
3.0.0
```

Это изменение означает целевую публичную идентичность принятой архитектуры, но не означает, что выпуск уже опубликован.

После принятия C3.7 и до финального выпуска ожидаемое состояние:

```text
package.json.version = 3.0.0
expected tag = v3.0.0
matching tag = absent
matching published release = absent
release truth = unreleased
```

Это честное состояние. Версия пакета уже определяет продуктовую границу, а существование выпуска выводится независимо.

Не вводятся промежуточные значения только ради обозначения процесса:

```text
NO 3.0.0-dev
NO 3.0.0-alpha solely for internal phase naming
NO 3.0.0-rc solely as stored project state
```

Предварительный выпуск допустим только если в будущем возникнет реальная отдельная потребность. C3.7 её не предполагает.

## 4. Граница C3.7 и C3.10

C3.7 строит и принимает контракт выпуска.

C3.7 не создаёт официальный тег и выпуск `v3.0.0`.

```text
C3.7
  package.json.version = 3.0.0
  + exact release verifier
  + tests
  + docs
  + Pages projection
        ↓
C3.8
  CI optimization
        ↓
C3.9
  documentation convergence
        ↓
C3.10
  external falsification
  + final self-host acceptance
        ↓
exact accepted candidate SHA
        ↓
tag v3.0.0
        ↓
published GitHub Release v3.0.0
        ↓
final release verification
        ↓
optional package publication
```

До C3.10 потребители-кандидаты используют полный неизменяемый `SHA`.

Официальный `v3.0.0` не создаётся до завершения финальной приёмки C3.10.

## 5. Формальная истина выпуска

Для версии `X.Y.Z` и точного коммита `S`:

```text
released(X.Y.Z, S) :=
    package.json.version == X.Y.Z
    AND expected_tag == "v" + X.Y.Z
    AND tag(expected_tag) exists
    AND resolve_tag_to_commit(expected_tag) == S
    AND github_release(expected_tag) exists
    AND github_release(expected_tag).draft == false
    AND github_release(expected_tag).prerelease == false
```

`S` — точный проверяемый коммит текущего release candidate или checkout выпуска.

Отдельный `release_commit` в файле не хранится.

Связь выпуска с коммитом задаёт сам неизменяемый тег:

```text
tag vX.Y.Z
  -> exact commit S
```

`GitHub Release` подтверждает публикацию этого тега, но не создаёт отдельную идентичность коммита.

## 6. Разрешение тега

Проверка должна корректно работать для лёгкого и аннотированного тега.

Лёгкий тег:

```text
refs/tags/vX.Y.Z
  -> commit S
```

Аннотированный тег:

```text
refs/tags/vX.Y.Z
  -> tag object
  -> ...
  -> commit S
```

Проверяющий код обязан разрешать цепочку до объекта `commit` и сравнивать конечный `SHA` с ожидаемым `S`.

Он не должен считать `SHA` объекта аннотированного тега коммитом выпуска.

Циклическая, неизвестная или неразрешимая цепочка завершается ошибкой.

## 7. Источник ожидаемого точного `SHA`

Новый постоянный файл для `SHA` не вводится.

В обычной проверке выпуска ожидаемым является точный текущий checkout:

```text
git rev-parse HEAD
```

Для процесса `GitHub Actions` выпуск проверяется после checkout официального тега. Поэтому:

```text
checkout(tag)
  ↓
HEAD = expected release commit S
  ↓
remote tag resolves to S
```

Это связывает локально исполняемый пакет, удалённый тег и опубликованный выпуск без дублируемой метаинформации.

Если `.git` или точный `HEAD` недоступен в контексте, где требуется доказательство официального выпуска, проверка завершается ошибкой.

## 8. Проверяющий механизм

Существующий `scripts/verify-release-ref.mjs` сохраняется как одна граница проверки выпуска.

Он уже проверяет:

```text
package version
  ↔ expected tag name
  ↔ tag existence
  ↔ GitHub Release existence
```

C3.7 усиливает этот же механизм, а не создаёт второй проверяющий модуль.

Финальная ответственность:

```text
1. прочитать package.json.version
2. вычислить v<version>
3. проверить точное имя ожидаемого тега
4. получить refs/tags/<tag>
5. разрешить ref/tag objects до commit SHA
6. получить current exact checkout SHA
7. доказать tag commit == checkout SHA
8. получить GitHub Release по тому же tag
9. потребовать draft == false
10. потребовать prerelease == false
11. вернуть один структурированный результат
```

Любая ошибка наблюдения `GitHub API` является ошибкой проверки, а не состоянием `unreleased`.

Отсутствие тега или выпуска при обычном наблюдении может быть честно представлено как `unreleased`; при команде строгой release verification это является `FAIL`.

## 9. Один вычислитель, два режима использования

Новая подсистема статусов не нужна.

Одна функция проверки должна позволять двум потребителям использовать одну семантику:

```text
strict verification
  -> release workflow
  -> prepublishOnly
  -> PASS / FAIL

read-only observation
  -> Policy Observatory
  -> published / package-only representation
```

Предпочтительно вынести только чистую общую функцию получения нормализованных release facts, если это реально уменьшит дублирование между существующим verifier и C3.6 collector.

Но C3.7 не требует такой абстракции заранее. Если существующий collector и verifier можно согласовать меньшим изменением, новая библиотека не создаётся.

YAGNI приоритетнее симметрии.

## 10. Поведение `Policy Observatory`

Обсерватория не становится источником истины выпуска.

Она показывает результат наблюдения относительно `package.json.version`.

После принятия C3.7 и до C3.10 ожидаемое представление:

```text
Версия пакета: 3.0.0
Ожидаемый тег: v3.0.0
Опубликованный выпуск: отсутствует
Состояние: версия определена, официальный выпуск ещё не опубликован
```

После финального выпуска:

```text
Версия пакета: 3.0.0
Тег: v3.0.0
Опубликованный выпуск: присутствует
Точный commit: <accepted release SHA>
```

Страница не хранит состояние между сборками и не получает кнопку публикации.

## 11. `repo-guard init` и потребители

`repo-guard init --action-ref` сохраняет существующую строгую модель:

```text
candidate / unreleased
  -> full 40-char SHA

published release
  -> exact vX.Y.Z tag matching package version
```

Не вводятся:

```text
main
latest
v3
v3.0
floating aliases
```

как рекомендуемый production ref.

C3.7 не добавляет поддержку legacy alias.

Если текущая проверка `init` допускает тег только по совпадению строки с `package.json.version`, C3.7 должна сохранить эту простую границу. Доказательство существования и точного release commit принадлежит release verifier, а не каждому запуску `init`.

## 12. Процесс официального выпуска

После финальной приёмки C3.10 последовательность минимальна:

```text
A. main = exact accepted candidate S
B. required checks for S = GREEN
C. package.json.version = 3.0.0 уже принято ранее
D. создать tag v3.0.0 -> S
E. создать published non-prerelease GitHub Release v3.0.0
F. release-integrity workflow checkout v3.0.0
G. verify-release-ref proves tag -> S and release published
H. только после этого допустим npm publish
```

Никакой semantic/code edit между `S` и созданием тега не допускается.

Если после финальной приёмки требуется исправление кода, прежний `S` перестаёт быть release candidate, исправление проходит обычный PR цикл, и C3.10 acceptance повторяется для нового `SHA`.

## 13. `npm publish`

Существующий `prepublishOnly` остаётся fail-closed границей.

Публикация пакета до существования корректного официального тега и `GitHub Release` должна завершаться ошибкой.

После C3.7 требование становится сильнее:

```text
package version matches tag
AND tag resolves to current exact checkout
AND matching published non-prerelease release exists
```

Это предотвращает публикацию:

```text
wrong commit under correct version
wrong tag under correct package
package before GitHub Release
package from stale checkout
package from unrelated commit
```

## 14. `release-integrity` процесс

Существующий `.github/workflows/release-integrity.yml` остаётся единственным специализированным процессом проверки опубликованного выпуска.

Он не создаёт тег, выпуск или пакет.

Он только читает и проверяет.

```text
release published
      ↓
checkout release tag
      ↓
verify-release-ref
      ↓
PASS | FAIL
```

C3.7 может обновить этот процесс только настолько, насколько нужно для точного доказательства `tag -> checkout SHA`.

Никаких write permissions для выпуска в этом процессе не требуется.

## 15. Ошибки и запрет по умолчанию

Строгая проверка завершается `FAIL`, если:

```text
package version отсутствует или некорректна
supplied tag != v<package version>
tag отсутствует
GitHub API недоступен
tag ref имеет неизвестный object type
tag chain не разрешается до commit
resolved tag commit != exact checkout SHA
GitHub Release отсутствует
release draft == true
release prerelease == true
release tag_name != expected tag
```

Ответ `200 OK` с неполной или противоречивой структурой не трактуется как успех.

Наблюдение не должно превращать ошибку API в `release absent`.

## 16. Семантическое версионирование

Остаётся простое правило:

```text
breaking public contract -> major
additive compatible capability -> minor
compatible correctness fix -> patch
```

Compression 3.0 является major cutover, поэтому:

```text
3.0.0
```

Не сохраняются устаревшие команды, поля, режимы или alias только ради искусственной совместимости.

## 17. Документация

C3.7 синхронизирует только документы, где меняется публичная version/release граница.

Минимальные кандидаты:

```text
README.md
RELEASING.md
Policy Observatory generated view
relevant tests/examples if they encode release assumptions
```

Документация должна прямо различать:

```text
package version
expected tag
published release
exact release commit
```

Но только `package version` является сохраняемой версией продукта.

До C3.10 документация не утверждает, что `v3.0.0` выпущен.

## 18. Отсутствие новой публичной команды

C3.7 не добавляет публичную CLI-команду вроде:

```text
repo-guard release
repo-guard version-state
repo-guard publish
```

Внутренний `npm run verify:release-ref` достаточен для release tooling.

Пользовательская CLI-поверхность остаётся:

```text
validate
check-diff
check-pr
init
doctor
```

## 19. Отсутствие новой семантики политики

Release truth не становится новым `FactRef` source, relation kind или runtime constraint kind только ради C3.7.

C3.7 относится к product/release boundary, а не к расширению языка policy.

Жёстко:

```text
NO new FactRef source
NO new relation descriptor
NO new runtime constraint kind
NO second evaluator
NO release-specific policy DSL
NO legacy compatibility layer
```

Если будущий реальный consumer потребует version policy как обычное ограничение репозитория, это рассматривается отдельно и должно по возможности выражаться существующими фактами и отношениями.

## 20. TDD границы реализации

Реализация начинается только после принятия отдельного implementation plan.

Ожидаемые независимые RED-срезы:

```text
A. package version cutover 2.0.0 -> 3.0.0
   + docs/observable package-only truth

B. exact tag resolution
   RED: correct tag name points to wrong commit and old verifier passes
   GREEN: verifier rejects mismatch

C. annotated tag resolution
   RED: annotated tag object is confused with commit
   GREEN: recursive resolution reaches exact commit

D. release object strictness
   RED: prerelease or malformed successful response passes
   GREEN: fail-closed

E. release workflow integration
   RED: workflow does not prove exact tag checkout relation
   GREEN: one existing verifier path proves it
```

Точный разрез может быть ещё сжат implementation plan, если несколько falsifier безопасно входят в одну маленькую транзакцию.

## 21. Governance boundary

Изменение `.github/workflows/release-integrity.yml` является governance path и требует отдельного доверенного `GovernanceGrant`.

Design и plan PR не получают такое разрешение, потому что они не меняют workflow.

Implementation issue, которая действительно меняет процесс выпуска, должна разрешить только нужный путь и не должна разрешать ослабление policy без отдельной причины.

## 22. Что C3.7 сознательно не делает

```text
NO actual v3.0.0 tag creation
NO GitHub Release v3.0.0 creation
NO npm publication
NO release automation that writes tags/releases
NO changelog subsystem
NO release notes generator
NO floating major tag
NO signing subsystem added speculatively
NO provenance/SBOM subsystem added speculatively
NO C3.8 CI optimization
NO C3.9 final documentation sweep
NO C3.10 external consumer acceptance
```

C3.7 создаёт строгую истину выпуска, а не платформу выпуска.

## 23. Критерии приёмки C3.7

Фаза принята, когда доказано всё ниже:

```text
1. package.json.version является единственным persisted version source
2. accepted version = 3.0.0
3. отсутствие v3.0.0 tag/release честно означает unreleased
4. verifier вычисляет expected tag из package version
5. verifier разрешает lightweight и annotated tag до exact commit
6. verifier сравнивает resolved tag commit с exact checkout SHA
7. verifier требует matching published non-draft non-prerelease GitHub Release
8. malformed/API-error state fail-closed
9. prepublishOnly использует ту же строгую verification boundary
10. release-integrity использует тот же verifier
11. Pages показывает package/release truth без нового authority
12. README/RELEASING не называют v3.0.0 выпущенным до C3.10
13. candidate consumers используют immutable SHA
14. public CLI surface не вырос
15. policy semantic core не вырос
16. никакого второго version/release state файла нет
```

После выполнения этих критериев #378 закрывается как завершённая архитектура выпуска, но официальный `v3.0.0` остаётся не выпущенным до C3.10.

## 24. Инвариант простоты

Итоговая модель должна объясняться одной цепочкой:

```text
package.json.version
        ↓
v<version>
        ↓
exact immutable tag commit
        ↓
published GitHub Release
```

Если для определения того, выпущена ли версия, нужно читать ещё один собственный файл `repo-guard`, дизайн нарушен.

Если два компонента независимо решают, какой `SHA` является release commit, дизайн нарушен.

Если имя версии приходится синхронизировать более чем в одном сохраняемом источнике, дизайн нарушен.

Цель C3.7 — не добавить release machinery, а убрать неоднозначность минимальным числом сущностей.
